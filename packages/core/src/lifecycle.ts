// RFC §5 (submission), §6 (lifecycle), §7.3 (decide), §8 (supersession).
//
// Pure transitions. Each returns the effect for the head to apply in one transaction:
// `changed` lists every card to persist, in the order the head assigns them fresh
// `change_seq` values from its counter. `change_seq` on returned cards is whatever was
// stored (0 for a new card) until the head assigns it; this module never touches the counter.

import { z } from 'zod';
import {
  BUILTIN_DECISIONS, EDIT_ACTION, actionId, effectiveActions, equal, producerPart,
  type Card, type ProducerCard,
} from './card.js';
import { PbcpError } from './errors.js';
import { inRoot, sameNamespace } from './id.js';

export const DecisionSchema = z.strictObject({
  decision: z.string().min(1),
  edited_proposal: z.string().optional(),
  comment: z.string().optional(),
  delegated_to: z.string().min(1).optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export type SubmitResult =
  | { status: 201 | 200; card: Card; changed: Card[]; superseded?: string }
  | { status: 409; card: Card; changed: []; superseded?: undefined };

export type DecideResult =
  | { status: 200; card: Card; changed: Card[] }
  | { status: 409; card: Card; changed: [] };

export interface UpdateResult {
  status: 200;
  card: Card;
  changed: Card[];
}

/** §5, §10, §12: the token's root owns the id, and the card is addressed to this head's owner. */
export function checkSubmission(incoming: ProducerCard, ctx: { root: string; owner: string }): void {
  if (!inRoot(incoming.id, ctx.root)) throw new PbcpError('outside_root', `${incoming.id} is outside root ${ctx.root}`);
  if (incoming.to_person !== ctx.owner) throw new PbcpError('wrong_person', `this head stores cards for ${ctx.owner} only`);
}

/** §6, §8. Null when `incoming` may supersede `target` (or supersedes nothing). */
export function canSupersede(target: Card | null, incoming: ProducerCard): PbcpError | null {
  const ref = incoming.supersedes;
  if (ref === undefined) return null;
  if (ref === incoming.id) return new PbcpError('supersede_self', 'a card cannot supersede itself');
  if (!sameNamespace(ref, incoming.id)) {
    return new PbcpError('cross_namespace_supersede', `${incoming.id} may not supersede ${ref}: different namespace`);
  }
  if (target === null) return new PbcpError('supersede_target_missing', `${ref} does not exist`);
  if (target.state === 'superseded') return new PbcpError('already_superseded', `${ref} is already superseded`);
  return null;
}

/**
 * §5 submission table. `stored` is the card at `incoming.id`; `target` is the card named
 * by `incoming.supersedes`, loaded by the head (pass null if absent). Refusals throw PbcpError;
 * a locked card with different content is a 409 *result*, carrying the stored card.
 */
export function submit(stored: Card | null, incoming: ProducerCard, now: string, target: Card | null = null): SubmitResult {
  if (stored !== null) {
    const same = equal(producerPart(stored), incoming);
    if (stored.state !== 'open') return same ? { status: 200, card: stored, changed: [] } : { status: 409, card: stored, changed: [] };
    if (same) return { status: 200, card: stored, changed: [] };
  }

  // Supersession applies when the card is new, or an open card is re-PUT naming a different target.
  const supersedes = incoming.supersedes !== undefined && incoming.supersedes !== stored?.supersedes;
  let predecessor: Card | undefined;
  if (supersedes) {
    const err = canSupersede(target, incoming);
    if (err) throw err;
    predecessor = { ...target!, state: 'superseded', changed_at: now };
  }

  let card: Card;
  if (stored === null) {
    card = { ...incoming, state: 'open', change_seq: 0, received_at: now, changed_at: now };
  } else {
    const { seen_at, ...kept } = headPart(stored);
    const revised = !equal(producerPart(stored), { ...producerPart(stored), body: incoming.body, actions: incoming.actions });
    card = { ...incoming, ...kept, ...(revised || seen_at === undefined ? {} : { seen_at }), received_at: now, changed_at: now };
  }

  const changed = predecessor ? [predecessor, card] : [card];
  return {
    status: stored === null ? 201 : 200,
    card,
    changed,
    ...(predecessor ? { superseded: predecessor.id } : {}),
  };
}

/** §4.3, §7.3. Head-side only: records the owner's decision and locks the card. */
export function decide(stored: Card, d: Decision, now: string): DecideResult {
  if (stored.kind !== 'decision') throw new PbcpError('not_decidable', `${stored.kind} cards take no decision`);
  if (stored.state !== 'open') return { status: 409, card: stored, changed: [] };

  const parsed = DecisionSchema.safeParse(d);
  if (!parsed.success) throw new PbcpError('invalid_decision', parsed.error.issues.map((i) => i.message).join('; '));
  const { decision, edited_proposal, comment, delegated_to } = parsed.data;

  const offered = effectiveActions(stored).map(actionId).filter((id) => id !== EDIT_ACTION);
  if (!offered.includes(decision) && !(BUILTIN_DECISIONS as readonly string[]).includes(decision)) {
    const hint = decision === EDIT_ACTION ? ' (the edit option is recorded as edited)' : '';
    throw new PbcpError('invalid_decision', `${decision} is not one of the card's actions or a protocol decision${hint}`);
  }
  if ((decision === 'edited') !== (edited_proposal !== undefined)) {
    throw new PbcpError('invalid_decision', 'edited_proposal is required with, and only with, edited');
  }
  if ((decision === 'delegated') !== (delegated_to !== undefined)) {
    throw new PbcpError('invalid_decision', 'delegated_to is required with, and only with, delegated');
  }

  const card: Card = {
    ...stored,
    state: 'decided',
    decision,
    ...(edited_proposal !== undefined ? { edited_proposal } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(delegated_to !== undefined ? { delegated_to } : {}),
    decided_at: now,
    changed_at: now,
  };
  return { status: 200, card, changed: [card] };
}

/** §4.2: explicit acknowledgement of an artifact or signal. Not a transition; the card stays in its state. */
export function acknowledge(stored: Card, now: string): UpdateResult {
  if (stored.kind === 'decision') throw new PbcpError('not_acknowledgeable', 'decision cards are decided, not acknowledged');
  if (stored.acknowledged_at !== undefined) return { status: 200, card: stored, changed: [] };
  const card: Card = { ...stored, acknowledged_at: now, changed_at: now };
  return { status: 200, card, changed: [card] };
}

/** §4.2 `seen_at`: the head presented the card to its owner. What counts as presenting is the head's call. */
export function markSeen(stored: Card, now: string): UpdateResult {
  if (stored.seen_at !== undefined) return { status: 200, card: stored, changed: [] };
  const card: Card = { ...stored, seen_at: now, changed_at: now };
  return { status: 200, card, changed: [card] };
}

function headPart(c: Card): Partial<Card> & Pick<Card, 'state' | 'change_seq' | 'received_at' | 'changed_at'> {
  const p = producerPart(c);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (!(k in p)) out[k] = v;
  return out as Partial<Card> & Pick<Card, 'state' | 'change_seq' | 'received_at' | 'changed_at'>;
}
