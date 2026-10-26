// RFC §7.2 durable consumer: process every change, then advance the cursor — never before.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Card, ProducerCard } from '@pbcp/core';
import type { HeadClient } from './head.js';

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
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw e;
      }
      const after = (JSON.parse(text) as { after?: unknown }).after;
      if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) throw new Error(`${path}: not a cursor file`);
      return after;
    },
    async set(n) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ after: n })}\n`);
      await rename(tmp, path);
    },
  };
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
}

/** One pass: submit produced cards, then sync until `next` stops moving. Never throws; failures go to onError. */
export async function producerPass(opts: ProducerOptions, signal?: AbortSignal): Promise<void> {
  const report = opts.onError ?? ((e: unknown) => console.error(e));

  if (opts.produce) {
    try {
      for await (const c of opts.produce()) {
        if (signal?.aborted) return;
        try {
          const res = await opts.head.submit(c);
          if (res.card.state !== 'open') await opts.onDecision(res.card);
        } catch (e) {
          report(e);
        }
      }
    } catch (e) {
      report(e);
    }
  }

  try {
    while (!signal?.aborted) {
      const after = await opts.cursor.get();
      const page = await opts.head.sync(after);
      for (const change of page.changes) await opts.onDecision(change.card);
      if (page.next <= after) return;
      await opts.cursor.set(page.next);
    }
  } catch (e) {
    report(e);
  }
}

/** Runs passes back to back, `intervalMs` (default 60 s) apart, never overlapping. */
export function runProducer(opts: ProducerOptions): { stop(): Promise<void> } {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const loop = (async () => {
    while (!ac.signal.aborted) {
      await producerPass(opts, ac.signal);
      if (ac.signal.aborted) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, opts.intervalMs ?? 60_000);
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
