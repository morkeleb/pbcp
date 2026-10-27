import { fileURLToPath } from 'node:url';
import { executor, HeadClient, memoryStore, type ExecutorOptions, type StateStore } from '@pbcp/client';
import { stubHead } from '@pbcp/client/testing';
import type { OrderCard } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { fixtureSource } from './fixture-source.js';
import { marker, taskFor, todoistRun } from './executor.js';

const FIX = fileURLToPath(new URL('../fixtures/tasks.json', import.meta.url));

function setup() {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const stub = stubHead({ now: () => new Date(clock).toISOString() });
  const src = fixtureSource(FIX);
  const errors: unknown[] = [];
  const opts = (store: StateStore = memoryStore()): ExecutorOptions => ({
    head: new HeadClient({ baseUrl: 'https://head.test', token: 'todoist', fetch: stub.fetch }),
    store, producer: 'todoist', leaseSeconds: 1, concurrency: 50,
    onError: (e) => void errors.push(e),
    run: todoistRun(src, { pollMs: 5, onError: (e) => void errors.push(e) }),
  });
  const ex = executor(opts());
  const order = (id: string) => stub.cards.get(id) as unknown as OrderCard;
  const outcome = (o: OrderCard, claimSeq = 1) => stub.cards.get(`todoist:order:${o.id.split(':')[2]}:outcome-${claimSeq}`);
  const until = async (check: () => boolean) => { for (let i = 0; !check(); i++) { if (i > 400) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };
  return { stub, src, errors, opts, ex, order, outcome, until, tick: (ms: number) => void (clock += ms) };
}

describe('todoist executor', () => {
  it('splits the order into task content, description and due string, and marks it with the order id', () => {
    const o = { id: 'head:order:01JBXZ0000000000000000000B', title: 'Call the plumber', body: 'About the boiler.\nDue: tomorrow 9am\n\nNumber is on the fridge.' } as OrderCard;
    expect(taskFor(o)).toEqual({ content: 'Call the plumber', description: `About the boiler.\n\nNumber is on the fridge.\n\n${marker(o.id)}`, due_string: 'tomorrow 9am' });
    expect(taskFor({ ...o, body: '' })).toEqual({ content: 'Call the plumber', description: marker(o.id) });
  });

  it('creates a task and closes the order with a Done outcome when the task is completed in Todoist', async () => {
    const t = setup();
    const o = t.stub.order({ to_producer: 'todoist', title: 'Book the dentist', body: 'Any weekday morning.\ndue: 2026-11-02' });
    await t.ex.pass();
    await t.until(() => t.src.created.length === 1);
    const id = t.src.created[0]!;
    expect(t.src.raw.get(id)).toMatchObject({ content: 'Book the dentist', description: `Any weekday morning.\n\npbcp: ${o.id}`, due: { string: '2026-11-02' }, labels: ['pbcp'] });
    expect(t.stub.cards.get(`todoist:order:${o.id.split(':')[2]}:progress-1-1`)).toMatchObject({ title: 'Added to Todoist: Book the dentist', urgency: 'log' });
    t.src.complete(id);
    await t.ex.idle();
    const out = t.outcome(o)!;
    expect(out).toMatchObject({ kind: 'signal', title: 'Done: Book the dentist', references: [o.id], thread: o.id });
    expect(out.body).toMatch(/Completed in Todoist at 2026-10-27/);
    expect(out['orders.result']).toBe('done');
    expect(out['orders.claim_seq']).toBe(1);
    expect(t.order(o.id).exec_state).toBe('done');
    expect(t.errors).toEqual([]);
  });

  it('finds a task completed while the executor was down through ctx.state, and posts Done without a second task', async () => {
    const t = setup();
    const shared = memoryStore();
    const first = executor(t.opts(shared));
    const o = t.stub.order({ to_producer: 'todoist', title: 'Water the plants', body: '' });
    await first.pass();
    await t.until(() => t.src.created.length === 1);
    await first.stop(); // a crash: no outcome, the lease lapses
    expect(t.outcome(o)).toBeUndefined();
    t.src.complete(t.src.created[0]!); // the person completes it meanwhile: the marker search no longer sees it
    t.tick(2000);
    const cursor = memoryStore(); // a fresh cursor, the same order state
    const again = executor(t.opts({ get: cursor.get, set: cursor.set, kv: shared.kv }));
    await again.pass();
    await again.idle();
    expect(t.src.created).toHaveLength(1);
    expect(t.outcome(o, 2)).toMatchObject({ title: 'Done: Water the plants', 'orders.result': 'done', 'orders.claim_seq': 2 });
    expect(t.order(o.id)).toMatchObject({ exec_state: 'done', claim_seq: 2 });
    expect(await shared.kv('orders').get(o.id)).toBeUndefined(); // dropped once the outcome is accepted
    expect(t.errors).toEqual([]);
  });

  it('falls back to the marker search when the order state is lost, while the task is still open', async () => {
    const t = setup();
    const o = t.stub.order({ to_producer: 'todoist', title: 'Feed the cat', body: '' });
    await t.ex.pass();
    await t.until(() => t.src.created.length === 1);
    await t.ex.stop();
    t.tick(2000);
    const again = executor(t.opts()); // a new, empty store
    await again.pass();
    expect(t.order(o.id)).toMatchObject({ exec_state: 'claimed', claim_seq: 2 });
    t.src.complete(t.src.created[0]!);
    await again.idle();
    expect(t.src.created).toHaveLength(1);
    expect(t.outcome(o, 2)).toMatchObject({ 'orders.result': 'done' });
    expect(t.order(o.id).exec_state).toBe('done');
  });

  it('fails the order when the task is deleted in Todoist', async () => {
    const t = setup();
    const o = t.stub.order({ to_producer: 'todoist', title: 'Pay the invoice', body: '' });
    await t.ex.pass();
    await t.until(() => t.src.created.length === 1);
    t.src.remove(t.src.created[0]!);
    await t.ex.idle();
    expect(t.outcome(o)).toMatchObject({ kind: 'signal', 'orders.result': 'failed', title: 'Not done: Pay the invoice' });
    expect(t.outcome(o)!.body).toMatch(/deleted without being completed/);
    expect(t.order(o.id).exec_state).toBe('failed');
  });

  it('deletes the task when the person cancels the order, and says so in a Stopped outcome', async () => {
    const t = setup();
    const o = t.stub.order({ to_producer: 'todoist', title: 'Send the reminders', body: '' });
    await t.ex.pass();
    await t.until(() => t.src.created.length === 1);
    t.stub.decideHere(o.id, { decision: 'dismissed' });
    await t.ex.idle();
    expect(t.src.raw.has(t.src.created[0]!)).toBe(false);
    expect(t.outcome(o)).toMatchObject({ 'orders.result': 'failed', title: 'Stopped: Send the reminders' });
    expect(t.outcome(o)!.body).toMatch(/cancelled, so the Todoist task "Send the reminders" was deleted/);
    expect(t.order(o.id)).toMatchObject({ exec_state: 'cancelled', state: 'decided' });
  });

  it('runs orders concurrently, so one waiting task does not hold up the next', async () => {
    const t = setup();
    const a = t.stub.order({ to_producer: 'todoist', title: 'One', body: '' });
    const b = t.stub.order({ to_producer: 'todoist', title: 'Two', body: '' });
    await t.ex.pass();
    await t.until(() => t.src.created.length === 2);
    expect(t.ex.running().sort()).toEqual([a.id, b.id].sort());
    t.src.complete(t.src.created[1]!);
    await t.until(() => t.order(b.id).exec_state === 'done');
    expect(t.order(a.id).exec_state).toBe('claimed');
    t.src.complete(t.src.created[0]!);
    await t.ex.idle();
    expect(t.order(a.id).exec_state).toBe('done');
    expect(t.errors).toEqual([]);
  });
});
