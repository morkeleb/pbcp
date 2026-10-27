import { describe, expect, it } from 'vitest';
import { parseCardOrThrow, type Card, type ProducerCard } from './card.js';
import { PbcpError } from './errors.js';
import { acknowledge, canSupersede, checkSubmission, decide, markSeen, snooze, submit, unsnooze } from './lifecycle.js';

const T0 = '2026-10-07T06:00:00Z';
const T1 = '2026-10-07T07:00:00Z';
const T2 = '2026-10-07T08:00:00Z';

const card = (over: Record<string, unknown> = {}): ProducerCard =>
  parseCardOrThrow({
    protocol: 'pbcp/1',
    id: 'goalpath:item:4421',
    kind: 'decision',
    to_person: 'morten',
    producer: 'goalpath',
    title: 'Ship 4421?',
    body: 'Evidence. Proposal.',
    emitted_at: T0,
    ...over,
  });

/** What a head does with `changed`: assign the next counter values in order. */
function apply(changed: Card[], counter: { n: number }): Card[] {
  return changed.map((c) => ({ ...c, change_seq: ++counter.n }));
}

function throws(fn: () => unknown, code: string, status: number): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PbcpError);
    expect((e as PbcpError).code).toBe(code);
    expect((e as PbcpError).status).toBe(status);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('submit (§5 table)', () => {
  it('none → 201 open', () => {
    const r = submit(null, card(), T0);
    expect(r.status).toBe(201);
    expect(r.card).toMatchObject({ state: 'open', received_at: T0, changed_at: T0 });
    expect(r.changed).toHaveLength(1);
  });

  it('open, identical (emitted_at aside) → 200, no change', () => {
    const [stored] = apply(submit(null, card(), T0).changed, { n: 0 });
    const r = submit(stored!, card({ emitted_at: T1 }), T1);
    expect(r.status).toBe(200);
    expect(r.changed).toEqual([]);
    expect(r.card).toBe(stored);
  });

  it('open, different → 200, replaced, received_at updated, seen_at cleared when the body changes', () => {
    const [stored] = apply(submit(null, card(), T0).changed, { n: 0 });
    const seen = markSeen(stored!, T0).card;
    const r = submit(seen, card({ body: 'Revised.' }), T1);
    expect(r.status).toBe(200);
    expect(r.card).toMatchObject({ state: 'open', body: 'Revised.', received_at: T1, changed_at: T1 });
    expect(r.card.seen_at).toBeUndefined();
    expect(r.changed).toEqual([r.card]);
  });

  it('keeps seen_at when only the title changes, clears it when actions change', () => {
    const seen = markSeen(submit(null, card(), T0).card, T0).card;
    expect(submit(seen, card({ title: 'Renamed' }), T1).card.seen_at).toBe(T0);
    expect(submit(seen, card({ actions: ['approve'] }), T1).card.seen_at).toBeUndefined();
  });

  it('decided, identical → 200 with the decision; different → 409 with the decision', () => {
    const decided = decide(submit(null, card(), T0).card, { decision: 'approve' }, T1).card;
    const same = submit(decided, card({ emitted_at: T2 }), T2);
    expect(same).toMatchObject({ status: 200, changed: [] });
    expect(same.card.decision).toBe('approve');
    const diff = submit(decided, card({ title: 'Changed' }), T2);
    expect(diff).toMatchObject({ status: 409, changed: [] });
    expect(diff.card).toBe(decided);
  });

  it('superseded behaves like decided', () => {
    const old = { ...submit(null, card(), T0).card, state: 'superseded' as const };
    expect(submit(old, card(), T1).status).toBe(200);
    expect(submit(old, card({ title: 'x' }), T1).status).toBe(409);
  });

  it('ignores head-owned fields when comparing', () => {
    const stored = { ...submit(null, card(), T0).card, change_seq: 9, seen_at: T0, snoozed_until: T2 };
    expect(submit(stored, card(), T1).status).toBe(200);
  });
});

describe('supersession (§6, §8)', () => {
  const successor = card({ id: 'goalpath:item:4421:revised', supersedes: 'goalpath:item:4421' });

  it('supersedes an open card atomically: predecessor first, successor second', () => {
    const counter = { n: 0 };
    const [pred] = apply(submit(null, card(), T0).changed, counter);
    const seenPred = { ...pred!, seen_at: T0 };
    const r = submit(null, successor, T1, seenPred);
    expect(r.status).toBe(201);
    expect(r.superseded).toBe('goalpath:item:4421');
    const [p, s] = apply(r.changed, counter);
    expect(p).toMatchObject({ id: 'goalpath:item:4421', state: 'superseded', changed_at: T1, change_seq: 2 });
    expect(s).toMatchObject({ id: 'goalpath:item:4421:revised', state: 'open', change_seq: 3 });
    expect(s!.seen_at).toBeUndefined();
  });

  it('supersedes a decided card and keeps its decision', () => {
    const decided = decide(submit(null, card(), T0).card, { decision: 'reject', comment: 'no' }, T1).card;
    const [p] = submit(null, successor, T2, decided).changed;
    expect(p).toMatchObject({ state: 'superseded', decision: 'reject', comment: 'no', decided_at: T1 });
  });

  it('refuses a superseded target with 409', () => {
    const gone = { ...submit(null, card(), T0).card, state: 'superseded' as const };
    throws(() => submit(null, successor, T1, gone), 'already_superseded', 409);
  });

  it('refuses a cross-namespace supersede with 403, before looking at the target', () => {
    const cross = card({ id: 'goalpath:milestone:88', supersedes: 'goalpath:item:4421' });
    throws(() => submit(null, cross, T1, null), 'cross_namespace_supersede', 403);
    expect(canSupersede(null, cross)?.status).toBe(403);
  });

  it('refuses self and missing targets with 400', () => {
    throws(() => submit(null, card({ supersedes: 'goalpath:item:4421' }), T1, null), 'supersede_self', 400);
    throws(() => submit(null, successor, T1, null), 'supersede_target_missing', 400);
  });

  it('does not re-supersede on an identical or same-target re-PUT of the successor', () => {
    const pred = submit(null, card(), T0).card;
    const s = submit(null, successor, T1, pred).card;
    expect(submit(s, successor, T2).changed).toEqual([]);
    const r = submit(s, { ...successor, title: 'Revised again' }, T2);
    expect(r.changed).toHaveLength(1);
    expect(r.superseded).toBeUndefined();
  });

  it('canSupersede is null without supersedes', () => {
    expect(canSupersede(null, card())).toBeNull();
  });
});

describe('decide (§4.3, §7.3)', () => {
  const open = submit(null, card({ actions: [{ id: 'ship-friday', default: true }, 'hold', 'edit'] }), T0).card;

  it('records an offered action and locks the card', () => {
    const r = decide(open, { decision: 'ship-friday', comment: 'go' }, T1);
    expect(r.status).toBe(200);
    expect(r.card).toMatchObject({ state: 'decided', decision: 'ship-friday', comment: 'go', decided_at: T1, changed_at: T1 });
    expect(r.changed).toEqual([r.card]);
  });

  it('accepts the protocol decisions with their required fields', () => {
    expect(decide(open, { decision: 'dismissed' }, T1).card.decision).toBe('dismissed');
    expect(decide(open, { decision: 'edited', edited_proposal: 'Ship Monday' }, T1).card.edited_proposal).toBe('Ship Monday');
    expect(decide(open, { decision: 'delegated', delegated_to: 'anna' }, T1).card.delegated_to).toBe('anna');
  });

  it('applies the default actions', () => {
    const plain = submit(null, card(), T0).card;
    expect(decide(plain, { decision: 'approve' }, T1).status).toBe(200);
    throws(() => decide(plain, { decision: 'ship-friday' }, T1), 'invalid_decision', 400);
  });

  it('refuses invalid decisions with 400', () => {
    throws(() => decide(open, { decision: 'approve' }, T1), 'invalid_decision', 400);
    throws(() => decide(open, { decision: 'edit' }, T1), 'invalid_decision', 400);
    throws(() => decide(open, { decision: 'edited' }, T1), 'invalid_decision', 400);
    throws(() => decide(open, { decision: 'delegated' }, T1), 'invalid_decision', 400);
    throws(() => decide(open, { decision: 'hold', edited_proposal: 'x' }, T1), 'invalid_decision', 400);
    throws(() => decide(open, { decision: 'hold', extra: 1 } as never, T1), 'invalid_decision', 400);
  });

  it('returns 409 for a decided or superseded card', () => {
    const decided = decide(open, { decision: 'hold' }, T1).card;
    expect(decide(decided, { decision: 'hold' }, T2)).toEqual({ status: 409, card: decided, changed: [] });
    expect(decide({ ...open, state: 'superseded' }, { decision: 'hold' }, T2).status).toBe(409);
  });

  it('refuses artifacts and signals', () => {
    const art = submit(null, card({ kind: 'artifact' }), T0).card;
    throws(() => decide(art, { decision: 'dismissed' }, T1), 'not_decidable', 400);
  });
});

describe('acknowledge and markSeen', () => {
  it('acknowledges an artifact without changing its state; idempotent', () => {
    const art = submit(null, card({ kind: 'artifact' }), T0).card;
    const r = acknowledge(art, T1);
    expect(r.card).toMatchObject({ state: 'open', acknowledged_at: T1 });
    expect(acknowledge(r.card, T2)).toEqual({ status: 200, card: r.card, changed: [] });
  });

  it('refuses to acknowledge a decision card', () => {
    throws(() => acknowledge(submit(null, card(), T0).card, T1), 'not_acknowledgeable', 400);
  });

  it('marks seen once', () => {
    const c = submit(null, card(), T0).card;
    const r = markSeen(c, T1);
    expect(r.card.seen_at).toBe(T1);
    expect(markSeen(r.card, T2).changed).toEqual([]);
  });
});

describe('snooze and unsnooze (§4.2, §6)', () => {
  it('sets snoozed_until on an open card without changing its state; idempotent', () => {
    const c = submit(null, card(), T0).card;
    const r = snooze(c, T2, T1);
    expect(r).toMatchObject({ status: 200, card: { state: 'open', snoozed_until: T2, changed_at: T1 } });
    expect(r.changed).toEqual([r.card]);
    expect(snooze(r.card, T2, T1)).toEqual({ status: 200, card: r.card, changed: [] });
    const later = '2026-10-07T09:00:00Z';
    expect(snooze(r.card, later, T1).card.snoozed_until).toBe(later);
  });

  it('unsnooze clears it, once', () => {
    const c = snooze(submit(null, card(), T0).card, T2, T0).card;
    const r = unsnooze(c, T1);
    expect(r.card).not.toHaveProperty('snoozed_until');
    expect(r.card).toMatchObject({ state: 'open', changed_at: T1 });
    expect(r.changed).toEqual([r.card]);
    expect(unsnooze(r.card, T2)).toEqual({ status: 200, card: r.card, changed: [] });
  });

  it('a decided or superseded card is a 409 result carrying the stored card', () => {
    const decided = decide(submit(null, card(), T0).card, { decision: 'approve' }, T1).card;
    expect(snooze(decided, T2, T1)).toEqual({ status: 409, card: decided, changed: [] });
    expect(unsnooze(decided, T1)).toEqual({ status: 409, card: decided, changed: [] });
    const superseded = { ...submit(null, card(), T0).card, state: 'superseded' as const };
    expect(snooze(superseded, T2, T1).status).toBe(409);
  });

  it('refuses an until that is not later than now, or not a UTC timestamp, with 400 invalid_snooze', () => {
    const c = submit(null, card(), T0).card;
    throws(() => snooze(c, T0, T1), 'invalid_snooze', 400);
    throws(() => snooze(c, T1, T1), 'invalid_snooze', 400);
    throws(() => snooze(c, 'tomorrow', T1), 'invalid_snooze', 400);
    throws(() => snooze(c, '2026-10-08T09:00:00+02:00', T1), 'invalid_snooze', 400);
  });

  it('a revision by re-PUT keeps snoozed_until (§5)', () => {
    const c = snooze(submit(null, card(), T0).card, T2, T0).card;
    expect(submit(c, card({ body: 'Revised.' }), T1).card.snoozed_until).toBe(T2);
  });
});

describe('checkSubmission (§5, §10, §12)', () => {
  it('requires the token root and the owner', () => {
    expect(() => checkSubmission(card(), { root: 'goalpath', owner: 'morten' })).not.toThrow();
    throws(() => checkSubmission(card(), { root: 'hermes', owner: 'morten' }), 'outside_root', 403);
    throws(() => checkSubmission(card({ to_person: 'anna' }), { root: 'goalpath', owner: 'morten' }), 'wrong_person', 403);
    throws(() => checkSubmission(card(), { root: 'goalpath', owner: 'morten', pathId: 'goalpath:item:1' }), 'id_mismatch', 400);
    expect(() => checkSubmission(card(), { root: 'goalpath', owner: 'morten', pathId: 'goalpath:item:4421' })).not.toThrow();
  });
});
