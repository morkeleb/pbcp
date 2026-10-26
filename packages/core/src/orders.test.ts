import { describe, expect, it } from 'vitest';
import { decide } from './lifecycle.js';
import { applyOutcome, claim, dismissOrder, expireIfDue, mintOrder, outcomeTarget, ulid, ulidOf, visibleTo, type OrderCard } from './orders.js';
import type { Card, ProducerCard } from './card.js';

const T0 = '2026-10-07T09:00:00Z';
const ID = '01J9Q3K7X2ABCDEFGHJKMNPQRS';
const mint = (to = '*', executors = ['hermes']) => mintOrder({ to_producer: to, title: 'Book the dentist', body: 'Tuesday' }, { ulid: ID, now: T0, executors });
const outcome = (over: Record<string, unknown> = {}): ProducerCard =>
  ({ protocol: 'pbcp/1', id: 'hermes:order:x:outcome', kind: 'signal', to_person: 'morten', producer: 'hermes', title: 'Done', body: '', emitted_at: T0, references: [`head:order:${ID}`], 'orders.claim_seq': 1, ...over }) as ProducerCard;

describe('ulid', () => {
  it('encodes time then randomness in Crockford base32, sortable by time', () => {
    const a = ulid(0, new Uint8Array(10));
    expect(a).toBe('00000000000000000000000000');
    const b = ulid(1_700_000_000_000, new Uint8Array(10).fill(255));
    expect(b).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(b.endsWith('ZZZZZZZZZZZZZZZZ')).toBe(true);
    expect(ulid(2, new Uint8Array(10)) > ulid(1, new Uint8Array(10).fill(255))).toBe(true);
  });

  it('ulidOf takes the upstream segment of head:order:<ulid> and refuses anything else', () => {
    expect(ulidOf(`head:order:${ID}`)).toBe(ID);
    for (const bad of ['hermes:order:x', `head:order:${ID}:x`, 'head:order:not-a-ulid']) expect(() => ulidOf(bad)).toThrow(/not an order id/);
  });
});

describe('mintOrder and visibleTo (A.1)', () => {
  it('mints head:order:<ulid> for to_producer, without to_person, open', () => {
    const { order, eligible } = mint('*', ['cal', 'hermes', 'cal']);
    expect(order).toMatchObject({ id: `head:order:${ID}`, kind: 'order', producer: 'head', to_producer: '*', exec_state: 'open', state: 'open', delivery: 'brief' });
    expect('to_person' in order).toBe(false);
    expect(eligible).toEqual(['cal', 'hermes']);
    expect(mint('todoist').eligible).toBeNull();
  });

  it('a wildcard order is visible only to the snapshot; a named one only to its producer', () => {
    const { order, eligible } = mint('*', ['hermes']);
    expect(visibleTo(order, 'hermes', eligible)).toBe(true);
    expect(visibleTo(order, 'late', eligible)).toBe(false);
    expect(visibleTo(order, 'hermes')).toBe(false);
    const named = mint('todoist').order;
    expect(visibleTo(named, 'todoist')).toBe(true);
    expect(visibleTo(named, 'hermes')).toBe(false);
  });

  it('refuses a bad recipient, title or ulid', () => {
    expect(() => mintOrder({ to_producer: 'a:b', title: 't', body: '' }, { ulid: ID, now: T0, executors: [] })).toThrow();
    expect(() => mintOrder({ to_producer: '*', title: 'a\nb', body: '' }, { ulid: ID, now: T0, executors: [] })).toThrow();
    expect(() => mintOrder({ to_producer: '*', title: 't', body: '' }, { ulid: 'x', now: T0, executors: [] })).toThrow();
  });
});

describe('claim, expireIfDue (A.2)', () => {
  it('sets the lease, counts claim_seq, and expires at or before now', () => {
    const r = claim(mint().order, 'hermes', 60, T0);
    expect(r).toMatchObject({ status: 200, card: { exec_state: 'claimed', claimed_by: 'hermes', claim_seq: 1, claim_expires_at: '2026-10-07T09:01:00Z' } });
    expect(expireIfDue(r.card, '2026-10-07T09:00:59Z').changed).toEqual([]);
    const lapsed = expireIfDue(r.card, '2026-10-07T09:01:00Z');
    expect(lapsed.card).toMatchObject({ exec_state: 'open', claim_seq: 1 });
    expect(lapsed.card.claimed_by).toBeUndefined();
  });

  it('reports the expiry it applied even when it refuses, and refuses a bad lease', () => {
    const held = claim(mint().order, 'hermes', 60, T0).card;
    const done = { ...held, exec_state: 'done' as const };
    expect(claim(done, 'hermes', 60, T0)).toMatchObject({ status: 410, changed: [] });
    expect(() => claim(held, 'hermes', 0, T0)).toThrow(/lease_seconds/);
  });
});

describe('applyOutcome (A.3)', () => {
  const held = () => claim(mint().order, 'hermes', 60, T0).card;
  it('moves exec_state only for the holder, the current claim_seq and a reference to the order', () => {
    expect(applyOutcome(held(), outcome(), T0)).toMatchObject({ stale: false, card: { exec_state: 'done' } });
    expect(applyOutcome(held(), outcome({ 'orders.result': 'failed' }), T0).card.exec_state).toBe('failed');
    expect(applyOutcome(held(), outcome({ 'orders.claim_seq': 2 }), T0).stale).toBe(true);
    expect(applyOutcome(held(), outcome({ producer: 'cal', id: 'cal:order:x:outcome' }), T0).stale).toBe(true);
    expect(applyOutcome(held(), outcome({ references: [] }), T0).stale).toBe(true);
    expect(applyOutcome(mint().order, outcome(), T0).stale).toBe(true);
  });

  it('finds the order an outcome names, and nothing for a card without orders.claim_seq', () => {
    expect(outcomeTarget(outcome())).toBe(`head:order:${ID}`);
    expect(outcomeTarget(outcome({ 'orders.claim_seq': undefined }))).toBeUndefined();
  });
});

describe('dismissed (A.1) through lifecycle.decide', () => {
  it('cancels an open or claimed order and leaves a done one done', () => {
    const held = claim(mint().order, 'hermes', 60, T0).card;
    const r = decide(held as unknown as Card, { decision: 'dismissed', comment: 'not needed' }, T0);
    expect(r).toMatchObject({ status: 200, card: { state: 'decided', decision: 'dismissed', exec_state: 'cancelled', comment: 'not needed' } });
    expect((r.card as unknown as OrderCard).claimed_by).toBeUndefined();
    expect(dismissOrder({ ...held, exec_state: 'done' }, { decision: 'dismissed' }, T0).exec_state).toBe('done');
    expect(decide(r.card, { decision: 'dismissed' }, T0).status).toBe(409);
  });

  it('refuses every other decision on an order', () => {
    const o = mint().order as unknown as Card;
    for (const d of [{ decision: 'approve' }, { decision: 'edited', edited_proposal: 'x' }, { decision: 'delegated', delegated_to: 'anna' }]) {
      expect(() => decide(o, d, T0)).toThrow(expect.objectContaining({ code: 'invalid_decision' }));
    }
  });
});
