import { load } from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { simpleParser } from 'mailparser';
import type { Listing } from '../domain/listing';
import { parseGermanNumber } from '../utils/numbers';
import { normalizeRemoteImageUrl } from '../utils/remote-image-url';

export type EmailMetadata = {
  receivedAt: string;
  subject?: string;
};

const decorativeImagePattern =
  /(?:^|[\W_])(logo|icon|sprite|spacer|pixel|tracker|tracking|beacon|analytics|badge|avatar|social|facebook|instagram|linkedin)(?:[\W_]|$)/i;
const trackingFilePattern =
  /(?:^|\/)(?:open|transparent|clear|blank|1x1)(?:[._-][^/]*)?\.(?:gif|png)$/i;

type CheerioSelection = ReturnType<CheerioAPI>;

function normalizedSelectionText(
  $: CheerioAPI,
  selection: CheerioSelection
): string {
  const clone = selection.clone();
  clone.find('*').each((_index, element) => {
    $(element).before(' ').after(' ');
  });
  return clone.text().replace(/\s+/g, ' ').trim();
}

function srcsetCandidates(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .flatMap((part, index) => {
      const [url, descriptor = ''] = part.trim().split(/\s+/);
      if (!url) return [];
      const descriptorMatch = descriptor.match(/^([0-9]+(?:\.[0-9]+)?)(?:w|x)$/i);
      return [{ url, score: Number(descriptorMatch?.[1] ?? 0), index }];
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(candidate => candidate.url);
}

function cssPixelDimension(style: string, property: 'width' | 'height'): number | undefined {
  const raw = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)px`, 'i'))?.[1];
  const value = raw === undefined ? undefined : Number(raw);
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function firstListingImage(
  $: CheerioAPI,
  context: CheerioSelection,
  baseUrl: string
): string | undefined {
  for (const element of context.find('img').toArray()) {
    const image = $(element);
    const width = Number.parseInt(image.attr('width') ?? '', 10);
    const height = Number.parseInt(image.attr('height') ?? '', 10);
    const descriptor = [
      image.attr('alt'),
      image.attr('title'),
      image.attr('class'),
      image.attr('id'),
    ]
      .filter(Boolean)
      .join(' ');
    const style = image.attr('style') ?? '';
    const cssWidth = cssPixelDimension(style, 'width');
    const cssHeight = cssPixelDimension(style, 'height');
    const isTiny =
      (Number.isFinite(width) && width <= 2) ||
      (Number.isFinite(height) && height <= 2) ||
      (cssWidth !== undefined && cssWidth <= 2) ||
      (cssHeight !== undefined && cssHeight <= 2);
    const isHidden =
      image.attr('hidden') !== undefined ||
      image.attr('aria-hidden')?.toLowerCase() === 'true' ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$))/i.test(style);
    if (isTiny || isHidden || decorativeImagePattern.test(descriptor)) continue;

    const picture = image.closest('picture');
    const pictureCandidates = picture.length
      ? picture
          .find('source')
          .toArray()
          .flatMap(source => [
            ...srcsetCandidates($(source).attr('data-srcset')),
            ...srcsetCandidates($(source).attr('srcset')),
          ])
      : [];
    const candidates = [
      image.attr('data-src'),
      image.attr('data-original'),
      image.attr('data-lazy-src'),
      ...pictureCandidates,
      ...srcsetCandidates(image.attr('data-srcset')),
      ...srcsetCandidates(image.attr('srcset')),
      image.attr('src'),
    ];
    for (const candidate of candidates) {
      const normalized = normalizeRemoteImageUrl(candidate, baseUrl);
      if (!normalized) continue;
      const parsed = new URL(normalized);
      const imageLocation = `${parsed.hostname}${parsed.pathname}`;
      if (decorativeImagePattern.test(imageLocation) || trackingFilePattern.test(parsed.pathname)) {
        continue;
      }
      return normalized;
    }
  }
  return undefined;
}

function exposeIdFromUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return undefined;
  }
  const host = parsed.hostname.toLocaleLowerCase('en-US');
  const canonicalMatch =
    (host === 'immobilienscout24.de' || host === 'www.immobilienscout24.de')
      ? parsed.pathname.match(/^\/expose\/(\d+)\/?$/i)
      : undefined;
  const emailMatch =
    host === 'push.search.is24.de'
      ? parsed.pathname.match(/^\/email\/expose\/(\d+)\/?$/i)
      : undefined;
  return canonicalMatch?.[1] ?? emailMatch?.[1];
}

function exposeFromHref(href: string): { id: string; url: string } | undefined {
  let candidate = href.replace(/&amp;/g, '&');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = exposeIdFromUrl(candidate);
    if (id) {
      return {
        id,
        url: `https://www.immobilienscout24.de/expose/${id}`,
      };
    }
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      break;
    }
  }
  return undefined;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labeledNumber(text: string, labels: string[]): number | undefined {
  for (const label of labels) {
    const expression = new RegExp(
      `\\b${escaped(label)}\\b\\s*:?\\s*([0-9][0-9.\\s]*(?:,[0-9]{1,2})?)`,
      'i'
    );
    const match = text.match(expression);
    const parsed = parseGermanNumber(match?.[1]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function firstMatchNumber(text: string, expression: RegExp): number | undefined {
  return parseGermanNumber(text.match(expression)?.[1]);
}

type CompactCardFacts = {
  title?: string;
  coldRent: number;
  livingSpace: number;
  rooms: number;
  address: string;
};

function parseCompactCard(text: string): CompactCardFacts | undefined {
  const match = text.match(
    /^(.*?)([0-9]+(?:\.[0-9]{3})*(?:,[0-9]{1,2})?)\s*(?:€|EUR)\s+([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2)\s+([0-9]+(?:[.,][0-9]+)?)\s*(?:Zi\.?|Zimmer)\s+([^|•·\n]{3,160})$/i
  );
  const coldRent = parseGermanNumber(match?.[2]);
  const livingSpace = parseGermanNumber(match?.[3]);
  const rooms = parseGermanNumber(match?.[4]);
  const address = match?.[5]?.trim();
  if (
    coldRent === undefined ||
    livingSpace === undefined ||
    rooms === undefined ||
    !address
  ) {
    return undefined;
  }
  const title = match?.[1]?.trim();
  return {
    ...(title ? { title } : {}),
    coldRent,
    livingSpace,
    rooms,
    address,
  };
}

function labeledText(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const expression = new RegExp(
      `\\b${escaped(label)}\\b\\s*:?\\s*([^|•·\\n]{1,60})`,
      'i'
    );
    const value = text.match(expression)?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parsePublishedAt(text: string, referenceDate: string): string | undefined {
  const dateMatch = text.match(/(?:veröffentlicht|eingestellt|online)\s*(?:am)?\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i);
  if (dateMatch?.[1] && dateMatch[2] && dateMatch[3]) {
    const date = new Date(
      Date.UTC(Number(dateMatch[3]), Number(dateMatch[2]) - 1, Number(dateMatch[1]))
    );
    return date.toISOString();
  }
  if (/\b(?:heute|gerade eben)\b/i.test(text)) return referenceDate;
  return undefined;
}

function parseLocation(
  text: string,
  fallbackAddress?: string
): Pick<Listing, 'address' | 'postalCode' | 'city' | 'district'> {
  const labeled = text.match(
    /(?:Adresse|Lage|Ort)\s*:?\s*([^|•·\n]{3,100}?)(?=\s+(?:Warmmiete|Kaltmiete|Wohnfläche|Fläche|Zimmer)\b|[|•·\n]|$)/i
  )?.[1]?.trim();
  const genericLocation = text.match(
    /\b(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]+(?:\s+(?!(?:Warmmiete|Kaltmiete|Wohnfläche|Fläche|Zimmer)\b)[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]+){0,2})/
  )?.[0];
  const cardLocation = text.match(
    /\b[0-9]+(?:[.,][0-9]+)?\s*(?:Zimmer\b|Zi\.)\s+([^|•·\n]{3,100})$/i
  )?.[1]?.trim();
  const address = labeled ?? cardLocation ?? genericLocation?.trim() ?? fallbackAddress;
  const postalMatch = address?.match(/\b(\d{5})\b/);
  const postalCode = postalMatch?.[1];
  const locationWithoutPostalCode = address
    ?.replace(/\b\d{5}\b/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const locationParts = locationWithoutPostalCode
    ?.split(',')
    .map(part => part.trim())
    .filter(Boolean);
  const city =
    locationParts && (postalCode || locationParts.length > 1) ? locationParts.at(-1) : undefined;
  const district =
    locationParts && locationParts.length > 1 ? locationParts.slice(0, -1).join(', ') : undefined;
  return {
    ...(address ? { address } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(city ? { city } : {}),
    ...(district ? { district } : {}),
  };
}

function extractFeatures(text: string): string[] {
  const knownFeatures = [
    'Balkon',
    'Terrasse',
    'Garten',
    'Einbauküche',
    'Aufzug',
    'Keller',
    'Stellplatz',
    'Garage',
    'barrierefrei',
    'möbliert',
    'Haustiere erlaubt',
  ];
  const normalizedText = text.toLocaleLowerCase('de-DE');
  return knownFeatures.filter(feature => normalizedText.includes(feature.toLocaleLowerCase('de-DE')));
}

function buildListing(params: {
  id: string;
  url: string;
  title: string;
  text: string;
  discoveredAt: string;
  imageUrl?: string;
}): Listing {
  const compactCard = parseCompactCard(params.text);
  const warmRent = labeledNumber(params.text, ['Warmmiete', 'Gesamtmiete']);
  const labeledColdRent = labeledNumber(params.text, ['Kaltmiete', 'Nettokaltmiete']);
  const coldRent = labeledColdRent ??
    (warmRent === undefined ? compactCard?.coldRent : undefined);
  const additionalCosts = labeledNumber(params.text, ['Nebenkosten']);
  const heatingCosts = labeledNumber(params.text, ['Heizkosten']);
  const deposit = labeledNumber(params.text, ['Kaution']);
  const livingSpace =
    labeledNumber(params.text, ['Wohnfläche', 'Fläche']) ??
    compactCard?.livingSpace ??
    firstMatchNumber(params.text, /([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2)(?=\s|[·,;]|$)/i);
  const rooms =
    labeledNumber(params.text, ['Zimmer']) ??
    compactCard?.rooms ??
    firstMatchNumber(
      params.text,
      /([0-9]+(?:[.,][0-9]+)?)\s*(?:Zimmer\b|Zi\.?(?=\s|[·,;]|$))/i
    );
  const floor = labeledText(params.text, ['Etage', 'Stockwerk']);
  const availableFrom = labeledText(params.text, ['Bezugsfrei ab', 'Verfügbar ab', 'Frei ab']);

  return {
    source: 'immoscout-email',
    sourceId: params.id,
    url: params.url,
    title: params.title || `ImmoScout24-Wohnung ${params.id}`,
    ...parseLocation(params.text, compactCard?.address),
    ...(warmRent !== undefined ? { warmRent } : {}),
    ...(coldRent !== undefined ? { coldRent } : {}),
    ...(additionalCosts !== undefined ? { additionalCosts } : {}),
    ...(heatingCosts !== undefined ? { heatingCosts } : {}),
    ...(deposit !== undefined ? { deposit } : {}),
    ...(livingSpace !== undefined ? { livingSpace } : {}),
    ...(rooms !== undefined ? { rooms } : {}),
    ...(floor ? { floor } : {}),
    ...(availableFrom ? { availableFrom } : {}),
    ...(parsePublishedAt(params.text, params.discoveredAt)
      ? { publishedAt: parsePublishedAt(params.text, params.discoveredAt) }
      : {}),
    discoveredAt: params.discoveredAt,
    ...(params.imageUrl ? { imageUrl: params.imageUrl } : {}),
    features: extractFeatures(params.text),
    rawText: params.text.slice(0, 6000),
  };
}

function isFallbackTitle(title: string, id: string): boolean {
  return title === `ImmoScout24-Wohnung ${id}`;
}

function mergeListingCandidates(existing: Listing, candidate: Listing): Listing {
  const title =
    isFallbackTitle(existing.title, existing.sourceId) &&
    !isFallbackTitle(candidate.title, candidate.sourceId)
      ? candidate.title
      : existing.title;
  const rawText =
    (candidate.rawText?.length ?? 0) > (existing.rawText?.length ?? 0)
      ? candidate.rawText
      : existing.rawText;

  return {
    ...existing,
    ...candidate,
    title,
    features: [...new Set([...existing.features, ...candidate.features])],
    ...(existing.imageUrl || candidate.imageUrl
      ? { imageUrl: candidate.imageUrl ?? existing.imageUrl }
      : {}),
    ...(rawText ? { rawText } : {}),
  };
}

export async function parseImmoScoutAlert(
  source: Buffer | string,
  metadata: EmailMetadata
): Promise<Listing[]> {
  const email = await simpleParser(source);
  const discoveredAt = email.date?.toISOString() ?? metadata.receivedAt;
  const html = typeof email.html === 'string' ? email.html : '';
  const listings = new Map<string, Listing>();

  if (html) {
    const $ = load(html);
    $('a[href]').each((_index, element) => {
      const link = $(element);
      const expose = exposeFromHref(link.attr('href') ?? '');
      if (!expose) return;
      const originBaseUrl = `${new URL(expose.url).origin}/`;
      const imageBaseUrl =
        normalizeRemoteImageUrl($('base[href]').first().attr('href'), originBaseUrl) ?? originBaseUrl;

      let context = link.parent();
      let selectedContext = context;
      let contextText = normalizedSelectionText($, context);
      for (let depth = 0; depth < 7; depth += 1) {
        const candidateText = normalizedSelectionText($, context);
        const hasFacts = /(?:€|EUR|m²|m2|Warmmiete|Kaltmiete)/i.test(candidateText);
        if (hasFacts && candidateText.length <= 2200) {
          selectedContext = context;
          contextText = candidateText;
          break;
        }
        const parent = context.parent();
        if (!parent.length) break;
        context = parent;
      }

      const rawLinkTitle = normalizedSelectionText($, link);
      const linkTitle = parseCompactCard(rawLinkTitle)?.title ?? rawLinkTitle;
      const heading = selectedContext.find('h1, h2, h3, h4').first();
      const rawHeadingTitle = normalizedSelectionText($, heading);
      const headingTitle = parseCompactCard(rawHeadingTitle)?.title ?? rawHeadingTitle;
      const genericLinkText = /^(?:mehr|ansehen|zum exposé|details|jetzt ansehen)$/i.test(linkTitle);
      const title = !genericLinkText && linkTitle.length >= 3 ? linkTitle : headingTitle;
      let imageUrl = firstListingImage($, selectedContext, imageBaseUrl);
      let imageContext = selectedContext;
      for (let depth = 0; !imageUrl && depth < 3; depth += 1) {
        const parent = imageContext.parent();
        if (!parent.length) break;
        const containsDifferentListing = parent
          .find('a[href]')
          .toArray()
          .some(anchor => {
            const candidate = exposeFromHref($(anchor).attr('href') ?? '');
            return candidate !== undefined && candidate.id !== expose.id;
          });
        if (containsDifferentListing) break;
        imageUrl = firstListingImage($, parent, imageBaseUrl);
        imageContext = parent;
      }

      const candidate = buildListing({
        id: expose.id,
        url: expose.url,
        title,
        text: contextText || email.text || metadata.subject || '',
        discoveredAt,
        ...(imageUrl ? { imageUrl } : {}),
      });
      const existing = listings.get(expose.id);
      listings.set(
        expose.id,
        existing ? mergeListingCandidates(existing, candidate) : candidate
      );
    });
  }

  const plainText = email.text ?? '';
  for (const rawUrl of plainText.match(/https?:\/\/\S+/g) ?? []) {
    const expose = exposeFromHref(rawUrl);
    if (!expose || listings.has(expose.id)) continue;
    listings.set(
      expose.id,
      buildListing({
        id: expose.id,
        url: expose.url,
        title: metadata.subject ?? '',
        text: plainText,
        discoveredAt,
      })
    );
  }

  return [...listings.values()];
}
