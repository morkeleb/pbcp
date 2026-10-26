import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PbcpError, type Card, type ProducerCard } from '@pbcp/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubHead } from '../test/stub.js';
import { card } from './card.js';
import { HeadClient, type Change } from './head.js';
import { fileCursor, fileState, memoryCursor, producerPass, runProducer } from './producer.js';

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
    const cursor = memoryCursor();
    await producerPass({ ...t, cursor, produce: () => [mk('a'), mk('b')] });
    expect([...t.stub.cards.keys()]).toEqual(['mail:acct:a', 'mail:acct:b']);
    expect(t.seen.map((c) => c.id)).toEqual(['mail:acct:a', 'mail:acct:b']);
    expect(await cursor.get()).toBe(2);
    expect(t.errors).toEqual([]);
  });

  it('calls onDecision for a submit that comes back decided (200 or 409)', async () => {
    const t = setup();
    const cursor = memoryCursor();
    await producerPass({ ...t, cursor, produce: () => [mk('a'), mk('b')] });
    t.stub.decideHere('mail:acct:a', { decision: 'approve' });
    t.stub.decideHere('mail:acct:b', { decision: 'reject' });
    await cursor.set(100); // so only the submit path can deliver them
    t.seen.length = 0;
    await producerPass({ ...t, cursor, produce: () => [mk('a'), mk('b', 'changed')] });
    expect(t.seen.map((c) => [c.id, c.decision])).toEqual([
      ['mail:acct:a', 'approve'],
      ['mail:acct:b', 'reject'],
    ]);
  });

  it('reports a failing submit and carries on with the next card', async () => {
    const t = setup();
    t.stub.script(500, 'down');
    await producerPass({ ...t, cursor: memoryCursor(), produce: () => [mk('a'), mk('b')] });
    expect(t.errors).toHaveLength(1);
    expect([...t.stub.cards.keys()]).toEqual(['mail:acct:b']);
  });

  it('loops over capped sync pages until next stops moving', async () => {
    const t = setup(1);
    const cursor = memoryCursor();
    for (const u of ['a', 'b', 'c']) await t.head.submit(mk(u));
    await producerPass({ ...t, cursor });
    expect(t.seen.map((c) => c.id)).toEqual(['mail:acct:a', 'mail:acct:b', 'mail:acct:c']);
    expect(await cursor.get()).toBe(3);
    expect(t.stub.requests.filter((r) => r.url.includes('/changes')).map((r) => new URL(r.url).searchParams.get('after'))).toEqual(['0', '1', '2', '3']);
  });

  it('does not advance the cursor when onDecision throws, and re-delivers next pass', async () => {
    const t = setup();
    const cursor = memoryCursor();
    await t.head.submit(mk('a'));
    t.stub.decideHere('mail:acct:a', { decision: 'approve' });
    const failing = vi.fn(async () => {
      throw new Error('imap down');
    });
    await producerPass({ ...t, cursor, onDecision: failing });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(t.errors).toEqual([new Error('imap down')]);
    expect(await cursor.get()).toBe(0);

    await producerPass({ ...t, cursor });
    expect(t.seen.map((c) => [c.id, c.decision])).toEqual([['mail:acct:a', 'approve']]);
    expect(await cursor.get()).toBe(2);
  });

  it('ends the pass on a sync error without touching the cursor', async () => {
    const t = setup();
    const cursor = memoryCursor(5);
    t.stub.script(503, 'later');
    await producerPass({ ...t, cursor });
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
    const cursor = memoryCursor();
    for (const u of ['a', 'b', 'c']) await t.head.submit(mk(u));
    const parked: [Change, unknown][] = [];
    const attempts = new Map<string, number>();
    const opts = { ...t, cursor, onDecision: failOn(t, 'mail:acct:a'), maxAttempts: 3, onParked: (c: Change, e: unknown) => void parked.push([c, e]) };

    for (let pass = 1; pass < 3; pass++) {
      await producerPass(opts, undefined, attempts);
      expect(await cursor.get()).toBe(0);
      expect(t.seen).toEqual([]);
      expect(parked).toEqual([]);
    }
    await producerPass(opts, undefined, attempts);
    expect(parked).toHaveLength(1);
    expect(parked[0]![0]).toMatchObject({ seq: 1, card: { id: 'mail:acct:a' } });
    expect(parked[0]![1]).toEqual(new Error('cannot process mail:acct:a'));
    expect(t.seen.map((c) => c.id)).toEqual(['mail:acct:b', 'mail:acct:c']);
    expect(await cursor.get()).toBe(3);
    expect(t.errors).toHaveLength(2);
    expect(attempts.size).toBe(0);
  });

  it('does not advance when onParked throws', async () => {
    const t = setup();
    const cursor = memoryCursor();
    await t.head.submit(mk('a'));
    const attempts = new Map<string, number>();
    const onParked = vi.fn(() => {
      throw new Error('cannot report');
    });
    const opts = { ...t, cursor, onDecision: failOn(t, 'mail:acct:a'), maxAttempts: 2, onParked };
    for (let pass = 0; pass < 3; pass++) await producerPass(opts, undefined, attempts);
    expect(onParked).toHaveBeenCalledTimes(2);
    expect(t.errors.at(-1)).toEqual(new Error('cannot report'));
    expect(await cursor.get()).toBe(0);
  });

  it('does not park a change that fails twice and then succeeds', async () => {
    const t = setup();
    const cursor = memoryCursor();
    await t.head.submit(mk('a'));
    const attempts = new Map<string, number>();
    const onParked = vi.fn();
    const opts = { ...t, cursor, onDecision: failOn(t, 'mail:acct:a', 2), maxAttempts: 3, onParked };
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
    const opts = { ...t, cursor: memoryCursor(100), produce: () => [mk('a')], onDecision: failOn(t, 'mail:acct:a'), maxAttempts: 1, onParked };
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
    const res = await producerPass({ ...t, cursor: memoryCursor(), produce: () => [mk('a'), mk('b')] });
    expect(res).toEqual({ retryAfterMs: 7000 });
    expect(t.stub.requests).toHaveLength(1);
    expect(t.errors[0]).toBeInstanceOf(PbcpError);
  });

  it('returns the wait on a 429 from sync without moving the cursor', async () => {
    const t = setup();
    const cursor = memoryCursor(4);
    t.stub.script(429, { error: 'rate_limited' }, { 'retry-after': '3' });
    expect(await producerPass({ ...t, cursor })).toEqual({ retryAfterMs: 3000 });
    expect(await cursor.get()).toBe(4);
  });

  it('reports next < after as an error and leaves the cursor', async () => {
    const t = setup();
    const cursor = memoryCursor(9);
    t.stub.script(200, { changes: [], next: 2 });
    expect(await producerPass({ ...t, cursor })).toEqual({});
    expect(t.errors).toHaveLength(1);
    expect(String(t.errors[0])).toMatch(/after 9 returned next 2/);
    expect(await cursor.get()).toBe(9);
  });
});

describe('fileState', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('is empty when missing, round-trips, deletes, and leaves no temp file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pbcp-state-'));
    const path = join(dir, 'nested', 'state.json');
    const s = fileState<{ uid: number }>(path);
    expect(await s.get('a')).toBeUndefined();
    await s.delete('a');
    await s.set('a', { uid: 1 });
    await s.set('b', { uid: 2 });
    expect(await fileState(path).get('a')).toEqual({ uid: 1 });
    await s.delete('a');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ b: { uid: 2 } });
    expect(await readdir(join(dir, 'nested'))).toEqual(['state.json']);
  });
});

describe('fileCursor', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('reads 0 when missing, round-trips, and leaves no temp file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pbcp-cursor-'));
    const path = join(dir, 'nested', 'cursor.json');
    expect(await fileCursor(path).get()).toBe(0);
    await fileCursor(path).set(42);
    expect(await fileCursor(path).get()).toBe(42);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ after: 42 });
    expect(await readdir(join(dir, 'nested'))).toEqual(['cursor.json']);
  });

  it('refuses a file that is not a cursor', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pbcp-cursor-'));
    const path = join(dir, 'c.json');
    await writeFile(path, '{"after":-1}');
    await expect(fileCursor(path).get()).rejects.toThrow(/not a cursor/);
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
    const run = runProducer({ ...t, cursor: memoryCursor(), produce, intervalMs: 5 });
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
      cursor: memoryCursor(),
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
    const run = runProducer({ ...t, cursor: memoryCursor(), intervalMs: 1 });
    await vi.waitFor(() => expect(t.stub.requests).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(t.stub.requests).toHaveLength(1);
    await run.stop();
  });
});
