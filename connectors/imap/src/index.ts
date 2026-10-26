import { HeadClient, fileCursor, runProducer } from '@pbcp/client';
import type { Card } from '@pbcp/core';
import { ImapFlow } from 'imapflow';
import { namespaceOf, toCard, type Fetched } from './mail.js';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] || fallback;
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const user = env('IMAP_USER');
const account = namespaceOf(env('PBCP_MAIL_ACCOUNT', user));
const toPerson = env('PBCP_TO_PERSON');
const mailboxes = env('IMAP_MAILBOXES', 'INBOX').split(',').map((s) => s.trim());
const archive = env('IMAP_ARCHIVE', 'Archive');

async function withImap<T>(mailbox: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: env('IMAP_HOST'), port: Number(env('IMAP_PORT', '993')), secure: true, auth: { user, pass: env('IMAP_PASSWORD') }, logger: false });
  c.on('error', (e) => console.error(e));
  await c.connect();
  try {
    const lock = await c.getMailboxLock(mailbox);
    try {
      return await fn(c);
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

async function* produce() {
  for (const mailbox of mailboxes) {
    const fetched: Fetched[] = await withImap(mailbox, async (c) => {
      const msgs = await c.fetchAll({ seen: false }, { uid: true, threadId: true, source: { maxLength: 256 * 1024 } }, { uid: true });
      return msgs.map((m) => ({ mailbox, uid: m.uid, threadId: m.threadId, source: m.source ?? '' }));
    });
    for (const m of fetched) yield await toCard(m, { account, toPerson });
  }
}

/** archive → move to the archive folder; keep → \Seen. A message that is already gone is not an error. */
async function onDecision(card: Card) {
  if (card.state !== 'decided' || (card.decision !== 'archive' && card.decision !== 'keep')) return;
  const [uid, messageId] = [card['x-imap-uid'], card['x-imap-message-id']];
  const header = typeof messageId === 'string' ? { 'message-id': messageId } : undefined;
  await withImap(String(card['x-imap-mailbox'] ?? 'INBOX'), async (c) => {
    let uids: number[] = [];
    if (typeof uid === 'number') uids = (await c.search({ uid: String(uid), header }, { uid: true })) || [];
    if (uids.length === 0 && header) uids = (await c.search({ header }, { uid: true })) || [];
    if (uids.length === 0) return;
    if (card.decision === 'archive') await c.messageMove(uids, archive, { uid: true });
    else await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
  });
}

const head = new HeadClient({ baseUrl: env('PBCP_HEAD_URL'), token: env('PBCP_TOKEN') });
const run = runProducer({ head, cursor: fileCursor(env('PBCP_CURSOR', 'pbcp-imap-cursor.json')), produce, onDecision });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void run.stop().then(() => process.exit(0)));
