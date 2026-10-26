// RFC Appendix A: the orders extension. Pure transitions, like lifecycle.ts: each returns the cards to persist in
// `changed`, in the order the head assigns them fresh `change_seq` values. The head owns the lease clock (`now`).
//
// Readings of Appendix A that the text leaves open are listed in rfc/OPEN.md under "Orders".

import { PROTOCOL, type Card, type HeadFields, type ProducerCard } from './card.js';
import { PbcpError } from './errors.js';
import { parseId } from './id.js';

export const EXEC_STATES = ['open', 'claimed', 'done', 'failed', 'cancelled'] as const;
export type ExecState = (typeof EXEC_STATES)[number];
/** `exec_state` values no event leaves (A.3). */
export const TERMINAL_EXEC_STATES: readonly ExecState[] = ['done', 'failed', 'cancelled'];

/** An order as the head stores it (A.1): `kind: order`, `to_producer` instead of `to_person`, plus the lease fields. */
export type OrderCard = HeadFields & {
  protocol: typeof PROTOCOL;
  id: string;
  kind: 'order';
  producer: 'head';
  title: string;
  body: string;
  urgency?: Card['urgency'];
  emitted_at: string;
  to_producer: string;
  exec_state: ExecState;
  [extension: string]: unknown;
};

/** The extension field an outcome card carries (A.1, A.3). */
export const OUTCOME_CLAIM_SEQ = 'orders.claim_seq';
/** Marks an outcome as a failure (`failed`); absent or `done` is success. Appendix A does not say how (OPEN, Orders). */
export const OUTCOME_RESULT = 'orders.result';

export const isOrder = (c: { kind: string }): c is OrderCard => c.kind === 'order';
export const isTerminal = (s: ExecState) => TERMINAL_EXEC_STATES.includes(s);

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID from a millisecond time and 10 random bytes (the caller supplies the randomness; core does no I/O). */
export function ulid(timeMs: number, random: Uint8Array): string {
  if (random.length < 10) throw new RangeError('ulid needs 10 random bytes');
  let time = '';
  for (let t = timeMs, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  let rand = '';
  let bits = 0;
  let acc = 0;
  for (const b of random.subarray(0, 10)) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += CROCKFORD[(acc >> bits) & 31];
    }
  }
  return time + rand;
}

/** The ULID segment of `head:order:<ulid>`: the `upstream-id` an executor's own cards use (A.4). */
export function ulidOf(orderId: string): string {
  const p = parseId(orderId);
  if (!p || p.producer !== 'head' || p.namespace !== 'order' || p.intent !== undefined || !ULID.test(p.upstream)) {
    throw new PbcpError('invalid_id', `${orderId} is not an order id (head:order:<ulid>)`);
  }
  return p.upstream;
}

export interface OrderInput {
  title: string;
  body: string;
  /** One producer name, or `*` for any executor the head trusts (A.1). */
  to_producer: string;
  urgency?: Card['urgency'];
}

export interface Minted {
  order: OrderCard;
  /** For `to_producer: *`, the executors eligible now: only they ever receive it (A.1). Null for a named recipient. Head-private. */
  eligible: readonly string[] | null;
}

/** A.1: the head mints an order for its owner. `executors` is the head's current set of executor roots. */
export function mintOrder(input: OrderInput, ctx: { ulid: string; now: string; executors: readonly string[] }): Minted {
  if (!ULID.test(ctx.ulid)) throw new PbcpError('invalid_id', `${ctx.ulid} is not a ULID`);
  if (input.to_producer !== '*' && !/^[A-Za-z0-9-]+$/.test(input.to_producer)) {
    throw new PbcpError('invalid_card', 'to_producer is a producer name or *');
  }
  if (input.title === '' || /[\r\n]/.test(input.title)) throw new PbcpError('invalid_card', 'title is one non-empty line');
  const order: OrderCard = {
    protocol: PROTOCOL,
    id: `head:order:${ctx.ulid}`,
    kind: 'order',
    producer: 'head',
    to_producer: input.to_producer,
    title: input.title,
    body: input.body,
    ...(input.urgency ? { urgency: input.urgency } : {}),
    emitted_at: ctx.now,
    state: 'open',
    exec_state: 'open',
    change_seq: 0,
    received_at: ctx.now,
    changed_at: ctx.now,
    delivery: input.urgency ?? 'brief',
  };
  return { order, eligible: input.to_producer === '*' ? [...new Set(ctx.executors)].sort() : null };
}

/** A.1 recipient rule: a producer reads an order named to it, or a wildcard order it was eligible for when minted. */
export function visibleTo(order: OrderCard, producerRoot: string, eligible?: readonly string[] | null): boolean {
  if (order.to_producer === '*') return eligible?.includes(producerRoot) ?? false;
  return order.to_producer === producerRoot;
}

const expired = (order: OrderCard, now: string) => order.claim_expires_at !== undefined && Date.parse(order.claim_expires_at) <= Date.parse(now);

const withoutLease = (o: OrderCard): OrderCard => {
  const { claimed_by: _by, claim_expires_at: _at, ...rest } = o;
  return rest as OrderCard;
};

/** A.2: a claimed order whose lease is at or before `now` returns to `open`; `claim_seq` is kept. Unchanged otherwise. */
export function expireIfDue(order: OrderCard, now: string): { card: OrderCard; changed: OrderCard[] } {
  if (order.exec_state !== 'claimed' || !expired(order, now)) return { card: order, changed: [] };
  const card: OrderCard = { ...withoutLease(order), exec_state: 'open', changed_at: now };
  return { card, changed: [card] };
}

export type ClaimResult =
  | { status: 200; card: OrderCard; changed: OrderCard[] }
  /** 409: another executor holds a live lease. 410: the order is terminal. Both carry the order (A.2, A.5). */
  | { status: 409 | 410; card: OrderCard; changed: OrderCard[] };

function addSeconds(iso: string, s: number): string {
  return new Date(Date.parse(iso) + s * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * A.2, A.5: claim or renew. Expiry is evaluated first, in the same transition, so `changed` may hold the expired
 * order even when the claim is refused. A claim by the lease holder while its lease is live is a renewal.
 */
export function claim(order: OrderCard, by: string, leaseSeconds: number, now: string): ClaimResult {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) throw new PbcpError('invalid_card', 'lease_seconds must be a positive integer');
  const { card: current, changed } = expireIfDue(order, now);
  if (isTerminal(current.exec_state)) return { status: 410, card: current, changed };
  if (current.exec_state === 'claimed' && current.claimed_by !== by) return { status: 409, card: current, changed };
  const card: OrderCard = {
    ...current,
    exec_state: 'claimed',
    claimed_by: by,
    claim_expires_at: addSeconds(now, leaseSeconds),
    claim_seq: (current.claim_seq ?? 0) + 1,
    changed_at: now,
  };
  return { status: 200, card, changed: [card] };
}

/** A.5: renewal is a claim by the holder; a renewal by anyone else is refused as a claim would be. */
export const renew = claim;

/** The order an outcome card names in `references`, if it is an outcome at all (it carries `orders.claim_seq`). */
export function outcomeTarget(card: ProducerCard): string | undefined {
  if (card[OUTCOME_CLAIM_SEQ] === undefined) return undefined;
  return card.references?.find((r) => {
    const p = parseId(r);
    return p?.producer === 'head' && p.namespace === 'order';
  });
}

/**
 * A.3: an outcome moves `exec_state` only when it comes from the current lease: the order is `claimed`, the
 * outcome's producer holds the lease, and its `orders.claim_seq` is the order's `claim_seq`. Otherwise it is
 * stale: stored by the caller as an ordinary card, the order unchanged. A terminal order never changes.
 * The head runs expireIfDue first, so a lapsed lease makes the outcome stale.
 */
export function applyOutcome(order: OrderCard, outcome: ProducerCard, now = outcome.emitted_at): { card: OrderCard; stale: boolean; changed: OrderCard[] } {
  const live =
    order.exec_state === 'claimed' &&
    order.claimed_by === outcome.producer &&
    outcome[OUTCOME_CLAIM_SEQ] === order.claim_seq &&
    outcome.references?.includes(order.id) === true;
  if (!live) return { card: order, stale: true, changed: [] };
  const exec_state: ExecState = outcome[OUTCOME_RESULT] === 'failed' ? 'failed' : 'done';
  const card: OrderCard = { ...withoutLease(order), exec_state, changed_at: now };
  return { card, stale: false, changed: [card] };
}

/** A.1: `dismissed`, the only decision an order takes, cancels it if open or claimed and releases the lease. */
export function dismissOrder(order: OrderCard, decision: { decision: string; comment?: string }, now: string): OrderCard {
  if (decision.decision !== 'dismissed') throw new PbcpError('invalid_decision', 'an order takes only the decision dismissed');
  const active = order.exec_state === 'open' || order.exec_state === 'claimed';
  return {
    ...(active ? withoutLease(order) : order),
    ...(active ? { exec_state: 'cancelled' as const } : {}),
    state: 'decided',
    decision: 'dismissed',
    ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
    decided_at: now,
    changed_at: now,
  };
}
