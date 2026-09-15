import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  applicationProfileForDiscordUser,
  renderApplicationMessage,
} from '../src/application/message-template';
import { loadProfile } from '../src/config';
import type { Listing } from '../src/domain/listing';

test('Anschreiben ersetzt Variablen, verwendet das richtige Nutzerprofil und enthält keinen Link', () => {
  const profile = loadProfile(path.resolve('config/profile.example.json'));
  const listing: Listing = {
    source: 'fixture',
    sourceId: '42',
    url: 'https://example.test/42',
    title: 'Testwohnung',
    discoveredAt: '2026-07-20T08:00:00.000Z',
    features: [],
  };
  const primary = applicationProfileForDiscordUser(profile, 'user-a', ['user-a', 'user-b']);
  const roommate = applicationProfileForDiscordUser(profile, 'user-b', ['user-a', 'user-b']);
  assert.ok(primary);
  assert.ok(roommate);
  const message = renderApplicationMessage(listing, primary);
  const roommateMessage = renderApplicationMessage(listing, roommate);
  assert.match(message, /Testwohnung/);
  assert.doesNotMatch(message, /https:\/\/example\.test\/42/);
  assert.match(message, /DEIN NAME/);
  assert.match(roommateMessage, /NAME DES MITBEWOHNERS/);
  assert.notEqual(message, roommateMessage);
  assert.doesNotMatch(message, /{{[a-zA-Z]+}}/);
  assert.equal(applicationProfileForDiscordUser(profile, 'user-c', ['user-a', 'user-b']), undefined);
});
