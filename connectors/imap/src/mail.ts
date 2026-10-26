import { createHash } from 'node:crypto';
import { card } from '@pbcp/client';
import type { ProducerCard } from '@pbcp/core';
import { simpleParser } from 'mailparser';

export interface Fetched { mailbox: string; uid: number; threadId?: string; source: Buffer | string }
export interface MailConfig { account: string; toPerson: string; inbox?: string }

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

/** A grammar-valid namespace (§5) from an account name such as an email address. */
export const namespaceOf = (account: string) => account.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/** One unseen message → one card (§11.1): headers and first lines, never a draft. */
export async function toCard(m: Fetched, cfg: MailConfig, maxLines = 12): Promise<ProducerCard> {
  const mail = await simpleParser(m.source);
  const messageId = mail.messageId ?? `${m.mailbox}/${m.uid}`;
  const refs = typeof mail.references === 'string' ? [mail.references] : (mail.references ?? []);
  const inbox = m.mailbox.toUpperCase() === (cfg.inbox ?? 'INBOX').toUpperCase();
  const lines = (mail.text ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l, i, a) => l !== '' || a[i - 1] !== '');
  const excerpt = lines.slice(0, maxLines).join('\n').trim().slice(0, 4000);
  return card({
    producer: 'mail',
    namespace: cfg.account,
    upstream: hash(messageId),
    kind: inbox ? 'decision' : 'artifact',
    to_person: cfg.toPerson,
    thread: m.threadId ? `thr-${m.threadId}` : `ref-${hash(refs[0] ?? mail.inReplyTo ?? messageId)}`,
    title: (mail.subject ?? '').replace(/\s+/g, ' ').trim() || '(no subject)',
    body: [`- **From:** ${mail.from?.text ?? 'unknown'}`, `- **Date:** ${mail.date?.toISOString() ?? 'unknown'}`]
      .concat(excerpt ? ['', excerpt.replace(/^/gm, '> ')] : [])
      .join('\n'),
    actions: inbox ? ['archive', 'keep'] : undefined,
    'x-imap-mailbox': m.mailbox,
    'x-imap-uid': m.uid,
    'x-imap-message-id': mail.messageId,
  });
}
