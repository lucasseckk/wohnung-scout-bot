import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  parseSearchRules,
  searchRulesFromProfile,
  type SearchProfile,
  type SearchRules,
} from '../config';

const maximumProfiles = 25;
const maximumNameLength = 100;

type ProfileRow = {
  id: string;
  name: string;
  rules_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
};

export type StoredSearchProfile = {
  id: string;
  name: string;
  rules: SearchRules;
  revision: number;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  activatedAt?: string;
};

export type ActiveSearchProfile = StoredSearchProfile & {
  active: true;
  activatedAt: string;
};

function normalizedName(value: string): { name: string; key: string } {
  if (typeof value !== 'string') throw new Error('Der Profilname muss Text sein.');
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name) throw new Error('Der Profilname darf nicht leer sein.');
  if (name.length > maximumNameLength) {
    throw new Error(`Der Profilname darf höchstens ${maximumNameLength} Zeichen lang sein.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('Der Profilname enthält nicht erlaubte Steuerzeichen.');
  }
  return { name, key: name.toLocaleLowerCase('de-DE') };
}

function nextTimestamp(previous?: string): string {
  const now = Date.now();
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  return new Date(Number.isFinite(previousTime) && now <= previousTime ? previousTime + 1 : now)
    .toISOString();
}

export class SearchProfileStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS search_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_search_profile (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        profile_id TEXT NOT NULL REFERENCES search_profiles(id) ON DELETE RESTRICT,
        activated_at TEXT NOT NULL
      );
    `);
  }

  ensureImported(
    profile: SearchProfile
  ): { profile: ActiveSearchProfile; imported: boolean } {
    const count = this.profileCount();
    if (count > 0) {
      return { profile: this.getActiveProfile(), imported: false };
    }

    const { name, key } = normalizedName(profile.profileName);
    const rules = parseSearchRules(searchRulesFromProfile(profile));
    const rulesJson = JSON.stringify(rules);
    const id = randomUUID();
    const now = new Date().toISOString();

    return this.inTransaction(() => {
      // Re-check under the write lock so two startup paths cannot import twice.
      if (this.profileCount() > 0) {
        return { profile: this.getActiveProfile(), imported: false };
      }
      this.database
        .prepare(`
          INSERT INTO search_profiles (
            id, name, name_key, rules_json, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?)
        `)
        .run(id, name, key, rulesJson, now, now);
      this.database
        .prepare(`
          INSERT INTO active_search_profile (singleton_id, profile_id, activated_at)
          VALUES (1, ?, ?)
        `)
        .run(id, now);
      return { profile: this.getActiveProfile(), imported: true };
    });
  }

  listProfiles(): StoredSearchProfile[] {
    const rows = this.database
      .prepare(`
        SELECT profile.id, profile.name, profile.rules_json, profile.revision,
          profile.created_at, profile.updated_at, active.activated_at
        FROM search_profiles AS profile
        LEFT JOIN active_search_profile AS active ON active.profile_id = profile.id
        ORDER BY profile.name_key ASC, profile.id ASC
      `)
      .all() as ProfileRow[];
    return rows.map(row => this.profileFromRow(row));
  }

  getProfile(id: string): StoredSearchProfile | undefined {
    const row = this.profileRow(id);
    return row ? this.profileFromRow(row) : undefined;
  }

  getActiveProfile(): ActiveSearchProfile {
    const row = this.database
      .prepare(`
        SELECT profile.id, profile.name, profile.rules_json, profile.revision,
          profile.created_at, profile.updated_at, active.activated_at
        FROM active_search_profile AS active
        INNER JOIN search_profiles AS profile ON profile.id = active.profile_id
        WHERE active.singleton_id = 1
      `)
      .get() as ProfileRow | undefined;
    if (!row?.activated_at) {
      throw new Error('Es ist kein aktives Suchprofil eingerichtet.');
    }
    return this.profileFromRow(row) as ActiveSearchProfile;
  }

  duplicateProfile(sourceId: string, newName: string): StoredSearchProfile {
    const { name, key } = normalizedName(newName);
    return this.inTransaction(() => {
      if (this.profileCount() >= maximumProfiles) {
        throw new Error(`Es können höchstens ${maximumProfiles} Suchprofile gespeichert werden.`);
      }
      const source = this.profileRow(sourceId);
      if (!source) throw new Error(`Suchprofil ${sourceId} wurde nicht gefunden.`);
      this.assertNameAvailable(key);

      // Parsing the source row prevents malformed or manually modified JSON from being copied.
      const rulesJson = JSON.stringify(this.rulesFromJson(source.rules_json, source.id));
      const id = randomUUID();
      const now = new Date().toISOString();
      this.database
        .prepare(`
          INSERT INTO search_profiles (
            id, name, name_key, rules_json, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?)
        `)
        .run(id, name, key, rulesJson, now, now);
      const duplicated = this.getProfile(id);
      if (!duplicated) throw new Error('Das duplizierte Suchprofil konnte nicht gelesen werden.');
      return duplicated;
    });
  }

  updateRules(id: string, rules: SearchRules, expectedRevision: number): StoredSearchProfile {
    const validatedRules = parseSearchRules(rules);
    const rulesJson = JSON.stringify(validatedRules);
    return this.inTransaction(() => {
      const current = this.profileRow(id);
      if (!current) throw new Error(`Suchprofil ${id} wurde nicht gefunden.`);
      this.assertRevision(current, expectedRevision);

      const currentRulesJson = JSON.stringify(this.rulesFromJson(current.rules_json, current.id));
      if (currentRulesJson === rulesJson) return this.profileFromRow(current);

      const updatedAt = nextTimestamp(current.updated_at);
      this.database
        .prepare(`
          UPDATE search_profiles
          SET rules_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(rulesJson, updatedAt, id);

      if (current.activated_at) {
        this.database
          .prepare(`
            UPDATE active_search_profile
            SET activated_at = ?
            WHERE singleton_id = 1 AND profile_id = ?
          `)
          .run(nextTimestamp(current.activated_at), id);
      }
      const updated = this.getProfile(id);
      if (!updated) throw new Error('Das aktualisierte Suchprofil konnte nicht gelesen werden.');
      return updated;
    });
  }

  renameProfile(id: string, newName: string, expectedRevision: number): StoredSearchProfile {
    const { name, key } = normalizedName(newName);
    return this.inTransaction(() => {
      const current = this.profileRow(id);
      if (!current) throw new Error(`Suchprofil ${id} wurde nicht gefunden.`);
      this.assertRevision(current, expectedRevision);
      if (current.name === name) return this.profileFromRow(current);
      this.assertNameAvailable(key, id);

      const updatedAt = nextTimestamp(current.updated_at);
      this.database
        .prepare(`
          UPDATE search_profiles
          SET name = ?, name_key = ?, revision = revision + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(name, key, updatedAt, id);
      const updated = this.getProfile(id);
      if (!updated) throw new Error('Das umbenannte Suchprofil konnte nicht gelesen werden.');
      return updated;
    });
  }

  activateProfile(id: string): ActiveSearchProfile {
    return this.inTransaction(() => {
      const profile = this.profileRow(id);
      if (!profile) throw new Error(`Suchprofil ${id} wurde nicht gefunden.`);
      const active = this.database
        .prepare('SELECT profile_id, activated_at FROM active_search_profile WHERE singleton_id = 1')
        .get() as { profile_id: string; activated_at: string } | undefined;
      if (active?.profile_id === id) return this.getActiveProfile();
      const activatedAt = nextTimestamp(active?.activated_at);
      this.database
        .prepare(`
          INSERT INTO active_search_profile (singleton_id, profile_id, activated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(singleton_id) DO UPDATE SET
            profile_id = excluded.profile_id,
            activated_at = excluded.activated_at
        `)
        .run(id, activatedAt);
      return this.getActiveProfile();
    });
  }

  deleteProfile(id: string): boolean {
    return this.inTransaction(() => {
      const profile = this.profileRow(id);
      if (!profile) return false;
      if (profile.activated_at) {
        throw new Error('Das aktive Suchprofil kann nicht gelöscht werden. Aktiviere zuerst ein anderes Profil.');
      }
      const result = this.database.prepare('DELETE FROM search_profiles WHERE id = ?').run(id);
      return result.changes > 0;
    });
  }

  close(): void {
    this.database.close();
  }

  private profileCount(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM search_profiles').get() as {
      count: number;
    };
    return row.count;
  }

  private profileRow(id: string): ProfileRow | undefined {
    return this.database
      .prepare(`
        SELECT profile.id, profile.name, profile.rules_json, profile.revision,
          profile.created_at, profile.updated_at, active.activated_at
        FROM search_profiles AS profile
        LEFT JOIN active_search_profile AS active ON active.profile_id = profile.id
        WHERE profile.id = ?
      `)
      .get(id) as ProfileRow | undefined;
  }

  private profileFromRow(row: ProfileRow): StoredSearchProfile {
    return {
      id: row.id,
      name: row.name,
      rules: this.rulesFromJson(row.rules_json, row.id),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      active: row.activated_at !== null,
      ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
    };
  }

  private rulesFromJson(json: string, profileId: string): SearchRules {
    try {
      return parseSearchRules(JSON.parse(json) as unknown);
    } catch (error) {
      throw new Error(`Die gespeicherten Regeln des Suchprofils ${profileId} sind ungültig.`, {
        cause: error,
      });
    }
  }

  private assertNameAvailable(key: string, exceptId?: string): void {
    const row = this.database
      .prepare(`
        SELECT id FROM search_profiles
        WHERE name_key = ? AND (? IS NULL OR id <> ?)
      `)
      .get(key, exceptId ?? null, exceptId ?? null) as { id: string } | undefined;
    if (row) throw new Error('Ein Suchprofil mit diesem Namen existiert bereits.');
  }

  private assertRevision(row: ProfileRow, expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || row.revision !== expectedRevision) {
      throw new Error(
        `Das Suchprofil wurde zwischenzeitlich geändert (erwartet: ${expectedRevision}, aktuell: ${row.revision}).`
      );
    }
  }

  private inTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }
}
