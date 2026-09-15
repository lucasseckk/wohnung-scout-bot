import type { SearchRules } from '../config';
import { parseSearchRules } from '../config';
import { parseGermanNumber } from '../utils/numbers';

type MaximumField = 'warmRent' | 'coldRent';
type MinimumField = 'livingSpace' | 'rooms';
type EditableNumericField = MaximumField | MinimumField;

const fallbackLabels: Record<EditableNumericField, string> = {
  warmRent: 'Warmmiete',
  coldRent: 'Kaltmiete',
  livingSpace: 'Wohnfläche',
  rooms: 'Zimmer',
};

function cloneRules(rules: SearchRules): SearchRules {
  return structuredClone(rules);
}

function normalizedListKey(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('de-DE');
}

/** Parses a comma-, semicolon- or line-separated modal value and keeps the first spelling. */
export function parseListInput(input: string): string[] {
  const unique = new Map<string, string>();
  for (const rawValue of input.split(/[,;\r\n]+/)) {
    const value = rawValue.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const key = normalizedListKey(value);
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()];
}

/** Formats a list for a Discord paragraph input. */
export function formatListInput(values: readonly string[]): string {
  return parseListInput(values.join('\n')).join('\n');
}

function assertNoListOverlap(
  category: string,
  lists: ReadonlyArray<{ label: string; values: readonly string[] }>
): void {
  const owners = new Map<string, { label: string; value: string }>();
  for (const list of lists) {
    for (const value of list.values) {
      const key = normalizedListKey(value);
      const previous = owners.get(key);
      if (previous && previous.label !== list.label) {
        throw new Error(
          `${category}: „${previous.value}“ steht gleichzeitig in „${previous.label}“ und „${list.label}“.`
        );
      }
      owners.set(key, { label: list.label, value });
    }
  }
}

function numericLabel(rules: SearchRules, field: EditableNumericField): string {
  return rules.numericCriteria[field]?.label || fallbackLabels[field];
}

function criterionFor(rules: SearchRules, field: EditableNumericField) {
  const criterion = rules.numericCriteria[field];
  if (!criterion) {
    throw new Error(`${fallbackLabels[field]} ist in diesem Suchprofil nicht eingerichtet.`);
  }
  return criterion;
}

function formatGermanNumber(value: number): string {
  return value.toLocaleString('de-DE', {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
}

function formatTriple(values: readonly [number | undefined, number | undefined, number | undefined], label: string): string {
  if (values.some(value => value === undefined)) {
    throw new Error(`${label} ist nicht vollständig konfiguriert.`);
  }
  return values.map(value => formatGermanNumber(value as number)).join(' | ');
}

export function formatMaximumTriple(rules: SearchRules, field: MaximumField): string {
  const criterion = criterionFor(rules, field);
  return formatTriple(
    [criterion.perfect.max, criterion.okay.max, criterion.mediocre.max],
    numericLabel(rules, field)
  );
}

export function formatMinimumTriple(rules: SearchRules, field: MinimumField): string {
  const criterion = criterionFor(rules, field);
  return formatTriple(
    [criterion.perfect.min, criterion.okay.min, criterion.mediocre.min],
    numericLabel(rules, field)
  );
}

function parseTriple(input: string, label: string, finalLabel: string): [number, number, number] {
  const parts = input.split(/[|;\r\n]+/).map(value => value.trim());
  if (parts.length !== 3 || parts.some(value => value.length === 0)) {
    throw new Error(
      `${label} braucht genau drei Werte: perfekt | okay | ${finalLabel}.`
    );
  }

  const parsed = parts.map(value => parseGermanNumber(value));
  const invalidIndex = parsed.findIndex(
    value => value === undefined || !Number.isFinite(value) || value < 0
  );
  if (invalidIndex >= 0) {
    throw new Error(
      `${label}: „${parts[invalidIndex]}“ ist keine gültige nichtnegative Zahl.`
    );
  }
  return parsed as [number, number, number];
}

function parseMaximumTriple(input: string, label: string): [number, number, number] {
  const values = parseTriple(input, label, 'absolute Obergrenze');
  if (!(values[0] <= values[1] && values[1] <= values[2])) {
    throw new Error(
      `${label} muss aufsteigend sein: perfekt ≤ okay ≤ absolute Obergrenze.`
    );
  }
  return values;
}

function parseMinimumTriple(input: string, label: string): [number, number, number] {
  const values = parseTriple(input, label, 'absolutes Minimum');
  if (!(values[0] >= values[1] && values[1] >= values[2])) {
    throw new Error(
      `${label} muss absteigend sein: perfekt ≥ okay ≥ absolutes Minimum.`
    );
  }
  return values;
}

function setMaximumTriple(
  rules: SearchRules,
  field: MaximumField,
  values: readonly [number, number, number]
): void {
  const criterion = criterionFor(rules, field);
  criterion.perfect = { ...criterion.perfect, max: values[0] };
  criterion.okay = { ...criterion.okay, max: values[1] };
  criterion.mediocre = { ...criterion.mediocre, max: values[2] };
}

function setMinimumTriple(
  rules: SearchRules,
  field: MinimumField,
  values: readonly [number, number, number]
): void {
  const criterion = criterionFor(rules, field);
  criterion.perfect = { ...criterion.perfect, min: values[0] };
  criterion.okay = { ...criterion.okay, min: values[1] };
  criterion.mediocre = { ...criterion.mediocre, min: values[2] };
}

export function applyRentInputs(
  rules: SearchRules,
  warmTriple: string,
  coldTriple: string
): SearchRules {
  const next = cloneRules(rules);
  const warmValues = parseMaximumTriple(warmTriple, numericLabel(next, 'warmRent'));
  const coldValues = parseMaximumTriple(coldTriple, numericLabel(next, 'coldRent'));
  setMaximumTriple(next, 'warmRent', warmValues);
  setMaximumTriple(next, 'coldRent', coldValues);
  return parseSearchRules(next);
}

export function applyHomeInputs(
  rules: SearchRules,
  spaceTriple: string,
  roomsTriple: string
): SearchRules {
  const next = cloneRules(rules);
  const spaceValues = parseMinimumTriple(spaceTriple, numericLabel(next, 'livingSpace'));
  const roomValues = parseMinimumTriple(roomsTriple, numericLabel(next, 'rooms'));
  setMinimumTriple(next, 'livingSpace', spaceValues);
  setMinimumTriple(next, 'rooms', roomValues);
  return parseSearchRules(next);
}

export function applyLocationInputs(
  rules: SearchRules,
  perfectInput: string,
  okayInput: string,
  mediocreInput: string
): SearchRules {
  const next = cloneRules(rules);
  if (!next.locationCriterion) {
    throw new Error('In diesem Suchprofil ist kein Lage-Kriterium eingerichtet.');
  }
  const perfect = parseListInput(perfectInput);
  const okay = parseListInput(okayInput);
  const mediocre = parseListInput(mediocreInput);
  assertNoListOverlap('Lage', [
    { label: 'Perfekt', values: perfect },
    { label: 'Okay', values: okay },
    { label: 'Mittelmäßig', values: mediocre },
  ]);
  next.locationCriterion.perfect = perfect;
  next.locationCriterion.okay = okay;
  next.locationCriterion.mediocre = mediocre;
  return parseSearchRules(next);
}

export function applyKeywordInputs(
  rules: SearchRules,
  positiveInput: string,
  negativeInput: string,
  hardExclusionsInput: string
): SearchRules {
  const next = cloneRules(rules);
  if (!next.keywordCriterion) {
    throw new Error('In diesem Suchprofil ist kein Merkmals-Kriterium eingerichtet.');
  }
  const positive = parseListInput(positiveInput);
  const negative = parseListInput(negativeInput);
  const hardExclusions = parseListInput(hardExclusionsInput);
  assertNoListOverlap('Merkmale', [
    { label: 'Positiv', values: positive },
    { label: 'Negativ', values: negative },
    { label: 'Harte Ausschlüsse', values: hardExclusions },
  ]);
  next.keywordCriterion.positive = positive;
  next.keywordCriterion.negative = negative;
  next.keywordCriterion.hardExclusions = hardExclusions;
  return parseSearchRules(next);
}
