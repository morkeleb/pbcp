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

  it('throws a PbcpError for a 409 error body rather than treating it as a card', async () => {
    const { head, stub } = setup();
    stub.script(409, { error: 'already_superseded', message: 'gone' });
    const err = await head.submit(sample()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PbcpError);
    expect(err).toMatchObject({ status: 409, code: 'already_superseded', message: 'gone' });
  });

  it('throws HeadHttpError when the body has no known code bound to the status', async () => {
    const { head, stub } = setup();
    stub.script(403, { error: 'nope' });
    await expect(head.submit(sample())).rejects.toMatchObject({ name: 'HeadHttpError', status: 403, body: { error: 'nope' } });
    stub.script(401, { error: 'too_large' });
    await expect(head.submit(sample())).rejects.toMatchObject({ name: 'HeadHttpError', status: 401 });
    stub.script(429, 'slow down');
    await expect(head.submit(sample())).rejects.toMatchObject({ name: 'HeadHttpError', status: 429, body: 'slow down' });
    stub.script(500, { error: 'boom' });
    await expect(head.submit(sample())).rejects.toMatchObject({ name: 'HeadHttpError', status: 500, body: { error: 'boom' } });
  });

  it('carries Retry-After seconds on a 429, and ignores an HTTP-date', async () => {
    const { head, stub } = setup();
    stub.script(429, { error: 'rate_limited', message: 'slow' }, { 'retry-after': '7' });
    const err = await head.submit(sample()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PbcpError);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 7 });
    stub.script(429, { error: 'rate_limited' }, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    expect(await head.submit(sample()).catch((e: PbcpError) => e.retryAfter)).toBeUndefined();
  });
});

describe('HeadClient.describe', () => {
  it('returns the head description from GET /', async () => {
    const { head, stub } = setup();
    expect(await head.describe()).toEqual({ protocol: 'pbcp/1', owner: 'morten', extensions: [], render: { mermaid: ['core'] } });
    expect(stub.requests[0]).toMatchObject({ method: 'GET', url: 'https://head.test/', headers: { authorization: 'Bearer tok' } });
  });

  it('rejects a body that is not a head description', async () => {
    const { head, stub } = setup();
    stub.script(200, { protocol: 'pbcp/1', extensions: [] });
    await expect(head.describe()).rejects.toMatchObject({ name: 'HeadHttpError', status: 200 });
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

  it('decides via POST and returns the stored card; 404 is not_found', async () => {
    const { head, stub } = setup();
    await head.submit(sample());
    const decided = await head.decide('mail:acct:m1', { decision: 'reject', comment: 'no' });
    expect(decided).toMatchObject({ status: 200, card: { state: 'decided', decision: 'reject', comment: 'no' } });
    expect(stub.requests.at(-1)!).toMatchObject({ method: 'POST', url: 'https://head.test/cards/mail%3Aacct%3Am1/decision' });
    await expect(head.decide('mail:acct:nope', { decision: 'approve' })).rejects.toMatchObject({ name: 'PbcpError', status: 404, code: 'not_found' });
  });

  it('returns a 409 on decide with the stored card (§7.3)', async () => {
    const { head } = setup();
    await head.submit(sample());
    await head.decide('mail:acct:m1', { decision: 'reject' });
    const again = await head.decide('mail:acct:m1', { decision: 'approve' });
    expect(again).toMatchObject({ status: 409, card: { state: 'decided', decision: 'reject' } });
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
