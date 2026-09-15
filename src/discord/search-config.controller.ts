import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { SearchRules } from '../config';
import type { StoredSearchProfile } from '../storage/search-profile-store';
import { SearchProfileStore } from '../storage/search-profile-store';
import {
  applyHomeInputs,
  applyKeywordInputs,
  applyLocationInputs,
  applyRentInputs,
  formatListInput,
  formatMaximumTriple,
  formatMinimumTriple,
} from './search-config-editor';

type ConfigAction =
  | 'activate'
  | 'confirm-activate'
  | 'cancel'
  | 'rent'
  | 'home'
  | 'locations'
  | 'keywords'
  | 'copy'
  | 'rename'
  | 'delete'
  | 'confirm-delete';

type ConfigModalAction = 'rent' | 'home' | 'locations' | 'keywords' | 'copy' | 'rename';

const configSelectId = 'wohnung:config:select';
const buttonPattern =
  /^wohnung:config:(activate|confirm-activate|cancel|rent|home|locations|keywords|copy|rename|delete|confirm-delete):([0-9a-f-]{36}):(\d+)$/i;
const modalPattern =
  /^wohnung:config-modal:(rent|home|locations|keywords|copy|rename):([0-9a-f-]{36}):(\d+)$/i;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function errorMessage(error: unknown): string {
  return truncate(error instanceof Error ? error.message : 'Unbekannter Fehler', 1800);
}

function buttonId(action: ConfigAction, profile: StoredSearchProfile): string {
  return `wohnung:config:${action}:${profile.id}:${profile.revision}`;
}

function modalId(action: ConfigModalAction, profile: StoredSearchProfile): string {
  return `wohnung:config-modal:${action}:${profile.id}:${profile.revision}`;
}

function listSummary(values: readonly string[]): string {
  return values.length ? truncate(values.join(', '), 900) : '–';
}

function numericSummary(
  rules: SearchRules,
  kind: 'maximum' | 'minimum',
  field: 'warmRent' | 'coldRent' | 'livingSpace' | 'rooms'
): string {
  try {
    return kind === 'maximum'
      ? formatMaximumTriple(rules, field as 'warmRent' | 'coldRent')
      : formatMinimumTriple(rules, field as 'livingSpace' | 'rooms');
  } catch {
    return 'nicht eingerichtet';
  }
}

function inputRow(input: TextInputBuilder): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

export class SearchConfigController {
  constructor(
    private readonly allowedUserIds: string[],
    private readonly profiles: SearchProfileStore
  ) {}

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (interaction.commandName !== 'config') return false;
    if (!this.isAllowed(interaction.user.id)) {
      await interaction.reply({
        content: 'Dieser Wohnungs-Bot ist privat konfiguriert.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const active = this.profiles.getActiveProfile();
    await interaction.reply({
      ...this.dashboard(active.id, interaction.user.id),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  async handleSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
    if (interaction.customId !== configSelectId) return false;
    if (!this.isAllowed(interaction.user.id)) {
      await interaction.reply({
        content: 'Dieser Wohnungs-Bot ist privat konfiguriert.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const selectedId = interaction.values[0];
    if (!selectedId || !this.profiles.getProfile(selectedId)) {
      await interaction.reply({
        content: 'Dieses Suchprofil existiert nicht mehr. Starte `/config` erneut.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.update(this.dashboard(selectedId, interaction.user.id));
    return true;
  }

  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const match = interaction.customId.match(buttonPattern);
    if (!match?.[1] || !match[2] || !match[3]) return false;
    if (!this.isAllowed(interaction.user.id)) {
      await interaction.reply({
        content: 'Dieser Wohnungs-Bot ist privat konfiguriert.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (!this.isAdmin(interaction.user.id)) {
      await interaction.reply({
        content: 'Nur der Hauptnutzer darf Suchprofile verändern.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const action = match[1] as ConfigAction;
    const profileId = match[2];
    const revision = Number(match[3]);
    let committed = false;
    try {
      const profile = this.currentVersion(profileId, revision);
      if (action === 'cancel') {
        await interaction.update(this.dashboard(profile.id, interaction.user.id));
      } else if (action === 'activate') {
        await interaction.update(this.confirmActivation(profile));
      } else if (action === 'confirm-activate') {
        await interaction.deferUpdate();
        const active = this.profiles.activateProfile(profile.id);
        committed = true;
        await interaction.editReply({
          ...this.dashboard(active.id, interaction.user.id),
          content: `✅ **${active.name}** ist jetzt aktiv. Die Regeln gelten ab dem nächsten Suchlauf nur für künftig entdeckte Wohnungen.`,
        });
      } else if (action === 'delete') {
        await interaction.update(this.confirmDeletion(profile));
      } else if (action === 'confirm-delete') {
        await interaction.deferUpdate();
        this.profiles.deleteProfile(profile.id);
        committed = true;
        const active = this.profiles.getActiveProfile();
        await interaction.editReply({
          ...this.dashboard(active.id, interaction.user.id),
          content: `🗑️ **${profile.name}** wurde gelöscht.`,
        });
      } else {
        await interaction.showModal(this.modalFor(action, profile));
      }
    } catch (error) {
      const content = committed
        ? `Die Änderung wurde gespeichert, aber die Ansicht konnte nicht aktualisiert werden:\n${errorMessage(error)}\n\nÖffne \`/config\` erneut.`
        : `Die Konfiguration konnte nicht geändert werden:\n${errorMessage(error)}\n\nÖffne \`/config\` erneut.`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content, embeds: [], components: [] }).catch(() => undefined);
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    }
    return true;
  }

  async handleModal(interaction: ModalSubmitInteraction): Promise<boolean> {
    const match = interaction.customId.match(modalPattern);
    if (!match?.[1] || !match[2] || !match[3]) return false;
    if (!this.isAllowed(interaction.user.id) || !this.isAdmin(interaction.user.id)) {
      await interaction.reply({
        content: 'Nur der Hauptnutzer darf Suchprofile verändern.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const action = match[1] as ConfigModalAction;
    const profileId = match[2];
    const revision = Number(match[3]);
    if (interaction.isFromMessage()) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    let committed = false;
    try {
      const profile = this.currentVersion(profileId, revision);
      let updated: StoredSearchProfile;
      if (action === 'rent') {
        updated = this.profiles.updateRules(
          profile.id,
          applyRentInputs(
            profile.rules,
            interaction.fields.getTextInputValue('warm'),
            interaction.fields.getTextInputValue('cold')
          ),
          profile.revision
        );
      } else if (action === 'home') {
        updated = this.profiles.updateRules(
          profile.id,
          applyHomeInputs(
            profile.rules,
            interaction.fields.getTextInputValue('space'),
            interaction.fields.getTextInputValue('rooms')
          ),
          profile.revision
        );
      } else if (action === 'locations') {
        updated = this.profiles.updateRules(
          profile.id,
          applyLocationInputs(
            profile.rules,
            interaction.fields.getTextInputValue('perfect'),
            interaction.fields.getTextInputValue('okay'),
            interaction.fields.getTextInputValue('mediocre')
          ),
          profile.revision
        );
      } else if (action === 'keywords') {
        updated = this.profiles.updateRules(
          profile.id,
          applyKeywordInputs(
            profile.rules,
            interaction.fields.getTextInputValue('positive'),
            interaction.fields.getTextInputValue('negative'),
            interaction.fields.getTextInputValue('exclusions')
          ),
          profile.revision
        );
      } else if (action === 'copy') {
        updated = this.profiles.duplicateProfile(
          profile.id,
          interaction.fields.getTextInputValue('name')
        );
      } else {
        updated = this.profiles.renameProfile(
          profile.id,
          interaction.fields.getTextInputValue('name'),
          profile.revision
        );
      }
      committed = true;
      await interaction.editReply({
        ...this.dashboard(updated.id, interaction.user.id),
        content: action === 'copy'
          ? `✅ Neues Profil **${updated.name}** wurde als Kopie angelegt.`
          : `✅ **${updated.name}** wurde gespeichert. Änderungen an einem aktiven Profil gelten ab jetzt nur für neue Wohnungen.`,
      });
    } catch (error) {
      await interaction.editReply({
        content: committed
          ? `Die Änderung wurde gespeichert, aber die Ansicht konnte nicht aktualisiert werden:\n${errorMessage(error)}\n\nÖffne \`/config\` erneut.`
          : `Die Eingabe wurde nicht gespeichert:\n${errorMessage(error)}\n\nÖffne \`/config\` erneut und korrigiere die Werte.`,
        embeds: [],
        components: [],
      });
    }
    return true;
  }

  private dashboard(selectedId: string, userId: string) {
    const profiles = this.profiles.listProfiles();
    const active = profiles.find(profile => profile.active);
    const selected = profiles.find(profile => profile.id === selectedId) ?? active ?? profiles[0];
    if (!selected || !active) throw new Error('Es ist kein aktives Suchprofil vorhanden.');
    const rules = selected.rules;
    const locations = rules.locationCriterion;
    const keywords = rules.keywordCriterion;
    const readOnly = !this.isAdmin(userId);

    const embed = new EmbedBuilder()
      .setTitle('⚙️ Suchkonfiguration')
      .setColor(selected.active ? 0x2ecc71 : 0x3498db)
      .setDescription(
        `**Ausgewählt:** ${selected.name}\n**Aktiv:** ${active.name}\n${selected.active ? '✅ Dieses Profil bewertet neue Wohnungen.' : '💾 Dieses Profil ist gespeichert, aber nicht aktiv.'}`
      )
      .addFields(
        {
          name: 'Warmmiete · perfekt | okay | maximal',
          value: numericSummary(rules, 'maximum', 'warmRent'),
          inline: true,
        },
        {
          name: 'Kaltmiete · perfekt | okay | maximal',
          value: numericSummary(rules, 'maximum', 'coldRent'),
          inline: true,
        },
        {
          name: 'Wohnfläche · perfekt | okay | Minimum',
          value: numericSummary(rules, 'minimum', 'livingSpace'),
          inline: true,
        },
        {
          name: 'Zimmer · perfekt | okay | Minimum',
          value: numericSummary(rules, 'minimum', 'rooms'),
          inline: true,
        },
        {
          name: 'Gebiete',
          value: truncate(
            `**Perfekt:** ${listSummary(locations?.perfect ?? [])}\n**Okay:** ${listSummary(locations?.okay ?? [])}\n**Mittelmäßig:** ${listSummary(locations?.mediocre ?? [])}`,
            1024
          ),
        },
        {
          name: 'Merkmale',
          value: truncate(
            `**Gewünscht:** ${listSummary(keywords?.positive ?? [])}\n**Negativ:** ${listSummary(keywords?.negative ?? [])}\n**Ausschlüsse:** ${listSummary(keywords?.hardExclusions ?? [])}`,
            1024
          ),
        }
      )
      .setFooter({
        text: readOnly
          ? 'Nur-Lese-Zugriff · Änderungen darf der Hauptnutzer vornehmen.'
          : 'Änderungen werden vollständig geprüft und gelten ohne Container-Neustart.',
      });

    const select = new StringSelectMenuBuilder()
      .setCustomId(configSelectId)
      .setPlaceholder('Gespeichertes Profil auswählen')
      .addOptions(
        profiles.map(profile => ({
          label: truncate(profile.name, 100),
          description: profile.active ? 'Aktives Suchprofil' : `Gespeichert · Version ${profile.revision}`,
          value: profile.id,
          default: profile.id === selected.id,
        }))
      );
    const components: Array<
      ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
    > = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];

    if (!readOnly) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(buttonId('activate', selected))
            .setLabel('Aktivieren')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
            .setDisabled(selected.active),
          new ButtonBuilder()
            .setCustomId(buttonId('rent', selected))
            .setLabel('Mieten')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(buttonId('home', selected))
            .setLabel('Fläche & Zimmer')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(buttonId('locations', selected))
            .setLabel('Gebiete')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!locations),
          new ButtonBuilder()
            .setCustomId(buttonId('keywords', selected))
            .setLabel('Merkmale')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!keywords)
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(buttonId('copy', selected))
            .setLabel('Neue Kopie')
            .setEmoji('➕')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(buttonId('rename', selected))
            .setLabel('Umbenennen')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(buttonId('delete', selected))
            .setLabel('Löschen')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(selected.active)
        )
      );
    }

    return { content: '', embeds: [embed], components, allowedMentions: { parse: [] as never[] } };
  }

  private confirmActivation(profile: StoredSearchProfile) {
    return {
      content: `Soll **${profile.name}** wirklich aktiviert werden? Bestehende Wohnungen werden nicht nachträglich gepostet.`,
      embeds: [],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(buttonId('confirm-activate', profile))
            .setLabel('Ja, aktivieren')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(buttonId('cancel', profile))
            .setLabel('Abbrechen')
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
      allowedMentions: { parse: [] as never[] },
    };
  }

  private confirmDeletion(profile: StoredSearchProfile) {
    return {
      content: `Soll das gespeicherte Profil **${profile.name}** wirklich gelöscht werden?`,
      embeds: [],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(buttonId('confirm-delete', profile))
            .setLabel('Endgültig löschen')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(buttonId('cancel', profile))
            .setLabel('Abbrechen')
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
      allowedMentions: { parse: [] as never[] },
    };
  }

  private modalFor(action: Exclude<ConfigAction, 'activate' | 'confirm-activate' | 'cancel' | 'delete' | 'confirm-delete'>, profile: StoredSearchProfile): ModalBuilder {
    if (action === 'rent') {
      return new ModalBuilder()
        .setCustomId(modalId('rent', profile))
        .setTitle('Mietgrenzen bearbeiten')
        .addComponents(
          inputRow(
            new TextInputBuilder()
              .setCustomId('warm')
              .setLabel('Warm: perfekt | okay | Obergrenze')
              .setStyle(TextInputStyle.Short)
              .setValue(formatMaximumTriple(profile.rules, 'warmRent'))
              .setRequired(true)
          ),
          inputRow(
            new TextInputBuilder()
              .setCustomId('cold')
              .setLabel('Kalt: perfekt | okay | Obergrenze')
              .setStyle(TextInputStyle.Short)
              .setValue(formatMaximumTriple(profile.rules, 'coldRent'))
              .setRequired(true)
          )
        );
    }
    if (action === 'home') {
      return new ModalBuilder()
        .setCustomId(modalId('home', profile))
        .setTitle('Wohnung bearbeiten')
        .addComponents(
          inputRow(
            new TextInputBuilder()
              .setCustomId('space')
              .setLabel('Fläche: perfekt | okay | Minimum')
              .setStyle(TextInputStyle.Short)
              .setValue(formatMinimumTriple(profile.rules, 'livingSpace'))
              .setRequired(true)
          ),
          inputRow(
            new TextInputBuilder()
              .setCustomId('rooms')
              .setLabel('Zimmer: perfekt | okay | Minimum')
              .setStyle(TextInputStyle.Short)
              .setValue(formatMinimumTriple(profile.rules, 'rooms'))
              .setRequired(true)
          )
        );
    }
    if (action === 'locations') {
      const criterion = profile.rules.locationCriterion;
      if (!criterion) throw new Error('Dieses Profil besitzt keine Gebietsregeln.');
      return new ModalBuilder()
        .setCustomId(modalId('locations', profile))
        .setTitle('Gebiete bearbeiten')
        .addComponents(
          inputRow(this.listInput('perfect', 'Perfekte Gebiete', criterion.perfect)),
          inputRow(this.listInput('okay', 'Okay-Gebiete', criterion.okay)),
          inputRow(this.listInput('mediocre', 'Noch akzeptable Gebiete', criterion.mediocre))
        );
    }
    if (action === 'keywords') {
      const criterion = profile.rules.keywordCriterion;
      if (!criterion) throw new Error('Dieses Profil besitzt keine Merkmalsregeln.');
      return new ModalBuilder()
        .setCustomId(modalId('keywords', profile))
        .setTitle('Merkmale bearbeiten')
        .addComponents(
          inputRow(this.listInput('positive', 'Gewünschte Merkmale', criterion.positive)),
          inputRow(this.listInput('negative', 'Negative Merkmale', criterion.negative)),
          inputRow(this.listInput('exclusions', 'Harte Ausschlüsse', criterion.hardExclusions))
        );
    }
    const isCopy = action === 'copy';
    return new ModalBuilder()
      .setCustomId(modalId(action, profile))
      .setTitle(isCopy ? 'Neues Suchprofil' : 'Profil umbenennen')
      .addComponents(
        inputRow(
          new TextInputBuilder()
            .setCustomId('name')
            .setLabel('Profilname')
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(100)
            .setValue(isCopy ? `${truncate(profile.name, 90)} – Kopie` : profile.name)
            .setRequired(true)
        )
      );
  }

  private listInput(customId: string, label: string, values: readonly string[]): TextInputBuilder {
    const formatted = formatListInput(values);
    if (formatted.length > 4000) {
      throw new Error(
        `${label} ist zu lang für Discord. Kürze die Liste zunächst in der gespeicherten Konfiguration.`
      );
    }
    return new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setValue(formatted)
      .setRequired(false);
  }

  private currentVersion(id: string, revision: number): StoredSearchProfile {
    const profile = this.profiles.getProfile(id);
    if (!profile) throw new Error('Das Suchprofil wurde nicht gefunden.');
    if (profile.revision !== revision) {
      throw new Error('Das Suchprofil wurde inzwischen geändert. Bitte öffne `/config` erneut.');
    }
    return profile;
  }

  private isAllowed(userId: string): boolean {
    return this.allowedUserIds.includes(userId);
  }

  private isAdmin(userId: string): boolean {
    return this.allowedUserIds[0] === userId;
  }
}
