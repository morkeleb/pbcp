// In-process HeadUnderTest: the pure core functions over an in-memory map and a fake
// monotonic counter. It is the smallest thing that can run the fixtures, not a head.

import {
  acknowledge, CARD_LIMIT_BYTES, checkSubmission, decide, markSeen, parseCardOrThrow, PbcpError, PROTOCOL, submit,
  type Card, type Decision, type Urgency,
} from '../../src/index.js';
import type { HeadUnderTest, Response } from '../types.js';

export interface InProcessOptions {
  owner?: string;
  /** Maximum entries per `changes` page; small by default so the fixtures exercise paging. */
  pageSize?: number;
}

export function inProcessHead(opts: InProcessOptions = {}): HeadUnderTest {
  const owner = opts.owner ?? 'morten';
  const pageSize = opts.pageSize ?? 2;
  let cards = new Map<string, Card>();
  let tokens = new Map<string, { root: string; ceiling?: Urgency }>();
  let counter = 0;
  let now = '2026-10-07T00:00:00Z';

  const persist = (changed: Card[]): void => {
    for (const c of changed) cards.set(c.id, { ...c, change_seq: ++counter });
  };

  /** §7.4: any missing or unknown producer token is 401 unauthorized. */
  const producer = (token: string | null) => {
    const p = token === null ? undefined : tokens.get(token);
    if (p === undefined) throw new PbcpError('unauthorized', 'missing or invalid producer token');
    return p;
  };

  const handle = (fn: () => Response): Response => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof PbcpError) return { status: e.status, body: e.toJSON() };
      throw e;
    }
  };

  const ownerOp = (id: string, op: (c: Card) => { status: number; card: Card; changed: Card[] }): Response =>
    handle(() => {
      const stored = cards.get(id);
      if (!stored) throw new PbcpError('not_found', `no card ${id}`);
      const r = op(stored);
      persist(r.changed);
      return { status: r.status, body: cards.get(id) };
    });

  return {
    async reset() {
      cards = new Map();
      tokens = new Map();
      counter = 0;
    },

    async token(root, opts) {
      const t = `token-${root}-${tokens.size + 1}`;
      tokens.set(t, { root, ...(opts?.ceiling ? { ceiling: opts.ceiling } : {}) });
      return t;
    },

    async describe() {
      return { status: 200, body: { protocol: PROTOCOL, owner, seq: counter, extensions: [], render: { mermaid: ['core', 'extended'] } } };
    },

    async put(token, input) {
      return handle(() => {
        const { root, ceiling } = producer(token);
        // §3.1, §7.1: the size check comes before parsing; this head's limit is the 64 KiB every head accepts.
        const size = new TextEncoder().encode(typeof input === 'string' ? input : JSON.stringify(input)).length;
        if (size > CARD_LIMIT_BYTES) throw new PbcpError('too_large', `card is ${size} bytes; this head accepts ${CARD_LIMIT_BYTES}`);
        const incoming = parseCardOrThrow(input);
        checkSubmission(incoming, { root, owner });
        const target = incoming.supersedes === undefined ? null : (cards.get(incoming.supersedes) ?? null);
        const r = submit(cards.get(incoming.id) ?? null, incoming, now, target, ceiling);
        persist(r.changed);
        return { status: r.status, body: r.changed.length > 0 ? cards.get(incoming.id) : r.card };
      });
    },

    async changes(token, cursor) {
      return handle(() => {
        const { root } = producer(token);
        // §7.2: `after` is a non-negative decimal integer.
        const after = typeof cursor === 'string' && /^\d+$/.test(cursor) ? Number(cursor) : cursor;
        if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) throw new PbcpError('invalid_cursor', `after must be a non-negative integer, got ${JSON.stringify(cursor)}`);
        const pending = [...cards.values()].filter((c) => c.change_seq > after).sort((a, b) => a.change_seq - b.change_seq);
        const changes: Array<{ seq: number; card: Card }> = [];
        let next = after;
        for (const c of pending) {
          if (changes.length === pageSize) break;
          next = c.change_seq;
          if (c.producer === root) changes.push({ seq: c.change_seq, card: c });
        }
        return { status: 200, body: { changes, next } };
      });
    },

    async decide(id, d: Decision) {
      return ownerOp(id, (c) => decide(c, d, now));
    },

    // §7.3: decide takes the owner's credential only; a producer token is refused before anything else.
    async decideWithToken() {
      return handle(() => {
        throw new PbcpError('unauthorized', 'decide takes the owner\'s credential, not a producer token');
      });
    },

    async seen(id) {
      return ownerOp(id, (c) => markSeen(c, now));
    },

    async acknowledge(id) {
      return ownerOp(id, (c) => acknowledge(c, now));
    },

    clock: {
      set(iso) {
        now = iso;
      },
    },
  };
}
