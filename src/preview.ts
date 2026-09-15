import path from 'node:path';
import { loadProfile } from './config';
import { FixtureSource } from './sources/fixture.source';
import { scoreListing, tierLabel } from './scoring/scorer';

async function preview(): Promise<void> {
  const profilePath = path.resolve(process.argv[2] ?? './config/profile.example.json');
  const fixturePath = path.resolve(process.argv[3] ?? './test/fixtures/immoscout-alert.eml');
  const profile = loadProfile(profilePath);
  const listings = await new FixtureSource(fixturePath).fetchListings();

  for (const listing of listings) {
    const assessment = scoreListing(listing, profile);
    console.info(`\n${listing.title}`);
    console.info(`${tierLabel(assessment.tier)} · ${assessment.score}/100 · ${listing.url}`);
    for (const evaluation of assessment.evaluations) console.info(`  ${evaluation.explanation}`);
    for (const exclusion of assessment.hardExclusions) console.info(`  Ausschluss: ${exclusion}`);
  }
}

void preview().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
