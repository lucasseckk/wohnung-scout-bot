import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadProfile, parseSearchRules, type SearchRules } from '../src/config';
import {
  applyHomeInputs,
  applyKeywordInputs,
  applyLocationInputs,
  applyRentInputs,
  formatListInput,
  formatMaximumTriple,
  formatMinimumTriple,
  parseListInput,
} from '../src/discord/search-config-editor';

function exampleRules(): SearchRules {
  const profile = loadProfile(path.resolve('config/profile.example.json'));
  return parseSearchRules({
    numericCriteria: profile.numericCriteria,
    locationCriterion: profile.locationCriterion,
    keywordCriterion: profile.keywordCriterion,
    scoring: profile.scoring,
    notifications: profile.notifications,
  });
}

test('Mietgrenzen werden aus Discord-Eingaben übernommen und formatiert', () => {
  const original = exampleRules();
  const result = applyRentInputs(original, '900 | 1.100 | 1.300', '700; 900; 1100');

  assert.deepEqual(
    [
      result.numericCriteria.warmRent?.perfect.max,
      result.numericCriteria.warmRent?.okay.max,
      result.numericCriteria.warmRent?.mediocre.max,
    ],
    [900, 1100, 1300]
  );
  assert.deepEqual(
    [
      result.numericCriteria.coldRent?.perfect.max,
      result.numericCriteria.coldRent?.okay.max,
      result.numericCriteria.coldRent?.mediocre.max,
    ],
    [700, 900, 1100]
  );
  assert.equal(formatMaximumTriple(result, 'warmRent'), '900 | 1100 | 1300');
  assert.equal(formatMaximumTriple(result, 'coldRent'), '700 | 900 | 1100');
});

test('Wohnfläche und Zimmer akzeptieren Zeilen sowie deutsche Dezimalzahlen', () => {
  const result = applyHomeInputs(exampleRules(), '70\n60\n50', '3,5 | 3 | 2');

  assert.deepEqual(
    [
      result.numericCriteria.livingSpace?.perfect.min,
      result.numericCriteria.livingSpace?.okay.min,
      result.numericCriteria.livingSpace?.mediocre.min,
    ],
    [70, 60, 50]
  );
  assert.deepEqual(
    [
      result.numericCriteria.rooms?.perfect.min,
      result.numericCriteria.rooms?.okay.min,
      result.numericCriteria.rooms?.mediocre.min,
    ],
    [3.5, 3, 2]
  );
  assert.equal(formatMinimumTriple(result, 'rooms'), '3,5 | 3 | 2');
});

test('unlogische Reihenfolgen werden mit deutschen Hinweisen abgelehnt', () => {
  assert.throws(
    () => applyRentInputs(exampleRules(), '1100 | 900 | 1300', '700 | 900 | 1100'),
    /Warmmiete muss aufsteigend sein/
  );
  assert.throws(
    () => applyHomeInputs(exampleRules(), '60 | 70 | 50', '3,5 | 3 | 2'),
    /Wohnfläche muss absteigend sein/
  );
  assert.throws(
    () => applyHomeInputs(exampleRules(), '70 | 60', '3,5 | 3 | 2'),
    /genau drei Werte/
  );
});

test('Listen werden getrimmt, leere Werte entfernt und ohne Beachtung der Großschreibung dedupliziert', () => {
  assert.deepEqual(
    parseListInput(' Musterstadt-Nord, musterstadt-nord; Musterstadt West\n\nMusterstadt-Mitte '),
    ['Musterstadt-Nord', 'Musterstadt West', 'Musterstadt-Mitte']
  );
  assert.equal(formatListInput([' Balkon ', 'balkon', 'Aufzug']), 'Balkon\nAufzug');
});

test('Gebiete und Merkmale werden als unabhängige neue Regeln gespeichert', () => {
  const original = exampleRules();
  const snapshot = structuredClone(original);
  const withLocations = applyLocationInputs(
    original,
    'Musterstadt-Nord, Musterstadt-West, Musterstadt-Mitte',
    'Parkviertel; Altstadt',
    'Südstadt\nMusterstadt-Ost'
  );
  const result = applyKeywordInputs(
    withLocations,
    'Balkon, Keller; Fahrradraum',
    'Negativmerkmal',
    'Ausschlusswort A\nAusschlusswort B'
  );

  assert.deepEqual(result.locationCriterion?.perfect, [
    'Musterstadt-Nord',
    'Musterstadt-West',
    'Musterstadt-Mitte',
  ]);
  assert.deepEqual(result.locationCriterion?.okay, ['Parkviertel', 'Altstadt']);
  assert.deepEqual(result.locationCriterion?.mediocre, ['Südstadt', 'Musterstadt-Ost']);
  assert.deepEqual(result.keywordCriterion?.positive, ['Balkon', 'Keller', 'Fahrradraum']);
  assert.deepEqual(result.keywordCriterion?.negative, ['Negativmerkmal']);
  assert.deepEqual(result.keywordCriterion?.hardExclusions, [
    'Ausschlusswort A',
    'Ausschlusswort B',
  ]);
  assert.deepEqual(original, snapshot, 'Eingabeobjekt darf nicht mutiert werden');
});

test('derselbe Wert in widersprüchlichen Listen wird nicht stillschweigend akzeptiert', () => {
  assert.throws(
    () => applyLocationInputs(exampleRules(), 'Musterstadt-Ost', '', 'musterstadt-ost'),
    /steht gleichzeitig/
  );
  assert.throws(
    () => applyKeywordInputs(exampleRules(), 'Merkmal X', 'merkmal x', ''),
    /steht gleichzeitig/
  );
});
