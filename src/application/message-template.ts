import type { Applicant, SearchProfile } from '../config';
import type { Listing } from '../domain/listing';

export type ApplicationProfile = {
  label: string;
  template: string;
  applicant: Applicant;
};

function printable(value: string | number | undefined): string {
  return value === undefined ? '' : String(value);
}

export function applicationProfileForDiscordUser(
  profile: SearchProfile,
  userId: string,
  allowedUserIds: string[]
): ApplicationProfile | undefined {
  const allowedUserPosition = allowedUserIds.indexOf(userId) + 1;
  if (allowedUserPosition === 0) return undefined;
  if (allowedUserPosition === 1) {
    return {
      label: 'Hauptprofil',
      template: profile.application.template,
      applicant: profile.application.applicant,
    };
  }
  const additional = profile.application.additionalApplicants.find(
    candidate => candidate.allowedUserPosition === allowedUserPosition
  );
  if (!additional) return undefined;
  return {
    label: additional.label,
    template: additional.template ?? profile.application.template,
    applicant: additional.applicant,
  };
}

export function applicationProfileIsReady(application: ApplicationProfile): boolean {
  return Boolean(
    application.applicant.name.trim() &&
      (application.applicant.email.trim() || application.applicant.phone.trim())
  );
}

export function renderApplicationMessage(
  listing: Listing,
  application: ApplicationProfile
): string {
  const applicant = application.applicant;
  const values: Record<string, string> = {
    title: listing.title,
    address: listing.address ?? '',
    city: listing.city ?? '',
    district: listing.district ?? '',
    warmRent: printable(listing.warmRent),
    coldRent: printable(listing.coldRent),
    livingSpace: printable(listing.livingSpace),
    rooms: printable(listing.rooms),
    name: applicant.name,
    age: applicant.age,
    employment: applicant.employment,
    income: applicant.income,
    household: applicant.household,
    phone: applicant.phone,
    email: applicant.email,
    extras: applicant.extras,
  };

  return application.template
    .replace(/\{\{([a-zA-Z]+)}}/g, (_match, key: string) => values[key] ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
