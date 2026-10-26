// In-process HeadUnderTest: the pure core functions over an in-memory map and a fake
// monotonic counter. It is the smallest thing that can run the fixtures, not a head.

import {
  acknowledge, checkSubmission, decide, markSeen, parseCardOrThrow, PbcpError, submit,
  type Card, type Decision,
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
  let tokens = new Map<string, string>();
  let counter = 0;
  let now = '2026-10-07T00:00:00Z';

  const persist = (changed: Card[]): void => {
    for (const c of changed) cards.set(c.id, { ...c, change_seq: ++counter });
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
      if (!stored) return { status: 404, body: { error: 'not_found', message: id } };
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

    async token(root) {
      const t = `token-${root}-${tokens.size + 1}`;
      tokens.set(t, root);
      return t;
    },

    async put(token, input) {
      return handle(() => {
        const root = tokens.get(token);
        if (root === undefined) throw new PbcpError('unauthorized');
        const incoming = parseCardOrThrow(input);
        checkSubmission(incoming, { root, owner });
        const target = incoming.supersedes === undefined ? null : (cards.get(incoming.supersedes) ?? null);
        const r = submit(cards.get(incoming.id) ?? null, incoming, now, target);
        persist(r.changed);
        return { status: r.status, body: r.changed.length > 0 ? cards.get(incoming.id) : r.card };
      });
    },

    async changes(token, after) {
      return handle(() => {
        const root = tokens.get(token);
        if (root === undefined) throw new PbcpError('unauthorized');
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
