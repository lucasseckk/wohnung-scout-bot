import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  loadProfile,
  searchRulesFromProfile,
  type SearchProfile,
  type SearchRules,
} from '../src/config';
import { SearchProfileStore } from '../src/storage/search-profile-store';

const exampleProfile = loadProfile(path.resolve('config/profile.example.json'));

function privateProfile(): SearchProfile {
  return {
    ...exampleProfile,
    profileName: '  Musterstadt   Standard  ',
    application: {
      ...exampleProfile.application,
      template: 'PRIVATES-TEMPLATE-DARF-NICHT-IN-SQLITE-LANDEN',
      applicant: {
        ...exampleProfile.application.applicant,
        email: 'privat@example.test',
        phone: 'PRIVATE-TELEFONNUMMER',
      },
    },
  };
}

function temporaryDatabase(): { directory: string; databasePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wohnung-profile-store-'));
  return { directory, databasePath: path.join(directory, 'test.sqlite') };
}

test('importiert das JSON-Profil genau einmal, ohne private Bewerberdaten zu speichern', () => {
  const { directory, databasePath } = temporaryDatabase();
  let store: SearchProfileStore | undefined;
  try {
    store = new SearchProfileStore(databasePath);
    const first = store.ensureImported(privateProfile());
    assert.equal(first.imported, true);
    assert.equal(first.profile.name, 'Musterstadt Standard');
    assert.equal(first.profile.active, true);
    assert.equal(first.profile.revision, 1);
    assert.deepEqual(first.profile.rules, searchRulesFromProfile(exampleProfile));
    const originalId = first.profile.id;
    store.close();
    store = undefined;

    const rawDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const row = rawDatabase.prepare('SELECT rules_json FROM search_profiles').get() as {
      rules_json: string;
    };
    rawDatabase.close();
    assert.doesNotMatch(row.rules_json, /application|privat@example\.test|PRIVATE|TEMPLATE/);

    store = new SearchProfileStore(databasePath);
    const changedFile = { ...privateProfile(), profileName: 'Soll nicht erneut importiert werden' };
    const second = store.ensureImported(changedFile);
    assert.equal(second.imported, false);
    assert.equal(second.profile.id, originalId);
    assert.equal(second.profile.name, 'Musterstadt Standard');
    assert.equal(store.listProfiles().length, 1);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('dupliziert Profile, normalisiert eindeutige Namen und begrenzt die Anzahl auf 25', () => {
  const { directory, databasePath } = temporaryDatabase();
  const store = new SearchProfileStore(databasePath);
  try {
    const imported = store.ensureImported(privateProfile()).profile;
    const duplicate = store.duplicateProfile(imported.id, '  Große   Wohnung ');
    assert.equal(duplicate.name, 'Große Wohnung');
    assert.equal(duplicate.active, false);
    assert.equal(duplicate.revision, 1);
    assert.deepEqual(duplicate.rules, imported.rules);
    assert.throws(
      () => store.duplicateProfile(imported.id, 'große wohnung'),
      /existiert bereits/
    );
    assert.throws(
      () => store.duplicateProfile('nicht-vorhanden', 'Unbekannt'),
      /nicht gefunden/
    );

    for (let index = 3; index <= 25; index += 1) {
      store.duplicateProfile(imported.id, `Profil ${index}`);
    }
    assert.equal(store.listProfiles().length, 25);
    assert.throws(
      () => store.duplicateProfile(imported.id, 'Profil 26'),
      /höchstens 25/
    );
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('persistiert Aktivierung und aktualisiert deren Zeitpunkt nur bei relevanten Änderungen', () => {
  const { directory, databasePath } = temporaryDatabase();
  let store: SearchProfileStore | undefined;
  try {
    store = new SearchProfileStore(databasePath);
    const original = store.ensureImported(privateProfile()).profile;
    const originalActivation = original.activatedAt;

    const renamed = store.renameProfile(original.id, 'Musterstadt Hauptsuche', original.revision);
    assert.equal(renamed.revision, 2);
    assert.equal(renamed.activatedAt, originalActivation);

    const changedRules: SearchRules = {
      ...renamed.rules,
      notifications: { ...renamed.rules.notifications, postRejected: true },
    };
    const changed = store.updateRules(original.id, changedRules, renamed.revision);
    assert.equal(changed.revision, 3);
    assert.ok(changed.activatedAt);
    assert.ok(Date.parse(changed.activatedAt) > Date.parse(originalActivation));
    assert.throws(
      () => store?.updateRules(original.id, renamed.rules, renamed.revision),
      /zwischenzeitlich geändert/
    );

    const duplicate = store.duplicateProfile(original.id, 'Alternative');
    const activated = store.activateProfile(duplicate.id);
    assert.equal(activated.id, duplicate.id);
    assert.equal(activated.active, true);
    assert.equal(store.getProfile(original.id)?.active, false);
    const alternateActivation = activated.activatedAt;
    assert.equal(store.activateProfile(duplicate.id).activatedAt, alternateActivation);

    const inactiveChanged = store.updateRules(
      original.id,
      { ...changed.rules, notifications: { ...changed.rules.notifications, postRejected: false } },
      changed.revision
    );
    assert.equal(inactiveChanged.active, false);
    assert.equal(store.getActiveProfile().activatedAt, alternateActivation);

    store.close();
    store = undefined;
    store = new SearchProfileStore(databasePath);
    assert.equal(store.getActiveProfile().id, duplicate.id);
    assert.equal(store.getActiveProfile().activatedAt, alternateActivation);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('verbietet ungültige Regeln, veraltete Revisionen und das Löschen des aktiven Profils', () => {
  const { directory, databasePath } = temporaryDatabase();
  const store = new SearchProfileStore(databasePath);
  try {
    const active = store.ensureImported(privateProfile()).profile;
    const inactive = store.duplicateProfile(active.id, 'Zum Löschen');

    const invalidRules = {
      ...active.rules,
      scoring: { ...active.rules.scoring, perfectAt: 40, okayAt: 60 },
    } as SearchRules;
    assert.throws(() => store.updateRules(active.id, invalidRules, active.revision));

    const invalidBands = structuredClone(active.rules);
    const warmRent = invalidBands.numericCriteria.warmRent;
    assert.ok(warmRent);
    warmRent.perfect.max = 2000;
    warmRent.okay.max = 1800;
    assert.throws(() => store.updateRules(active.id, invalidBands, active.revision));

    const overlappingLocations = structuredClone(active.rules);
    assert.ok(overlappingLocations.locationCriterion);
    overlappingLocations.locationCriterion.perfect = ['Musterstadt-Mitte'];
    overlappingLocations.locationCriterion.okay = ['musterstadt-mitte'];
    assert.throws(() => store.updateRules(active.id, overlappingLocations, active.revision));

    const unsafeRules = {
      ...active.rules,
      application: privateProfile().application,
    } as unknown as SearchRules;
    assert.throws(() => store.updateRules(active.id, unsafeRules, active.revision));
    assert.equal(store.getProfile(active.id)?.revision, active.revision);

    assert.throws(() => store.deleteProfile(active.id), /aktive Suchprofil kann nicht gelöscht/);
    assert.equal(store.deleteProfile(inactive.id), true);
    assert.equal(store.deleteProfile(inactive.id), false);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('meldet beschädigte gespeicherte Regeln ausdrücklich statt sie still zu verwenden', () => {
  const { directory, databasePath } = temporaryDatabase();
  let store: SearchProfileStore | undefined;
  try {
    store = new SearchProfileStore(databasePath);
    const id = store.ensureImported(privateProfile()).profile.id;
    store.close();
    store = undefined;

    const rawDatabase = new DatabaseSync(databasePath);
    rawDatabase
      .prepare('UPDATE search_profiles SET rules_json = ? WHERE id = ?')
      .run(JSON.stringify({ application: privateProfile().application }), id);
    rawDatabase.close();

    store = new SearchProfileStore(databasePath);
    assert.throws(() => store?.getActiveProfile(), /gespeicherten Regeln.*ungültig/);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
