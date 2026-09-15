import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { numericListingFields } from './domain/listing';

const bandSchema = z
  .object({
    min: z.number().finite().nonnegative().optional(),
    max: z.number().finite().nonnegative().optional(),
  })
  .refine(value => value.min !== undefined || value.max !== undefined, {
    message: 'Ein Wertebereich braucht mindestens min oder max.',
  })
  .refine(
    value => value.min === undefined || value.max === undefined || value.min <= value.max,
    { message: 'min darf nicht größer als max sein.' }
  );

const numericCriterionSchema = z.object({
  label: z.string().min(1),
  weight: z.number().positive(),
  rejectOutside: z.boolean().default(false),
  rejectWhenMissing: z.boolean().default(false),
  perfect: bandSchema,
  okay: bandSchema,
  mediocre: bandSchema,
});

const numericCriteriaShape = Object.fromEntries(
  numericListingFields.map(field => [field, numericCriterionSchema.optional()])
) as Record<(typeof numericListingFields)[number], z.ZodOptional<typeof numericCriterionSchema>>;

const applicantSchema = z.object({
  name: z.string().default(''),
  age: z.string().default(''),
  employment: z.string().default(''),
  income: z.string().default(''),
  household: z.string().default(''),
  phone: z.string().default(''),
  email: z.string().default(''),
  extras: z.string().default(''),
});

const additionalApplicantSchema = z.object({
  label: z.string().min(1),
  allowedUserPosition: z.number().int().min(2),
  template: z.string().min(1).optional(),
  applicant: applicantSchema.default({}),
});

const searchRulesShape = {
  numericCriteria: z.object(numericCriteriaShape),
  locationCriterion: z
    .object({
      label: z.string().default('Lage'),
      weight: z.number().positive(),
      rejectOutside: z.boolean().default(false),
      perfect: z.array(z.string()).default([]),
      okay: z.array(z.string()).default([]),
      mediocre: z.array(z.string()).default([]),
    })
    .optional(),
  keywordCriterion: z
    .object({
      label: z.string().default('Ausstattung & Text'),
      weight: z.number().positive(),
      positive: z.array(z.string()).default([]),
      negative: z.array(z.string()).default([]),
      hardExclusions: z.array(z.string()).default([]),
    })
    .optional(),
  scoring: z.object({
    perfectAt: z.number().min(0).max(100),
    okayAt: z.number().min(0).max(100),
    mediocreAt: z.number().min(0).max(100),
    missingValueFactor: z.number().min(0).max(1).default(0.2),
  }),
  notifications: z.object({
    minimumTier: z.enum(['perfect', 'okay', 'mediocre', 'not_match']).default('mediocre'),
    postRejected: z.boolean().default(false),
  }),
};

function validateScoringThresholds(
  profile: { scoring: { perfectAt: number; okayAt: number; mediocreAt: number } },
  context: z.RefinementCtx
): void {
    if (!(profile.scoring.perfectAt > profile.scoring.okayAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scoring', 'perfectAt'],
        message: 'perfectAt muss größer als okayAt sein.',
      });
    }
    if (!(profile.scoring.okayAt > profile.scoring.mediocreAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scoring', 'okayAt'],
        message: 'okayAt muss größer als mediocreAt sein.',
      });
    }
}

type RuleValidationTarget = {
  numericCriteria: Partial<
    Record<(typeof numericListingFields)[number], z.infer<typeof numericCriterionSchema>>
  >;
  locationCriterion?: {
    perfect: string[];
    okay: string[];
    mediocre: string[];
  };
  keywordCriterion?: {
    positive: string[];
    negative: string[];
    hardExclusions: string[];
  };
};

function bandContains(
  outer: z.infer<typeof bandSchema>,
  inner: z.infer<typeof bandSchema>
): boolean {
  if (outer.min !== undefined && (inner.min === undefined || inner.min < outer.min)) return false;
  if (outer.max !== undefined && (inner.max === undefined || inner.max > outer.max)) return false;
  return true;
}

function normalizedRuleValue(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('de-DE');
}

function validateDisjointLists(
  label: string,
  lists: Array<{ path: string; values: string[] }>,
  context: z.RefinementCtx
): void {
  const owners = new Map<string, string>();
  for (const list of lists) {
    for (const value of list.values) {
      const key = normalizedRuleValue(value);
      if (!key) continue;
      const previous = owners.get(key);
      if (previous && previous !== list.path) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [label, list.path],
          message: `„${value}“ darf nicht gleichzeitig in mehreren Bereichen stehen.`,
        });
      } else {
        owners.set(key, list.path);
      }
    }
  }
}

function validateRuleLogic(profile: RuleValidationTarget, context: z.RefinementCtx): void {
  for (const field of numericListingFields) {
    const criterion = profile.numericCriteria[field];
    if (!criterion) continue;
    if (
      !bandContains(criterion.okay, criterion.perfect) ||
      !bandContains(criterion.mediocre, criterion.okay)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['numericCriteria', field],
        message: 'Perfekt muss innerhalb von okay und okay innerhalb von mittelmäßig liegen.',
      });
    }
  }
  if (profile.locationCriterion) {
    validateDisjointLists(
      'locationCriterion',
      [
        { path: 'perfect', values: profile.locationCriterion.perfect },
        { path: 'okay', values: profile.locationCriterion.okay },
        { path: 'mediocre', values: profile.locationCriterion.mediocre },
      ],
      context
    );
  }
  if (profile.keywordCriterion) {
    validateDisjointLists(
      'keywordCriterion',
      [
        { path: 'positive', values: profile.keywordCriterion.positive },
        { path: 'negative', values: profile.keywordCriterion.negative },
        { path: 'hardExclusions', values: profile.keywordCriterion.hardExclusions },
      ],
      context
    );
  }
}

const searchRulesSchema = z
  .object(searchRulesShape)
  .strict()
  .superRefine((profile, context) => {
    validateScoringThresholds(profile, context);
    validateRuleLogic(profile, context);
  });

const profileSchema = z
  .object({
    profileName: z.string().trim().min(1).max(80),
    ...searchRulesShape,
    application: z.object({
      template: z.string().min(1),
      applicant: applicantSchema.default({}),
      additionalApplicants: z.array(additionalApplicantSchema).default([]),
    }),
  })
  .strict()
  .superRefine((profile, context) => {
    validateScoringThresholds(profile, context);
    validateRuleLogic(profile, context);
    const positions = profile.application.additionalApplicants.map(
      applicant => applicant.allowedUserPosition
    );
    if (new Set(positions).size !== positions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['application', 'additionalApplicants'],
        message: 'Jede allowedUserPosition darf nur einmal vorkommen.',
      });
    }
  });

export type SearchProfile = z.infer<typeof profileSchema>;
export type SearchRules = z.infer<typeof searchRulesSchema>;
export type ApplicationConfig = SearchProfile['application'];
export type NumericCriterion = z.infer<typeof numericCriterionSchema>;
export type RangeBand = z.infer<typeof bandSchema>;
export type Applicant = z.infer<typeof applicantSchema>;

function validationMessage(prefix: string, issues: z.ZodIssue[]): string {
  return `${prefix}:\n${issues
    .map(issue => `- ${issue.path.join('.') || 'Profil'}: ${issue.message}`)
    .join('\n')}`;
}

export function parseSearchRules(raw: unknown): SearchRules {
  const result = searchRulesSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(validationMessage('Suchregeln sind ungültig', result.error.issues));
  }
  return result.data;
}

export function searchRulesFromProfile(profile: SearchProfile): SearchRules {
  return parseSearchRules({
    numericCriteria: profile.numericCriteria,
    ...(profile.locationCriterion ? { locationCriterion: profile.locationCriterion } : {}),
    ...(profile.keywordCriterion ? { keywordCriterion: profile.keywordCriterion } : {}),
    scoring: profile.scoring,
    notifications: profile.notifications,
  });
}

export type RuntimeConfig = {
  discord: {
    token: string;
    channelId: string;
    pingRoleId?: string;
    pingRoleName?: string;
    allowedUserIds: string[];
  };
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    mailbox: string;
    lookbackHours: number;
    maxMessages: number;
    senderContains: string;
    subjectContains?: string;
  };
  databasePath: string;
  pollIntervalMinutes: number;
  notifyExistingOnStart: boolean;
  retentionDays: number;
  profile: SearchProfile;
  profilePath: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Umgebungsvariable ${name} fehlt.`);
  return value;
}

function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} muss eine positive Zahl sein.`);
  }
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes', 'ja'].includes(raw)) return true;
  if (['false', '0', 'no', 'nein'].includes(raw)) return false;
  throw new Error(`${name} muss true oder false sein.`);
}

export function loadProfile(profilePath: string): SearchProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Suchprofil ${profilePath} konnte nicht gelesen werden.`, { cause: error });
  }

  const result = profileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(validationMessage('Suchprofil ist ungültig', result.error.issues));
  }
  return result.data;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const profilePath = path.resolve(process.env.PROFILE_PATH ?? './config/profile.json');
  const subjectContains = process.env.IMAP_SUBJECT_CONTAINS?.trim() || 'Angebot';
  const pingRoleId = process.env.DISCORD_PING_ROLE_ID?.trim();
  const pingRoleName = process.env.DISCORD_PING_ROLE_NAME?.trim();
  const allowedUserIds = (process.env.DISCORD_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (allowedUserIds.length === 0) {
    throw new Error('DISCORD_ALLOWED_USER_IDS muss mindestens eine private Discord-ID enthalten.');
  }
  if (new Set(allowedUserIds).size !== allowedUserIds.length) {
    throw new Error('DISCORD_ALLOWED_USER_IDS enthält doppelte Discord-IDs.');
  }
  const profile = loadProfile(profilePath);
  const configuredPositions = new Set(
    profile.application.additionalApplicants.map(applicant => applicant.allowedUserPosition)
  );
  for (let position = 2; position <= allowedUserIds.length; position += 1) {
    if (!configuredPositions.has(position)) {
      throw new Error(
        `Für die ${position}. ID in DISCORD_ALLOWED_USER_IDS fehlt ein eigenes Bewerberprofil.`
      );
    }
  }
  const unusedPosition = [...configuredPositions].find(position => position > allowedUserIds.length);
  if (unusedPosition !== undefined) {
    throw new Error(
      `Bewerberprofil ${unusedPosition} hat keine passende ID in DISCORD_ALLOWED_USER_IDS.`
    );
  }

  return {
    discord: {
      token: requiredEnv('DISCORD_TOKEN'),
      channelId: requiredEnv('DISCORD_CHANNEL_ID'),
      ...(pingRoleId ? { pingRoleId } : {}),
      ...(pingRoleName ? { pingRoleName } : {}),
      allowedUserIds,
    },
    imap: {
      host: requiredEnv('IMAP_HOST'),
      port: positiveNumberEnv('IMAP_PORT', 993),
      secure: booleanEnv('IMAP_SECURE', true),
      user: requiredEnv('IMAP_USER'),
      password: requiredEnv('IMAP_PASSWORD'),
      mailbox: process.env.IMAP_MAILBOX?.trim() || 'INBOX',
      lookbackHours: positiveNumberEnv('IMAP_LOOKBACK_HOURS', 72),
      maxMessages: positiveNumberEnv('IMAP_MAX_MESSAGES', 100),
      senderContains: process.env.IMAP_SENDER_CONTAINS?.trim() || 'immobilienscout24',
      ...(subjectContains ? { subjectContains } : {}),
    },
    databasePath: path.resolve(process.env.DATABASE_PATH ?? './data/wohnungen.sqlite'),
    pollIntervalMinutes: positiveNumberEnv('POLL_INTERVAL_MINUTES', 10),
    notifyExistingOnStart: booleanEnv('NOTIFY_EXISTING_ON_START', false),
    retentionDays: positiveNumberEnv('RETENTION_DAYS', 30),
    profile,
    profilePath,
  };
}
