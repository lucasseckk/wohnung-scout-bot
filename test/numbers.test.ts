import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGermanNumber } from '../src/utils/numbers';

test('deutsche und internationale Zahlenformate werden normalisiert', () => {
  assert.equal(parseGermanNumber('1.250,50 €'), 1250.5);
  assert.equal(parseGermanNumber('68,5 m²'), 68.5);
  assert.equal(parseGermanNumber('1.420 €'), 1420);
  assert.equal(parseGermanNumber('1250.50'), 1250.5);
  assert.equal(parseGermanNumber(undefined), undefined);
});
