import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Listing } from '../src/domain/listing';
import type { Assessment } from '../src/scoring/scorer';
import { ListingStore } from '../src/storage/listing-store';

const assessment: Assessment = {
  score: 80,
  tier: 'okay',
  rejected: false,
  evaluations: [],
  hardExclusions: [],
};

function listing(sourceId: string): Listing {
  return {
    source: 'fixture',
    sourceId,
    url: `https://example.test/${sourceId}`,
    title: 'Testwohnung',
    discoveredAt: '2026-07-20T08:00:00.000Z',
    features: [],
    rawText: 'Dieser vollständige Mailtext soll nicht persistiert werden.',
  };
}

test('SQLite-Store dedupliziert und speichert Status/Discord-ID', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wohnung-bot-'));
  const store = new ListingStore(path.join(directory, 'test.sqlite'));
  const testListing = listing('99');

  assert.equal(store.isEmpty(), true);
  const firstInsert = store.upsert(testListing, assessment);
  assert.equal(firstInsert.isNew, true);
  assert.equal(firstInsert.pendingNotification, true);
  assert.match(firstInsert.firstSeenAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(store.get('fixture:99')?.notificationState, 'pending');
  assert.equal(store.isEmpty(), false);
  assert.deepEqual(store.upsert(testListing, assessment), {
    isNew: false,
    pendingNotification: true,
    firstSeenAt: firstInsert.firstSeenAt,
  });
  store.markNotified('fixture:99', 'discord-123');
  assert.deepEqual(store.upsert(testListing, assessment), {
    isNew: false,
    pendingNotification: false,
    firstSeenAt: firstInsert.firstSeenAt,
  });
  assert.equal(store.updateStatus('fixture:99', 'interested'), true);
  assert.equal(store.get('fixture:99')?.status, 'interested');
  assert.equal(store.get('fixture:99')?.discordMessageId, 'discord-123');
  assert.equal(store.get('fixture:99')?.notificationState, 'notified');
  assert.ok(store.get('fixture:99')?.notificationDecidedAt);
  assert.equal(store.get('fixture:99')?.listing.rawText, undefined);

  assert.equal(store.setUserStatus('fixture:99', 'user-a', 'watchlist'), true);
  assert.equal(store.setUserStatus('fixture:99', 'user-b', 'interested'), true);
  assert.equal(store.getUserStatus('fixture:99', 'user-a'), 'watchlist');
  assert.equal(store.getUserStatus('fixture:99', 'user-b'), 'interested');
  assert.equal(store.listByUserStatus('user-a', 'watchlist').length, 1);
  assert.equal(store.listByUserStatus('user-a', ['watchlist', 'interested']).length, 1);
  assert.equal(store.listByUserStatus('user-b', 'watchlist').length, 0);
  assert.equal(store.removeUserStatus('fixture:99', 'user-a', 'watchlist'), true);
  assert.equal(store.getUserStatus('fixture:99', 'user-a'), undefined);
  assert.equal(store.getUserStatus('fixture:99', 'user-b'), 'interested');

  store.updateStatus('fixture:99', 'watchlist');
  assert.equal(store.migrateLegacyWatchlist('legacy-user'), 1);
  assert.equal(store.getUserStatus('fixture:99', 'legacy-user'), 'watchlist');
  assert.equal(store.removeUserStatus('fixture:99', 'legacy-user', 'watchlist'), true);
  assert.equal(store.migrateLegacyWatchlist('legacy-user'), 0);
  assert.equal(store.getUserStatus('fixture:99', 'legacy-user'), undefined);

  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Notification-Entscheidungen bleiben bei erneutem Upsert erhalten', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wohnung-notifications-'));
  const store = new ListingStore(path.join(directory, 'test.sqlite'));

  const retryListing = listing('retry');
  const firstRetry = store.upsert(retryListing, assessment);
  assert.equal(firstRetry.pendingNotification, true);
  assert.equal(store.upsert(retryListing, assessment).pendingNotification, true);

  assert.equal(store.markNotificationSkipped('fixture:retry', 'Unter Mindestscore'), true);
  assert.equal(store.markNotificationSkipped('fixture:retry', 'Anderer Grund'), false);
  assert.deepEqual(
    {
      state: store.get('fixture:retry')?.notificationState,
      reason: store.get('fixture:retry')?.notificationReason,
      pending: store.upsert(retryListing, assessment).pendingNotification,
    },
    { state: 'skipped', reason: 'Unter Mindestscore', pending: false }
  );

  const bootstrapListing = listing('bootstrap');
  store.upsert(bootstrapListing, assessment);
  store.markNotified('fixture:bootstrap', 'bootstrap');
  assert.equal(store.get('fixture:bootstrap')?.notificationState, 'bootstrap');
  assert.equal(store.upsert(bootstrapListing, assessment).pendingNotification, false);

  const notifiedListing = listing('notified');
  store.upsert(notifiedListing, assessment);
  store.markNotified('fixture:notified', 'discord-456');
  assert.equal(store.markNotificationSkipped('fixture:notified', 'Darf nicht zurückgesetzt werden'), false);
  assert.equal(store.get('fixture:notified')?.notificationState, 'notified');
  assert.equal(store.upsert(notifiedListing, assessment).pendingNotification, false);

  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('stiller Erstbestand wird bereits beim Einfügen atomar als Bootstrap markiert', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wohnung-bootstrap-store-'));
  const store = new ListingStore(path.join(directory, 'test.sqlite'));
  try {
    const listing: Listing = {
      source: 'fixture',
      sourceId: 'bootstrap',
      url: 'https://example.test/bootstrap',
      title: 'Vorhandene Wohnung',
      discoveredAt: '2026-07-20T08:00:00.000Z',
      features: [],
    };
    const assessment: Assessment = {
      score: 80,
      tier: 'okay',
      rejected: false,
      evaluations: [],
      hardExclusions: [],
    };

    assert.deepEqual(store.upsert(listing, assessment, 'bootstrap'), {
      isNew: true,
      pendingNotification: false,
      firstSeenAt: store.get('fixture:bootstrap')?.firstSeenAt,
    });
    assert.equal(store.get('fixture:bootstrap')?.notificationState, 'bootstrap');
    assert.equal(store.get('fixture:bootstrap')?.discordMessageId, 'bootstrap');
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bestehende Datenbank wird sicher auf NotificationState migriert', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wohnung-migration-'));
  const databasePath = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE listings (
      listing_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      assessment TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      discord_message_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(source, source_id)
    );
  `);
  const insert = legacy.prepare(`
    INSERT INTO listings (
      listing_key, source, source_id, payload, assessment, status,
      discord_message_id, first_seen_at, last_seen_at
    ) VALUES (?, 'fixture', ?, ?, ?, 'new', ?, ?, ?)
  `);
  const decidedAt = '2026-07-20T09:00:00.000Z';
  for (const [sourceId, messageId] of [
    ['legacy-skipped', null],
    ['legacy-notified', 'discord-old'],
    ['legacy-bootstrap', 'bootstrap'],
  ] as const) {
    insert.run(
      `fixture:${sourceId}`,
      sourceId,
      JSON.stringify(listing(sourceId)),
      JSON.stringify(assessment),
      messageId,
      '2026-07-20T08:00:00.000Z',
      decidedAt
    );
  }
  legacy.close();

  const store = new ListingStore(databasePath);
  const migratedSkipped = store.get('fixture:legacy-skipped');
  assert.equal(migratedSkipped?.notificationState, 'skipped');
  assert.equal(
    migratedSkipped?.notificationReason,
    'Vor der Status-Migration ohne Discord-Nachricht verarbeitet'
  );
  assert.equal(migratedSkipped?.notificationDecidedAt, decidedAt);
  assert.equal(store.get('fixture:legacy-notified')?.notificationState, 'notified');
  assert.equal(store.get('fixture:legacy-bootstrap')?.notificationState, 'bootstrap');

  assert.equal(store.upsert(listing('legacy-skipped'), assessment).pendingNotification, false);
  assert.equal(store.upsert(listing('legacy-notified'), assessment).pendingNotification, false);
  assert.equal(store.upsert(listing('legacy-bootstrap'), assessment).pendingNotification, false);
  const postMigrationInsert = store.upsert(listing('new-after-migration'), assessment);
  assert.equal(postMigrationInsert.isNew, true);
  assert.equal(postMigrationInsert.pendingNotification, true);
  assert.equal(store.get('fixture:new-after-migration')?.notificationState, 'pending');

  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
