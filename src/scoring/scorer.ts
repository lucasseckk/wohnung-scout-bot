import type { NumericCriterion, RangeBand, SearchRules } from '../config';
import type { Listing, NumericListingField } from '../domain/listing';

export type MatchLevel = 'perfect' | 'okay' | 'mediocre' | 'outside' | 'missing';
export type OverallTier = 'perfect' | 'okay' | 'mediocre' | 'not_match' | 'rejected';

export type CriterionEvaluation = {
  criterion: string;
  level: MatchLevel;
  factor: number;
  weight: number;
  explanation: string;
};

export type Assessment = {
  score: number;
  tier: OverallTier;
  rejected: boolean;
  evaluations: CriterionEvaluation[];
  hardExclusions: string[];
};

const levelFactors: Record<Exclude<MatchLevel, 'missing'>, number> = {
  perfect: 1,
  okay: 0.7,
  mediocre: 0.4,
  outside: 0,
};

function inBand(value: number, band: RangeBand): boolean {
  return (band.min === undefined || value >= band.min) && (band.max === undefined || value <= band.max);
}

function formatValue(field: NumericListingField, value: number): string {
  if (field === 'warmRent' || field === 'coldRent') {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
  }
  if (field === 'livingSpace') return `${value.toLocaleString('de-DE')} m²`;
  return value.toLocaleString('de-DE');
}

function evaluateNumeric(
  field: NumericListingField,
  criterion: NumericCriterion,
  listing: Listing,
  missingFactor: number
): { evaluation: CriterionEvaluation; hardExclusion?: string } {
  const value = listing[field];
  if (value === undefined) {
    return {
      evaluation: {
        criterion: criterion.label,
        level: 'missing',
        factor: missingFactor,
        weight: criterion.weight,
        explanation: `${criterion.label}: Angabe fehlt`,
      },
      ...(criterion.rejectWhenMissing ? { hardExclusion: `${criterion.label} fehlt` } : {}),
    };
  }

  const level: Exclude<MatchLevel, 'missing'> = inBand(value, criterion.perfect)
    ? 'perfect'
    : inBand(value, criterion.okay)
      ? 'okay'
      : inBand(value, criterion.mediocre)
        ? 'mediocre'
        : 'outside';

  return {
    evaluation: {
      criterion: criterion.label,
      level,
      factor: levelFactors[level],
      weight: criterion.weight,
      explanation: `${criterion.label}: ${formatValue(field, value)} – ${levelLabel(level)}`,
    },
    ...(level === 'outside' && criterion.rejectOutside
      ? { hardExclusion: `${criterion.label} außerhalb des erlaubten Bereichs` }
      : {}),
  };
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de-DE')
    .replace(/ß/g, 'ss');
}

function matchesOne(haystack: string, needles: string[]): boolean {
  const normalizedHaystack = normalized(haystack);
  return needles.some(needle => normalizedHaystack.includes(normalized(needle)));
}

function locationTokens(value: string): string[] {
  return normalized(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function containsTokenSequence(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;

  return haystack.some((_, start) =>
    needle.every((token, offset) => haystack[start + offset] === token)
  );
}

function containsTokenWindowInAnyOrder(haystack: string[], needle: string[]): boolean {
  if (needle.length < 2 || needle.length > haystack.length) return false;
  const expected = [...needle].sort().join('\u0000');

  return haystack.some((_, start) => {
    const window = haystack.slice(start, start + needle.length);
    return window.length === needle.length && window.sort().join('\u0000') === expected;
  });
}

/**
 * Matches human location spellings without relying on punctuation or on whether
 * the provider writes "city, district" or "city-district". Reordered free-text
 * matches must form one compact window of whole words, which keeps names such as
 * "Nordstraße" or "Nordost" from matching the configured district "Nord".
 */
function matchesLocation(listing: Listing, needles: string[]): boolean {
  const locationValues = [listing.address, listing.postalCode, listing.city, listing.district]
    .filter((value): value is string => Boolean(value))
    .map(locationTokens);
  const structuredTokens = new Set(
    [listing.city, listing.district]
      .filter((value): value is string => Boolean(value))
      .flatMap(locationTokens)
  );

  return needles.some(needle => {
    const expectedTokens = locationTokens(needle);
    if (!expectedTokens.length) return false;

    if (
      locationValues.some(
        value =>
          containsTokenSequence(value, expectedTokens) ||
          containsTokenWindowInAnyOrder(value, expectedTokens)
      )
    ) {
      return true;
    }

    return expectedTokens.length > 1 && expectedTokens.every(token => structuredTokens.has(token));
  });
}

function levelLabel(level: MatchLevel): string {
  const labels: Record<MatchLevel, string> = {
    perfect: 'perfekt',
    okay: 'okay',
    mediocre: 'mittelmäßig',
    outside: 'außerhalb',
    missing: 'Angabe fehlt',
  };
  return labels[level];
}

export function tierLabel(tier: OverallTier): string {
  const labels: Record<OverallTier, string> = {
    perfect: 'Perfekt',
    okay: 'Okay',
    mediocre: 'Mittelmäßig',
    not_match: 'Schwacher Treffer',
    rejected: 'Ausgeschlossen',
  };
  return labels[tier];
}

export function scoreListing(listing: Listing, profile: SearchRules): Assessment {
  const evaluations: CriterionEvaluation[] = [];
  const hardExclusions: string[] = [];

  for (const field of Object.keys(profile.numericCriteria) as NumericListingField[]) {
    const criterion = profile.numericCriteria[field];
    if (!criterion) continue;
    const result = evaluateNumeric(field, criterion, listing, profile.scoring.missingValueFactor);
    evaluations.push(result.evaluation);
    if (result.hardExclusion) hardExclusions.push(result.hardExclusion);
  }

  if (profile.locationCriterion) {
    const criterion = profile.locationCriterion;
    const location =
      listing.address ?? [listing.postalCode, listing.city, listing.district].filter(Boolean).join(' ');
    const level: MatchLevel = !location
      ? 'missing'
      : matchesLocation(listing, criterion.perfect)
        ? 'perfect'
        : matchesLocation(listing, criterion.okay)
          ? 'okay'
          : matchesLocation(listing, criterion.mediocre)
            ? 'mediocre'
            : 'outside';
    const factor = level === 'missing' ? profile.scoring.missingValueFactor : levelFactors[level];
    evaluations.push({
      criterion: criterion.label,
      level,
      factor,
      weight: criterion.weight,
      explanation: `${criterion.label}: ${location || 'Angabe fehlt'} – ${levelLabel(level)}`,
    });
    if (level === 'outside' && criterion.rejectOutside) {
      hardExclusions.push(`${criterion.label} außerhalb der gewünschten Gebiete`);
    }
  }

  if (profile.keywordCriterion) {
    const criterion = profile.keywordCriterion;
    const text = [listing.title, listing.description, listing.rawText, ...listing.features]
      .filter(Boolean)
      .join(' ');
    const positiveMatches = criterion.positive.filter(keyword => matchesOne(text, [keyword]));
    const negativeMatches = criterion.negative.filter(keyword => matchesOne(text, [keyword]));
    const exclusionMatches = criterion.hardExclusions.filter(keyword => matchesOne(text, [keyword]));
    hardExclusions.push(...exclusionMatches.map(keyword => `Ausschlusswort „${keyword}“ gefunden`));

    const positiveRatio = criterion.positive.length
      ? positiveMatches.length / criterion.positive.length
      : 1;
    const factor = Math.max(0, Math.min(1, positiveRatio - negativeMatches.length * 0.2));
    const level: MatchLevel = factor >= 0.75 ? 'perfect' : factor >= 0.45 ? 'okay' : factor > 0 ? 'mediocre' : 'outside';
    const details = [
      positiveMatches.length ? `positiv: ${positiveMatches.join(', ')}` : '',
      negativeMatches.length ? `negativ: ${negativeMatches.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    evaluations.push({
      criterion: criterion.label,
      level,
      factor,
      weight: criterion.weight,
      explanation: `${criterion.label}: ${levelLabel(level)}${details ? ` (${details})` : ''}`,
    });
  }

  const totalWeight = evaluations.reduce((sum, evaluation) => sum + evaluation.weight, 0);
  const weightedScore = evaluations.reduce(
    (sum, evaluation) => sum + evaluation.weight * evaluation.factor,
    0
  );
  const score = totalWeight ? Math.round((weightedScore / totalWeight) * 100) : 0;
  const rejected = hardExclusions.length > 0;
  const tier: OverallTier = rejected
    ? 'rejected'
    : score >= profile.scoring.perfectAt
      ? 'perfect'
      : score >= profile.scoring.okayAt
        ? 'okay'
        : score >= profile.scoring.mediocreAt
          ? 'mediocre'
          : 'not_match';

  return { score, tier, rejected, evaluations, hardExclusions };
}

const tierRank: Record<OverallTier, number> = {
  perfect: 4,
  okay: 3,
  mediocre: 2,
  not_match: 1,
  rejected: 0,
};

export function isAtLeastTier(tier: OverallTier, minimum: OverallTier): boolean {
  return tierRank[tier] >= tierRank[minimum];
}
