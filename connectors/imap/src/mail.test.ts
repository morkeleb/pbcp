import { createHash } from 'node:crypto';
import { isId } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { labelOf, namespaceOf, readable, sourceOf, successor, summaryOf, toCard, zoneOf, type Open } from './mail.js';

const raw = (headers: Record<string, string>, body: string) =>
  `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

const anna = raw(
  {
    From: 'Anna Berg <anna@nordic.example>',
    To: 'morten@example.com',
    Subject: 'Invoice   timing\r\n  for September',
    Date: 'Wed, 07 Oct 2026 13:02:11 +0000',
    'Message-ID': '<CA+abc=def@mail.example.com>',
    References: '<root-1@mail.example.com> <mid-2@mail.example.com>',
  },
  'Hi Morten,\r\n\r\n\r\nCan we pay on the 20th?\r\n# not a heading\r\n' + Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'),
);
const cfg = { account: 'morten-example-com', toPerson: 'morten', timeZone: 'UTC' };

describe('toCard', () => {
  it('maps an INBOX message to a decision card with archive (the default) and keep', async () => {
    const { card: c, ref } = await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, cfg);
    expect(isId(c.id)).toBe(true);
    expect(c.id).toBe(`mail:morten-example-com:${createHash('sha256').update('<CA+abc=def@mail.example.com>').digest('hex').slice(0, 24)}`);
    expect(c.id).toMatch(/^mail:morten-example-com:[0-9a-f]{24}$/);
    expect(c).toMatchObject({
      protocol: 'pbcp/1',
      producer: 'mail',
      kind: 'decision',
      to_person: 'morten',
      title: 'Invoice timing for September',
      actions: [{ id: 'archive', default: true }, 'keep'],
    });
    expect(Object.keys(c).filter((k) => k.startsWith('x-'))).toEqual([]);
    expect(ref).toEqual({ mailbox: 'INBOX', uid: 42, messageId: '<CA+abc=def@mail.example.com>' });
    expect(c.body).not.toContain('Message-ID');
    expect(c.body).toContain('**From:** "Anna Berg" <anna@nordic.example>');
    expect(c.body).toContain('**Date:** Wed 7 Oct 13:02');
    expect(c.body).toContain('> Hi Morten,\n> \n> Can we pay on the 20th?\n> # not a heading');
    expect(c.body).not.toContain('line 20');
    expect(c.summary).toMatch(/^Hi Morten, Can we pay on the 20th\? # not a heading line 0 line 1 .*…$/);
    expect(c.summary!.length).toBeLessThanOrEqual(200);
  });

  it('summarises the opening text: one line, no quoted lines, cut at a word (§4.1, §11.1)', () => {
    expect(summaryOf('Sure, the 20th works.\r\n\r\nOn Wed, Anna wrote:\r\n> Can we pay\r\n>   on the 20th?')).toBe('Sure, the 20th works. On Wed, Anna wrote:');
    expect(summaryOf('word '.repeat(60), 30)).toBe('word word word word word word…');
    expect(summaryOf('x'.repeat(250))).toHaveLength(200);
    expect(summaryOf('  \n> only quoted\n')).toBeUndefined();
  });

  it('is deterministic, and the id ignores mailbox and uid', async () => {
    const { card: a } = await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, cfg);
    const { card: b } = await toCard({ mailbox: 'Archive', uid: 7, source: Buffer.from(anna) }, cfg);
    expect(b.id).toBe(a.id);
    expect(b.thread).toBe(a.thread);
    expect(b.kind).toBe('artifact');
    expect('actions' in b).toBe(false);
  });

  it('threads by the server thread id when present, else the References root', async () => {
    const reply = raw({ From: 'x@y', Subject: 'Re', 'Message-ID': '<other@x>', 'In-Reply-To': '<root-1@mail.example.com>' }, 'ok');
    const root = raw({ From: 'x@y', Subject: 'Root', 'Message-ID': '<root-1@mail.example.com>' }, 'ok');
    const fromRefs = (await toCard({ mailbox: 'INBOX', uid: 1, source: anna }, cfg)).card.thread;
    expect((await toCard({ mailbox: 'INBOX', uid: 2, source: reply }, cfg)).card.thread).toBe(fromRefs);
    expect((await toCard({ mailbox: 'INBOX', uid: 3, source: root }, cfg)).card.thread).toBe(fromRefs);
    expect((await toCard({ mailbox: 'INBOX', uid: 1, threadId: '1781234567890', source: anna }, cfg)).card.thread).toBe('thr-1781234567890');
  });

  it('copes with a message lacking Message-ID, subject and text', async () => {
    const bare = 'From: a@b\r\n\r\n';
    const { card: c, ref } = await toCard({ mailbox: 'Lists', uid: 9, source: bare }, cfg);
    expect(isId(c.id)).toBe(true);
    expect(c.title).toBe('(no subject)');
    expect(c.body).toBe('- **From:** a@b\n- **Date:** unknown\n\n_This message has no Message-ID; its card id is not stable across moves._');
    expect('summary' in c).toBe(false);
    expect(ref).toEqual({ mailbox: 'Lists', uid: 9, messageId: undefined });
    expect((await toCard({ mailbox: 'Lists', uid: 9, source: bare }, cfg)).card.id).toBe(c.id);
    expect((await toCard({ mailbox: 'Archive', uid: 3, source: bare }, cfg)).card.id).not.toBe(c.id);
  });
});

describe('readable', () => {
  it('writes a local time a person reads at a glance, not an ISO timestamp', () => {
    expect(readable(new Date('2026-10-26T15:00:00Z'), 'Europe/Copenhagen')).toBe('Mon 26 Oct 16:00');
    expect(readable(new Date('2026-10-27T09:05:00Z'), 'UTC')).toBe('Tue 27 Oct 09:05');
    expect(readable(new Date('2026-10-26T23:30:00Z'), 'Europe/Copenhagen')).toBe('Tue 27 Oct 00:30');
    expect(readable(new Date('2026-10-26T15:00:00Z'))).toBe('Mon 26 Oct 15:00 UTC');
  });
});

describe('IMAP_TZ', () => {
  it('writes the date in the configured zone, with no suffix', async () => {
    const { card } = await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, { ...cfg, timeZone: zoneOf('Europe/Copenhagen') });
    expect(card.body).toContain('- **Date:** Wed 7 Oct 15:02\n');
  });

  it('writes UTC and says so when no zone is set', async () => {
    const { card } = await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, { account: cfg.account, toPerson: cfg.toPerson, timeZone: zoneOf(undefined) });
    expect(card.body).toContain('- **Date:** Wed 7 Oct 13:02 UTC\n');
  });

  it('checks the zone: empty is unset, a bad name throws', () => {
    expect(zoneOf('')).toBeUndefined();
    expect(zoneOf('Europe/Copenhagen')).toBe('Europe/Copenhagen');
    expect(() => zoneOf('Mars/Base')).toThrow(RangeError);
  });
});

describe('IMAP_SOURCE_URL (§4.1, §11.1)', () => {
  const gmail = { url: 'https://mail.google.com/mail/u/0/#search/rfc822msgid:{message_id}', label: 'Open in mail' };

  it('links every card to its message when set: the Message-ID without brackets, percent-encoded', async () => {
    const inbox = (await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, { ...cfg, source: gmail })).card;
    expect(inbox.source).toEqual({ url: 'https://mail.google.com/mail/u/0/#search/rfc822msgid:CA%2Babc%3Ddef%40mail.example.com', label: 'Open in mail' });
    const other = (await toCard({ mailbox: 'Lists', uid: 7, source: anna }, { ...cfg, source: gmail })).card;
    expect(other.kind).toBe('artifact');
    expect(other.source).toEqual(inbox.source);
  });

  it('fills {uid}, takes the label as given, and leaves the card without source when unset', async () => {
    expect(sourceOf({ url: 'https://mail.example/#uid={uid}&id={message_id}', label: 'Webmail' }, '<a b@x>', 42)).toEqual({ url: 'https://mail.example/#uid=42&id=a%20b%40x', label: 'Webmail' });
    expect(sourceOf(undefined, '<a@x>', 1)).toBeUndefined();
    expect('source' in (await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, cfg)).card).toBe(false);
  });

  it('gives no source when the template needs a Message-ID the message lacks', async () => {
    const bare = 'From: a@b\r\n\r\n';
    expect('source' in (await toCard({ mailbox: 'INBOX', uid: 9, source: bare }, { ...cfg, source: gmail })).card).toBe(false);
    expect((await toCard({ mailbox: 'INBOX', uid: 9, source: bare }, { ...cfg, source: { url: 'https://mail.example/#uid={uid}', label: 'Webmail' } })).card.source)
      .toEqual({ url: 'https://mail.example/#uid=9', label: 'Webmail' });
  });
});

describe('successor (§11.1, §8)', () => {
  const msg = (n: number) => raw({ From: 'x@y', Subject: 'Re: invoice', 'Message-ID': `<m${n}@x>`, References: '<root@x>' }, `message ${n}`);
  const at = async (n: number) => toCard({ mailbox: 'INBOX', uid: n, source: msg(n) }, cfg);

  it('records the first message of a thread as its open card, superseding nothing', async () => {
    const { card, ref } = await at(1);
    const next = successor(card, ref)!;
    expect(next.card).toBe(card);
    expect('supersedes' in next.card).toBe(false);
    expect(next.open).toEqual({ id: card.id, refs: [{ ...ref, card: card.id }] });
  });

  it('a new message supersedes the open card, which then covers every message of the thread', async () => {
    const [a, b, c] = [await at(1), await at(2), await at(3)];
    const o1 = successor(a.card, a.ref)!.open;
    const two = successor(b.card, b.ref, o1)!;
    expect(two.card).toMatchObject({ id: b.card.id, thread: a.card.thread, supersedes: a.card.id });
    expect(two.open).toEqual({ id: b.card.id, supersedes: a.card.id, refs: [{ ...a.ref, card: a.card.id }, { ...b.ref, card: b.card.id }] });
    const three = successor(c.card, c.ref, two.open)!;
    expect(three.card.supersedes).toBe(b.card.id);
    expect(three.open.refs.map((r) => r.uid)).toEqual([1, 2, 3]);
  });

  it('produces the open card again with the same supersedes, and skips the messages it superseded', async () => {
    const [a, b] = [await at(1), await at(2)];
    const open: Open = successor(b.card, b.ref, successor(a.card, a.ref)!.open)!.open;
    expect(successor(b.card, b.ref, open)).toEqual({ card: { ...b.card, supersedes: a.card.id }, open });
    expect(successor(a.card, a.ref, open)).toBeUndefined();
  });
});

describe('labels (§4.1)', () => {
  it('labels a card with its mailbox, then the fixed IMAP_LABELS, without repeats', async () => {
    expect((await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, cfg)).card.labels).toEqual(['inbox']);
    expect((await toCard({ mailbox: '[Gmail]/All Mail', uid: 7, source: anna }, cfg)).card.labels).toEqual(['gmail-all-mail']);
    expect((await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, { ...cfg, labels: ['work', 'inbox'] })).card.labels).toEqual(['inbox', 'work']);
    const many = Array.from({ length: 10 }, (_, i) => `l${i}`);
    expect((await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, { ...cfg, labels: many })).card.labels).toHaveLength(8);
  });

  it('makes a label from a mailbox name or an IMAP_LABELS entry', () => {
    expect(labelOf('INBOX')).toBe('inbox');
    expect(labelOf(' Clients / Nordic Supply ')).toBe('clients-nordic-supply');
    expect(labelOf('x'.repeat(40))).toBe('x'.repeat(32));
    expect(labelOf('a'.repeat(31) + '/b')).toBe('a'.repeat(31));
    expect(labelOf('///')).toBe('');
  });
});

describe('namespaceOf', () => {
  it('turns an address into a grammar-valid namespace', () => {
    expect(namespaceOf('Morten.Nielsen+pbcp@Example.com')).toBe('morten-nielsen-pbcp-example-com');
    expect(isId(`mail:${namespaceOf('__x__@y')}:u`)).toBe(true);
  });
});
