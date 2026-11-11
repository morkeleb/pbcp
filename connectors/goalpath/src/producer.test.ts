import { fileURLToPath } from 'node:url';
import { HeadClient, memoryStore, producerPass, type Parked, type SubmitResponse } from '@pbcp/client';
import { stubHead } from '@pbcp/client/testing';
import { isId, type ProducerCard } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { fixtureSource, loadFixtures } from './fixture-source.js';
import { answeredCard, approvalId, ganttTitle, goalpathProducer, labelOf, movedId, NAMESPACE, taskId } from './producer.js';

const FIX = fileURLToPath(new URL('../fixtures', import.meta.url));
const M = (n: number) => `7a1e0c2e-4d4b-4c51-9b1a-00000000000${n}`;
const I = (n: string) => `3c9b7f10-2a6e-4e0f-8d3e-0000000000${n}`;
const cfg = { toPerson: 'morten', projectId: 'p-demo', tz: 'Europe/Copenhagen', label: 'billing-platform' };
const RISK = `goalpath:milestone:${M(4)}.20261124:risk`;
const APPROVAL = `goalpath:approval:${I('12')}`;
const BUILD = 'goalpath:build:gh-run-118842';
const TASK = `goalpath:task:${I('15')}`;
const tasksOf = (cs: ProducerCard[]) => cs.filter((c) => c.id.startsWith('goalpath:task:'));

function setup(now = '2026-10-26T12:00:00Z') {
  const data = loadFixtures(FIX);
  const gp = fixtureSource(data, 'p-demo');
  const stub = stubHead();
  let clock = new Date(now);
  const head = new HeadClient({ baseUrl: 'https://head.test', token: 't', fetch: stub.fetch });
  const store = memoryStore();
  const producer = goalpathProducer(gp, store, cfg, () => clock);
  const errors: unknown[] = [];
  const parked: Parked[] = [];
  const attempts = new Map<string, number>();
  const answers: [string, number][] = [];
  let seen = 0;
  /** One pass; returns the cards PUT during it. */
  const pass = async () => {
    const onSubmitted = (c: ProducerCard, r: SubmitResponse) => (answers.push([c.id, r.status]), producer.onSubmitted(c, r));
    await producerPass({ ...producer, onSubmitted, head, store, onError: (e) => errors.push(e), onParked: (p) => void parked.push(p) }, undefined, attempts);
    const puts = stub.requests.filter((r) => r.method === 'PUT').map((r) => r.body as ProducerCard);
    return puts.slice(seen, (seen = puts.length));
  };
  const items = (data.list_my_items as { items: Record<string, unknown>[] }).items;
  const item = (n: string) => items.find((i) => i.id === I(n))!;
  const forecast = (n: number) => (data.get_milestone_forecast as Record<string, Record<string, unknown>>)[M(n)]!;
  /** A process restart: what runProducer keeps in memory (parked and 409-answered cards) is gone; the store stays. */
  const restart = () => attempts.clear();
  /** The item is no longer assigned to you: list_my_items stops listing it, get_item still has it. */
  const drop = (n: string) => void (data.get_item = { ...(data.get_item as object), [I(n)]: items.splice(items.findIndex((i) => i.id === I(n)), 1)[0] });
  /** The item is deleted in GoalPath: get_item answers "Item not found". */
  const remove = (n: string) => void items.splice(items.findIndex((i) => i.id === I(n)), 1);
  return { stub, gp, store, producer, drop, remove, pass, errors, parked, answers, restart, item, forecast, at: (t: string) => void (clock = new Date(t)) };
}

describe('goalpath producer', () => {
  it('turns a slip, an approval and a red build into cards, and nothing else', async () => {
    const { pass, errors } = setup();
    const cards = await pass();
    expect(errors).toEqual([]);
    expect(cards.map((c) => c.id)).toEqual([RISK, APPROVAL, BUILD]);
    for (const c of cards) expect(isId(c.id)).toBe(true);

    const [risk, approval, build] = cards as [ProducerCard, ProducerCard, ProducerCard];
    expect(risk).toMatchObject({ kind: 'signal', urgency: 'brief', thread: M(4), title: 'Billing revamp: forecast 24 Nov, 11 days past 13 Nov', source: { url: 'https://goalpath.example/m/4' } });
    expect(risk.supersedes).toBeUndefined();
    expect(risk.body).toContain('Forecast **2026-11-24** (confidence: low) against the deadline 2026-11-13: 11 days late.');
    expect(risk.body).toContain('- Scope grew by 6 items since 12 Oct');
    expect(risk.body).toContain('**Also affected.** Rollout depends on this milestone.');

    expect(approval).toMatchObject({ kind: 'decision', urgency: 'brief', thread: M(4), title: 'Accept GP-12 Export invoices as CSV?' });
    expect(approval.actions).toEqual([{ id: 'accept', label: 'Accept', body: 'Sets GP-12 to Accepted.' }, { id: 'reject', label: 'Reject', body: 'Sets GP-12 to Rejected.' }]);
    expect(approval.body).toMatch(/## Proposal/);
    // §4.1: one line of plain text from the item's title and status.
    expect(approval.summary).toMatch(/^GP-12 Export invoices as CSV is \w+ in Billing revamp and waiting for your acceptance\. Proposed: accept it, which sets it to Accepted in GoalPath\.$/);
    expect(risk.summary).toBe('Billing revamp is forecast for 2026-11-24, 11 days past its deadline 2026-11-13. Cut scope, move the deadline or add capacity.');
    expect(build.summary).toMatch(/^ci \/ test ended \w+ on #91, linked to GP-14 /);

    expect(build).toMatchObject({ kind: 'signal', urgency: 'immediate', thread: M(4), title: 'Build failed: ci / test on #91 (GP-14)', source: { url: 'https://git.example/acme/billing/actions/runs/118842' } });
    // Tickets (GP-15 NotStarted, GP-16 green with a failing *suggested* link) and the Accepted ones never become cards.
    expect(cards.some((c) => /GP-1[056]|GP-9\b|118851|118839/.test(`${c.title} ${c.id}`))).toBe(false);
  });

  it('is idempotent: the same slip, approval and build twice change nothing on the head', async () => {
    const { pass, stub, errors } = setup();
    await pass();
    const before = new Map([...stub.cards].map(([id, c]) => [id, c.change_seq]));
    expect(await pass().then((cs) => cs.map((c) => c.id))).toEqual([BUILD]); // re-PUT of the still-red run, identical
    expect(new Map([...stub.cards].map(([id, c]) => [id, c.change_seq]))).toEqual(before);
    expect(errors).toEqual([]);
  });

  it('supersedes the risk card on a later slip, then on recovery, then on the next slip', async () => {
    const { pass, forecast, stub } = setup();
    await pass();
    forecast(4).projectedCompletionDate = '2026-12-02';
    const [later] = await pass();
    expect(later).toMatchObject({ id: `goalpath:milestone:${M(4)}.20261202:risk`, supersedes: RISK, title: 'Billing revamp: forecast 2 Dec, 19 days past 13 Nov' });
    expect(later!.body).toContain('The forecast was 2026-11-24 when last reported.');
    expect(stub.cards.get(RISK)!.state).toBe('superseded');

    forecast(4).projectedCompletionDate = '2026-11-12';
    const [back] = await pass();
    expect(back).toMatchObject({ id: `goalpath:milestone:${M(4)}.20261112:on-track`, kind: 'signal', supersedes: later!.id, title: 'Billing revamp: back on track, forecast 12 Nov (deadline 13 Nov)' });
    expect(stub.cards.get(later!.id)!.state).toBe('superseded');
    expect(await pass()).toHaveLength(1); // only the build; staying on track sends nothing

    forecast(4).projectedCompletionDate = '2026-11-20';
    const [again] = await pass();
    expect(again).toMatchObject({ id: `goalpath:milestone:${M(4)}.20261120:risk`, supersedes: back!.id });
    expect(stub.cards.get(back!.id)!.state).toBe('superseded');
    expect(stub.cards.get(again!.id)!.state).toBe('open');
  });

  it('known gap: a risk chain back at a projected date it already used gets a 409 once per process, never parked', async () => {
    const { pass, forecast, stub, store, errors, parked, answers, restart } = setup();
    await pass();
    forecast(4).projectedCompletionDate = '2026-11-12';
    const [back] = await pass();
    forecast(4).projectedCompletionDate = '2026-11-24'; // the date of the first, now superseded, risk card
    const riskPuts = () => stub.requests.filter((r) => r.method === 'PUT' && r.url.endsWith(encodeURIComponent(RISK))).length;
    const [again] = await pass();
    expect(again).toMatchObject({ id: RISK, supersedes: back!.id });
    // The head answers 409 with the stored, superseded card: a result, not a refusal, so nothing is counted or parked.
    expect(answers.filter(([id]) => id === RISK)).toEqual([[RISK, 201], [RISK, 409]]);
    // The client does not send the same content again while the loop runs.
    for (let n = 0; n < 7; n++) expect((await pass()).map((c) => c.id)).toEqual([BUILD]);
    expect(riskPuts()).toBe(2);
    // After a restart the 409 is seen once more, then suppressed again.
    restart();
    expect((await pass()).map((c) => c.id)).toEqual([RISK, BUILD]);
    expect((await pass()).map((c) => c.id)).toEqual([BUILD]);
    expect(riskPuts()).toBe(3);
    expect(answers.filter(([id, s]) => id === RISK && s === 409)).toHaveLength(2);
    expect(stub.cards.get(RISK)!.state).toBe('superseded');
    expect(stub.cards.get(back!.id)!.state).toBe('open');
    expect(errors).toEqual([]);
    expect(parked).toEqual([]);
    expect(await store.kv(NAMESPACE).get(`risk:${M(4)}`)).toMatchObject({ card: back!.id }); // the chain stays at on-track
    forecast(4).projectedCompletionDate = '2026-11-26'; // a new date heals it
    expect((await pass())[0]).toMatchObject({ id: `goalpath:milestone:${M(4)}.20261126:risk`, supersedes: back!.id });
  });

  it('keeps one store entry per milestone and item, next to the cursor', async () => {
    const { pass, store } = setup('2026-10-26T19:30:00Z');
    await pass();
    expect(await store.kv(NAMESPACE).keys()).toEqual([`approval:${I('12')}`, 'digest', `risk:${M(4)}`]);
    expect(await store.get()).toBeGreaterThan(0);
  });

  it('retries a risk card whose submit failed, without breaking the chain', async () => {
    const { pass, stub, errors } = setup();
    stub.script(503, { error: 'unavailable' });
    expect((await pass()).map((c) => c.id)).toEqual([RISK, APPROVAL, BUILD]);
    expect(errors).toHaveLength(1);
    expect((await pass()).map((c) => c.id)).toEqual([RISK, BUILD]);
    expect(stub.cards.has(RISK)).toBe(true);
  });

  it('writes a head decision back to GoalPath once', async () => {
    const { pass, stub, gp, item } = setup();
    await pass();
    stub.decideHere(APPROVAL, { decision: 'accept', comment: 'Checked the export on staging.' });
    await pass();
    expect(gp.writes).toEqual([
      ['set_item_status', { itemId: I('12'), status: 'Accepted' }],
      ['add_comment', { itemId: I('12'), content: 'Checked the export on staging.' }],
    ]);
    item('12').status = 'Accepted'; // the write-back as GoalPath now reports it
    const cards = await pass();
    expect(cards.map((c) => c.id)).toEqual([BUILD]); // no "answered in GoalPath" for a card decided on the head
    expect(gp.writes).toHaveLength(2);
  });

  it('writes edited back as accept with its text, delegated as a comment, dismissed as nothing', async () => {
    for (const [d, writes] of [
      [{ decision: 'edited', edited_proposal: 'Accept once the header row is localised.' }, [['set_item_status', { itemId: I('12'), status: 'Accepted' }], ['add_comment', { itemId: I('12'), content: 'Accept once the header row is localised.' }]]],
      [{ decision: 'delegated', delegated_to: 'anna', comment: 'Finance owns this.' }, [['add_comment', { itemId: I('12'), content: 'Delegated to anna.\n\nFinance owns this.' }]]],
      [{ decision: 'dismissed' }, []],
    ] as const) {
      const { pass, stub, gp } = setup();
      await pass();
      stub.decideHere(APPROVAL, d);
      await pass();
      await pass();
      expect(gp.writes).toEqual(writes);
    }
  });

  it('links the answered card to the item through the round, once the item has left your list', () => {
    const a = { card: APPROVAL, round: 1, label: 'GP-12 Export invoices as CSV', thread: M(4), url: 'https://goalpath.example/i/12' };
    const cfg = { toPerson: 'morten', projectId: 'p-demo', tz: 'UTC' };
    const c = answeredCard(a, undefined, cfg, new Date('2026-10-26T12:00:00Z'));
    expect(c.source).toEqual({ url: 'https://goalpath.example/i/12', label: 'GoalPath item' });
    expect(c.body).toContain('it is no longer assigned to you');
    expect('source' in answeredCard({ ...a, url: undefined }, undefined, cfg, new Date('2026-10-26T12:00:00Z'))).toBe(false);
  });

  it('supersedes an open approval answered in GoalPath first, and then ignores a late head decision', async () => {
    const { pass, stub, gp, item } = setup();
    await pass();
    item('12').status = 'Accepted';
    const [answered] = (await pass()).filter((c) => c.id.startsWith('goalpath:approval:'));
    expect(answered).toMatchObject({ id: `${APPROVAL}:answered`, kind: 'signal', supersedes: APPROVAL, thread: M(4), title: 'GP-12 Export invoices as CSV: answered in GoalPath' });
    expect(answered!.body).toContain('it is now Accepted');
    expect(answered!.source).toEqual({ url: 'https://goalpath.example/i/12', label: 'GoalPath item' });
    expect(answered!.labels).toEqual(['billing-platform', 'billing-revamp']);
    // The head marked the approval superseded, so a decision can no longer land on it (§8): it answers with the card as is.
    expect(stub.decideHere(APPROVAL, { decision: 'reject' })).toMatchObject({ state: 'superseded' });
    expect(stub.cards.get(APPROVAL)).not.toHaveProperty('decision');
    await pass();
    expect(gp.writes).toEqual([]);
    expect((await pass()).map((c) => c.id)).toEqual([BUILD]);
  });

  it('mirrors a new round when the item comes back to the queue', async () => {
    const { pass, stub, item } = setup();
    await pass();
    stub.decideHere(APPROVAL, { decision: 'reject' });
    await pass();
    item('12').status = 'Rejected';
    await pass();
    item('12').status = 'Finished';
    const [round2] = (await pass()).filter((c) => c.kind === 'decision');
    expect(round2).toMatchObject({ id: approvalId(I('12'), 2), supersedes: APPROVAL });
    expect(round2!.id).toBe(`${APPROVAL}.2`);
  });

  it('produces the digest once a day after GOALPATH_DIGEST_AT, with one gantt', async () => {
    const { pass, at } = setup('2026-10-26T19:30:00Z'); // 20:30 in Copenhagen
    const digest = (await pass()).find((c) => c.id.startsWith('goalpath:digest:'))!;
    expect(digest).toMatchObject({ id: 'goalpath:digest:2026-10-26', kind: 'artifact', urgency: 'brief', thread: 'p-demo', title: 'GoalPath 26 Oct: 1 done, 1 blocked, 2 milestones late', summary: '1 done, 1 blocked and 2 milestones late in GoalPath on 26 Oct.' });
    expect('actions' in digest).toBe(false);
    expect(digest.body).toBe([
      '1 item was accepted in the last 24 hours and 1 is blocked; 2 milestones are forecast past their deadline.', '',
      '```mermaid', 'gantt', '  title Milestone forecasts', '  dateFormat YYYY-MM-DD', '  axisFormat %d %b',
      '  Billing revamp :crit, 2026-09-28, 2026-11-24',
      '  Mobile beta :2026-10-12, 2026-12-04',
      '  Rollout :crit, 2026-12-01, 2027-01-22',
      '```', '',
      '**Done** (accepted in the last 24 hours)', '- GP-10 Invoice PDF layout', '',
      '**Blocked**', '- GP-14 Retry failed card payments', '',
      '**Unplanned work.** 25% of completed work in the week of 19 Oct; the weeks before, newest first: 40%, 20%, 10%.',
    ].join('\n'));
    expect(digest.body.match(/```mermaid/g)).toHaveLength(1);

    at('2026-10-26T21:00:00Z');
    expect((await pass()).some((c) => c.id.startsWith('goalpath:digest:'))).toBe(false);
    at('2026-10-27T18:00:00Z'); // 19:00 the next day: not yet
    expect((await pass()).some((c) => c.id.startsWith('goalpath:digest:'))).toBe(false);
    at('2026-10-27T19:00:00Z');
    expect((await pass()).map((c) => c.id)).toContain('goalpath:digest:2026-10-27');
  });

  it('labels every card with the project, and the milestone when there is one (§4.1)', async () => {
    const { pass } = setup('2026-10-26T19:30:00Z');
    const cards = await pass();
    const by = (prefix: string) => cards.find((c) => c.id.startsWith(prefix))!;
    expect(by('goalpath:milestone:').labels).toEqual(['billing-platform', 'billing-revamp']);
    expect(by('goalpath:approval:').labels).toEqual(['billing-platform', 'billing-revamp']);
    expect(by('goalpath:build:').labels).toEqual(['billing-platform', 'billing-revamp']);
    expect(by('goalpath:digest:').labels).toEqual(['billing-platform']);
  });

  it('makes a label from a name, within the grammar of §4.1', async () => {
    expect(labelOf('Billing revamp')).toBe('billing-revamp');
    expect(labelOf('  Q4: Mobile beta (iOS) ')).toBe('q4-mobile-beta-ios');
    expect(labelOf('Café Øresund')).toBe('cafe-resund');
    expect(labelOf('A very long milestone name that keeps on going')).toBe('a-very-long-milestone-name-that');
    expect(labelOf('—')).toBeUndefined();
    expect(await fixtureSource(loadFixtures(FIX), 'p-demo').projectName()).toBe('Billing Platform');
  });

  it('escapes gantt task names', () => {
    expect(ganttTitle('Q4: review #2; 100% done')).toBe('Q4 review 2 100 done');
    expect(ganttTitle('section cleanup')).toBe('· section cleanup');
    expect(ganttTitle('x'.repeat(50))).toHaveLength(40);
  });

  describe('tasks (§4.1, §4.3, §11.1)', () => {
    /** GP-15 due today with a description and a link; GP-16 due on Friday at a time. */
    const dated = () => {
      const t = setup();
      Object.assign(t.item('15'), { deadline: '2026-10-26', description: 'Cache the last 50 receipts on the device.', url: 'https://goalpath.example/i/15' });
      t.item('16').deadline = '2026-10-30T14:30:00Z';
      return t;
    };

    it('turns an item assigned to you with a due date into a task card', async () => {
      const { pass, errors, at, stub } = dated();
      const [today, friday] = tasksOf(await pass()) as [ProducerCard, ProducerCard];
      expect(errors).toEqual([]);
      expect(today).toMatchObject({
        id: TASK, kind: 'task', urgency: 'brief', about: '2026-10-26', thread: M(5), title: 'GP-15 Offline mode for receipts',
        summary: 'GP-15 Offline mode for receipts is NotStarted in Mobile beta, due 2026-10-26.', body: 'Cache the last 50 receipts on the device.',
        source: { url: 'https://goalpath.example/i/15', label: 'GoalPath item' }, labels: ['billing-platform', 'mobile-beta'],
      });
      expect(today).not.toHaveProperty('at');
      expect(today).not.toHaveProperty('actions');
      // Due later is `log` until its day (§4.1a); a time of day becomes `at`, the local day `about`.
      expect(friday).toMatchObject({ id: taskId(I('16')), kind: 'task', urgency: 'log', about: '2026-10-30', at: '2026-10-30T14:30:00Z', summary: 'GP-16 Push notification opt-in is Started in Mobile beta, due 2026-10-30 at 15:30.' });
      expect(friday.body).toBe(friday.summary);
      at('2026-10-30T08:00:00Z');
      expect(tasksOf(await pass()).find((c) => c.id === friday.id)).toMatchObject({ urgency: 'brief' });
      expect(stub.cards.get(friday.id)).toMatchObject({ state: 'open', urgency: 'brief' });
    });

    it('makes no task of an undated item, an Accepted one, or one not assigned to you', async () => {
      const { pass, item } = setup();
      item('10').deadline = '2026-10-20'; // Accepted
      expect(tasksOf(await pass())).toEqual([]); // GP-12, 14, 15, 16 have no due date; only your items are listed at all
    });

    it('on done sets the item Accepted, then supersedes the task with a closing log artifact', async () => {
      const { pass, stub, gp, item } = dated();
      await pass();
      stub.decideHere(TASK, { decision: 'done', comment: 'Shipped in 2.4.' });
      await pass();
      expect(gp.writes).toEqual([['set_item_status', { itemId: I('15'), status: 'Accepted' }], ['add_comment', { itemId: I('15'), content: 'Shipped in 2.4.' }]]);
      const [closed] = tasksOf(await pass()).filter((c) => c.id.startsWith(TASK));
      expect(closed).toMatchObject({
        id: `${TASK}:closed`, kind: 'artifact', urgency: 'log', supersedes: TASK, thread: M(5), title: 'GP-15 Offline mode for receipts: done in GoalPath',
        body: '**GP-15 Offline mode for receipts**: Marked done here; set to Accepted in GoalPath.', source: { url: 'https://goalpath.example/i/15', label: 'GoalPath item' },
      });
      expect(stub.cards.get(TASK)).toMatchObject({ state: 'superseded', decision: 'done' });
      item('15').status = 'Accepted'; // the write-back as GoalPath now reports it
      expect(tasksOf(await pass()).map((c) => c.id)).toEqual([taskId(I('16'))]);
      expect(gp.writes).toHaveLength(2);
    });

    it('on dismissed leaves the item and closes the task', async () => {
      const { pass, stub, gp } = dated();
      await pass();
      stub.decideHere(TASK, { decision: 'dismissed' });
      await pass();
      const [closed] = tasksOf(await pass()).filter((c) => c.id.startsWith(TASK));
      expect(closed).toMatchObject({ id: `${TASK}:closed`, supersedes: TASK, title: 'GP-15 Offline mode for receipts: dismissed', body: '**GP-15 Offline mode for receipts**: Dismissed here; left as it is in GoalPath (NotStarted).' });
      expect(gp.writes).toEqual([]);
      expect(tasksOf(await pass()).map((c) => c.id)).toEqual([taskId(I('16'))]); // the item is still dated and open, but its task is closed
    });

    it('supersedes an open task completed in GoalPath, or no longer assigned to you, without a decision', async () => {
      const { pass, stub, gp, item } = dated();
      await pass();
      item('15').status = 'Accepted';
      const cards = tasksOf(await pass());
      expect(cards.find((c) => c.id === `${TASK}:closed`)).toMatchObject({ kind: 'artifact', urgency: 'log', supersedes: TASK, title: 'GP-15 Offline mode for receipts: done in GoalPath', body: '**GP-15 Offline mode for receipts**: Accepted in GoalPath.' });
      expect(stub.cards.get(TASK)).toMatchObject({ state: 'superseded' });
      expect(stub.cards.get(TASK)).not.toHaveProperty('decision');
      // A late decision cannot land on the superseded task (§8), and nothing is written back.
      expect(stub.decideHere(TASK, { decision: 'done' })).toMatchObject({ state: 'superseded' });
      await pass();
      expect(gp.writes).toEqual([]);
    });

    it('closes the task of an item no longer assigned to you', async () => {
      const { pass, stub, gp, drop } = dated();
      await pass();
      drop('15');
      const closed = tasksOf(await pass()).find((c) => c.id.startsWith(TASK));
      expect(closed).toMatchObject({ id: `${TASK}:closed`, supersedes: TASK, title: 'GP-15 Offline mode for receipts: closed in GoalPath', body: '**GP-15 Offline mode for receipts**: It is no longer assigned to you in GoalPath.', source: { url: 'https://goalpath.example/i/15' } });
      expect(stub.cards.get(TASK)).toMatchObject({ state: 'superseded' });
      expect(gp.writes).toEqual([]);
    });

    it('supersedes the task of an item deleted in GoalPath with a signal (§6)', async () => {
      const { pass, stub, remove } = dated();
      await pass();
      remove('15');
      const closed = tasksOf(await pass()).find((c) => c.id.startsWith(TASK));
      expect(closed).toMatchObject({ id: `${TASK}:closed`, kind: 'signal', urgency: 'log', supersedes: TASK, title: 'GP-15 Offline mode for receipts: deleted in GoalPath', source: { url: 'https://goalpath.example/i/15' } });
      expect(stub.cards.get(TASK)).toMatchObject({ state: 'superseded' });
      expect(tasksOf(await pass()).filter((c) => c.id.startsWith(TASK))).toEqual([]);
    });

    it('re-PUTs an open task under the same id when its item is re-dated (§5, §8)', async () => {
      const { pass, stub, item } = dated();
      await pass();
      item('15').deadline = '2026-11-02T09:00:00Z';
      const [moved] = tasksOf(await pass()).filter((c) => c.id.startsWith(TASK));
      expect(moved).toMatchObject({ id: TASK, kind: 'task', about: '2026-11-02', at: '2026-11-02T09:00:00Z', urgency: 'log' });
      expect(moved).not.toHaveProperty('supersedes');
      expect(stub.cards.get(TASK)).toMatchObject({ state: 'open', about: '2026-11-02' });
      expect([...stub.cards.keys()].filter((k) => k.startsWith(TASK))).toEqual([TASK]);
    });

    it('keeps an open task whose item lost its due date, on the day last sent, until it is closed or moved', async () => {
      const { pass, stub, item } = dated();
      await pass();
      delete item('15').deadline;
      expect(tasksOf(await pass()).filter((c) => c.id.startsWith(TASK))).toMatchObject([{ id: TASK, about: '2026-10-26' }]);
      expect(stub.cards.get(TASK)).toMatchObject({ state: 'open', about: '2026-10-26' });
      item('15').deadline = '2026-10-28';
      expect(tasksOf(await pass()).filter((c) => c.id.startsWith(TASK))).toMatchObject([{ id: TASK, about: '2026-10-28' }]);
    });

    it('supersedes a dismissed task whose item is then re-dated with a moved-<n> task, numbered from the store (§4.3)', async () => {
      const { pass, stub, gp, item, store } = dated();
      await pass();
      stub.decideHere(TASK, { decision: 'dismissed' });
      item('15').deadline = '2026-11-02'; // re-dated in GoalPath before the reader closed the dismissed task
      await pass(); // produce re-PUTs nothing new; sync brings the decision
      const M1 = `${TASK}:moved-1`, M2 = `${TASK}:moved-2`;
      expect(movedId(TASK, 1)).toBe(M1);
      const [first] = tasksOf(await pass()).filter((c) => c.id.startsWith(TASK));
      expect(first).toMatchObject({ id: M1, kind: 'task', supersedes: TASK, about: '2026-11-02', urgency: 'log', title: 'GP-15 Offline mode for receipts' });
      expect(isId(M1)).toBe(true);
      expect(stub.cards.get(TASK)).toMatchObject({ state: 'superseded', decision: 'dismissed', about: '2026-10-26' });
      expect(stub.cards.get(M1)).toMatchObject({ state: 'open' });
      // Open again: a re-date re-PUTs the successor under its own id, still superseding the first.
      item('15').deadline = '2026-11-03';
      expect(tasksOf(await pass()).filter((c) => c.id.startsWith(TASK))).toMatchObject([{ id: M1, about: '2026-11-03', supersedes: TASK }]);
      stub.decideHere(M1, { decision: 'dismissed' });
      item('15').deadline = '2026-11-09';
      await pass();
      expect(tasksOf(await pass()).filter((c) => c.id.startsWith(TASK))).toMatchObject([{ id: M2, supersedes: M1, about: '2026-11-09' }]);
      expect(await store.kv(NAMESPACE).get(`task:${I('15')}`)).toMatchObject({ card: M2, prev: M1, moves: 2 });
      stub.decideHere(M2, { decision: 'done' });
      await pass();
      const [closed] = tasksOf(await pass()).filter((c) => c.id.startsWith(TASK));
      expect(closed).toMatchObject({ id: `${TASK}:closed`, kind: 'artifact', supersedes: M2, title: 'GP-15 Offline mode for receipts: done in GoalPath' });
      expect(gp.writes).toEqual([['set_item_status', { itemId: I('15'), status: 'Accepted' }]]);
      expect([...stub.cards.keys()].filter((k) => k.startsWith(TASK)).sort()).toEqual([TASK, `${TASK}:closed`, M1, M2].sort());
    });

    it('sends a closed task no more, even when its item is re-dated: a dismissed task stays dismissed', async () => {
      const { pass, stub, item } = dated();
      await pass();
      stub.decideHere(TASK, { decision: 'dismissed' });
      await pass();
      await pass(); // the `:closed` card
      item('15').deadline = '2026-11-02';
      expect(tasksOf(await pass()).filter((c) => c.id.startsWith(TASK))).toEqual([]);
      expect([...stub.cards.keys()].filter((k) => k.startsWith(TASK))).toEqual([TASK, `${TASK}:closed`]);
    });

    it('follows an older dated task under its id, and moves and closes it with its date segment', async () => {
      const { pass, stub, item, store } = dated();
      const OLD = taskId(I('15'), '2026-10-26');
      await store.kv(NAMESPACE).set(`task:${I('15')}`, { card: TASK, item: I('15'), date: '2026-10-20', label: 'GP-15 Offline mode for receipts', thread: M(5), submitted: true, decision: 'dismissed', closed: true });
      await store.kv(NAMESPACE).set(`task:${I('15')}:2026-10-26`, { card: OLD, item: I('15'), date: '2026-10-26', label: 'GP-15 Offline mode for receipts', thread: M(5), submitted: true });
      expect(tasksOf(await pass()).filter((c) => c.id.startsWith(TASK)).map((c) => c.id)).toEqual([OLD]);
      stub.decideHere(OLD, { decision: 'dismissed' });
      item('15').deadline = '2026-11-02';
      await pass();
      const [moved] = tasksOf(await pass()).filter((c) => c.id.startsWith(TASK));
      expect(moved).toMatchObject({ id: `${OLD}-moved-1`, supersedes: OLD, about: '2026-11-02' });
      expect(isId(moved!.id)).toBe(true);
      stub.decideHere(moved!.id, { decision: 'dismissed' });
      await pass();
      expect(tasksOf(await pass()).filter((c) => c.id.startsWith(TASK))).toMatchObject([{ id: `${TASK}:closed-2026-10-26`, supersedes: moved!.id }]);
    });

    it('makes no task of an item in the approval queue, and closes an open task whose item enters it', async () => {
      const { pass, stub, item } = dated();
      item('12').deadline = '2026-10-26'; // Finished: the approval queue
      const first = await pass();
      expect(first.some((c) => c.id === APPROVAL)).toBe(true);
      expect(tasksOf(first).map((c) => c.id)).toEqual([TASK, taskId(I('16'))]);
      item('15').status = 'Finished';
      const cards = await pass();
      expect(cards.find((c) => c.id === `${TASK}:closed`)).toMatchObject({ supersedes: TASK, title: 'GP-15 Offline mode for receipts: waiting for acceptance', body: '**GP-15 Offline mode for receipts**: Finished in GoalPath and waiting for your acceptance; the approval card asks for it.' });
      expect(cards.some((c) => c.id === approvalId(I('15'), 1))).toBe(true);
      expect(stub.cards.get(TASK)).toMatchObject({ state: 'superseded' });
    });

    it('acts on a decision once, however often it is delivered', async () => {
      const { pass, stub, gp, producer, restart } = dated();
      await pass();
      const decided = stub.decideHere(TASK, { decision: 'done' });
      await pass();
      await producer.onDecision(decided); // the same change delivered again (§7.2)
      const closing = tasksOf(await pass()).filter((c) => c.id.startsWith(TASK));
      restart();
      await producer.onDecision(decided);
      const after = tasksOf(await pass()).filter((c) => c.id.startsWith(TASK));
      expect(gp.writes).toEqual([['set_item_status', { itemId: I('15'), status: 'Accepted' }]]);
      expect(closing.map((c) => c.id)).toEqual([`${TASK}:closed`]);
      expect(after).toEqual([]); // the task is neither re-sent nor closed again
    });
  });
});
