export const numericListingFields = [
  'warmRent',
  'coldRent',
  'livingSpace',
  'rooms',
] as const;

export type NumericListingField = (typeof numericListingFields)[number];

export type Listing = {
  source: 'immoscout-email' | 'fixture' | string;
  sourceId: string;
  url: string;
  title: string;
  description?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  district?: string;
  warmRent?: number;
  coldRent?: number;
  additionalCosts?: number;
  heatingCosts?: number;
  deposit?: number;
  livingSpace?: number;
  rooms?: number;
  floor?: string;
  availableFrom?: string;
  publishedAt?: string;
  discoveredAt: string;
  imageUrl?: string;
  features: string[];
  rawText?: string;
};

export function listingKey(listing: Pick<Listing, 'source' | 'sourceId'>): string {
  return `${listing.source}:${listing.sourceId}`;
}
