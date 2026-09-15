import { once } from 'node:events';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { SearchProfile } from '../config';
import type { Listing } from '../domain/listing';
import { listingKey } from '../domain/listing';
import {
  applicationProfileForDiscordUser,
  applicationProfileIsReady,
  renderApplicationMessage,
} from '../application/message-template';
import type { Assessment, OverallTier } from '../scoring/scorer';
import { tierLabel } from '../scoring/scorer';
import type { StoredListing } from '../storage/listing-store';
import { ListingStore } from '../storage/listing-store';
import { SearchProfileStore } from '../storage/search-profile-store';
import { normalizeRemoteImageUrl } from '../utils/remote-image-url';
import { SearchConfigController } from './search-config.controller';

type DiscordConfig = {
  token: string;
  channelId: string;
  pingRoleId?: string;
  pingRoleName?: string;
  allowedUserIds: string[];
};

type InteractionAction = 'interested' | 'watchlist' | 'ignored' | 'draft' | 'remove';

const watchlistSelectId = 'wohnung:watchlist-select';

const colors: Record<OverallTier, number> = {
  perfect: 0x2ecc71,
  okay: 0x3498db,
  mediocre: 0xf1c40f,
  not_match: 0x95a5a6,
  rejected: 0xe74c3c,
};

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function safeErrorLabel(error: unknown): string {
  if (!error || typeof error !== 'object') return 'Unbekannter Fehler';
  const record = error as { name?: unknown; code?: unknown; status?: unknown };
  const name = typeof record.name === 'string' ? record.name : 'Fehler';
  const identifiers = [record.code, record.status]
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(String);
  return identifiers.length ? `${name} (${identifiers.join('/')})` : name;
}

type ManagedInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ChatInputCommandInteraction
  | ModalSubmitInteraction;

async function reportInteractionFailure(
  interaction: ManagedInteraction,
  context: string,
  error: unknown
): Promise<void> {
  console.error(`${context}:`, safeErrorLabel(error));
  if (interaction.replied || interaction.deferred) return;
  await interaction
    .reply({
      content: 'Die Aktion konnte gerade nicht abgeschlossen werden. Bitte versuche es erneut.',
      flags: MessageFlags.Ephemeral,
    })
    .catch(replyError => {
      console.error('Discord-Fehlerantwort fehlgeschlagen:', safeErrorLabel(replyError));
    });
}

function formatCurrency(value: number | undefined): string {
  return value === undefined
    ? 'nicht angegeben'
    : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

function formatNumber(value: number | undefined, suffix = ''): string {
  return value === undefined ? 'nicht angegeben' : `${value.toLocaleString('de-DE')}${suffix}`;
}

function formatDate(value: string | undefined): string {
  if (!value) return 'nicht angegeben';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'nicht angegeben'
    : new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function interactionId(action: InteractionAction, key: string): string {
  const customId = `wohnung:${action}:${Buffer.from(key).toString('base64url')}`;
  if (customId.length > 100) throw new Error(`Discord-Interaktions-ID für ${key} ist zu lang.`);
  return customId;
}

function parseInteractionId(customId: string): { action: InteractionAction; key: string } | undefined {
  const match = customId.match(
    /^wohnung:(interested|watchlist|ignored|draft|remove):([A-Za-z0-9_-]+)$/
  );
  if (!match?.[1] || !match[2]) return undefined;
  return {
    action: match[1] as InteractionAction,
    key: Buffer.from(match[2], 'base64url').toString('utf8'),
  };
}

export class DiscordService {
  private readonly client = new Client({ intents: [GatewayIntentBits.Guilds] });
  private readonly searchConfig: SearchConfigController;
  private resolvedPingRoleId?: string;

  constructor(
    private readonly config: DiscordConfig,
    private readonly store: ListingStore,
    private readonly profile: SearchProfile,
    searchProfiles: SearchProfileStore
  ) {
    this.searchConfig = new SearchConfigController(config.allowedUserIds, searchProfiles);
    this.client.on(Events.InteractionCreate, interaction => {
      if (interaction.isButton()) {
        void this.handleButton(interaction).catch(error => {
          return reportInteractionFailure(interaction, 'Discord-Interaktion fehlgeschlagen', error);
        });
      } else if (interaction.isStringSelectMenu()) {
        void this.handleWatchlistSelect(interaction).catch(error => {
          return reportInteractionFailure(interaction, 'Discord-Auswahl fehlgeschlagen', error);
        });
      } else if (interaction.isChatInputCommand()) {
        void this.handleCommand(interaction).catch(error => {
          return reportInteractionFailure(interaction, 'Discord-Befehl fehlgeschlagen', error);
        });
      } else if (interaction.isModalSubmit()) {
        void this.searchConfig.handleModal(interaction).catch(error => {
          return reportInteractionFailure(
            interaction,
            'Discord-Konfigurationsformular fehlgeschlagen',
            error
          );
        });
      }
    });
    this.client.on(Events.Error, error =>
      console.error('Discord-Clientfehler:', safeErrorLabel(error))
    );
  }

  async connect(): Promise<void> {
    try {
      const ready = once(this.client, Events.ClientReady);
      await this.client.login(this.config.token);
      if (!this.client.isReady()) await ready;
      console.info(`Discord verbunden als ${this.client.user?.tag ?? 'Bot'}.`);
      await this.resolvePingRole();
      await this.registerCommands().catch(error => {
        console.warn(
          'Die Discord-Befehle konnten nicht registriert werden:',
          safeErrorLabel(error)
        );
      });
    } catch (error) {
      this.client.destroy();
      throw error;
    }
  }

  async publishListing(listing: Listing, assessment: Assessment): Promise<string> {
    const channel = await this.client.channels.fetch(this.config.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Discord-Kanal ${this.config.channelId} ist kein Textkanal.`);
    }

    const key = listingKey(listing);
    const embed = this.buildEmbed(listing, assessment);
    const components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(interactionId('interested', key))
          .setLabel('Interessiert')
          .setEmoji('✉️')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(interactionId('watchlist', key))
          .setLabel('Merken')
          .setEmoji('⭐')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(interactionId('ignored', key))
          .setLabel('Ignorieren')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Secondary)
      ),
    ];

    const pingRoleId = this.resolvedPingRoleId;
    const message = await channel.send({
      ...(pingRoleId ? { content: `<@&${pingRoleId}>` } : {}),
      embeds: [embed],
      components,
      allowedMentions: {
        parse: [],
        roles: pingRoleId ? [pingRoleId] : [],
        users: [],
      },
    });
    return message.id;
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  private buildEmbed(listing: Listing, assessment: Assessment): EmbedBuilder {
    const location =
      listing.address ?? [listing.postalCode, listing.city, listing.district].filter(Boolean).join(' · ');
    const explanations = assessment.evaluations
      .slice()
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 5)
      .map(evaluation => `• ${evaluation.explanation}`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle(truncate(listing.title || 'Neue Wohnung', 256))
      .setURL(listing.url)
      .setColor(colors[assessment.tier])
      .setDescription(
        truncate(
          `**${tierLabel(assessment.tier)} · ${assessment.score}/100 Punkte**\n${explanations}`,
          4096
        )
      )
      .addFields(
        { name: 'Warmmiete', value: formatCurrency(listing.warmRent), inline: true },
        { name: 'Kaltmiete', value: formatCurrency(listing.coldRent), inline: true },
        { name: 'Wohnfläche', value: formatNumber(listing.livingSpace, ' m²'), inline: true },
        { name: 'Zimmer', value: formatNumber(listing.rooms), inline: true },
        { name: 'Lage', value: truncate(location || 'nicht angegeben', 1024), inline: true },
        {
          name: listing.publishedAt ? 'Veröffentlicht' : 'Im Suchauftrag entdeckt',
          value: formatDate(listing.publishedAt ?? listing.discoveredAt),
          inline: true,
        }
      )
      .setFooter({ text: truncate(`Quelle: ImmoScout24-Suchauftrag · ${listingKey(listing)}`, 2048) })
      .setTimestamp(new Date(listing.publishedAt ?? listing.discoveredAt));

    const additionalFields: Array<{ name: string; value: string; inline: boolean }> = [];
    if (listing.coldRent !== undefined && listing.livingSpace) {
      additionalFields.push({
        name: 'Kaltmiete/m²',
        value: `${(listing.coldRent / listing.livingSpace).toLocaleString('de-DE', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} €/m²`,
        inline: true,
      });
    }
    if (listing.additionalCosts !== undefined) {
      additionalFields.push({ name: 'Nebenkosten', value: formatCurrency(listing.additionalCosts), inline: true });
    }
    if (listing.heatingCosts !== undefined) {
      additionalFields.push({ name: 'Heizkosten', value: formatCurrency(listing.heatingCosts), inline: true });
    }
    if (listing.deposit !== undefined) {
      additionalFields.push({ name: 'Kaution', value: formatCurrency(listing.deposit), inline: true });
    }
    if (listing.floor) additionalFields.push({ name: 'Etage', value: truncate(listing.floor, 1024), inline: true });
    if (listing.availableFrom) {
      additionalFields.push({ name: 'Verfügbar ab', value: truncate(listing.availableFrom, 1024), inline: true });
    }
    if (additionalFields.length) embed.addFields(additionalFields);
    if (listing.features.length) {
      embed.addFields({ name: 'Merkmale', value: truncate(listing.features.join(' · '), 1024) });
    }
    const imageUrl = normalizeRemoteImageUrl(listing.imageUrl);
    if (imageUrl) embed.setImage(imageUrl);
    return embed;
  }

  private isAllowedUser(userId: string): boolean {
    return this.config.allowedUserIds.includes(userId);
  }

  private async registerCommands(): Promise<void> {
    const channel = await this.client.channels.fetch(this.config.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Discord-Kanal ${this.config.channelId} ist kein Textkanal.`);
    }
    const commands = await channel.guild.commands.fetch();
    const definitions = [
      {
        name: 'merkliste',
        description: 'Zeigt deine persönliche Merkliste mit Entwürfen und Entfernen-Funktion.',
      },
      {
        name: 'config',
        description: 'Zeigt und verwaltet die gespeicherten Wohnungssuchprofile.',
      },
    ];
    for (const definition of definitions) {
      const existing = commands.find(command => command.name === definition.name);
      if (existing) {
        if (existing.description !== definition.description) await existing.edit(definition);
      } else {
        await channel.guild.commands.create(definition);
      }
    }
    console.info('Discord-Befehle /merkliste und /config sind bereit.');
  }

  private async resolvePingRole(): Promise<void> {
    if (!this.config.pingRoleId && !this.config.pingRoleName) return;
    const channel = await this.client.channels.fetch(this.config.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Discord-Kanal ${this.config.channelId} ist kein Textkanal.`);
    }
    const roles = await channel.guild.roles.fetch();
    const role = this.config.pingRoleId
      ? roles.get(this.config.pingRoleId)
      : (() => {
          const matches = roles.filter(candidate => candidate.name === this.config.pingRoleName);
          if (matches.size !== 1) {
            throw new Error(
              `Discord-Rolle „${this.config.pingRoleName}“ muss exakt einmal existieren; gefunden: ${matches.size}.`
            );
          }
          return matches.first();
        })();
    if (!role || role.id === channel.guild.id) {
      throw new Error('Die konfigurierte Discord-Benachrichtigungsrolle ist ungültig.');
    }

    const member = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
    const permissions = channel.permissionsFor(member);
    const requiredPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ];
    if (!permissions || requiredPermissions.some(permission => !permissions.has(permission))) {
      throw new Error('Dem Bot fehlen Rechte zum Anzeigen oder Posten im Discord-Zielkanal.');
    }
    if (!role.mentionable && !permissions.has(PermissionFlagsBits.MentionEveryone)) {
      throw new Error(
        `Discord-Rolle @${role.name} ist nicht erwähnbar und der Bot darf gesperrte Rollen nicht pingen.`
      );
    }
    this.resolvedPingRoleId = role.id;
    console.info(`Discord-Rolle @${role.name} wird bei jedem Wohnungs-Post erwähnt.`);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (await this.searchConfig.handleCommand(interaction)) return;
    if (interaction.commandName !== 'merkliste') return;
    if (!this.isAllowedUser(interaction.user.id)) {
      await interaction.reply({
        content: 'Dieser Wohnungs-Bot ist privat konfiguriert.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const saved = this.store.listByUserStatus(
      interaction.user.id,
      ['watchlist', 'interested'],
      25
    );
    if (saved.length === 0) {
      await interaction.reply({
        content: 'Deine Merkliste ist leer. Mit **Merken** fügst du eine Wohnung hinzu.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const options = saved.map(item => {
      const key = listingKey(item.listing);
      const encodedKey = Buffer.from(key).toString('base64url');
      if (encodedKey.length > 100) throw new Error(`Merkliste-Schlüssel für ${key} ist zu lang.`);
      const location = item.listing.district ?? item.listing.address ?? item.listing.city ?? 'Lage unbekannt';
      const status = item.userStatus === 'interested' ? 'Interessiert' : 'Gemerkt';
      return {
        label: truncate(item.listing.title || 'Wohnung', 100),
        description: truncate(
          `${status} · ${item.assessment.score}/100 · ${formatCurrency(item.listing.warmRent)} · ${location}`,
          100
        ),
        value: encodedKey,
      };
    });
    const lines = saved.map((item, index) => {
      const location = item.listing.district ?? item.listing.address ?? item.listing.city ?? 'Lage unbekannt';
      const status = item.userStatus === 'interested' ? '✉️ Interessiert' : '⭐ Gemerkt';
      return `${index + 1}. [${truncate(item.listing.title || 'Wohnung', 80)}](${item.listing.url}) — ${status} · **${item.assessment.score}/100** · ${formatCurrency(item.listing.warmRent)} · ${truncate(location, 50)}`;
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(watchlistSelectId)
      .setPlaceholder(`Wohnung auswählen (${saved.length})`)
      .addOptions(options);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('⭐ Deine Merkliste')
          .setDescription(truncate(lines.join('\n'), 4096))
          .setColor(0x3498db)
          .setFooter({ text: 'Bis zu 25 gemerkte oder interessante Wohnungen · Auswahl öffnet die Aktionen' }),
      ],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  private async handleWatchlistSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (await this.searchConfig.handleSelect(interaction)) return;
    if (interaction.customId !== watchlistSelectId) return;
    if (!this.isAllowedUser(interaction.user.id)) {
      await interaction.reply({
        content: 'Dieser Wohnungs-Bot ist privat konfiguriert.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const encodedKey = interaction.values[0];
    const key = encodedKey ? Buffer.from(encodedKey, 'base64url').toString('utf8') : '';
    const userStatus = key ? this.store.getUserStatus(key, interaction.user.id) : undefined;
    if (!key || (userStatus !== 'watchlist' && userStatus !== 'interested')) {
      await interaction.reply({
        content: 'Diese Wohnung ist nicht mehr auf deiner Merkliste. Starte `/merkliste` erneut.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const stored = this.store.get(key);
    if (!stored) {
      await interaction.reply({
        content: 'Die Wohnung wurde in der lokalen Datenbank nicht gefunden.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const components = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(interactionId('draft', key))
        .setLabel('E-Mail-Entwurf')
        .setEmoji('✉️')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(interactionId('remove', key))
        .setLabel('Entfernen')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setLabel('Exposé öffnen').setStyle(ButtonStyle.Link).setURL(stored.listing.url)
    );
    await interaction.reply({
      content: 'Nur für dich sichtbar:',
      embeds: [this.buildEmbed(stored.listing, stored.assessment)],
      components: [components],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (await this.searchConfig.handleButton(interaction)) return;
    const parsed = parseInteractionId(interaction.customId);
    if (!parsed) return;

    if (
      !this.isAllowedUser(interaction.user.id)
    ) {
      await interaction.reply({
        content: 'Dieser Wohnungs-Bot ist privat konfiguriert.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const stored = this.store.get(parsed.key);
    if (!stored) {
      await interaction.reply({
        content: 'Die Wohnung wurde in der lokalen Datenbank nicht gefunden.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (parsed.action === 'remove') {
      const currentStatus = this.store.getUserStatus(parsed.key, interaction.user.id);
      const removed =
        currentStatus === 'watchlist' || currentStatus === 'interested'
          ? this.store.removeUserStatus(parsed.key, interaction.user.id, currentStatus)
          : false;
      await interaction.reply({
        content: removed
          ? 'Von deiner Merkliste entfernt. Mit `/merkliste` siehst du die aktualisierte Liste.'
          : 'Die Wohnung war nicht mehr auf deiner Merkliste.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (parsed.action === 'draft') {
      const currentStatus = this.store.getUserStatus(parsed.key, interaction.user.id);
      if (currentStatus !== 'watchlist' && currentStatus !== 'interested') {
        await interaction.reply({
          content: 'Diese Wohnung ist nicht mehr auf deiner Merkliste.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await this.replyWithApplicationDraft(interaction, stored, false);
      return;
    }
    if (parsed.action === 'watchlist') {
      this.store.setUserStatus(parsed.key, interaction.user.id, 'watchlist');
      await interaction.reply({
        content: 'Auf deine Merkliste gesetzt. Öffne sie jederzeit mit `/merkliste`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (parsed.action === 'ignored') {
      this.store.setUserStatus(parsed.key, interaction.user.id, 'ignored');
      await interaction.reply({ content: 'Für dich als ignoriert markiert.', flags: MessageFlags.Ephemeral });
      return;
    }
    await this.replyWithApplicationDraft(interaction, stored, true);
  }

  private async replyWithApplicationDraft(
    interaction: ButtonInteraction,
    stored: StoredListing,
    markedInterested: boolean
  ): Promise<void> {
    const application = applicationProfileForDiscordUser(
      this.profile,
      interaction.user.id,
      this.config.allowedUserIds
    );
    if (!application) {
      await interaction.reply({
        content: 'Für deine Discord-ID ist kein eigenes Bewerberprofil eingerichtet.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!applicationProfileIsReady(application)) {
      await interaction.reply({
        content: `Das Bewerberprofil **${application.label}** ist noch unvollständig. Bitte ergänze mindestens Name sowie E-Mail oder Telefonnummer in \`config/profile.json\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const draft = renderApplicationMessage(stored.listing, application);
    const exposeButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel('Exposé öffnen').setStyle(ButtonStyle.Link).setURL(stored.listing.url)
    );
    const heading = markedInterested
      ? `**Als interessiert markiert · Entwurf für ${application.label}:**`
      : `**E-Mail-Entwurf für ${application.label}:**`;
    if (draft.length <= 1750 && !draft.includes('```')) {
      await interaction.reply({
        content: `${heading}\n\n\`\`\`\n${draft}\n\`\`\``,
        components: [exposeButton],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } else {
      await interaction.reply({
        content: `${heading}\nDer Text ist als private Datei angehängt.`,
        files: [new AttachmentBuilder(Buffer.from(draft, 'utf8'), { name: 'email-entwurf.txt' })],
        components: [exposeButton],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
    if (markedInterested) {
      this.store.setUserStatus(listingKey(stored.listing), interaction.user.id, 'interested');
    }
  }
}
