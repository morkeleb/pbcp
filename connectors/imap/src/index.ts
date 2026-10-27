import { HeadClient, fileStore, runProducer } from '@pbcp/client';
import type { Card, ProducerCard } from '@pbcp/core';
import { ImapFlow } from 'imapflow';
import { namespaceOf, toCard, type Fetched, type MailRef } from './mail.js';

const env = (name: string, fallback?: string): string => process.env[name] || fallback || (() => { throw new Error(`${name} is required`); })();

const user = env('IMAP_USER');
const account = namespaceOf(env('PBCP_MAIL_ACCOUNT', user));
const mailboxes = env('IMAP_MAILBOXES', 'INBOX').split(',').map((s) => s.trim());
const archive = env('IMAP_ARCHIVE', 'Archive');
const store = fileStore(env('PBCP_STORE', env('PBCP_CURSOR', 'pbcp-imap.store.json')));
const state = store.kv<MailRef>('mail');
let pending: [string, MailRef] | undefined; // the decision card being submitted, until the head answers
const head = new HeadClient({ baseUrl: env('PBCP_HEAD_URL'), token: env('PBCP_TOKEN') });
const toPerson = process.env.PBCP_TO_PERSON || (await head.describe()).owner;

async function withImap<T>(mailbox: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: env('IMAP_HOST'), port: Number(env('IMAP_PORT', '993')), secure: true, auth: { user, pass: env('IMAP_PASSWORD') }, logger: false });
  await c.on('error', (e) => console.error(e)).connect();
  try { return await c.mailboxOpen(mailbox).then(() => fn(c)); } finally { await c.logout(); }
}

async function* produce() {
  for (const mailbox of mailboxes) {
    const fetched: Fetched[] = await withImap(mailbox, async (c) => {
      const msgs = await c.fetchAll({ seen: false }, { uid: true, threadId: true, source: { maxLength: 256 * 1024 } }, { uid: true });
      return msgs.map((m) => ({ mailbox, uid: m.uid, threadId: m.threadId, source: m.source ?? '' }));
    });
    for (const m of fetched) {
      const { card, ref } = await toCard(m, { account, toPerson });
      pending = card.kind === 'decision' ? [card.id, ref] : undefined;
      yield card;
    }
  }
}

/** archive → move to the archive folder; keep → \Seen. A message that is already gone is not an error. */
async function onDecision(card: Card) {
  const ref = card.state === 'decided' && (card.decision === 'archive' || card.decision === 'keep') ? await state.get(card.id) : undefined;
  if (!ref) return;
  const header = ref.messageId ? { 'message-id': ref.messageId } : undefined;
  await withImap(ref.mailbox, async (c) => {
    let uids = (await c.search({ uid: String(ref.uid), header }, { uid: true })) || [];
    if (uids.length === 0 && header) uids = (await c.search({ header }, { uid: true })) || [];
    if (uids.length && card.decision === 'archive') await c.messageMove(uids, archive, { uid: true });
    else if (uids.length) await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
  });
  await state.delete(card.id);
}

/** A decision card's message ref is recorded once the head has answered (201, 200 or 409), never for a failed submit. */
async function onSubmitted(card: ProducerCard) {
  if (pending?.[0] === card.id) await state.set(card.id, pending[1]);
}

const run = runProducer({ head, store, produce, onSubmitted, onDecision });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void run.stop().then(() => process.exit(0)));
