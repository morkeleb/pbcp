// RFC §7.2 durable consumer: process every change, then advance the cursor — never before.

import { PbcpError, toJSON, type Card, type ProducerCard } from '@pbcp/core';
import { HeadHttpError, type Change, type HeadClient, type SubmitResponse } from './head.js';
import type { CursorStore } from './store.js';

/** A change the producer gave up on (§7.2): a sync change whose `onDecision` kept failing, or a card the head kept refusing. */
export type Parked = { from: 'sync'; seq: number; card: Card } | { from: 'submit'; card: ProducerCard };

export interface ProducerOptions {
  head: Pick<HeadClient, 'submit' | 'sync'>;
  /** The cursor, usually a StateStore (`fileStore`) that also holds the connector's own state. */
  store?: CursorStore;
  /** @deprecated since 0.4: use `store`. Removed in 0.5. */
  cursor?: CursorStore;
  /** Cards to submit this pass; may be omitted by a pure listener. Runs to completion before any `onDecision` call. */
  produce?: () => AsyncIterable<ProducerCard> | Iterable<ProducerCard>;
  /**
   * Called once for every card the head answered (201, 200 or 409), before `produce()` is resumed for the next card,
   * so a connector can record local state only once the head has the card. Not called for a refused or failed submit.
   */
  onSubmitted?: (card: ProducerCard, result: SubmitResponse) => void | Promise<void>;
  /**
   * Called after `produce()` has finished: first for each non-open card a submit returned, then for every sync
   * change in order. Never runs while `produce()` is suspended. Must be idempotent.
   */
  onDecision: (card: Card) => Promise<void>;
  intervalMs?: number;
  onError?: (err: unknown) => void;
  /** Failed attempts before a change is parked (§7.2): `onDecision` for a sync change, or a refused submit. Default 5. */
  maxAttempts?: number;
  /** Reports a parked change; it is skipped (sync: the cursor moves past it) only once this returns. Default: console.error. */
  onParked?: (parked: Parked, error: unknown) => void | Promise<void>;
}

export interface PassResult {
  /** Set when the head answered 429 with Retry-After: wait at least this long before the next request (§7.4). */
  retryAfterMs?: number;
}

/** A refusal that sending the same card again cannot fix: a 4xx other than 401 (credentials), 408 and 429. */
const permanent = (e: unknown) => {
  const status = e instanceof PbcpError || e instanceof HeadHttpError ? e.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
};

/** A submitted card's identity for attempt counting: its id and content, `emitted_at` aside, so a revised card starts over. */
const submitKey = (c: ProducerCard) => `submit ${toJSON({ ...c, emitted_at: '' })}`;

const PARKED = Number.POSITIVE_INFINITY;

/**
 * One pass: submit produced cards, then call onDecision for decided submit results, then sync until `next` stops
 * moving. Never throws; failures go to onError. `attempts` counts failures per sync change and per refused card,
 * and remembers parked cards; pass the same map to every pass of one loop.
 */
export async function producerPass(opts: ProducerOptions, signal?: AbortSignal, attempts = new Map<string, number>()): Promise<PassResult> {
  const store = opts.store ?? opts.cursor;
  if (!store) throw new TypeError('producerPass: `store` is required');
  const report = opts.onError ?? ((e: unknown) => console.error(e));
  const maxAttempts = opts.maxAttempts ?? 5;
  const onParked =
    opts.onParked ??
    ((p: Parked, e: unknown) =>
      console.error(`pbcp: parked ${p.card.id}${p.from === 'sync' ? ` at seq ${p.seq}` : ' (submit)'} after ${maxAttempts} failed attempts`, e));
  const fail = (e: unknown): PassResult => {
    report(e);
    return e instanceof PbcpError && e.retryAfter !== undefined ? { retryAfterMs: e.retryAfter * 1000 } : {};
  };

  /** Counts a failure under `key`; at maxAttempts reports it through onParked. True once parked. */
  const strike = async (key: string, parked: Parked, e: unknown): Promise<boolean> => {
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    if (n < maxAttempts) {
      report(e);
      return false;
    }
    try {
      await onParked(parked, e);
    } catch (parkError) {
      report(parkError);
      return false;
    }
    return true;
  };

  /** True when the cursor may move past this change: it was processed, or parked and reported. */
  const handle = async (change: Change): Promise<boolean> => {
    const key = `sync ${change.card.id}@${change.seq}`;
    try {
      await opts.onDecision(change.card);
      attempts.delete(key);
      return true;
    } catch (e) {
      if (!(await strike(key, { from: 'sync', ...change }, e))) return false;
      attempts.delete(key);
      return true;
    }
  };

  const answered: Card[] = [];
  if (opts.produce) {
    try {
      for await (const c of opts.produce()) {
        if (signal?.aborted) return {};
        const key = submitKey(c);
        if (attempts.get(key) === PARKED) continue;
        let res: SubmitResponse;
        try {
          res = await opts.head.submit(c);
        } catch (e) {
          if (permanent(e)) {
            if (await strike(key, { from: 'submit', card: c }, e)) attempts.set(key, PARKED);
            continue;
          }
          const r = fail(e);
          if (r.retryAfterMs !== undefined) return r;
          continue;
        }
        attempts.delete(key);
        if (opts.onSubmitted) await Promise.resolve(opts.onSubmitted(c, res)).catch(report);
        if (res.card.state !== 'open') answered.push(res.card);
      }
    } catch (e) {
      report(e);
    }
  }
  // The same changes arrive through sync too, so a failure here is reported but never counted.
  for (const card of answered) await opts.onDecision(card).catch(report);

  try {
    while (!signal?.aborted) {
      const after = await store.get();
      const page = await opts.head.sync(after);
      if (page.next < after) {
        report(new Error(`sync after ${after} returned next ${page.next}; the cursor is not moved`));
        return {};
      }
      for (const change of page.changes) if (!(await handle(change))) return {};
      if (page.next === after) return {};
      await store.set(page.next);
    }
  } catch (e) {
    return fail(e);
  }
  return {};
}

/** Runs passes back to back, `intervalMs` (default 60 s) apart, or longer when the head asks (Retry-After); never overlapping. */
export function runProducer(opts: ProducerOptions): { stop(): Promise<void> } {
  if (!(opts.store ?? opts.cursor)) throw new TypeError('runProducer: `store` is required');
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
