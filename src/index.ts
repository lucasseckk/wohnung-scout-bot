import 'dotenv/config';
import { HousingBot } from './bot';
import { loadRuntimeConfig } from './config';
import { DiscordService } from './discord/discord.service';
import { ImmoScoutEmailSource } from './sources/immoscout-email.source';
import { ListingStore } from './storage/listing-store';
import { SearchProfileStore } from './storage/search-profile-store';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const store = new ListingStore(config.databasePath);
  const profileStore = new SearchProfileStore(config.databasePath);
  const initialProfile = profileStore.ensureImported(config.profile);
  if (initialProfile.imported) {
    console.info(`Suchprofil „${initialProfile.profile.name}“ wurde in SQLite übernommen.`);
  }
  const migratedWatchlistItems = store.migrateLegacyWatchlist(config.discord.allowedUserIds[0]);
  if (migratedWatchlistItems > 0) {
    console.info(
      `${migratedWatchlistItems} bisherige Merkliste-Einträge wurden dem Hauptprofil zugeordnet.`
    );
  }
  const source = new ImmoScoutEmailSource(config.imap);
  const discord = new DiscordService(config.discord, store, config.profile, profileStore);
  const bot = new HousingBot(config, source, store, discord, profileStore);

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.info(`${signal} empfangen; Bot wird sauber beendet.`);
    await bot.stop();
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));

  await bot.start();
}

void main().catch(error => {
  console.error('Bot konnte nicht gestartet werden:', error);
  process.exitCode = 1;
});
