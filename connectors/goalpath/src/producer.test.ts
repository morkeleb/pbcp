import { fileURLToPath } from 'node:url';
import { HeadClient, memoryCursor, producerPass, type StateStore } from '@pbcp/client';
import { isId, type ProducerCard } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { stubHead } from '../../../packages/client/test/stub.js';
import { fixtureSource, loadFixtures } from './fixture-source.js';
import { approvalId, ganttTitle, goalpathProducer, type State } from './producer.js';

const FIX = fileURLToPath(new URL('../fixtures', import.meta.url));
const M = (n: number) => `7a1e0c2e-4d4b-4c51-9b1a-00000000000${n}`;
const I = (n: string) => `3c9b7f10-2a6e-4e0f-8d3e-0000000000${n}`;
const cfg = { toPerson: 'morten', projectId: 'p-demo', tz: 'Europe/Copenhagen' };
const RISK = `goalpath:milestone:${M(4)}.20261124:risk`;
const APPROVAL = `goalpath:approval:${I('12')}`;
const BUILD = 'goalpath:build:gh-run-118842';

function memState(): StateStore<State> {
  const m = new Map<string, State>();
  return { get: async (k) => structuredClone(m.get(k)), set: async (k, v) => void m.set(k, structuredClone(v)), delete: async (k) => void m.delete(k) };
}

function setup(now = '2026-10-26T12:00:00Z') {
  const data = loadFixtures(FIX);
  const gp = fixtureSource(data, 'p-demo');
  const stub = stubHead();
  let clock = new Date(now);
  const producer = goalpathProducer(new HeadClient({ baseUrl: 'https://head.test', token: 't', fetch: stub.fetch }), gp, memState(), cfg, () => clock);
  const cursor = memoryCursor();
  const errors: unknown[] = [];
  let seen = 0;
  /** One pass; returns the cards PUT during it. */
  const pass = async () => {
    await producerPass({ ...producer, cursor, onError: (e) => errors.push(e) });
    const puts = stub.requests.filter((r) => r.method === 'PUT').map((r) => r.body as ProducerCard);
    return puts.slice(seen, (seen = puts.length));
  };
  const items = (data.list_my_items as { items: Record<string, unknown>[] }).items;
  const item = (n: string) => items.find((i) => i.id === I(n))!;
  const forecast = (n: number) => (data.get_milestone_forecast as Record<string, Record<string, unknown>>)[M(n)]!;
  return { stub, gp, pass, errors, item, forecast, at: (t: string) => void (clock = new Date(t)) };
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
    // The stub does not implement supersession: the predecessor stays open there. A head marks it superseded (§8).
    expect(stub.cards.get(RISK)!.state).toBe('open');

    forecast(4).projectedCompletionDate = '2026-11-12';
    const [back] = await pass();
    expect(back).toMatchObject({ id: `goalpath:milestone:${M(4)}.20261112:on-track`, kind: 'signal', supersedes: later!.id, title: 'Billing revamp: back on track, forecast 12 Nov (deadline 13 Nov)' });
    expect(await pass()).toHaveLength(1); // only the build; staying on track sends nothing

    forecast(4).projectedCompletionDate = '2026-11-20';
    const [again] = await pass();
    expect(again).toMatchObject({ id: `goalpath:milestone:${M(4)}.20261120:risk`, supersedes: back!.id });
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

  it('supersedes an open approval answered in GoalPath first, and then ignores a late head decision', async () => {
    const { pass, stub, gp, item } = setup();
    await pass();
    item('12').status = 'Accepted';
    const [answered] = (await pass()).filter((c) => c.id.startsWith('goalpath:approval:'));
    expect(answered).toMatchObject({ id: `${APPROVAL}:answered`, kind: 'signal', supersedes: APPROVAL, thread: M(4), title: 'GP-12 Export invoices as CSV: answered in GoalPath' });
    expect(answered!.body).toContain('it is now Accepted');
    // The stub leaves the predecessor open, so a decision can still land on it; GoalPath already answered, so nothing is written.
    stub.decideHere(APPROVAL, { decision: 'reject' });
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
    expect(digest).toMatchObject({ id: 'goalpath:digest:2026-10-26', kind: 'artifact', urgency: 'brief', thread: 'p-demo', title: 'GoalPath 26 Oct: 1 done, 1 blocked, 2 milestones late' });
    expect('actions' in digest).toBe(false);
    expect(digest.body).toBe([
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

  it('escapes gantt task names', () => {
    expect(ganttTitle('Q4: review #2; 100% done')).toBe('Q4 review 2 100 done');
    expect(ganttTitle('section cleanup')).toBe('· section cleanup');
    expect(ganttTitle('x'.repeat(50))).toHaveLength(40);
  });
});
