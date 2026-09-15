import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadProfile } from '../src/config';
import type { Listing } from '../src/domain/listing';
import { scoreListing } from '../src/scoring/scorer';

const profile = loadProfile(path.resolve('config/profile.example.json'));

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: 'fixture',
    sourceId: '1',
    url: 'https://example.test/1',
    title: 'Wohnung mit Balkon, Einbauküche und Aufzug',
    address: '10997 Berlin Kreuzberg',
    warmRent: 1000,
    coldRent: 800,
    livingSpace: 70,
    rooms: 3,
    discoveredAt: '2026-07-20T08:00:00.000Z',
    features: ['Balkon', 'Einbauküche', 'Aufzug'],
    ...overrides,
  };
}

test('perfekter Treffer erhält eine hohe, erklärbare Bewertung', () => {
  const assessment = scoreListing(listing(), profile);
  assert.equal(assessment.tier, 'perfect');
  assert.equal(assessment.score, 100);
  assert.equal(assessment.rejected, false);
  assert.ok(assessment.evaluations.some(item => item.criterion === 'Warmmiete'));
});

test('hartes Preislimit schließt Treffer aus', () => {
  const assessment = scoreListing(listing({ warmRent: 1700 }), profile);
  assert.equal(assessment.tier, 'rejected');
  assert.equal(assessment.rejected, true);
  assert.match(assessment.hardExclusions.join(' '), /Warmmiete/);
});

test('fehlende optionale Angaben werden sichtbar abgewertet, aber nicht verworfen', () => {
  const assessment = scoreListing(
    listing({ warmRent: undefined, coldRent: undefined, rooms: undefined }),
    profile
  );
  assert.notEqual(assessment.tier, 'rejected');
  assert.ok(assessment.evaluations.some(item => item.level === 'missing'));
});

test('Ausschlusswörter greifen unabhängig vom Zahlenscore', () => {
  const assessment = scoreListing(listing({ description: 'Nur mit WBS erforderlich' }), profile);
  assert.equal(assessment.tier, 'rejected');
});

test('erkennt Stadt und Stadtteil unabhängig von Reihenfolge und Trennzeichen', () => {
  const musterstadtProfile = structuredClone(profile);
  musterstadtProfile.locationCriterion = {
    label: 'Lage',
    weight: 15,
    rejectOutside: true,
    perfect: ['Musterstadt-Mitte'],
    okay: ['Musterstadt-West'],
    mediocre: ['Musterstadt-Ost'],
  };

  const assessment = scoreListing(
    listing({
      address: 'Mitte, Musterstadt',
      city: 'Musterstadt',
      district: 'Mitte',
    }),
    musterstadtProfile
  );

  assert.equal(
    assessment.evaluations.find(item => item.criterion === 'Lage')?.level,
    'perfect'
  );
  assert.equal(assessment.rejected, false);
});

test('erkennt die umgekehrte Ortsreihenfolge auch ohne vorab getrennte Felder', () => {
  const musterstadtProfile = structuredClone(profile);
  musterstadtProfile.locationCriterion = {
    label: 'Lage',
    weight: 15,
    rejectOutside: true,
    perfect: ['Musterstadt-Mitte'],
    okay: [],
    mediocre: [],
  };

  const assessment = scoreListing(
    listing({
      address: '12345 Mitte, Musterstadt',
      city: undefined,
      district: undefined,
    }),
    musterstadtProfile
  );

  assert.equal(
    assessment.evaluations.find(item => item.criterion === 'Lage')?.level,
    'perfect'
  );
  assert.equal(assessment.rejected, false);
});

test('erkennt Stadtteile auch bei einer zusätzlichen Straße im Ortsfeld', () => {
  const musterstadtProfile = structuredClone(profile);
  musterstadtProfile.locationCriterion = {
    label: 'Lage',
    weight: 15,
    rejectOutside: true,
    perfect: ['Musterstadt-Mitte'],
    okay: [],
    mediocre: [],
  };

  const assessment = scoreListing(
    listing({
      address: 'Beispielstraße 10, Mitte, Musterstadt',
      city: 'Musterstadt',
      district: 'Beispielstraße 10, Mitte',
    }),
    musterstadtProfile
  );

  assert.equal(
    assessment.evaluations.find(item => item.criterion === 'Lage')?.level,
    'perfect'
  );
  assert.equal(assessment.rejected, false);
});

test('verwechselt einen Stadtteil nicht mit einem Teil eines Straßennamens', () => {
  const musterstadtProfile = structuredClone(profile);
  musterstadtProfile.locationCriterion = {
    label: 'Lage',
    weight: 15,
    rejectOutside: true,
    perfect: ['Musterstadt-Nord'],
    okay: [],
    mediocre: [],
  };

  const assessment = scoreListing(
    listing({
      address: 'Nordstraße 12, Musterstadt',
      city: 'Musterstadt',
      district: 'Nordstraße 12',
    }),
    musterstadtProfile
  );

  assert.equal(
    assessment.evaluations.find(item => item.criterion === 'Lage')?.level,
    'outside'
  );
  assert.equal(assessment.rejected, true);
});

test('verwechselt benachbarte Ortsnamen ohne strukturierte Felder nicht', () => {
  const musterstadtProfile = structuredClone(profile);
  musterstadtProfile.locationCriterion = {
    label: 'Lage',
    weight: 15,
    rejectOutside: true,
    perfect: ['Musterstadt-Nord'],
    okay: [],
    mediocre: [],
  };

  for (const address of [
    'Musterstadt-Nordost, Musterstadt',
    'Nordbahnhof, Musterstadt',
    'Nordstraße 12, Musterstadt',
    'Mitte, Beispielmetropole',
  ]) {
    const assessment = scoreListing(
      listing({ address, city: undefined, district: undefined }),
      musterstadtProfile
    );
    assert.equal(
      assessment.evaluations.find(item => item.criterion === 'Lage')?.level,
      'outside',
      address
    );
    assert.equal(assessment.rejected, true, address);
  }
});
