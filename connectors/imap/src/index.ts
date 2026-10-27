import { HeadClient, fileStore, runProducer } from '@pbcp/client';
import type { Card, ProducerCard } from '@pbcp/core';
import { ImapFlow } from 'imapflow';
import { labelOf, namespaceOf, successor, toCard, zoneOf, type Fetched, type Open } from './mail.js';

const env = (name: string, fallback?: string): string => process.env[name] || fallback || (() => { throw new Error(`${name} is required`); })();
const [user, mailboxes, timeZone] = [env('IMAP_USER'), env('IMAP_MAILBOXES', 'INBOX').split(',').map((s) => s.trim()), zoneOf(process.env.IMAP_TZ)];
const account = namespaceOf(env('PBCP_MAIL_ACCOUNT', user)), labels = (process.env.IMAP_LABELS ?? '').split(',').map(labelOf).filter(Boolean);
const store = fileStore(env('PBCP_STORE', env('PBCP_CURSOR', 'pbcp-imap.store.json'))), threads = store.kv<Open>('thread');
const source = process.env.IMAP_SOURCE_URL ? { url: process.env.IMAP_SOURCE_URL, label: env('IMAP_SOURCE_LABEL', 'Open in mail') } : undefined;
let pending: [string, string, Open] | undefined; // card id, thread and its open card, recorded once the head answers
const head = new HeadClient({ baseUrl: env('PBCP_HEAD_URL'), token: env('PBCP_TOKEN') }), toPerson = process.env.PBCP_TO_PERSON || (await head.describe()).owner;
async function withImap<T>(mailbox: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: env('IMAP_HOST'), port: Number(env('IMAP_PORT', '993')), secure: true, auth: { user, pass: env('IMAP_PASSWORD') }, logger: false });
  await c.on('error', (e) => console.error(e)).connect();
  try { return await c.mailboxOpen(mailbox).then(() => fn(c)); } finally { await c.logout(); }
}

async function* produce() {
  for (const mailbox of mailboxes) {
    for (const m of await withImap(mailbox, async (c): Promise<Fetched[]> =>
      (await c.fetchAll({ seen: false }, { uid: true, threadId: true, source: { maxLength: 256 * 1024 } }, { uid: true })).map((m) => ({ mailbox, uid: m.uid, threadId: m.threadId, source: m.source ?? '' })))) {
      const { card, ref } = await toCard(m, { account, toPerson, timeZone, source, labels });
      const next = card.kind === 'decision' ? successor(card, ref, await threads.get(card.thread!)) : { card, open: undefined };
      pending = next?.open && [card.id, card.thread!, next.open];
      if (next) yield next.card;
    }
  }
}

/** archive → move to the archive folder, keep → \Seen: every message of the thread's open card, or a predecessor's own (§11.1). Gone is not an error. */
async function onDecision(card: Card) {
  const open = card.state === 'decided' && card.thread ? await threads.get(card.thread) : undefined;
  const refs = open?.id === card.id ? open.refs : (open?.refs ?? []).filter((r) => r.card === card.id);
  for (const ref of card.decision === 'archive' || card.decision === 'keep' ? refs : []) {
    const header = ref.messageId ? { 'message-id': ref.messageId } : undefined;
    await withImap(ref.mailbox, async (c) => {
      let uids = (await c.search({ uid: String(ref.uid), header }, { uid: true })) || [];
      if (uids.length === 0 && header) uids = (await c.search({ header }, { uid: true })) || [];
      if (uids.length && card.decision === 'archive') await c.messageMove(uids, env('IMAP_ARCHIVE', 'Archive'), { uid: true });
      else if (uids.length) await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    });
  }
  if (open?.id === card.id) await threads.delete(card.thread!);
}

/** A thread's open card is recorded once the head has answered (201, 200 or 409), never for a failed submit. */
const onSubmitted = async (card: ProducerCard) => void (pending?.[0] === card.id && (await threads.set(pending[1], pending[2])));

const run = runProducer({ head, store, produce, onSubmitted, onDecision });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void run.stop().then(() => process.exit(0)));
