import { createHash } from 'node:crypto';
import { card } from '@pbcp/client';
import type { ProducerCard } from '@pbcp/core';
import { simpleParser } from 'mailparser';

export interface Fetched { mailbox: string; uid: number; threadId?: string; source: Buffer | string }
export interface MailConfig { account: string; toPerson: string; inbox?: string; timeZone?: string }
/** Where a card's message lives: producer state, never fields on the card (OPEN #41). */
export interface MailRef { mailbox: string; uid: number; messageId?: string }
/** A thread's open decision card, as far as this reader knows, and the messages it covers (`card`: the id each was sent as). */
export interface Open { id: string; supersedes?: string; refs: (MailRef & { card: string })[] }
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
/** A grammar-valid namespace (§5) from an account name such as an email address. */
export const namespaceOf = (account: string) => account.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
export const summaryOf = (text: string, max = 200) => ((s: string, cut = s.slice(0, max).replace(/\s+\S*$/, '')) => (s.length <= max ? s : `${cut.length < max ? cut : s.slice(0, max - 1)}…`) || undefined)(text.split(/\r?\n/).filter((l) => !/^\s*>/.test(l)).join(' ').replace(/\s+/g, ' ').trim());

/** `Mon 26 Oct 16:00` in `timeZone`; absolute, not `today`, since an open card is produced again on later days. */
export const readable = (d: Date, timeZone?: string) => ((p: Record<string, string>) => `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`)(Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value])));
/** §11.1: a new message in a thread with an open card supersedes it (§8); a message the open card already covers is skipped. */
export function successor(c: ProducerCard, ref: MailRef, open?: Open): { card: ProducerCard; open: Open } | undefined {
  if (open?.id === c.id) return { card: open.supersedes ? { ...c, supersedes: open.supersedes } : c, open };
  if (open?.refs.some((r) => r.card === c.id)) return undefined;
  const refs = [...(open?.refs ?? []), { ...ref, card: c.id }];
  return open ? { card: { ...c, supersedes: open.id }, open: { id: c.id, supersedes: open.id, refs } } : { card: c, open: { id: c.id, refs } };
}

/** One unseen message → one card (§11.1): headers and first lines, never a draft; `summary` is the unquoted opening text, ≤ 200 chars. */
export async function toCard(m: Fetched, cfg: MailConfig, maxLines = 12): Promise<{ card: ProducerCard; ref: MailRef }> {
  const mail = await simpleParser(m.source);
  const messageId = mail.messageId ?? `${m.mailbox}/${m.uid}`;
  const refs = typeof mail.references === 'string' ? [mail.references] : (mail.references ?? []);
  const inbox = m.mailbox.toUpperCase() === (cfg.inbox ?? 'INBOX').toUpperCase();
  const excerpt = (mail.text ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l, i, a) => l !== '' || a[i - 1] !== '').slice(0, maxLines).join('\n').trim().slice(0, 4000);
  const c = card({
    producer: 'mail', namespace: cfg.account, upstream: hash(messageId), kind: inbox ? 'decision' : 'artifact', to_person: cfg.toPerson,
    thread: m.threadId ? `thr-${m.threadId}` : `ref-${hash(refs[0] ?? mail.inReplyTo ?? messageId)}`,
    title: (mail.subject ?? '').replace(/\s+/g, ' ').trim() || '(no subject)',
    summary: summaryOf(mail.text ?? ''),
    body: [`- **From:** ${mail.from?.text ?? 'unknown'}`, `- **Date:** ${mail.date ? readable(mail.date, cfg.timeZone) : 'unknown'}`]
      .concat(excerpt ? ['', excerpt.replace(/^/gm, '> ')] : [])
      .concat(mail.messageId ? [] : ['', '_This message has no Message-ID; its card id is not stable across moves._'])
      .join('\n'),
    actions: inbox ? [{ id: 'archive', default: true }, 'keep'] : undefined, // §11.1: a bare approve archives
  });
  return { card: c, ref: { mailbox: m.mailbox, uid: m.uid, messageId: mail.messageId } };
}
