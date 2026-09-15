import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseImmoScoutAlert } from '../src/sources/immoscout-email-parser';

test('ImmoScout-Suchauftrag liefert normalisierte Wohnungen', async () => {
  const email = await fs.readFile(path.resolve('test/fixtures/immoscout-alert.eml'));
  const listings = await parseImmoScoutAlert(email, {
    receivedAt: '2026-07-20T08:15:00.000Z',
    subject: 'Neue Wohnungen',
  });

  assert.equal(listings.length, 2);
  const first = listings.find(listing => listing.sourceId === '170000001');
  assert.ok(first);
  assert.equal(first.url, 'https://www.immobilienscout24.de/expose/170000001');
  assert.equal(first.warmRent, 1050);
  assert.equal(first.coldRent, 820);
  assert.equal(first.livingSpace, 68.5);
  assert.equal(first.rooms, 3);
  assert.equal(first.floor, '3. OG');
  assert.equal(first.availableFrom, '01.09.2026');
  assert.equal(first.postalCode, '10997');
  assert.match(first.city ?? '', /Berlin Kreuzberg/);
  assert.deepEqual(first.features.sort(), ['Aufzug', 'Balkon', 'Einbauküche'].sort());
  assert.equal(first.imageUrl, 'https://images.example.test/wohnung-1.jpg');

  const second = listings.find(listing => listing.sourceId === '170000002');
  assert.ok(second);
  assert.equal(second.title, 'Ruhige Wohnung am Stadtrand');
  assert.equal(second.warmRent, 1420);
  assert.equal(second.livingSpace, 50);
});

test('erstes echtes Wohnungsbild gewinnt gegen Logo, Tracker und Platzhalter', async () => {
  const email = `From: suchauftrag@immobilienscout24.de
Subject: Neue Wohnung
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<article>
  <img src="https://assets.example.test/logo.png" alt="ImmoScout Logo">
  <img src="https://assets.example.test/open.gif" alt="">
  <img src="https://assets.example.test/unknown.gif" style="width: 1px; height: 1px; opacity: 0" alt="">
  <h2><a href="https://www.immobilienscout24.de/expose/170000003">Wohnung mit Foto</a></h2>
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="
       data-src="//pictures.immobilienscout24.de/listings/170000003-first.jpg"
       alt="Wohnzimmer">
  <img src="https://pictures.immobilienscout24.de/listings/170000003-second.jpg" alt="Küche">
  <p>Ort: 12345 Musterstadt-West · Warmmiete: 1.250 € · Kaltmiete: 950 € · Wohnfläche: 72 m² · Zimmer: 3</p>
</article>`;

  const listings = await parseImmoScoutAlert(email, {
    receivedAt: '2026-07-20T09:00:00.000Z',
    subject: 'Neue Wohnung',
  });

  assert.equal(listings.length, 1);
  assert.equal(
    listings[0]?.imageUrl,
    'https://pictures.immobilienscout24.de/listings/170000003-first.jpg'
  );
});

test('picture-srcset nutzt das größte Bild und löst relative Links am Portal-Ursprung auf', async () => {
  const email = `From: suchauftrag@immobilienscout24.de
Subject: Neue Wohnung mit Picture
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<article>
  <h2><a href="https://www.immobilienscout24.de/expose/170000004">Wohnung mit Picture</a></h2>
  <picture>
    <source srcset="images/high.jpg 2x, images/low.jpg 1x">
    <img src="/images/fallback.jpg" alt="Wohnzimmer">
  </picture>
  <p>Ort: 12345 Musterstadt-West · Warmmiete: 1.250 € · Kaltmiete: 950 € · Wohnfläche: 72 m² · Zimmer: 3</p>
</article>`;

  const listings = await parseImmoScoutAlert(email, {
    receivedAt: '2026-07-20T09:30:00.000Z',
    subject: 'Neue Wohnung mit Picture',
  });

  assert.equal(
    listings[0]?.imageUrl,
    'https://www.immobilienscout24.de/images/high.jpg'
  );
});

test('aktuelles ImmoScout-Mailformat mit is24-Link und unbeschrifteten Kartendaten', async () => {
  const email = `From: ImmoScout24 <myscout@immobilienscout24.de>
Subject: 1 Angebot: Mietwohnung in Musterstadt
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<div class="listing-card">
  <div class="listing-image">
    <a href="https://push.search.is24.de/email/expose/900000101?utm_source=email">
      <img src="https://pictures.immobilienscout24.de/listings/900000101.jpg" alt="Wohnzimmer">
    </a>
  </div>
  <div class="listing-details">
    <a href="https://push.search.is24.de/email/expose/900000101?utm_source=email">
      Synthetische 3-Zimmer-Testwohnung in Musterstadt-Ost
    </a>
    <div>1.234 € 77 m² 3 Zi. Musterstadt-Ost, Musterstadt</div>
  </div>
</div>`;

  const listings = await parseImmoScoutAlert(email, {
    receivedAt: '2026-07-21T06:30:00.000Z',
    subject: '1 Angebot: Mietwohnung in Musterstadt',
  });

  assert.equal(listings.length, 1);
  const listing = listings[0];
  assert.ok(listing);
  assert.equal(listing.sourceId, '900000101');
  assert.equal(listing.url, 'https://www.immobilienscout24.de/expose/900000101');
  assert.equal(listing.title, 'Synthetische 3-Zimmer-Testwohnung in Musterstadt-Ost');
  assert.equal(listing.warmRent, undefined);
  assert.equal(listing.coldRent, 1234);
  assert.equal(listing.livingSpace, 77);
  assert.equal(listing.rooms, 3);
  assert.equal(listing.address, 'Musterstadt-Ost, Musterstadt');
  assert.equal(listing.district, 'Musterstadt-Ost');
  assert.equal(listing.city, 'Musterstadt');
  assert.equal(
    listing.imageUrl,
    'https://pictures.immobilienscout24.de/listings/900000101.jpg'
  );
});

test('trennt Postleitzahl, umgekehrten Stadtteil und Stadt korrekt', async () => {
  const email = `From: ImmoScout24 <myscout@immobilienscout24.de>
Subject: Wohnung in Musterstadt
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<div>
  <a href="https://push.search.is24.de/email/expose/900000102">Testwohnung in Musterstadt-Mitte</a>
  <p>1.100 € 75 m² 3 Zi. 12345 Mitte, Musterstadt</p>
</div>`;

  const listings = await parseImmoScoutAlert(email, {
    receivedAt: '2026-07-21T19:05:28.000Z',
    subject: 'Wohnung in Musterstadt',
  });

  assert.equal(listings[0]?.address, '12345 Mitte, Musterstadt');
  assert.equal(listings[0]?.postalCode, '12345');
  assert.equal(listings[0]?.district, 'Mitte');
  assert.equal(listings[0]?.city, 'Musterstadt');
});

test('ähnlich aussehende Exposé-Links fremder Hosts werden nicht akzeptiert', async () => {
  const email = `From: test@example.test
Subject: Fremder Link
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<a href="https://push.search.is24.de.evil.example/email/expose/900000103">
  Kein ImmoScout-Inserat
</a>
<a href="https://evil.example/redirect?next=https%3A%2F%2Fpush.search.is24.de%2Femail%2Fexpose%2F900000104">
  Fremder Redirect
</a>
<a href="ftp://push.search.is24.de/email/expose/900000105">Falsches Protokoll</a>
<a href="https://push.search.is24.de/email/expose/900000106/evil">Falscher Pfad</a>
<a href="https://user@push.search.is24.de/email/expose/900000107">Credentials</a>
<a href="https://push.search.is24.de:444/email/expose/900000108">Sonderport</a>`;

  const listings = await parseImmoScoutAlert(email, {
    receivedAt: '2026-07-21T06:30:00.000Z',
    subject: 'Fremder Link',
  });

  assert.deepEqual(listings, []);
});

test('kompakte Kartendaten verwechseln weder Jahr noch Warmmiete mit der Kaltmiete', async () => {
  const currentCard = `From: ImmoScout24 <myscout@immobilienscout24.de>
Subject: Angebot
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<div>
  <a href="https://push.search.is24.de/email/expose/900000109">Titel</a>
  <p>Neubau 2030 1.234 € 77 m² 3 Zi. Musterstadt-Ost, Musterstadt</p>
</div>`;
  const warmOnlyCard = `From: ImmoScout24 <myscout@immobilienscout24.de>
Subject: Angebot
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<div>
  <a href="https://www.immobilienscout24.de/expose/900000110">Wohnung</a>
  <p>Warmmiete: 1.456 € · Wohnfläche: 77 m² · Zimmer: 3 · Ort: Musterstadt-Ost, Musterstadt</p>
</div>`;

  const current = await parseImmoScoutAlert(currentCard, {
    receivedAt: '2026-07-21T06:30:00.000Z',
    subject: 'Angebot',
  });
  const warmOnly = await parseImmoScoutAlert(warmOnlyCard, {
    receivedAt: '2026-07-21T06:30:00.000Z',
    subject: 'Angebot',
  });

  assert.equal(current[0]?.title, 'Titel');
  assert.equal(current[0]?.coldRent, 1234);
  assert.equal(current[0]?.rooms, 3);
  assert.equal(warmOnly[0]?.warmRent, 1456);
  assert.equal(warmOnly[0]?.coldRent, undefined);
});

test('ein Link um die komplette Karte liefert nur den Titel und kompakte Fakten', async () => {
  const email = `From: ImmoScout24 <myscout@immobilienscout24.de>
Subject: Angebot
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<a href="https://push.search.is24.de/email/expose/900000111">
  Synthetisches Loft Neubau 2030 1.234 € 77 m² 3 Zi Musterstadt-Ost, Musterstadt
</a>`;

  const listings = await parseImmoScoutAlert(email, {
    receivedAt: '2026-07-21T06:30:00.000Z',
    subject: 'Angebot',
  });

  assert.equal(listings[0]?.title, 'Synthetisches Loft Neubau 2030');
  assert.equal(listings[0]?.coldRent, 1234);
  assert.equal(listings[0]?.livingSpace, 77);
  assert.equal(listings[0]?.rooms, 3);
  assert.equal(listings[0]?.address, 'Musterstadt-Ost, Musterstadt');
});

test('aneinanderliegende HTML-Elemente verkleben weder Jahreszahl noch Mietlabel', async () => {
  const compactEmail = `From: ImmoScout24 <myscout@immobilienscout24.de>
Subject: Angebot
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<div><a href="https://push.search.is24.de/email/expose/900000112">Neubau 2030</a><div>1.234 € 77 m² 3 Zi. Musterstadt-Ost, Musterstadt</div></div>`;
  const warmEmail = `From: ImmoScout24 <myscout@immobilienscout24.de>
Subject: Angebot
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<div><a href="https://push.search.is24.de/email/expose/900000113">Wohnung</a><span>Warmmiete</span><span>1.456 €</span><span>Wohnfläche</span><span>77 m²</span><span>Zimmer</span><span>3</span></div>`;

  const compact = await parseImmoScoutAlert(compactEmail, {
    receivedAt: '2026-07-21T06:30:00.000Z',
    subject: 'Angebot',
  });
  const warm = await parseImmoScoutAlert(warmEmail, {
    receivedAt: '2026-07-21T06:30:00.000Z',
    subject: 'Angebot',
  });

  assert.equal(compact[0]?.coldRent, 1234);
  assert.equal(compact[0]?.livingSpace, 77);
  assert.equal(compact[0]?.rooms, 3);
  assert.equal(warm[0]?.warmRent, 1456);
  assert.equal(warm[0]?.coldRent, undefined);
});
