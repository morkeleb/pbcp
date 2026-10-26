import { isId } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { namespaceOf, toCard } from './mail.js';

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
const cfg = { account: 'morten-example-com', toPerson: 'morten' };

describe('toCard', () => {
  it('maps an INBOX message to a decision card with archive/keep', async () => {
    const c = await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, cfg);
    expect(isId(c.id)).toBe(true);
    expect(c.id).toMatch(/^mail:morten-example-com:[0-9a-f]{24}$/);
    expect(c).toMatchObject({
      protocol: 'pbcp/1',
      producer: 'mail',
      kind: 'decision',
      to_person: 'morten',
      title: 'Invoice timing for September',
      actions: ['archive', 'keep'],
      'x-imap-mailbox': 'INBOX',
      'x-imap-uid': 42,
      'x-imap-message-id': '<CA+abc=def@mail.example.com>',
    });
    expect(c.body).toContain('**From:** "Anna Berg" <anna@nordic.example>');
    expect(c.body).toContain('**Date:** 2026-10-07T13:02:11.000Z');
    expect(c.body).toContain('> Hi Morten,\n> \n> Can we pay on the 20th?\n> # not a heading');
    expect(c.body).not.toContain('line 20');
  });

  it('is deterministic, and the id ignores mailbox and uid', async () => {
    const a = await toCard({ mailbox: 'INBOX', uid: 42, source: anna }, cfg);
    const b = await toCard({ mailbox: 'Archive', uid: 7, source: Buffer.from(anna) }, cfg);
    expect(b.id).toBe(a.id);
    expect(b.thread).toBe(a.thread);
    expect(b.kind).toBe('artifact');
    expect('actions' in b).toBe(false);
  });

  it('threads by the server thread id when present, else the References root', async () => {
    const reply = raw({ From: 'x@y', Subject: 'Re', 'Message-ID': '<other@x>', 'In-Reply-To': '<root-1@mail.example.com>' }, 'ok');
    const root = raw({ From: 'x@y', Subject: 'Root', 'Message-ID': '<root-1@mail.example.com>' }, 'ok');
    const fromRefs = (await toCard({ mailbox: 'INBOX', uid: 1, source: anna }, cfg)).thread;
    expect((await toCard({ mailbox: 'INBOX', uid: 2, source: reply }, cfg)).thread).toBe(fromRefs);
    expect((await toCard({ mailbox: 'INBOX', uid: 3, source: root }, cfg)).thread).toBe(fromRefs);
    expect((await toCard({ mailbox: 'INBOX', uid: 1, threadId: '1781234567890', source: anna }, cfg)).thread).toBe('thr-1781234567890');
  });

  it('copes with a message lacking Message-ID, subject and text', async () => {
    const bare = 'From: a@b\r\n\r\n';
    const c = await toCard({ mailbox: 'Lists', uid: 9, source: bare }, cfg);
    expect(isId(c.id)).toBe(true);
    expect(c.title).toBe('(no subject)');
    expect(c.body).toBe('- **From:** a@b\n- **Date:** unknown');
    expect('x-imap-message-id' in c).toBe(false);
    expect((await toCard({ mailbox: 'Lists', uid: 9, source: bare }, cfg)).id).toBe(c.id);
  });
});

describe('namespaceOf', () => {
  it('turns an address into a grammar-valid namespace', () => {
    expect(namespaceOf('Morten.Nielsen+pbcp@Example.com')).toBe('morten-nielsen-pbcp-example-com');
    expect(isId(`mail:${namespaceOf('__x__@y')}:u`)).toBe(true);
  });
});
