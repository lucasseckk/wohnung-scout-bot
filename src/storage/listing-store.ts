import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Listing } from '../domain/listing';
import { listingKey } from '../domain/listing';
import type { Assessment } from '../scoring/scorer';

export type ListingStatus = 'new' | 'watchlist' | 'interested' | 'ignored' | 'applied';
export type UserListingStatus = Exclude<ListingStatus, 'new'>;
export type NotificationState = 'pending' | 'notified' | 'skipped' | 'bootstrap';

export type ListingUpsertResult = {
  isNew: boolean;
  pendingNotification: boolean;
  firstSeenAt: string;
};

export type StoredListing = {
  listing: Listing;
  assessment: Assessment;
  status: ListingStatus;
  notificationState: NotificationState;
  notificationReason?: string;
  notificationDecidedAt?: string;
  discordMessageId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type StoredUserListing = StoredListing & {
  userStatus: UserListingStatus;
};

type ListingRow = {
  payload: string;
  assessment: string;
  status: ListingStatus;
  notification_state: NotificationState;
  notification_reason: string | null;
  notification_decided_at: string | null;
  discord_message_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

type UserListingRow = ListingRow & {
  user_status: UserListingStatus;
};

export class ListingStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        listing_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        assessment TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        discord_message_id TEXT,
        notification_state TEXT NOT NULL DEFAULT 'skipped'
          CHECK (notification_state IN ('pending', 'notified', 'skipped', 'bootstrap')),
        notification_reason TEXT,
        notification_decided_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(source, source_id)
      );
      CREATE INDEX IF NOT EXISTS listings_pending_idx
        ON listings(discord_message_id, status);
      CREATE TABLE IF NOT EXISTS listing_user_statuses (
        listing_key TEXT NOT NULL REFERENCES listings(listing_key) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('watchlist', 'interested', 'ignored', 'applied')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (listing_key, user_id)
      );
      CREATE INDEX IF NOT EXISTS listing_user_status_idx
        ON listing_user_statuses(user_id, status, updated_at DESC);
    `);
    this.migrateNotificationState();
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS listings_notification_state_idx
        ON listings(notification_state, status);
    `);
  }

  upsert(
    listing: Listing,
    assessment: Assessment,
    initialNotificationState: 'pending' | 'bootstrap' = 'pending'
  ): ListingUpsertResult {
    const key = listingKey(listing);
    const exists = this.database
      .prepare(
        'SELECT notification_state, first_seen_at FROM listings WHERE listing_key = ?'
      )
      .get(key) as
      | { notification_state: NotificationState; first_seen_at: string }
      | undefined;
    const now = new Date().toISOString();
    const persistedListing = { ...listing };
    delete persistedListing.rawText;

    this.database
      .prepare(`
        INSERT INTO listings (
          listing_key, source, source_id, payload, assessment, status,
          discord_message_id, notification_state, notification_reason,
          notification_decided_at, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, 'new', ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(listing_key) DO UPDATE SET
          payload = excluded.payload,
          assessment = excluded.assessment,
          last_seen_at = excluded.last_seen_at
      `)
      .run(
        key,
        listing.source,
        listing.sourceId,
        JSON.stringify(persistedListing),
        JSON.stringify(assessment),
        initialNotificationState === 'bootstrap' ? 'bootstrap' : null,
        initialNotificationState,
        initialNotificationState === 'bootstrap' ? now : null,
        now,
        now
      );

    return {
      isNew: !exists,
      pendingNotification:
        exists?.notification_state === 'pending' ||
        (!exists && initialNotificationState === 'pending'),
      firstSeenAt: exists?.first_seen_at ?? now,
    };
  }

  markNotified(key: string, discordMessageId: string): void {
    const notificationState: NotificationState =
      discordMessageId === 'bootstrap' ? 'bootstrap' : 'notified';
    this.database
      .prepare(`
        UPDATE listings
        SET discord_message_id = ?, notification_state = ?, notification_reason = NULL,
          notification_decided_at = ?
        WHERE listing_key = ?
      `)
      .run(discordMessageId, notificationState, new Date().toISOString(), key);
  }

  markNotificationSkipped(key: string, reason: string): boolean {
    const normalizedReason = reason.trim() || 'Nicht zur Benachrichtigung ausgewählt';
    const result = this.database
      .prepare(`
        UPDATE listings
        SET notification_state = 'skipped', notification_reason = ?,
          notification_decided_at = ?
        WHERE listing_key = ? AND notification_state = 'pending'
      `)
      .run(normalizedReason, new Date().toISOString(), key);
    return result.changes > 0;
  }

  isEmpty(): boolean {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM listings').get() as {
      count: number;
    };
    return row.count === 0;
  }

  pruneInactive(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.database
      .prepare(`
        DELETE FROM listings
        WHERE last_seen_at < ? AND status IN ('new', 'ignored')
          AND NOT EXISTS (
            SELECT 1 FROM listing_user_statuses AS user_status
            WHERE user_status.listing_key = listings.listing_key
              AND user_status.status IN ('watchlist', 'interested', 'applied')
          )
      `)
      .run(cutoff);
    return Number(result.changes);
  }

  updateStatus(key: string, status: ListingStatus): boolean {
    const result = this.database
      .prepare('UPDATE listings SET status = ? WHERE listing_key = ?')
      .run(status, key);
    return result.changes > 0;
  }

  setUserStatus(key: string, userId: string, status: UserListingStatus): boolean {
    const result = this.database
      .prepare(`
        INSERT INTO listing_user_statuses (listing_key, user_id, status, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(listing_key, user_id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run(key, userId, status, new Date().toISOString());
    return result.changes > 0;
  }

  getUserStatus(key: string, userId: string): UserListingStatus | undefined {
    const row = this.database
      .prepare('SELECT status FROM listing_user_statuses WHERE listing_key = ? AND user_id = ?')
      .get(key, userId) as { status: UserListingStatus } | undefined;
    return row?.status;
  }

  removeUserStatus(key: string, userId: string, status: UserListingStatus): boolean {
    const result = this.database
      .prepare(
        'DELETE FROM listing_user_statuses WHERE listing_key = ? AND user_id = ? AND status = ?'
      )
      .run(key, userId, status);
    return result.changes > 0;
  }

  listByUserStatus(
    userId: string,
    status: UserListingStatus | UserListingStatus[],
    limit = 25
  ): StoredUserListing[] {
    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));
    const statuses = Array.isArray(status) ? status : [status];
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.database
      .prepare(`
        SELECT listings.payload, listings.assessment, listings.status,
          listings.discord_message_id, listings.notification_state,
          listings.notification_reason, listings.notification_decided_at,
          listings.first_seen_at, listings.last_seen_at,
          user_status.status AS user_status
        FROM listing_user_statuses AS user_status
        INNER JOIN listings ON listings.listing_key = user_status.listing_key
        WHERE user_status.user_id = ? AND user_status.status IN (${placeholders})
        ORDER BY user_status.updated_at DESC
        LIMIT ?
      `)
      .all(userId, ...statuses, safeLimit) as UserListingRow[];
    return rows.map(row => ({ ...this.storedListingFromRow(row), userStatus: row.user_status }));
  }

  migrateLegacyWatchlist(userId: string | undefined): number {
    if (!userId) return 0;
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.database
        .prepare(`
          INSERT OR IGNORE INTO listing_user_statuses (listing_key, user_id, status, updated_at)
          SELECT listing_key, ?, status, last_seen_at
          FROM listings
          WHERE status = 'watchlist'
        `)
        .run(userId);
      this.database
        .prepare(
          "UPDATE listings SET status = 'new' WHERE status IN ('watchlist', 'interested', 'applied')"
        )
        .run();
      this.database.exec('COMMIT;');
      return Number(result.changes);
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  get(key: string): StoredListing | undefined {
    const row = this.database
      .prepare(`
        SELECT payload, assessment, status, discord_message_id, notification_state,
          notification_reason, notification_decided_at, first_seen_at, last_seen_at
        FROM listings WHERE listing_key = ?
      `)
      .get(key) as ListingRow | undefined;
    if (!row) return undefined;
    return this.storedListingFromRow(row);
  }

  private storedListingFromRow(row: ListingRow): StoredListing {
    return {
      listing: JSON.parse(row.payload) as Listing,
      assessment: JSON.parse(row.assessment) as Assessment,
      status: row.status,
      notificationState: row.notification_state,
      ...(row.notification_reason ? { notificationReason: row.notification_reason } : {}),
      ...(row.notification_decided_at
        ? { notificationDecidedAt: row.notification_decided_at }
        : {}),
      ...(row.discord_message_id ? { discordMessageId: row.discord_message_id } : {}),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  private migrateNotificationState(): void {
    const columns = this.database.prepare('PRAGMA table_info(listings)').all() as Array<{
      name: string;
    }>;
    const columnNames = new Set(columns.map(column => column.name));
    const needsState = !columnNames.has('notification_state');
    const needsReason = !columnNames.has('notification_reason');
    const needsDecidedAt = !columnNames.has('notification_decided_at');
    if (!needsState && !needsReason && !needsDecidedAt) return;

    this.database.exec('BEGIN IMMEDIATE;');
    try {
      if (needsState) {
        this.database.exec(`
          ALTER TABLE listings ADD COLUMN notification_state TEXT NOT NULL DEFAULT 'skipped'
            CHECK (notification_state IN ('pending', 'notified', 'skipped', 'bootstrap'));
        `);
      }
      if (needsReason) {
        this.database.exec('ALTER TABLE listings ADD COLUMN notification_reason TEXT;');
      }
      if (needsDecidedAt) {
        this.database.exec('ALTER TABLE listings ADD COLUMN notification_decided_at TEXT;');
      }
      if (needsState) {
        this.database.exec(`
          UPDATE listings
          SET notification_state = CASE
                WHEN discord_message_id = 'bootstrap' THEN 'bootstrap'
                WHEN discord_message_id IS NOT NULL THEN 'notified'
                ELSE 'skipped'
              END,
              notification_reason = CASE
                WHEN discord_message_id IS NULL
                  THEN 'Vor der Status-Migration ohne Discord-Nachricht verarbeitet'
                ELSE NULL
              END,
              notification_decided_at = last_seen_at;
        `);
      }
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
