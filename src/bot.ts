import { searchRulesFromProfile } from './config';
import type { RuntimeConfig } from './config';
import type { Listing } from './domain/listing';
import { listingKey } from './domain/listing';
import type { Assessment } from './scoring/scorer';
import { isAtLeastTier, scoreListing } from './scoring/scorer';
import type { ListingSource } from './sources/listing-source';
import { ListingStore } from './storage/listing-store';
import type { SearchProfileStore } from './storage/search-profile-store';

export interface ListingNotifier {
  connect(): Promise<void>;
  publishListing(listing: Listing, assessment: Assessment): Promise<string>;
  disconnect(): Promise<void>;
}

export class HousingBot {
  private interval?: NodeJS.Timeout;
  private running = false;
  private stopping = false;
  private currentRun?: Promise<void>;
  private firstSuccessfulRun = true;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly source: ListingSource,
    private readonly store: ListingStore,
    private readonly discord: ListingNotifier,
    private readonly profileStore?: SearchProfileStore
  ) {}

  async start(): Promise<void> {
    await this.discord.connect();
    this.interval = setInterval(() => {
      void this.runOnce().catch(error => console.error('Wohnungssuche fehlgeschlagen:', error));
    }, this.config.pollIntervalMinutes * 60 * 1000);
    console.info(`Wohnungssuche läuft alle ${this.config.pollIntervalMinutes} Minuten.`);
    await this.runOnce().catch(error => {
      console.error(
        'Erster Wohnungssuchlauf fehlgeschlagen; der Bot versucht es beim nächsten Intervall erneut:',
        error
      );
    });
  }

  async runOnce(): Promise<void> {
    if (this.stopping) return;
    if (this.running) {
      console.warn('Vorheriger Suchlauf läuft noch; dieser Durchgang wird übersprungen.');
      return;
    }
    this.running = true;
    const operation = this.executeRun();
    this.currentRun = operation;
    try {
      await operation;
    } finally {
      this.running = false;
      if (this.currentRun === operation) this.currentRun = undefined;
    }
  }

  private async executeRun(): Promise<void> {
    const listings = await this.source.fetchListings();
    const activeProfile = this.profileStore?.getActiveProfile();
    const rules = activeProfile?.rules ?? searchRulesFromProfile(this.config.profile);
    const activationTime = activeProfile ? Date.parse(activeProfile.activatedAt) : undefined;
    if (activeProfile && !Number.isFinite(activationTime)) {
      throw new Error(`Aktivierungszeit des Suchprofils „${activeProfile.name}“ ist ungültig.`);
    }
    const silentBootstrap =
      this.firstSuccessfulRun && !this.config.notifyExistingOnStart && this.store.isEmpty();
    const assessed = listings
      .map(listing => ({ listing, assessment: scoreListing(listing, rules) }))
      .sort((left, right) => right.assessment.score - left.assessment.score);

    let posted = 0;
    let discovered = 0;
    for (const item of assessed) {
      const key = listingKey(item.listing);
      const state = this.store.upsert(
        item.listing,
        item.assessment,
        silentBootstrap ? 'bootstrap' : 'pending'
      );
      if (state.isNew) discovered += 1;
      if (!state.pendingNotification) continue;

      if (activeProfile && this.profileStore) {
        const latestProfile = this.profileStore.getActiveProfile();
        if (
          latestProfile.id !== activeProfile.id ||
          latestProfile.revision !== activeProfile.revision ||
          latestProfile.activatedAt !== activeProfile.activatedAt
        ) {
          this.store.markNotificationSkipped(key, 'Suchprofil wurde während des Suchlaufs geändert');
          continue;
        }
      }

      const firstSeenTime = Date.parse(state.firstSeenAt);
      if (!Number.isFinite(firstSeenTime)) {
        this.store.markNotificationSkipped(key, 'Ungültiger Zeitpunkt der ersten Erkennung');
        continue;
      }
      if (activationTime !== undefined && firstSeenTime < activationTime) {
        this.store.markNotificationSkipped(
          key,
          `Vor Aktivierung von „${activeProfile?.name ?? 'Suchprofil'}“ entdeckt`
        );
        continue;
      }

      if (item.assessment.rejected) {
        if (!rules.notifications.postRejected) {
          this.store.markNotificationSkipped(
            key,
            item.assessment.hardExclusions.join('; ') || 'Durch Suchregeln ausgeschlossen'
          );
          continue;
        }
      } else if (!isAtLeastTier(item.assessment.tier, rules.notifications.minimumTier)) {
        this.store.markNotificationSkipped(
          key,
          `Unter Mindeststufe ${rules.notifications.minimumTier}`
        );
        continue;
      }

      const messageId = await this.discord.publishListing(item.listing, item.assessment);
      this.store.markNotified(key, messageId);
      posted += 1;
    }
    this.firstSuccessfulRun = false;
    const pruned = this.store.pruneInactive(this.config.retentionDays);
    console.info(
      `Suchlauf: ${listings.length} Treffer, ${discovered} neu, ${posted} in Discord gepostet, ${pruned} alte Datensätze entfernt.`
    );
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    const activeRun = this.currentRun;
    if (activeRun) {
      console.info('Laufende Wohnungssuche wird vor dem Beenden abgeschlossen.');
      await activeRun.catch(error => {
        console.error('Laufende Wohnungssuche endete beim Beenden mit einem Fehler:', error);
      });
    }
    await this.discord.disconnect();
    this.store.close();
    this.profileStore?.close();
  }
}
