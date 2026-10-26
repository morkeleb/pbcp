import { PbcpError, type ProducerCard } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { stubHead } from '../test/stub.js';
import { card } from './card.js';
import { HeadClient, HeadHttpError } from './head.js';

const sample = (over: Partial<ProducerCard> = {}): ProducerCard =>
  card({ producer: 'mail', namespace: 'acct', upstream: 'm1', kind: 'decision', to_person: 'morten', title: 'Hi', body: 'b', emitted_at: '2026-10-26T10:00:00Z', ...over });

function setup() {
  const stub = stubHead();
  return { stub, head: new HeadClient({ baseUrl: 'https://head.test/', token: 'tok', fetch: stub.fetch }) };
}

describe('HeadClient.submit', () => {
  it('returns 201 for a new card and 200 for a re-PUT', async () => {
    const { head } = setup();
    const first = await head.submit(sample());
    expect(first.status).toBe(201);
    expect(first.card.state).toBe('open');
    expect((await head.submit(sample())).status).toBe(200);
  });

  it('returns a 409 with the stored decided card instead of throwing', async () => {
    const { head, stub } = setup();
    await head.submit(sample());
    stub.decideHere('mail:acct:m1', { decision: 'approve' });
    const res = await head.submit(sample({ title: 'Changed' }));
    expect(res.status).toBe(409);
    expect(res.card).toMatchObject({ state: 'decided', decision: 'approve', title: 'Hi' });
  });

  it('sends the bearer token and URL-encodes the id', async () => {
    const { head, stub } = setup();
    await head.submit(sample());
    const req = stub.requests[0]!;
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('https://head.test/cards/mail%3Aacct%3Am1');
    expect(req.headers.authorization).toBe('Bearer tok');
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('throws a PbcpError carrying the body code on 400', async () => {
    const { head, stub } = setup();
    stub.script(400, { error: 'head_owned_field', message: 'state is head-owned' });
    const err = await head.submit(sample()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PbcpError);
    expect(err).toMatchObject({ status: 400, code: 'head_owned_field', message: 'state is head-owned' });
  });

  it('falls back to a status-appropriate code for unknown or mismatched codes', async () => {
    const { head, stub } = setup();
    stub.script(403, { error: 'nope' });
    await expect(head.submit(sample())).rejects.toMatchObject({ status: 403, code: 'outside_root' });
    stub.script(401, { error: 'too_large' });
    await expect(head.submit(sample())).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    stub.script(429, 'slow down');
    await expect(head.submit(sample())).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('throws HeadHttpError for statuses outside the protocol', async () => {
    const { head, stub } = setup();
    stub.script(500, { error: 'boom' });
    const err = await head.submit(sample()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeadHttpError);
    expect(err).toMatchObject({ status: 500, body: { error: 'boom' } });
  });
});

describe('HeadClient.sync and decide', () => {
  it('passes the cursor and returns the page', async () => {
    const { head, stub } = setup();
    await head.submit(sample());
    const page = await head.sync(0);
    expect(stub.requests.at(-1)!.url).toBe('https://head.test/changes?after=0');
    expect(page.changes.map((c) => c.card.id)).toEqual(['mail:acct:m1']);
    expect(page.next).toBe(1);
  });

  it('rejects a malformed sync body', async () => {
    const { head, stub } = setup();
    stub.script(200, { changes: [] });
    await expect(head.sync(0)).rejects.toBeInstanceOf(HeadHttpError);
  });

  it('decides via POST and returns the stored card; 404 is a HeadHttpError', async () => {
    const { head, stub } = setup();
    await head.submit(sample());
    const decided = await head.decide('mail:acct:m1', { decision: 'reject', comment: 'no' });
    expect(decided).toMatchObject({ state: 'decided', decision: 'reject', comment: 'no' });
    expect(stub.requests.at(-1)!).toMatchObject({ method: 'POST', url: 'https://head.test/cards/mail%3Aacct%3Am1/decision' });
    await expect(head.decide('mail:acct:nope', { decision: 'approve' })).rejects.toMatchObject({ name: 'HeadHttpError', status: 404 });
  });

  it('turns a 409 on decide into already_decided', async () => {
    const { head, stub } = setup();
    stub.script(409, { error: 'already_decided', message: 'x' });
    await expect(head.decide('mail:acct:m1', { decision: 'approve' })).rejects.toMatchObject({ code: 'already_decided' });
  });
});

describe('card()', () => {
  it('builds the id, protocol and producer, and stamps emitted_at', () => {
    const c = card({ producer: 'mail', namespace: 'acct', upstream: 'u.1', intent: 'reply', kind: 'signal', to_person: 'p', title: 't', body: '', 'x-a': 1 });
    expect(c).toMatchObject({ protocol: 'pbcp/1', id: 'mail:acct:u.1:reply', producer: 'mail', 'x-a': 1 });
    expect(c.emitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect('actions' in card({ producer: 'mail', namespace: 'a', upstream: 'u', kind: 'signal', to_person: 'p', title: 't', body: '', actions: undefined })).toBe(false);
  });

  it('refuses a card that would not pass the head', () => {
    expect(() => card({ producer: 'mail', namespace: 'a@b', upstream: 'u', kind: 'signal', to_person: 'p', title: 't', body: '' })).toThrow(PbcpError);
    expect(() => card({ producer: 'mail', namespace: 'a', upstream: 'u', kind: 'signal', to_person: 'p', title: 'two\nlines', body: '' })).toThrow(
      expect.objectContaining({ code: 'invalid_card' }),
    );
  });
});
