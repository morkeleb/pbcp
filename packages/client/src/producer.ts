// RFC §7.2 durable consumer: process every change, then advance the cursor — never before.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PbcpError, type Card, type ProducerCard } from '@pbcp/core';
import type { Change, HeadClient, SubmitResponse } from './head.js';

export interface CursorStore {
  get(): Promise<number>;
  set(n: number): Promise<void>;
}

export function memoryCursor(initial = 0): CursorStore {
  let value = initial;
  return {
    get: async () => value,
    set: async (n) => {
      value = n;
    },
  };
}

/** A JSON file `{ "after": n }`. A missing file is cursor 0; writes go through a temp file and rename. */
export function fileCursor(path: string): CursorStore {
  return {
    async get() {
      const json = await readJson(path);
      if (json === undefined) return 0;
      const after = (json as { after?: unknown } | null)?.after;
      if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) throw new Error(`${path}: not a cursor file`);
      return after;
    },
    set: (n) => writeJson(path, { after: n }),
  };
}

export interface StateStore<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A JSON object file of producer-local state, keyed by (say) card id. A missing file is empty; writes are atomic. */
export function fileState<T>(path: string): StateStore<T> {
  const load = async () => ((await readJson(path)) ?? {}) as Record<string, T>;
  return {
    async get(key) {
      const all = await load();
      return Object.hasOwn(all, key) ? all[key] : undefined;
    },
    async set(key, value) {
      await writeJson(path, { ...(await load()), [key]: value });
    },
    async delete(key) {
      const all = await load();
      if (!Object.hasOwn(all, key)) return;
      delete all[key];
      await writeJson(path, all);
    },
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`);
  await rename(tmp, path);
}

export interface ProducerOptions {
  head: Pick<HeadClient, 'submit' | 'sync'>;
  cursor: CursorStore;
  /** Cards to submit this pass; may be omitted by a pure listener. */
  produce?: () => AsyncIterable<ProducerCard> | Iterable<ProducerCard>;
  /** Called with every changed card, and with any non-open card a submit returns. Must be idempotent. */
  onDecision: (card: Card) => Promise<void>;
  intervalMs?: number;
  onError?: (err: unknown) => void;
  /** Failed onDecision attempts for one sync change before it is parked (§7.2). Default 5. */
  maxAttempts?: number;
  /** Reports a parked change; the cursor moves past it only once this returns. Default: console.error. */
  onParked?: (change: Change, error: unknown) => void | Promise<void>;
}

export interface PassResult {
  /** Set when the head answered 429 with Retry-After: wait at least this long before the next request (§7.4). */
  retryAfterMs?: number;
}

/**
 * One pass: submit produced cards, then sync until `next` stops moving. Never throws; failures go to onError.
 * `attempts` counts failed onDecision calls per change; pass the same map to every pass of one loop.
 */
export async function producerPass(opts: ProducerOptions, signal?: AbortSignal, attempts = new Map<string, number>()): Promise<PassResult> {
  const report = opts.onError ?? ((e: unknown) => console.error(e));
  const maxAttempts = opts.maxAttempts ?? 5;
  const onParked = opts.onParked ?? ((c: Change, e: unknown) => console.error(`pbcp: parked ${c.card.id} at seq ${c.seq} after ${maxAttempts} failed attempts`, e));
  const fail = (e: unknown): PassResult => {
    report(e);
    return e instanceof PbcpError && e.retryAfter !== undefined ? { retryAfterMs: e.retryAfter * 1000 } : {};
  };

  /** True when the cursor may move past this change: it was processed, or parked and reported. */
  const handle = async (change: Change): Promise<boolean> => {
    const key = `${change.card.id}@${change.seq}`;
    try {
      await opts.onDecision(change.card);
      attempts.delete(key);
      return true;
    } catch (e) {
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      if (n < maxAttempts) {
        report(e);
        return false;
      }
      try {
        await onParked(change, e);
      } catch (parkError) {
        report(parkError);
        return false;
      }
      attempts.delete(key);
      return true;
    }
  };

  if (opts.produce) {
    try {
      for await (const c of opts.produce()) {
        if (signal?.aborted) return {};
        let res: SubmitResponse;
        try {
          res = await opts.head.submit(c);
        } catch (e) {
          const r = fail(e);
          if (r.retryAfterMs !== undefined) return r;
          continue;
        }
        // The same change arrives through sync too, so a failure here is reported but never counted.
        if (res.card.state !== 'open') await opts.onDecision(res.card).catch(report);
      }
    } catch (e) {
      report(e);
    }
  }

  try {
    while (!signal?.aborted) {
      const after = await opts.cursor.get();
      const page = await opts.head.sync(after);
      if (page.next < after) {
        report(new Error(`sync after ${after} returned next ${page.next}; the cursor is not moved`));
        return {};
      }
      for (const change of page.changes) if (!(await handle(change))) return {};
      if (page.next === after) return {};
      await opts.cursor.set(page.next);
    }
  } catch (e) {
    return fail(e);
  }
  return {};
}

/** Runs passes back to back, `intervalMs` (default 60 s) apart, or longer when the head asks (Retry-After); never overlapping. */
export function runProducer(opts: ProducerOptions): { stop(): Promise<void> } {
  const ac = new AbortController();
  const attempts = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const loop = (async () => {
    while (!ac.signal.aborted) {
      const { retryAfterMs = 0 } = await producerPass(opts, ac.signal, attempts);
      if (ac.signal.aborted) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, Math.max(opts.intervalMs ?? 60_000, retryAfterMs));
      });
    }
  })();

  return {
    async stop() {
      ac.abort();
      clearTimeout(timer);
      wake?.();
      await loop;
    },
  };
}
