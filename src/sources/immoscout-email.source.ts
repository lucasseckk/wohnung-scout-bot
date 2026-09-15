import { ImapFlow } from 'imapflow';
import type { RuntimeConfig } from '../config';
import type { Listing } from '../domain/listing';
import type { ListingSource } from './listing-source';
import { parseImmoScoutAlert } from './immoscout-email-parser';

type ImapConfig = RuntimeConfig['imap'];

export class ImmoScoutEmailSource implements ListingSource {
  constructor(private readonly config: ImapConfig) {}

  async fetchListings(): Promise<Listing[]> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
    });
    let connected = false;

    try {
      await client.connect();
      connected = true;
      const lock = await client.getMailboxLock(this.config.mailbox);
      try {
        const since = new Date(Date.now() - this.config.lookbackHours * 60 * 60 * 1000);
        const uids = await client.search(
          {
            since,
            from: this.config.senderContains,
            ...(this.config.subjectContains ? { subject: this.config.subjectContains } : {}),
          },
          { uid: true }
        );
        if (!uids || uids.length === 0) return [];
        const selectedUids = uids.slice(-this.config.maxMessages);

        const listings = new Map<string, Listing>();
        for await (const message of client.fetch(
          selectedUids,
          { uid: true, envelope: true, source: true },
          { uid: true }
        )) {
          if (!message.source) continue;
          const sender = (message.envelope?.from ?? [])
            .map(address => `${address.name ?? ''} ${address.address ?? ''}`)
            .join(' ')
            .toLocaleLowerCase('de-DE');
          const subject = message.envelope?.subject ?? '';
          if (!sender.includes(this.config.senderContains.toLocaleLowerCase('de-DE'))) continue;
          if (
            this.config.subjectContains &&
            !subject.toLocaleLowerCase('de-DE').includes(this.config.subjectContains.toLocaleLowerCase('de-DE'))
          ) {
            continue;
          }

          const receivedAt = message.envelope?.date?.toISOString() ?? new Date().toISOString();
          try {
            const parsed = await parseImmoScoutAlert(message.source, { receivedAt, subject });
            for (const listing of parsed) {
              listings.set(`${listing.source}:${listing.sourceId}`, listing);
            }
          } catch (error) {
            console.warn(`Suchauftrag-E-Mail UID ${message.uid} konnte nicht verarbeitet werden:`, error);
          }
        }
        return [...listings.values()];
      } finally {
        lock.release();
      }
    } finally {
      if (connected) await client.logout().catch(() => undefined);
    }
  }
}
