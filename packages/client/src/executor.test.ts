import { describe, expect, it } from 'vitest';
import { executor, runExecutor, Cancelled, type ExecCtx, type ExecutorOptions } from './executor.js';
import { HeadClient } from './head.js';
import { memoryStore } from './store.js';
import { stubHead } from './testing.js';
import type { OrderCard } from '@pbcp/core';

function setup(opts: { executors?: string[]; now?: () => string } = {}) {
  const stub = stubHead({ executors: opts.executors ?? ['hermes', 'cal'], now: opts.now });
  const head = (token: string) => new HeadClient({ baseUrl: 'https://head.test', token, fetch: stub.fetch });
  const errors: unknown[] = [];
  const base = (over: Partial<ExecutorOptions> & Pick<ExecutorOptions, 'run'>): ExecutorOptions => ({
    head: head('hermes'),
    store: memoryStore(),
    producer: 'hermes',
    onError: (e) => void errors.push(e),
    ...over,
  });
  const order = (id: string) => stub.cards.get(id) as unknown as OrderCard;
  return { stub, head, errors, base, order };
}

const waitUntil = (ctx: ExecCtx, check: () => boolean) =>
  new Promise<void>((resolve, reject) => {
    const tick = async () => {
      try {
        await ctx.checkpoint();
        if (check()) return resolve();
        setTimeout(tick, 5);
      } catch (e) {
        reject(e);
      }
    };
    void tick();
  });

describe('executor', () => {
  it('claims an order addressed to it, reports progress, and closes the thread with an outcome that moves it to done', async () => {
    const t = setup();
    const o = t.stub.order({ to_producer: 'hermes', title: 'Book the dentist', body: 'Any weekday morning.' });
    const ex = executor(t.base({
      run: async (order, ctx) => {
        expect(order).toMatchObject({ id: o.id, exec_state: 'claimed', claimed_by: 'hermes', claim_seq: 1 });
        await ctx.progress('Called the clinic\nThey open at 8.');
        await ctx.checkpoint();
        return { kind: 'signal', title: 'Booked Tuesday 09:00', body: 'Confirmation 4411.' };
      },
    }));
    await ex.pass();
    await ex.idle();
    const k = o.id.split(':')[2];
    expect(t.stub.cards.get(`hermes:order:${k}:progress-1`)).toMatchObject({ kind: 'signal', urgency: 'log', thread: o.id, references: [o.id], title: 'Called the clinic', to_person: 'morten' });
    expect(t.stub.cards.get(`hermes:order:${k}:outcome`)).toMatchObject({ kind: 'signal', thread: o.id, references: [o.id], 'orders.claim_seq': 2, title: 'Booked Tuesday 09:00' });
    expect(t.order(o.id)).toMatchObject({ exec_state: 'done' });
    expect(t.errors).toEqual([]);
  });

  it('takes wildcard orders it is eligible for and leaves others alone', async () => {
    const t = setup({ executors: ['hermes'] });
    const wild = t.stub.order({ to_producer: '*', title: 'Water the plants', body: '' });
    const other = t.stub.order({ to_producer: 'cal', title: 'Move the review', body: '' });
    const ran: string[] = [];
    const ex = executor(t.base({ concurrency: 5, run: async (order) => (ran.push(order.id), { kind: 'signal', title: 'ok', body: '' }) }));
    await ex.pass();
    await ex.idle();
    expect(ran).toEqual([wild.id]);
    expect(t.order(other.id).exec_state).toBe('open');
  });

  it('stands down on 409 when another executor holds the lease', async () => {
    const t = setup();
    const o = t.stub.order({ to_producer: '*', title: 'Pay the invoice', body: '' });
    // hermes reads the order while it is open; cal claims it before hermes does
    const page = await t.head('hermes').sync(0);
    expect(page.changes).toHaveLength(1);
    await t.head('cal').claim(o.id, 60);
    const h = t.head('hermes');
    const claims: number[] = [];
    const head = {
      sync: async (after: number) => (after === 0 ? page : h.sync(after)),
      submit: h.submit.bind(h),
      describe: h.describe.bind(h),
      claim: (id: string, lease: number) => h.claim(id, lease).catch((e) => (claims.push(e.status), Promise.reject(e))),
    };
    let ran = false;
    const ex = executor(t.base({ head, run: async () => ((ran = true), { kind: 'signal', title: 'x', body: '' }) }));
    await ex.pass();
    await ex.idle();
    expect(claims).toEqual([409]);
    expect(ran).toBe(false);
    expect(t.order(o.id)).toMatchObject({ claimed_by: 'cal' });
    expect(t.errors).toEqual([]);
  });

  it('turns a cancel (410 on renewal) into a failed outcome saying what was and was not done (A.5)', async () => {
    const t = setup();
    const o = t.stub.order({ to_producer: 'hermes', title: 'Send the reminders', body: '' });
    const ex = executor(t.base({
      run: async (_order, ctx) => {
        await ctx.progress('Sent to Anna');
        t.stub.decideHere(o.id, { decision: 'dismissed' });
        await ctx.checkpoint(); // the renewal is the check
        await ctx.progress('Sent to Bo');
        return { kind: 'signal', title: 'All sent', body: '' };
      },
    }));
    await ex.pass();
    await ex.idle();
    const out = t.stub.cards.get(`hermes:order:${o.id.split(':')[2]}:outcome`)!;
    expect(out).toMatchObject({ kind: 'signal', 'orders.result': 'failed', title: 'Stopped: Send the reminders' });
    expect(out.body).toMatch(/cancelled[\s\S]*- Sent to Anna[\s\S]*Not done/);
    expect(out.body).not.toMatch(/Bo/);
    expect(t.order(o.id)).toMatchObject({ exec_state: 'cancelled', state: 'decided' });
  });

  it('aborts ctx.signal with Cancelled when the lease is lost, and the stale outcome leaves the order alone', async () => {
    let clock = Date.parse('2026-10-26T12:00:00Z');
    const t = setup({ now: () => new Date(clock).toISOString() });
    const o = t.stub.order({ to_producer: '*', title: 'Draft the post', body: '' });
    let reason: unknown;
    const ex = executor(t.base({
      run: async (_order, ctx) => {
        clock += 61_000;
        await t.head('cal').claim(o.id, 60);
        await ctx.checkpoint().catch((e) => (reason = e));
        expect(ctx.signal.aborted).toBe(true);
        throw ctx.signal.reason;
      },
    }));
    await ex.pass();
    await ex.idle();
    expect(reason).toBeInstanceOf(Cancelled);
    expect(reason).toMatchObject({ reason: 'lease-lost' });
    expect(t.stub.cards.get(`hermes:order:${o.id.split(':')[2]}:outcome`)).toMatchObject({ 'orders.result': 'failed', 'orders.claim_seq': 2 });
    expect(t.order(o.id)).toMatchObject({ exec_state: 'claimed', claimed_by: 'cal', claim_seq: 2 });
  });

  it('renews the lease at half its length while the worker runs', async () => {
    const t = setup({ now: () => new Date().toISOString() });
    const o = t.stub.order({ to_producer: 'hermes', title: 'Wait a bit', body: '' });
    const ex = executor(t.base({ leaseSeconds: 1, run: async () => (await new Promise((r) => setTimeout(r, 1300)), { kind: 'signal', title: 'ok', body: '' }) }));
    await ex.pass();
    await ex.idle();
    const out = t.stub.cards.get(`hermes:order:${o.id.split(':')[2]}:outcome`)!;
    expect(out['orders.claim_seq']).toBeGreaterThanOrEqual(3);
    expect(t.order(o.id).exec_state).toBe('done');
  }, 5000);

  it('reports a thrown worker error as a failed outcome, and a decision outcome with its actions', async () => {
    const t = setup();
    const a = t.stub.order({ to_producer: 'hermes', title: 'Charge the card', body: '' });
    const b = t.stub.order({ to_producer: 'hermes', title: 'Draft the reply', body: '' });
    const ex = executor(t.base({
      concurrency: 2,
      run: async (order) => {
        if (order.id === a.id) throw new Error('card declined');
        return { kind: 'decision', title: 'Send this reply?', body: '> Hi Anna', actions: ['send', 'discard'] };
      },
    }));
    await ex.pass();
    await ex.idle();
    const key = (o: OrderCard) => `hermes:order:${o.id.split(':')[2]}:outcome`;
    expect(t.stub.cards.get(key(a))).toMatchObject({ 'orders.result': 'failed', title: 'Failed: Charge the card' });
    expect(t.stub.cards.get(key(a))!.body).toMatch(/card declined/);
    expect(t.stub.cards.get(key(b))).toMatchObject({ kind: 'decision', actions: ['send', 'discard'] });
    expect([t.order(a.id).exec_state, t.order(b.id).exec_state]).toEqual(['failed', 'done']);
  });

  it('claims no more than its concurrency and keeps the cursor so the rest come back', async () => {
    const t = setup();
    const a = t.stub.order({ to_producer: 'hermes', title: 'One', body: '' });
    const b = t.stub.order({ to_producer: 'hermes', title: 'Two', body: '' });
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ran: string[] = [];
    const ex = executor(t.base({ store, run: async (o) => (ran.push(o.id), await gate, { kind: 'signal', title: 'ok', body: '' }) }));
    await ex.pass();
    expect(ex.running()).toEqual([a.id]);
    expect(t.order(b.id).exec_state).toBe('open');
    expect(await store.get()).toBe(0);
    release();
    await ex.idle();
    await ex.pass();
    await ex.idle();
    expect(ran).toEqual([a.id, b.id]);
    expect(t.order(b.id).exec_state).toBe('done');
  });

  it('stop() aborts runs without an outcome, so the lease lapses and the order comes back', async () => {
    const t = setup();
    const o = t.stub.order({ to_producer: 'hermes', title: 'Long job', body: '' });
    let seen: unknown;
    const run = runExecutor(t.base({
      run: (_order, ctx) =>
        new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject((seen = ctx.signal.reason)))),
    }));
    await new Promise((r) => setTimeout(r, 20));
    await run.stop();
    expect(seen).toMatchObject({ reason: 'stopped' });
    expect(t.stub.cards.get(`hermes:order:${o.id.split(':')[2]}:outcome`)).toBeUndefined();
    expect(t.order(o.id).exec_state).toBe('claimed');
  });

  it('is usable with waitUntil-style polling workers that checkpoint between waits', async () => {
    const t = setup();
    const o = t.stub.order({ to_producer: 'hermes', title: 'Poll', body: '' });
    let ticks = 0;
    const ex = executor(t.base({ run: async (_order, ctx) => (await waitUntil(ctx, () => ++ticks >= 3), { kind: 'signal', title: 'ok', body: `${ticks}` }) }));
    await ex.pass();
    await ex.idle();
    expect(t.order(o.id)).toMatchObject({ exec_state: 'done', claim_seq: 4 });
  });
});
