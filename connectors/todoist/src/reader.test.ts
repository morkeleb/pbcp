import { fileURLToPath } from 'node:url';
import { HeadClient, memoryStore, producerPass, type StateStore } from '@pbcp/client';
import { stubHead } from '@pbcp/client/testing';
import type { Card, ProducerCard } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { fixtureSource } from './fixture-source.js';
import { instant, labelOf, todoistReader, urgencyOf, type Rec } from './reader.js';

const FIX = fileURLToPath(new URL('../fixtures/due.json', import.meta.url));
const [BANK, PLANTS, PASSPORT] = ['todoist:task:6Xfx0101', 'todoist:task:6Xfx0102:2026-11-04', 'todoist:task:6Xfx0103'];

// 2026-11-05 10:00 in Copenhagen (CET, UTC+1).
function setup() {
  const stub = stubHead({ now: () => '2026-11-05T09:00:00Z' });
  const clock = { now: new Date('2026-11-05T09:00:00Z') };
  const src = fixtureSource(FIX, { today: '2026-11-05', now: () => clock.now });
  const head = new HeadClient({ baseUrl: 'https://head.test', token: 'todoist', fetch: stub.fetch });
  const errors: unknown[] = [];
  const reader = (store: StateStore) => todoistReader(src, store.kv<Rec>('tasks'), { toPerson: 'morten', timeZone: 'Europe/Copenhagen' }, () => clock.now);
  let store = memoryStore();
  let r = reader(store);
  const pass = () => producerPass({ ...r, head, store, onError: (e) => void errors.push(e) });
  /** A fresh sync cursor over the same reader state: every decision is delivered again. */
  const resync = () => { const [kept, cursor] = [store, memoryStore()]; store = { get: cursor.get, set: cursor.set, kv: kept.kv }; r = reader(store); };
  const card = (id: string) => stub.cards.get(id) as Card & Record<string, unknown>;
  const puts = (id: string) => stub.requests.filter((q) => q.method === 'PUT' && (q.body as ProducerCard).id === id).map((q) => ({ ...(q.body as ProducerCard), emitted_at: '' }));
  return { stub, src, clock, errors, pass, resync, card, puts, onDecision: (c: Card) => r.onDecision(c) };
}

describe('todoist reader', () => {
  it('turns a task due today into a task card: due day, time and duration, project thread, labels, link, and a body of description, subtasks and comments', async () => {
    const t = setup();
    await t.pass();
    expect(t.errors).toEqual([]);
    // The task due on the 20th is not sent, nor the executor's task for an order (labelled pbcp).
    expect([...t.stub.cards.keys()].sort()).toEqual([BANK, PLANTS, PASSPORT]);
    expect(t.card(BANK)).toMatchObject({
      kind: 'task', state: 'open', title: 'Call the bank', urgency: 'brief', about: '2026-11-05', at: '2026-11-05T16:00:00Z', until: '2026-11-05T16:30:00Z',
      thread: 'todoist:project:6Xfp0002', labels: ['home-garden', 'errands', 'phone'], actions: ['tomorrow'],
      source: { url: 'https://app.todoist.com/app/task/6Xfx0101', label: 'Todoist task' },
    });
    expect(t.card(BANK).body).toBe('Ask why the card was declined.\n\n## Subtasks\n\n- [ ] Find the account number\n\n## Comments\n\nTheir number is on the back of the card.');
    expect(t.card(PASSPORT)).toMatchObject({ urgency: 'brief', about: '2026-11-05', labels: ['inbox'], thread: 'todoist:project:6Xfp0001' });
    expect(t.card(PASSPORT).at).toBeUndefined(); // a day, no time (§4.1a)
  });

  it('gives a recurring task one card per occurrence, its id carrying the due day, and no tomorrow action', async () => {
    const t = setup();
    await t.pass();
    expect(t.card(PLANTS)).toMatchObject({ kind: 'task', urgency: 'brief', about: '2026-11-04', title: 'Water the plants' }); // overdue
    expect(t.card(PLANTS).actions).toBeUndefined();
  });

  it('maps urgency by §4.1a: due on the day brief, later or undated log, and p1 immediate only within 3 hours of its due time today', () => {
    const today = '2026-11-05', now = new Date('2026-11-05T09:00:00Z'), h = (n: number) => new Date(+now + n * 36e5);
    expect([4, 3, 2, 1].map((p) => urgencyOf(p, today, today))).toEqual(['brief', 'brief', 'brief', 'brief']); // a day, no time
    expect([4, 3, 1].map((p) => urgencyOf(p, '2026-11-01', today))).toEqual(['brief', 'brief', 'brief']); // overdue
    expect([4, 3, 1].map((p) => urgencyOf(p, '2026-11-06', today))).toEqual(['log', 'log', 'log']);
    expect(urgencyOf(4, undefined, today)).toBe('log');
    expect([2, 3, 4].map((n) => urgencyOf(4, today, today, h(n), now))).toEqual(['immediate', 'immediate', 'brief']);
    expect(urgencyOf(4, today, today, h(-1), now)).toBe('immediate'); // passed today, still open
    expect(urgencyOf(3, today, today, h(1), now)).toBe('brief'); // p2
    expect(urgencyOf(4, '2026-11-04', today, h(-20), now)).toBe('brief'); // overdue from another day
  });

  it('revises an open p1 card to immediate when its due time comes within 3 hours', async () => {
    const t = setup();
    await t.pass();
    expect(t.card(BANK)).toMatchObject({ urgency: 'brief', at: '2026-11-05T16:00:00Z' });
    t.clock.now = new Date('2026-11-05T13:30:00Z');
    await t.pass();
    expect(t.card(BANK)).toMatchObject({ urgency: 'immediate', state: 'open' });
    expect(t.errors).toEqual([]);
  });

  it('fetches subtasks, comments and project names only for a task new or changed since the last pass', async () => {
    const t = setup();
    const calls: string[] = [];
    for (const k of ['subtasks', 'comments', 'project'] as const) {
      const fn = t.src[k] as (id: string) => Promise<unknown>;
      (t.src as Record<typeof k, unknown>)[k] = (id: string) => (calls.push(`${k} ${id}`), fn(id));
    }
    await t.pass();
    expect(calls.sort()).toEqual(['comments 6Xfx0101', 'comments 6Xfx0102', 'comments 6Xfx0103', 'project 6Xfp0001', 'project 6Xfp0002', 'subtasks 6Xfx0101', 'subtasks 6Xfx0102', 'subtasks 6Xfx0103']);
    calls.length = 0;
    await t.pass();
    expect(calls).toEqual([]);
    expect(t.card(BANK).body).toContain('## Subtasks\n\n- [ ] Find the account number'); // the body kept from the first pass
    t.src.raw.set('6Xfx0101', { ...t.src.raw.get('6Xfx0101'), description: 'Ask why the card was declined twice.', updated_at: '2026-11-05T08:30:00.000000Z' });
    await t.pass();
    expect(calls.sort()).toEqual(['comments 6Xfx0101', 'subtasks 6Xfx0101']);
    expect(t.card(BANK).body).toMatch(/^Ask why the card was declined twice\.\n\n## Subtasks/);
    expect(t.errors).toEqual([]);
  });

  it('slugs labels to the §4.1 grammar and reads a floating due time in TODOIST_TZ', () => {
    expect(['Home & Garden', 'Ærinder', '--x--', 'a'.repeat(40), '!!'].map(labelOf)).toEqual(['home-garden', 'rinder', 'x', 'a'.repeat(32), '']);
    expect(instant('2026-11-05T17:00:00', 'Europe/Copenhagen').toISOString()).toBe('2026-11-05T16:00:00.000Z');
    expect(instant('2026-07-05T17:00:00', 'Europe/Copenhagen').toISOString()).toBe('2026-07-05T15:00:00.000Z');
    expect(instant('2026-11-05T17:00:00Z', 'Europe/Copenhagen').toISOString()).toBe('2026-11-05T17:00:00.000Z');
  });

  it('on done completes the task in Todoist and supersedes the card with a Done in Todoist log artifact', async () => {
    const t = setup();
    await t.pass();
    t.stub.decideHere(BANK, { decision: 'done' });
    await t.pass();
    expect(t.src.closed).toEqual(['6Xfx0101']);
    await t.pass();
    expect(t.card(`${BANK}:closed`)).toMatchObject({
      kind: 'artifact', urgency: 'log', title: 'Done in Todoist', summary: 'Call the bank', body: 'Marked done here, and completed in Todoist.',
      supersedes: BANK, thread: 'todoist:project:6Xfp0002', source: { url: 'https://app.todoist.com/app/task/6Xfx0101' },
    });
    expect(t.card(BANK)).toMatchObject({ state: 'superseded', decision: 'done' });
    expect(t.errors).toEqual([]);
  });

  it('on tomorrow reschedules the task and supersedes the card with a task for the new day, moved-1; no log artifact (§4.3)', async () => {
    const t = setup();
    await t.pass();
    t.stub.decideHere(PASSPORT, { decision: 'tomorrow' });
    await t.pass();
    await t.pass();
    expect(t.src.rescheduled).toEqual(['6Xfx0103']);
    expect(t.src.closed).toEqual([]);
    expect(t.card(PASSPORT)).toMatchObject({ state: 'superseded', decision: 'tomorrow', about: '2026-11-05' });
    expect(t.card(`${PASSPORT}:moved-1`)).toMatchObject({
      kind: 'task', state: 'open', title: 'Renew the passport', about: '2026-11-06', urgency: 'log', supersedes: PASSPORT, actions: ['tomorrow'],
      thread: 'todoist:project:6Xfp0001', labels: ['inbox'], source: { url: 'https://app.todoist.com/app/task/6Xfx0103' },
    });
    expect(t.card(`${PASSPORT}:closed`)).toBeUndefined();
    // Its day comes: the same card, now brief; then tomorrow again is moved-2, and done closes the chain.
    t.clock.now = new Date('2026-11-06T09:00:00Z');
    t.src.today('2026-11-06');
    await t.pass();
    expect(t.card(`${PASSPORT}:moved-1`)).toMatchObject({ state: 'open', urgency: 'brief' });
    t.stub.decideHere(`${PASSPORT}:moved-1`, { decision: 'tomorrow' });
    await t.pass();
    await t.pass();
    expect(t.card(`${PASSPORT}:moved-2`)).toMatchObject({ kind: 'task', state: 'open', about: '2026-11-07', supersedes: `${PASSPORT}:moved-1` });
    t.clock.now = new Date('2026-11-07T09:00:00Z');
    t.src.today('2026-11-07');
    await t.pass();
    t.stub.decideHere(`${PASSPORT}:moved-2`, { decision: 'done' });
    await t.pass();
    await t.pass();
    expect(t.src.closed).toEqual(['6Xfx0103']);
    expect(t.card(`${PASSPORT}:closed`)).toMatchObject({ kind: 'artifact', title: 'Done in Todoist', supersedes: `${PASSPORT}:moved-2` });
    expect([...t.stub.cards.keys()].filter((k) => k.startsWith(PASSPORT)).sort()).toEqual([PASSPORT, `${PASSPORT}:closed`, `${PASSPORT}:moved-1`, `${PASSPORT}:moved-2`]);
    expect(t.errors).toEqual([]);
  });

  it('acts on tomorrow once: a re-sync or a crash after the Todoist call neither reschedules twice nor mints another moved-<n>', async () => {
    const t = setup();
    await t.pass();
    t.stub.decideHere(PASSPORT, { decision: 'tomorrow' });
    const reschedule = t.src.reschedule;
    t.src.reschedule = async (id, d) => { await reschedule(id, d); throw new Error('crash'); };
    await t.pass();
    t.src.reschedule = reschedule;
    await t.pass();
    await t.onDecision(t.card(PASSPORT));
    t.resync();
    await t.pass();
    await t.pass();
    expect(t.src.rescheduled).toEqual(['6Xfx0103']);
    expect([...t.stub.cards.keys()].filter((k) => k.startsWith(`${PASSPORT}:`))).toEqual([`${PASSPORT}:moved-1`]);
  });

  it('re-PUTs an open card under the same id when its task is moved in Todoist, and keeps it while it is not due today (§5, §8)', async () => {
    const t = setup();
    await t.pass();
    t.src.move('6Xfx0101', '2026-11-08');
    await t.pass();
    await t.pass();
    expect(t.card(BANK)).toMatchObject({ kind: 'task', state: 'open', about: '2026-11-08', urgency: 'log' });
    expect(t.card(BANK).at).toBeUndefined(); // the time of day went with the move
    expect(t.card(`${BANK}:closed`)).toBeUndefined();
    t.src.move('6Xfx0101', '2026-11-05');
    await t.pass();
    expect(t.card(BANK)).toMatchObject({ state: 'open', about: '2026-11-05', urgency: 'brief' });
    expect(t.errors).toEqual([]);
  });

  it('keeps a recurring occurrence\'s original date in its id when it moves, and closes it only when the activity log has it completed', async () => {
    const t = setup();
    await t.pass();
    t.src.move('6Xfx0102', '2026-11-06'); // postponed, not completed
    await t.pass();
    expect(t.card(PLANTS)).toMatchObject({ state: 'open', about: '2026-11-06', urgency: 'log' });
    expect(t.card('todoist:task:6Xfx0102:closed-2026-11-04')).toBeUndefined();
    t.src.complete('6Xfx0102'); // every day: the next occurrence is due on the 7th
    await t.pass();
    await t.pass();
    expect(t.card('todoist:task:6Xfx0102:closed-2026-11-04')).toMatchObject({ kind: 'artifact', title: 'Done in Todoist', supersedes: PLANTS });
    expect([...t.stub.cards.keys()].filter((k) => k.startsWith('todoist:task:6Xfx0102:20'))).toEqual([PLANTS]); // the 7th is not due yet
    expect(t.errors).toEqual([]);
  });

  it('without the activity log, takes a recurring task due on another day as moved and re-PUTs it, never Done in Todoist', async () => {
    const t = setup();
    await t.pass();
    t.src.completedSince = async () => { throw new Error('403'); };
    t.src.move('6Xfx0102', '2026-11-06');
    await t.pass();
    await t.pass();
    expect(t.card(PLANTS)).toMatchObject({ state: 'open', about: '2026-11-06' });
    t.src.complete('6Xfx0102'); // completed, but the reader cannot see it: the next occurrence reads as a move
    await t.pass();
    expect(t.card(PLANTS)).toMatchObject({ state: 'open', about: '2026-11-07' });
    expect(t.card('todoist:task:6Xfx0102:closed-2026-11-04')).toBeUndefined();
    expect(t.errors).toEqual([]);
  });

  it('supersedes a card whose task was deleted in Todoist with a Deleted in Todoist signal (§6)', async () => {
    const t = setup();
    await t.pass();
    t.src.remove('6Xfx0101');
    await t.pass();
    expect(t.card(`${BANK}:closed`)).toMatchObject({ kind: 'signal', urgency: 'log', title: 'Deleted in Todoist', supersedes: BANK });
    expect(t.card(`${BANK}:closed`).source).toBeUndefined();
  });

  it('records Already completed when the person marks done a task Todoist already has completed, without completing it again', async () => {
    const t = setup();
    await t.pass();
    t.src.complete('6Xfx0101');
    t.stub.decideHere(BANK, { decision: 'done' });
    await t.onDecision(t.card(BANK)); // the decision before the next pass notices the completion
    await t.pass();
    expect(t.src.closed).toEqual([]);
    expect(t.card(`${BANK}:closed`)).toMatchObject({ title: 'Already completed', supersedes: BANK });
  });

  it('supersedes a card whose task was completed in Todoist, with no decision; a recurring one closes its occurrence by date', async () => {
    const t = setup();
    await t.pass();
    t.src.complete('6Xfx0101');
    t.src.complete('6Xfx0102'); // every day: now due today
    await t.pass();
    expect(t.card(`${BANK}:closed`)).toMatchObject({ title: 'Done in Todoist', body: 'Completed in Todoist.', supersedes: BANK });
    expect(t.card(BANK)).toMatchObject({ state: 'superseded' });
    expect(t.card(BANK).decision).toBeUndefined();
    expect(t.card(`todoist:task:6Xfx0102:closed-2026-11-04`)).toMatchObject({ title: 'Done in Todoist', body: 'Completed in Todoist.', supersedes: PLANTS });
    expect(t.card('todoist:task:6Xfx0102:2026-11-05')).toMatchObject({ kind: 'task', state: 'open', about: '2026-11-05' });
    expect(t.errors).toEqual([]);
  });

  it('leaves the task alone on dismissed and sends nothing: dismissal ends the card, not the subject, and the decision is the record (§4.3)', async () => {
    const t = setup();
    await t.pass();
    t.stub.decideHere(PASSPORT, { decision: 'dismissed' });
    await t.pass();
    await t.pass();
    await t.onDecision(t.card(PASSPORT)); // the decision again
    t.resync();
    await t.pass();
    t.clock.now = new Date('2026-11-06T09:00:00Z'); // the next day: still due, now overdue, still not now
    t.src.today('2026-11-06');
    await t.pass();
    expect([t.src.closed, t.src.rescheduled]).toEqual([[], []]);
    expect(t.card(`${PASSPORT}:closed`)).toBeUndefined();
    expect(t.card(PASSPORT)).toMatchObject({ state: 'decided', decision: 'dismissed' });
    expect(t.puts(PASSPORT)).toHaveLength(2); // the passes before the decision reached the reader
    expect([...t.stub.cards.keys()].filter((k) => k.startsWith(PASSPORT))).toEqual([PASSPORT]);
    expect(t.errors).toEqual([]);
  });

  it('brings a dismissed task back as moved-<n> when its due date is later changed in Todoist, and closes it when Todoist completes it', async () => {
    const t = setup();
    await t.pass();
    t.stub.decideHere(PASSPORT, { decision: 'dismissed' });
    await t.pass();
    await t.pass();
    t.src.move('6Xfx0103', '2026-11-09'); // a new fact in Todoist, passes later
    await t.pass();
    const M1 = `${PASSPORT}:moved-1`;
    expect(t.card(M1)).toMatchObject({ kind: 'task', state: 'open', supersedes: PASSPORT, about: '2026-11-09', urgency: 'log', title: 'Renew the passport', actions: ['tomorrow'] });
    expect(t.card(PASSPORT)).toMatchObject({ state: 'superseded', decision: 'dismissed' });
    await t.pass();
    expect(new Set(t.puts(M1).map((c) => JSON.stringify(c))).size).toBe(1); // followed under its id, not minted again
    // Dismissed again and re-dated again: the next number.
    t.stub.decideHere(M1, { decision: 'dismissed' });
    await t.pass();
    t.src.move('6Xfx0103', '2026-11-12');
    await t.pass();
    expect(t.card(`${PASSPORT}:moved-2`)).toMatchObject({ state: 'open', supersedes: M1, about: '2026-11-12' });
    t.src.complete('6Xfx0103');
    await t.pass();
    await t.pass();
    expect(t.card(`${PASSPORT}:closed`)).toMatchObject({ kind: 'artifact', title: 'Done in Todoist', supersedes: `${PASSPORT}:moved-2` });
    expect([t.src.closed, t.src.rescheduled]).toEqual([[], []]);
    expect(t.errors).toEqual([]);
  });

  it('acts on a decision once: a re-sync, a repeated call or a crash after the Todoist call neither completes twice nor posts a different closing card', async () => {
    const t = setup();
    await t.pass();
    t.stub.decideHere(BANK, { decision: 'done' });
    // A crash right after Todoist completed the task, before the result was recorded.
    const close = t.src.close;
    t.src.close = async (id) => { await close(id); throw new Error('crash'); };
    await t.pass();
    t.src.close = close;
    expect(t.src.closed).toEqual(['6Xfx0101']);
    await t.pass(); // the decision again, from the unmoved cursor: the call before the crash counts
    await t.onDecision(t.card(BANK));
    t.resync();
    await t.pass();
    await t.pass();
    expect(t.src.closed).toEqual(['6Xfx0101']);
    const closings = t.puts(`${BANK}:closed`);
    expect(closings.length).toBeGreaterThan(0);
    expect(new Set(closings.map((c) => JSON.stringify(c))).size).toBe(1);
    expect(t.card(`${BANK}:closed`)).toMatchObject({ title: 'Done in Todoist' });
  });
});
