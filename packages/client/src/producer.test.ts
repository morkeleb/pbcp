import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PbcpError, type Card, type ProducerCard } from '@pbcp/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubHead } from './testing.js';
import { card } from './card.js';
import { HeadClient } from './head.js';
import { producerPass, runProducer, type Parked } from './producer.js';
import { fileCursor, fileState, fileStore, memoryCursor, memoryStore } from './store.js';

const mk = (upstream: string, title = 'T'): ProducerCard =>
  card({ producer: 'mail', namespace: 'acct', upstream, kind: 'decision', to_person: 'morten', title, body: 'b' });

function setup(pageSize?: number) {
  const stub = stubHead({ pageSize });
  const head = new HeadClient({ baseUrl: 'https://head.test', token: 't', fetch: stub.fetch });
  const seen: Card[] = [];
  const errors: unknown[] = [];
  return { stub, head, seen, errors, onDecision: async (c: Card) => void seen.push(c), onError: (e: unknown) => void errors.push(e) };
}

describe('producerPass', () => {
  it('submits produced cards and syncs them back, advancing the cursor', async () => {
    const t = setup();
    const cursor = memoryStore();
    await producerPass({ ...t, store: cursor, produce: () => [mk('a'), mk('b')] });
    expect([...t.stub.cards.keys()]).toEqual(['mail:acct:a', 'mail:acct:b']);
    expect(t.seen.map((c) => c.id)).toEqual(['mail:acct:a', 'mail:acct:b']);
    expect(await cursor.get()).toBe(2);
    expect(t.errors).toEqual([]);
  });

  it('calls onDecision for a submit that comes back decided (200 or 409)', async () => {
    const t = setup();
    const cursor = memoryStore();
    await producerPass({ ...t, store: cursor, produce: () => [mk('a'), mk('b')] });
    t.stub.decideHere('mail:acct:a', { decision: 'approve' });
    t.stub.decideHere('mail:acct:b', { decision: 'reject' });
    await cursor.set(100); // so only the submit path can deliver them
    t.seen.length = 0;
    await producerPass({ ...t, store: cursor, produce: () => [mk('a'), mk('b', 'changed')] });
    expect(t.seen.map((c) => [c.id, c.decision])).toEqual([
      ['mail:acct:a', 'approve'],
      ['mail:acct:b', 'reject'],
    ]);
  });

  it('reports a failing submit and carries on with the next card', async () => {
    const t = setup();
    t.stub.script(500, 'down');
    await producerPass({ ...t, store: memoryStore(), produce: () => [mk('a'), mk('b')] });
    expect(t.errors).toHaveLength(1);
    expect([...t.stub.cards.keys()]).toEqual(['mail:acct:b']);
  });

  it('loops over capped sync pages until next stops moving', async () => {
    const t = setup(1);
    const cursor = memoryStore();
    for (const u of ['a', 'b', 'c']) await t.head.submit(mk(u));
    await producerPass({ ...t, store: cursor });
    expect(t.seen.map((c) => c.id)).toEqual(['mail:acct:a', 'mail:acct:b', 'mail:acct:c']);
    expect(await cursor.get()).toBe(3);
    expect(t.stub.requests.filter((r) => r.url.includes('/changes')).map((r) => new URL(r.url).searchParams.get('after'))).toEqual(['0', '1', '2', '3']);
  });

  it('does not advance the cursor when onDecision throws, and re-delivers next pass', async () => {
    const t = setup();
    const cursor = memoryStore();
    await t.head.submit(mk('a'));
    t.stub.decideHere('mail:acct:a', { decision: 'approve' });
    const failing = vi.fn(async () => {
      throw new Error('imap down');
    });
    await producerPass({ ...t, store: cursor, onDecision: failing });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(t.errors).toEqual([new Error('imap down')]);
    expect(await cursor.get()).toBe(0);

    await producerPass({ ...t, store: cursor });
    expect(t.seen.map((c) => [c.id, c.decision])).toEqual([['mail:acct:a', 'approve']]);
    expect(await cursor.get()).toBe(2);
  });

  it('ends the pass on a sync error without touching the cursor', async () => {
    const t = setup();
    const cursor = memoryStore(5);
    t.stub.script(503, 'later');
    await producerPass({ ...t, store: cursor });
    expect(t.errors).toHaveLength(1);
    expect(await cursor.get()).toBe(5);
  });
});

describe('parking (§7.2)', () => {
  const failOn = (t: ReturnType<typeof setup>, id: string, times = Infinity) => {
    let failures = 0;
    return vi.fn(async (c: Card) => {
      if (c.id === id && failures < times) {
        failures++;
        throw new Error(`cannot process ${id}`);
      }
      await t.onDecision(c);
    });
  };

  it('C23 a parked change: the cursor advances and onParked fires', async () => {
    const t = setup();
    const cursor = memoryStore();
    for (const u of ['a', 'b', 'c']) await t.head.submit(mk(u));
    const parked: [Parked, unknown][] = [];
    const attempts = new Map<string, number>();
    const opts = { ...t, store: cursor, onDecision: failOn(t, 'mail:acct:a'), maxAttempts: 3, onParked: (p: Parked, e: unknown) => void parked.push([p, e]) };

    for (let pass = 1; pass < 3; pass++) {
      await producerPass(opts, undefined, attempts);
      expect(await cursor.get()).toBe(0);
      expect(t.seen).toEqual([]);
      expect(parked).toEqual([]);
    }
    await producerPass(opts, undefined, attempts);
    expect(parked).toHaveLength(1);
    expect(parked[0]![0]).toMatchObject({ from: 'sync', seq: 1, card: { id: 'mail:acct:a' } });
    expect(parked[0]![1]).toEqual(new Error('cannot process mail:acct:a'));
    expect(t.seen.map((c) => c.id)).toEqual(['mail:acct:b', 'mail:acct:c']);
    expect(await cursor.get()).toBe(3);
    expect(t.errors).toHaveLength(2);
    expect(attempts.size).toBe(0);
  });

  it('does not advance when onParked throws', async () => {
    const t = setup();
    const cursor = memoryStore();
    await t.head.submit(mk('a'));
    const attempts = new Map<string, number>();
    const onParked = vi.fn(() => {
      throw new Error('cannot report');
    });
    const opts = { ...t, store: cursor, onDecision: failOn(t, 'mail:acct:a'), maxAttempts: 2, onParked };
    for (let pass = 0; pass < 3; pass++) await producerPass(opts, undefined, attempts);
    expect(onParked).toHaveBeenCalledTimes(2);
    expect(t.errors.at(-1)).toEqual(new Error('cannot report'));
    expect(await cursor.get()).toBe(0);
  });

  it('does not park a change that fails twice and then succeeds', async () => {
    const t = setup();
    const cursor = memoryStore();
    await t.head.submit(mk('a'));
    const attempts = new Map<string, number>();
    const onParked = vi.fn();
    const opts = { ...t, store: cursor, onDecision: failOn(t, 'mail:acct:a', 2), maxAttempts: 3, onParked };
    for (let pass = 0; pass < 3; pass++) await producerPass(opts, undefined, attempts);
    expect(onParked).not.toHaveBeenCalled();
    expect(t.seen.map((c) => c.id)).toEqual(['mail:acct:a']);
    expect(await cursor.get()).toBe(1);
    expect(attempts.size).toBe(0);
  });

  it('never counts failures on the submit path', async () => {
    const t = setup();
    await t.head.submit(mk('a'));
    t.stub.decideHere('mail:acct:a', { decision: 'approve' });
    const attempts = new Map<string, number>();
    const onParked = vi.fn();
    const opts = { ...t, store: memoryStore(100), produce: () => [mk('a')], onDecision: failOn(t, 'mail:acct:a'), maxAttempts: 1, onParked };
    await producerPass(opts, undefined, attempts);
    expect(t.errors).toHaveLength(1);
    expect(onParked).not.toHaveBeenCalled();
    expect(attempts.size).toBe(0);
  });
});

describe('Retry-After and next < after', () => {
  it('stops the pass on a 429 from submit and returns the wait', async () => {
    const t = setup();
    t.stub.script(429, { error: 'rate_limited' }, { 'retry-after': '7' });
    const res = await producerPass({ ...t, store: memoryStore(), produce: () => [mk('a'), mk('b')] });
    expect(res).toEqual({ retryAfterMs: 7000 });
    expect(t.stub.requests).toHaveLength(1);
    expect(t.errors[0]).toBeInstanceOf(PbcpError);
  });

  it('returns the wait on a 429 from sync without moving the cursor', async () => {
    const t = setup();
    const cursor = memoryStore(4);
    t.stub.script(429, { error: 'rate_limited' }, { 'retry-after': '3' });
    expect(await producerPass({ ...t, store: cursor })).toEqual({ retryAfterMs: 3000 });
    expect(await cursor.get()).toBe(4);
  });

  it('reports next < after as an error and leaves the cursor', async () => {
    const t = setup();
    const cursor = memoryStore(9);
    t.stub.script(200, { changes: [], next: 2 });
    expect(await producerPass({ ...t, store: cursor })).toEqual({});
    expect(t.errors).toHaveLength(1);
    expect(String(t.errors[0])).toMatch(/after 9 returned next 2/);
    expect(await cursor.get()).toBe(9);
  });
});

describe('onSubmitted and ordering', () => {
  it('reports each answered submit before produce() resumes, and never runs onDecision inside produce()', async () => {
    const t = setup();
    await t.head.submit(mk('a'));
    t.stub.decideHere('mail:acct:a', { decision: 'approve' });
    const log: string[] = [];
    const produce = async function* () {
      for (const u of ['a', 'b']) {
        log.push(`yield ${u}`);
        yield mk(u, u === 'a' ? 'T' : 'B');
        log.push(`resumed ${u}`);
      }
      log.push('produce done');
    };
    await producerPass({
      ...t,
      store: memoryStore(100),
      produce,
      onSubmitted: (c, r) => void log.push(`submitted ${c.id} ${r.status}`),
      onDecision: async (c) => void log.push(`decision ${c.id} ${c.state}`),
    });
    expect(log).toEqual([
      'yield a', 'submitted mail:acct:a 200', 'resumed a',
      'yield b', 'submitted mail:acct:b 201', 'resumed b',
      'produce done',
      'decision mail:acct:a decided',
    ]);
  });

  it('passes a 409 to onSubmitted and does not call it for a refused or failed submit', async () => {
    const t = setup();
    await t.head.submit(mk('a'));
    t.stub.decideHere('mail:acct:a', { decision: 'reject' });
    t.stub.script(500, 'boom');
    const seen: [string, number][] = [];
    await producerPass({ ...t, store: memoryStore(100), produce: () => [mk('x'), mk('a', 'Changed')], onSubmitted: (c, r) => void seen.push([c.id, r.status]) });
    expect(seen).toEqual([['mail:acct:a', 409]]);
    expect(t.errors).toHaveLength(1);
  });

  it('reports an onSubmitted failure and carries on', async () => {
    const t = setup();
    await producerPass({ ...t, store: memoryStore(), produce: () => [mk('a'), mk('b')], onSubmitted: async () => { throw new Error('disk full'); } });
    expect(t.stub.cards.size).toBe(2);
    expect(t.errors).toEqual([new Error('disk full'), new Error('disk full')]);
  });
});

describe('a 409 on submit', () => {
  it('stops sending the same content for as long as the loop runs, but sends a changed card', async () => {
    const t = setup();
    await t.head.submit(mk('a'));
    t.stub.decideHere('mail:acct:a', { decision: 'approve' });
    const attempts = new Map<string, number>();
    let title = 'Changed';
    const submitted: number[] = [];
    const opts = { ...t, store: memoryStore(100), produce: () => [mk('a', title)], onSubmitted: (_c: ProducerCard, r: { status: number }) => void submitted.push(r.status) };
    for (let pass = 0; pass < 3; pass++) await producerPass(opts, undefined, attempts);
    expect(submitted).toEqual([409]);
    expect(t.stub.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    title = 'Changed again';
    await producerPass(opts, undefined, attempts);
    expect(submitted).toEqual([409, 409]);
  });
});

describe('parking on the submit path (§7.2)', () => {
  it('parks a card the head keeps refusing with a 4xx, reports it, and stops sending it', async () => {
    const t = setup();
    const attempts = new Map<string, number>();
    const parked: [Parked, unknown][] = [];
    const wrong = { ...mk('a'), to_person: 'someone-else' };
    const opts = { ...t, store: memoryStore(), produce: () => [wrong, mk('b')], maxAttempts: 2, onParked: (p: Parked, e: unknown) => void parked.push([p, e]) };
    await producerPass(opts, undefined, attempts);
    expect(parked).toEqual([]);
    await producerPass(opts, undefined, attempts);
    expect(parked).toHaveLength(1);
    expect(parked[0]![0]).toEqual({ from: 'submit', card: wrong });
    expect(parked[0]![1]).toMatchObject({ status: 403, code: 'wrong_person' });
    const puts = () => t.stub.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('mail%3Aacct%3Aa')).length;
    expect(puts()).toBe(2);
    await producerPass(opts, undefined, attempts);
    expect(puts()).toBe(2);
    expect(t.stub.cards.has('mail:acct:b')).toBe(true);
  });

  it('starts over when the refused card changes', async () => {
    const t = setup();
    const attempts = new Map<string, number>();
    const onParked = vi.fn();
    let title = 'T';
    const produce = () => [{ ...mk('a', title), to_person: 'someone-else' }];
    const opts = { ...t, store: memoryStore(), produce, maxAttempts: 2, onParked };
    await producerPass(opts, undefined, attempts);
    title = 'T2';
    await producerPass(opts, undefined, attempts);
    expect(onParked).not.toHaveBeenCalled();
  });

  it('never parks on 401, 429 or 5xx', async () => {
    const t = setup();
    const attempts = new Map<string, number>();
    const onParked = vi.fn();
    const opts = { ...t, store: memoryStore(), produce: () => [mk('a')], maxAttempts: 1, onParked };
    for (const [status, body] of [[401, { error: 'unauthorized' }], [500, 'boom'], [429, { error: 'rate_limited' }]] as const) {
      t.stub.script(status, body);
      await producerPass(opts, undefined, attempts);
    }
    expect(onParked).not.toHaveBeenCalled();
    expect(t.errors).toHaveLength(3);
  });
});

describe('fileStore', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('keeps the cursor and namespaced state in one file, and leaves no temp file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pbcp-store-'));
    const path = join(dir, 'nested', 'store.json');
    const s = fileStore(path);
    expect(await s.get()).toBe(0);
    const kv = s.kv<{ uid: number }>('mail');
    expect(await kv.get('a')).toBeUndefined();
    await kv.delete('a');
    await Promise.all([s.set(42), kv.set('a', { uid: 1 }), kv.set('b', { uid: 2 }), s.kv('other').set('a', 'x')]);
    expect(await fileStore(path).get()).toBe(42);
    expect(await fileStore(path).kv('mail').get('a')).toEqual({ uid: 1 });
    await kv.delete('a');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ after: 42, state: { mail: { b: { uid: 2 } }, other: { a: 'x' } } });
    expect(await readdir(join(dir, 'nested'))).toEqual(['store.json']);
  });

  it('lists keys by prefix, sorted', async () => {
    const kv = memoryStore().kv<number>('n');
    for (const k of ['risk:b', 'approval:x', 'risk:a']) await kv.set(k, 1);
    expect(await kv.keys('risk:')).toEqual(['risk:a', 'risk:b']);
    expect(await kv.keys()).toEqual(['approval:x', 'risk:a', 'risk:b']);
  });

  it('reads a 0.3 cursor file, writes one back while there is no state, and refuses anything else', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pbcp-store-'));
    const path = join(dir, 'c.json');
    await writeFile(path, '{"after":7}\n');
    expect(await fileStore(path).get()).toBe(7);
    await fileCursor(path).set(8);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ after: 8 });
    expect(await memoryCursor(3).get()).toBe(3);
    await writeFile(path, '{"after":-1}');
    await expect(fileStore(path).get()).rejects.toThrow(/not a store file/);
  });

  it('keeps the deprecated fileState format: one flat object', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pbcp-store-'));
    const path = join(dir, 'state.json');
    const s = fileState<number>(path);
    await s.set('a', 1);
    await s.set('b', 2);
    await s.delete('a');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ b: 2 });
    expect(await s.keys()).toEqual(['b']);
  });
});

describe('runProducer', () => {
  it('stop() waits for the in-flight pass and no further pass starts', async () => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let passes = 0;
    const produce = async function* () {
      passes++;
      await gate;
      yield mk('a');
    };
    const run = runProducer({ ...t, store: memoryStore(), produce, intervalMs: 5 });
    await vi.waitFor(() => expect(passes).toBe(1));

    let stopped = false;
    const stopping = run.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(passes).toBe(1);
    expect(t.stub.cards.size).toBe(0); // aborted before submitting
  });

  it('runs passes back to back at the interval until stopped', async () => {
    const t = setup();
    let passes = 0;
    const run = runProducer({
      ...t,
      store: memoryStore(),
      produce: () => {
        passes++;
        return [];
      },
      intervalMs: 1,
    });
    await vi.waitFor(() => expect(passes).toBeGreaterThanOrEqual(3));
    await run.stop();
    const after = passes;
    await new Promise((r) => setTimeout(r, 10));
    expect(passes).toBe(after);
  });

  it('waits for Retry-After instead of the interval', async () => {
    const t = setup();
    t.stub.script(429, { error: 'rate_limited' }, { 'retry-after': '1' });
    const run = runProducer({ ...t, store: memoryStore(), intervalMs: 1 });
    await vi.waitFor(() => expect(t.stub.requests).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(t.stub.requests).toHaveLength(1);
    await run.stop();
  });
});
