// RFC Appendix A.4, A.5: the executor loop. Sync for orders addressed to this producer or `*`, claim each with a
// lease renewed at half its length, run the worker, and close the thread with one outcome card. Cancellation
// arrives as a 410 on renewal; the loop turns it into an abort signal and a final outcome saying what was done.

import { ClaimRefusal, isOrder, OUTCOME_CLAIM_SEQ, OUTCOME_RESULT, ulidOf, type OrderCard, type ProducerCard } from '@pbcp/core';
import { card } from './card.js';
import type { HeadClient } from './head.js';
import type { StateStore } from './store.js';

/** Why a run stopped early: the person cancelled (410), the lease went to another executor (409), or the loop stopped. */
export class Cancelled extends Error {
  override readonly name = 'Cancelled';
  constructor(readonly reason: 'cancelled' | 'lease-lost' | 'stopped', message?: string) {
    super(message ?? reason);
  }
}

export interface ExecCtx {
  /** Renews the lease now. Call before each irreversible step; throws Cancelled if the order was cancelled or the lease lost. */
  checkpoint(): Promise<void>;
  /** PUTs `<producer>:order:<ulid>:progress-<claim_seq>-<n>`: a `signal` at `urgency: log` in the order's thread. */
  progress(note: string): Promise<void>;
  /** Aborted on cancel, lease loss or stop, with a Cancelled as its reason; for long awaits. */
  signal: AbortSignal;
  /** Waits `ms`; rejects with the Cancelled at once if the run is cancelled, loses its lease or is stopped. */
  sleep(ms: number): Promise<void>;
  /**
   * State kept for this order across claims, in the executor's store: what a run did, so a re-claim after a crash
   * can find it (the task it created, the message it sent). Deleted once the order's outcome is accepted.
   */
  state: OrderState;
  /** The order as of the latest claim or renewal. */
  readonly order: OrderCard;
}

export interface OrderState {
  get<T>(): Promise<T | undefined>;
  set<T>(value: T): Promise<void>;
}

export type Outcome =
  /** Done, nothing to decide. */
  | { kind: 'signal'; title: string; body: string }
  /** Done, and the result needs the person's approval ("here is the draft"). */
  | { kind: 'decision'; title: string; body: string; actions?: string[] }
  /** Not done. Posted as a signal with `orders.result: failed`; the others carry `orders.result: done` (A.3). */
  | { kind: 'failed'; title: string; body: string };

export interface ExecutorOptions {
  head: Pick<HeadClient, 'sync' | 'submit' | 'claim' | 'describe'>;
  /** The cursor and, in namespace `orders`, each running order's state (`ctx.state`). */
  store: StateStore;
  /** This executor's producer root: it claims orders to this name or `*`, and writes `<producer>:order:<ulid>:…`. */
  producer: string;
  /** Where outcome and progress cards are addressed; default the head's owner from `GET /`. */
  toPerson?: string;
  /** Default 60; renewed every half lease (A.5). */
  leaseSeconds?: number;
  run: (order: OrderCard, ctx: ExecCtx) => Promise<Outcome>;
  onProgress?: (order: OrderCard, note: string) => void;
  onError?: (err: unknown) => void;
  /** Between passes; default 30 s. */
  intervalMs?: number;
  /** Orders run at once; default 1. A pass stops claiming when full and does not move the cursor past what it left. */
  concurrency?: number;
}

interface Job {
  done: Promise<void>;
  abort: (reason: Cancelled) => void;
}

const firstLine = (s: string, fallback: string) => (s.split('\n').find((l) => l.trim() !== '')?.trim() || fallback).slice(0, 200);

export interface Executor {
  /** One pass: sync and claim what is new; started runs continue in the background. */
  pass(): Promise<void>;
  /** Orders running now, by id. */
  running(): string[];
  /** Resolves when every started run has finished. */
  idle(): Promise<void>;
  /** Stops the loop and aborts runs without posting an outcome; their leases lapse and the orders are claimed again. */
  stop(): Promise<void>;
}

/** The executor without its timer, for tests and hosts that drive passes themselves. */
export function executor(opts: ExecutorOptions): Executor {
  const report = opts.onError ?? ((e: unknown) => console.error(e));
  const lease = opts.leaseSeconds ?? 60;
  const jobs = new Map<string, Job>();
  const states = opts.store.kv<unknown>('orders');
  let toPerson = opts.toPerson;
  let stopped = false;

  const start = (claimed: OrderCard): Job => {
    const ac = new AbortController();
    const k = ulidOf(claimed.id);
    let current = claimed;
    /** This run's claim: renewals keep it (A.2), and a refusal's order may belong to another root's claim. */
    const seq = claimed.claim_seq!;
    let n = 0;
    const notes: string[] = [];
    let renewal: Promise<void> = Promise.resolve();

    const abort = (reason: Cancelled) => {
      if (!ac.signal.aborted) ac.abort(reason);
    };
    /** Renewals are serialised, so the timer and checkpoint() never race and `current` is the latest answer. */
    const renew = () =>
      (renewal = renewal.then(async () => {
        if (ac.signal.aborted) return;
        try {
          current = await opts.head.claim(current.id, lease);
        } catch (e) {
          if (e instanceof ClaimRefusal) {
            current = e.order as OrderCard;
            abort(new Cancelled(e.code === 'order_terminal' ? 'cancelled' : 'lease-lost', e.message));
          } else report(e);
        }
      }));
    const timer = setInterval(() => void renew(), (lease * 1000) / 2);

    const own = (intent: string, c: { kind: ProducerCard['kind']; title: string; body: string; urgency?: ProducerCard['urgency']; [extra: string]: unknown }) =>
      card({ ...c, producer: opts.producer, namespace: 'order', upstream: k, intent, to_person: toPerson!, thread: current.id, references: [current.id] });

    const ctx: ExecCtx = {
      signal: ac.signal,
      get order() {
        return current;
      },
      async checkpoint() {
        await renew();
        if (ac.signal.aborted) throw ac.signal.reason as Cancelled;
      },
      async progress(note) {
        n += 1;
        notes.push(note);
        opts.onProgress?.(current, note);
        // Per claim, so a re-run's progress never collides with the first run's (A.4).
        await opts.head.submit(own(`progress-${seq}-${n}`, { kind: 'signal', urgency: 'log', title: firstLine(note, `Progress ${n}`), body: note }));
      },
      sleep: (ms) =>
        new Promise<void>((resolve, reject) => {
          if (ac.signal.aborted) return reject(ac.signal.reason as Cancelled);
          const t = setTimeout(() => (ac.signal.removeEventListener('abort', stop), resolve()), ms);
          const stop = () => (clearTimeout(t), reject(ac.signal.reason as Cancelled));
          ac.signal.addEventListener('abort', stop, { once: true });
        }),
      state: {
        get: async <T>() => (await states.get(claimed.id)) as T | undefined,
        set: async <T>(value: T) => states.set(claimed.id, value),
      },
    };

    const outcomeOf = async (): Promise<Outcome | undefined> => {
      try {
        return await opts.run(current, ctx);
      } catch (e) {
        const stop = e instanceof Cancelled ? e : ac.signal.aborted ? (ac.signal.reason as Cancelled) : undefined;
        if (stop?.reason === 'stopped') return undefined;
        const done = notes.length ? notes.map((x) => `- ${firstLine(x, '')}`).join('\n') : '- Nothing.';
        const why = stop?.reason === 'cancelled' ? 'The order was cancelled.' : stop ? 'The lease was lost to another executor.' : `It failed: ${e instanceof Error ? e.message : String(e)}`;
        return {
          kind: 'failed',
          title: stop?.reason === 'cancelled' ? `Stopped: ${current.title}` : `Failed: ${current.title}`,
          body: `${why}\n\n**Done before it stopped**\n\n${done}\n\n**Not done**\n\nEverything after the last step above.`,
        };
      }
    };

    const done = (async () => {
      try {
        const outcome = await outcomeOf();
        if (!outcome) return;
        await renewal;
        const result = outcome.kind === 'failed' ? { kind: 'signal' as const, [OUTCOME_RESULT]: 'failed' } : { kind: outcome.kind, [OUTCOME_RESULT]: 'done' };
        // A.3, A.4: one outcome per claim, carrying that claim's claim_seq. After a cancel the head ignores it: the order is terminal.
        const res = await opts.head.submit(
          own(`outcome-${seq}`, {
            ...result,
            title: firstLine(outcome.title, 'Outcome'),
            body: outcome.body,
            ...(outcome.kind === 'decision' && outcome.actions ? { actions: outcome.actions } : {}),
            [OUTCOME_CLAIM_SEQ]: seq,
          }),
        );
        if (res.status !== 409) await states.delete(claimed.id);
      } catch (e) {
        report(e);
      } finally {
        clearInterval(timer);
        jobs.delete(claimed.id);
      }
    })();
    return { done, abort };
  };

  const pass = async () => {
    if (stopped) return;
    try {
      toPerson ??= (await opts.head.describe()).owner;
      for (;;) {
        const after = await opts.store.get();
        const page = await opts.head.sync(after);
        if (page.next < after) throw new Error(`sync after ${after} returned next ${page.next}; the cursor is not moved`);
        for (const { card: c } of page.changes) {
          if (stopped) return;
          if (!isOrder(c as { kind: string })) continue;
          const o = c as unknown as OrderCard;
          if (o.exec_state !== 'open' || (o.to_producer !== opts.producer && o.to_producer !== '*') || jobs.has(o.id)) continue;
          if (jobs.size >= (opts.concurrency ?? 1)) return; // full: leave the cursor so this order comes back
          try {
            jobs.set(o.id, start(await opts.head.claim(o.id, lease)));
          } catch (e) {
            if (!(e instanceof ClaimRefusal)) throw e; // 409 another root has it; 410 it ended: stand down either way
          }
        }
        if (page.next === after) return;
        await opts.store.set(page.next);
      }
    } catch (e) {
      report(e);
    }
  };

  return {
    pass,
    running: () => [...jobs.keys()],
    idle: async () => {
      while (jobs.size) await Promise.all([...jobs.values()].map((j) => j.done));
    },
    async stop() {
      stopped = true;
      for (const j of jobs.values()) j.abort(new Cancelled('stopped'));
      await Promise.all([...jobs.values()].map((j) => j.done));
    },
  };
}

/** Runs passes `intervalMs` apart (default 30 s) until stopped. */
export function runExecutor(opts: ExecutorOptions): { stop(): Promise<void> } {
  const ex = executor(opts);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let stopping = false;
  const loop = (async () => {
    while (!stopping) {
      await ex.pass();
      if (stopping) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, opts.intervalMs ?? 30_000);
      });
    }
  })();
  return {
    async stop() {
      stopping = true;
      clearTimeout(timer);
      wake?.();
      await loop;
      await ex.stop();
    },
  };
}
