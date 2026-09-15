import type { Listing } from '../domain/listing';

export interface ListingSource {
  fetchListings(): Promise<Listing[]>;
}
