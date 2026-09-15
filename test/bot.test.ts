import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HousingBot } from '../src/bot';
import type { ListingNotifier } from '../src/bot';
import { loadProfile, searchRulesFromProfile } from '../src/config';
import type { RuntimeConfig } from '../src/config';
import type { Listing } from '../src/domain/listing';
import type { Assessment } from '../src/scoring/scorer';
import { scoreListing } from '../src/scoring/scorer';
import type { ListingSource } from '../src/sources/listing-source';
import { ListingStore } from '../src/storage/listing-store';
import { SearchProfileStore } from '../src/storage/search-profile-store';

class MutableSource implements ListingSource {
  constructor(public listings: Listing[]) {}
  async fetchListings(): Promise<Listing[]> {
    return this.listings;
  }
}

class RecordingNotifier implements ListingNotifier {
  readonly published: Listing[] = [];
  disconnected = false;
  async connect(): Promise<void> {}
  async publishListing(listing: Listing, _assessment: Assessment): Promise<string> {
    this.published.push(listing);
    return `discord-${listing.sourceId}`;
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

class FailOnceSource implements ListingSource {
  calls = 0;
  constructor(private readonly listing: Listing) {}
  async fetchListings(): Promise<Listing[]> {
    this.calls += 1;
    if (this.calls === 1) throw new Error('Temporärer IMAP-Fehler');
    return [this.listing];
  }
}

class BlockingSource implements ListingSource {
  readonly started: Promise<void>;
  private signalStarted!: () => void;
  private releaseRun!: () => void;
  private readonly released: Promise<void>;

  constructor() {
    this.started = new Promise(resolve => {
      this.signalStarted = resolve;
    });
    this.released = new Promise(resolve => {
      this.releaseRun = resolve;
    });
  }

  release(): void {
    this.releaseRun();
  }

  async fetchListings(): Promise<Listing[]> {
    this.signalStarted();
    await this.released;
    return [];
  }
}

function perfectListing(sourceId: string): Listing {
  return {
    source: 'fixture',
    sourceId,
    url: `https://example.test/${sourceId}`,
    title: 'Wohnung mit Balkon, Einbauküche und Aufzug',
    address: '10997 Berlin Kreuzberg',
    warmRent: 1000,
    coldRent: 800,
    livingSpace: 70,
    rooms: 3,
    discoveredAt: '2026-07-20T08:00:00.000Z',
    features: ['Balkon', 'Einbauküche', 'Aufzug'],
  };
}

test('stiller Erststart markiert Bestand, postet danach aber echte Neuzugänge', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wohnung-bot-worker-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const store = new ListingStore(databasePath);
  const source = new MutableSource([perfectListing('old')]);
  const notifier = new RecordingNotifier();
  const config: RuntimeConfig = {
    discord: { token: 'test', channelId: 'test', allowedUserIds: [] },
    imap: {
      host: 'example.test',
      port: 993,
      secure: true,
      user: 'test',
      password: 'test',
      mailbox: 'INBOX',
      lookbackHours: 72,
      maxMessages: 100,
      senderContains: 'immobilienscout24',
    },
    databasePath,
    pollIntervalMinutes: 10,
    notifyExistingOnStart: false,
    retentionDays: 30,
    profile: loadProfile(path.resolve('config/profile.example.json')),
    profilePath: path.resolve('config/profile.example.json'),
  };
  const bot = new HousingBot(config, source, store, notifier);

  await bot.runOnce();
  assert.equal(notifier.published.length, 0);
  assert.equal(store.get('fixture:old')?.discordMessageId, 'bootstrap');

  source.listings = [perfectListing('old'), perfectListing('new')];
  await bot.runOnce();
  assert.deepEqual(notifier.published.map(listing => listing.sourceId), ['new']);
  assert.equal(store.get('fixture:new')?.discordMessageId, 'discord-new');

  await bot.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Profilwechsel veröffentlicht keine alten Ausschlüsse, aber neue Treffer mit dem aktiven Profil', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wohnung-bot-profiles-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const store = new ListingStore(databasePath);
  const profileStore = new SearchProfileStore(databasePath);
  const profile = loadProfile(path.resolve('config/profile.example.json'));
  const imported = profileStore.ensureImported(profile).profile;
  const tooExpensive = { ...perfectListing('old-rejected'), warmRent: 2000 };
  const source = new MutableSource([tooExpensive]);
  const notifier = new RecordingNotifier();
  const config: RuntimeConfig = {
    discord: { token: 'test', channelId: 'test', allowedUserIds: [] },
    imap: {
      host: 'example.test',
      port: 993,
      secure: true,
      user: 'test',
      password: 'test',
      mailbox: 'INBOX',
      lookbackHours: 72,
      maxMessages: 100,
      senderContains: 'immobilienscout24',
    },
    databasePath,
    pollIntervalMinutes: 10,
    notifyExistingOnStart: true,
    retentionDays: 30,
    profile,
    profilePath: path.resolve('config/profile.example.json'),
  };
  const bot = new HousingBot(config, source, store, notifier, profileStore);

  await bot.runOnce();
  assert.equal(store.get('fixture:old-rejected')?.notificationState, 'skipped');
  assert.equal(notifier.published.length, 0);

  const pendingBeforeSwitch = perfectListing('pending-before-switch');
  store.upsert(pendingBeforeSwitch, scoreListing(pendingBeforeSwitch, imported.rules));
  await new Promise(resolve => setTimeout(resolve, 5));

  const relaxed = profileStore.duplicateProfile(imported.id, 'Lockereres Profil');
  const rules = searchRulesFromProfile(profile);
  const warmRent = rules.numericCriteria.warmRent;
  assert.ok(warmRent);
  warmRent.perfect.max = 2100;
  warmRent.okay.max = 2300;
  warmRent.mediocre.max = 2500;
  profileStore.updateRules(relaxed.id, rules, relaxed.revision);
  profileStore.activateProfile(relaxed.id);

  source.listings = [tooExpensive, pendingBeforeSwitch];
  await bot.runOnce();
  assert.equal(notifier.published.length, 0);
  assert.equal(store.get('fixture:pending-before-switch')?.notificationState, 'skipped');

  source.listings = [
    tooExpensive,
    pendingBeforeSwitch,
    { ...tooExpensive, sourceId: 'new-after-switch' },
  ];
  await bot.runOnce();
  assert.deepEqual(notifier.published.map(listing => listing.sourceId), ['new-after-switch']);

  await bot.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('ein Fehler im ersten Abruf stoppt die späteren Intervalle nicht', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wohnung-bot-retry-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const store = new ListingStore(databasePath);
  const source = new FailOnceSource(perfectListing('after-imap-retry'));
  const notifier = new RecordingNotifier();
  const profile = loadProfile(path.resolve('config/profile.example.json'));
  const config: RuntimeConfig = {
    discord: { token: 'test', channelId: 'test', allowedUserIds: [] },
    imap: {
      host: 'example.test', port: 993, secure: true, user: 'test', password: 'test',
      mailbox: 'INBOX', lookbackHours: 72, maxMessages: 100,
      senderContains: 'immobilienscout24',
    },
    databasePath,
    pollIntervalMinutes: 0.001,
    notifyExistingOnStart: true,
    retentionDays: 30,
    profile,
    profilePath: path.resolve('config/profile.example.json'),
  };
  const bot = new HousingBot(config, source, store, notifier);

  await bot.start();
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.ok(source.calls >= 2);
  assert.deepEqual(notifier.published.map(listing => listing.sourceId), ['after-imap-retry']);

  await bot.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('sauberes Beenden wartet auf einen bereits laufenden Suchlauf', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wohnung-bot-shutdown-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const store = new ListingStore(databasePath);
  const source = new BlockingSource();
  const notifier = new RecordingNotifier();
  const profile = loadProfile(path.resolve('config/profile.example.json'));
  const config: RuntimeConfig = {
    discord: { token: 'test', channelId: 'test', allowedUserIds: [] },
    imap: {
      host: 'example.test', port: 993, secure: true, user: 'test', password: 'test',
      mailbox: 'INBOX', lookbackHours: 72, maxMessages: 100,
      senderContains: 'immobilienscout24',
    },
    databasePath,
    pollIntervalMinutes: 10,
    notifyExistingOnStart: true,
    retentionDays: 30,
    profile,
    profilePath: path.resolve('config/profile.example.json'),
  };
  const bot = new HousingBot(config, source, store, notifier);

  const run = bot.runOnce();
  await source.started;
  const stopping = bot.stop();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(notifier.disconnected, false);
  source.release();
  await run;
  await stopping;
  assert.equal(notifier.disconnected, true);

  fs.rmSync(directory, { recursive: true, force: true });
});
