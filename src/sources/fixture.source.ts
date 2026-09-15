import fs from 'node:fs/promises';
import type { Listing } from '../domain/listing';
import type { ListingSource } from './listing-source';
import { parseImmoScoutAlert } from './immoscout-email-parser';

export class FixtureSource implements ListingSource {
  constructor(private readonly fixturePath: string) {}

  async fetchListings(): Promise<Listing[]> {
    const source = await fs.readFile(this.fixturePath);
    return parseImmoScoutAlert(source, {
      receivedAt: new Date().toISOString(),
      subject: 'Lokale Vorschau',
    });
  }
}
