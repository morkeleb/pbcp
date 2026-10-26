// `@pbcp/client/testing`: an in-memory head behind a fetch function, for testing producers and tools without a
// server. Its rules are @pbcp/core's own transitions (submit, supersession, decide, acknowledge), so a connector
// under test sees the protocol's answers. It is not a head: one owner, no persistence, no limits, no ceilings
// unless given, any producer token accepted (its root is the card's `producer`). It implements the orders
// extension (Appendix A) with @pbcp/core's orders.ts; a token's root for sync and claim is `roots[token] ?? token`.

import {
  acknowledge, applyOutcome, checkSubmission, claim, decide, expireIfDue, isOrder, markSeen, mintOrder, outcomeTarget,
  parseCardOrThrow, PbcpError, PROTOCOL, submit, ulid, visibleTo,
  type Card, type Decision, type OrderCard, type OrderInput, type Urgency,
} from '@pbcp/core';

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubOptions {
  /** Maximum entries per `/changes` page. Default: no cap. */
  pageSize?: number;
  /** The owner's person id; cards must be addressed to it (§10). Default `morten`. */
  owner?: string;
  /** The Authorization value the owner endpoints accept. Default `Session owner`. */
  ownerCredential?: string;
  /** Urgency ceiling per producer root (§9). */
  ceilings?: Record<string, Urgency>;
  /** The head clock; a fixed instant by default. */
  now?: () => string;
  /** Producer roots that are executors: they receive `to_producer: *` orders minted while they are listed (A.1). */
  executors?: string[];
  /** The producer root of each bearer token; a token not listed is its own root. */
  roots?: Record<string, string>;
}

export interface Stub {
  /** Pass as `fetch` to HeadClient or OwnerClient. */
  fetch: typeof fetch;
  cards: Map<string, Card>;
  requests: Recorded[];
  /** Answer the next request with this instead of the routes. */
  script(status: number, body: unknown, headers?: Record<string, string>): void;
  /** Decide as the owner, bypassing HTTP. Throws a PbcpError on refusal. */
  decideHere(id: string, d: Decision): Card;
  /** The highest change_seq assigned (`GET /` `seq`, §7.5). */
  readonly seq: number;
  /** The owner gives an order (A.1); returns the stored order. */
  order(input: OrderInput): OrderCard;
}

export const STUB_NOW = '2026-10-26T12:00:00Z';

export function stubHead(opts: StubOptions = {}): Stub {
  const owner = opts.owner ?? 'morten';
  const ownerCredential = opts.ownerCredential ?? 'Session owner';
  const now = opts.now ?? (() => STUB_NOW);
  const cards = new Map<string, Card>();
  const requests: Recorded[] = [];
  const scripted: { status: number; body: unknown; headers?: Record<string, string> }[] = [];
  let seq = 0;
  const eligible = new Map<string, readonly string[] | null>();

  const persist = (changed: Array<Card | OrderCard>) => {
    for (const c of changed) cards.set(c.id, { ...c, change_seq: ++seq } as Card);
  };
  const orderAt = (id: string): OrderCard | undefined => {
    const c = cards.get(id) as { kind: string } | undefined;
    return c && isOrder(c) ? c : undefined;
  };
  /** A.2: lapsed leases return to `open` before anything reads or writes the order. */
  const expireAll = () => {
    for (const id of [...cards.keys()]) {
      const o = orderAt(id);
      if (o) persist(expireIfDue(o, now()).changed);
    }
  };
  const rootOf = (auth: string) => {
    const token = auth.slice('Bearer '.length);
    return opts.roots?.[token] ?? token;
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const ownerOp = (id: string, op: (c: Card) => { status: number; changed: Card[]; card: Card }) => {
    const stored = cards.get(id);
    if (!stored) throw new PbcpError('not_found', `no card ${id}`);
    const r = op(stored);
    persist(r.changed);
    return { status: r.status, card: cards.get(id)! };
  };

  const route = (method: string, url: URL, auth: string | undefined, body: unknown): Response => {
    const path = url.pathname;
    const id = (m: RegExpExecArray) => decodeURIComponent(m[1]!);
    const asOwner = /^\/cards\/[^/]+\/(decision|seen|acknowledge)$/.test(path);
    if (asOwner ? auth !== ownerCredential : !auth?.startsWith('Bearer ')) throw new PbcpError('unauthorized', 'missing or invalid credential');

    if (method === 'GET' && path === '/') return json(200, { protocol: PROTOCOL, owner, seq, extensions: [], render: { mermaid: ['core'] } });

    const put = method === 'PUT' && /^\/cards\/([^/]+)$/.exec(path);
    if (put) {
      const incoming = parseCardOrThrow(body);
      checkSubmission(incoming, { root: incoming.producer, owner, pathId: id(put) });
      const target = incoming.supersedes === undefined ? null : (cards.get(incoming.supersedes) ?? null);
      const r = submit(cards.get(incoming.id) ?? null, incoming, now(), target, opts.ceilings?.[incoming.producer]);
      persist(r.changed);
      const ordered = r.changed.length > 0 ? outcomeTarget(incoming) : undefined;
      const o = ordered === undefined ? undefined : orderAt(ordered);
      if (o) {
        const expiry = expireIfDue(o, now());
        persist(expiry.changed);
        persist(applyOutcome(expiry.card, incoming, now()).changed);
      }
      return json(r.status, r.changed.length > 0 ? cards.get(incoming.id) : r.card);
    }

    if (method === 'GET' && path === '/changes') {
      const raw = url.searchParams.get('after') ?? '';
      if (!/^\d+$/.test(raw)) throw new PbcpError('invalid_cursor', `after must be a non-negative integer, got ${JSON.stringify(raw)}`);
      const after = Number(raw);
      expireAll();
      const root = rootOf(auth!);
      const changes = [...cards.values()]
        .filter((c) => c.change_seq > after)
        .filter((c) => !isOrder(c as { kind: string }) || visibleTo(c as unknown as OrderCard, root, eligible.get(c.id)))
        .sort((a, b) => a.change_seq - b.change_seq)
        .slice(0, opts.pageSize ?? Infinity)
        .map((c) => ({ seq: c.change_seq, card: c }));
      return json(200, { changes, next: changes.at(-1)?.seq ?? after });
    }

    const claimed = method === 'POST' && /^\/cards\/([^/]+)\/claim$/.exec(path);
    if (claimed) {
      const root = rootOf(auth!);
      const o = orderAt(id(claimed));
      if (!o || !visibleTo(o, root, eligible.get(o.id))) throw new PbcpError('not_found', `no order ${id(claimed)} for ${root}`);
      const r = claim(o, root, (body as { lease_seconds?: number } | undefined)?.lease_seconds ?? NaN, now());
      persist(r.changed);
      return json(r.status, cards.get(o.id));
    }

    const owned = method === 'POST' && /^\/cards\/([^/]+)\/(decision|seen|acknowledge)$/.exec(path);
    if (owned) {
      const op = owned[2] === 'decision' ? (c: Card) => decide(c, body as Decision, now()) : owned[2] === 'seen' ? (c: Card) => markSeen(c, now()) : (c: Card) => acknowledge(c, now());
      const r = ownerOp(id(owned), op);
      return json(r.status, r.card);
    }

    throw new PbcpError('not_found', path);
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = { ...(init?.headers as Record<string, string>) };
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, url: String(input), headers, body });

    const next = scripted.shift();
    if (next) return json(next.status, next.body, next.headers);
    try {
      return route(method, url, headers.authorization, body);
    } catch (e) {
      if (e instanceof PbcpError) return json(e.status, e.toJSON());
      throw e;
    }
  };

  return {
    fetch: fetchImpl,
    cards,
    requests,
    script: (status, body, headers) => void scripted.push({ status, body, headers }),
    decideHere: (id, d) => ownerOp(id, (c) => decide(c, d, now())).card,
    get seq() {
      return seq;
    },
    order(input) {
      const random = new Uint8Array(10).map((_, i) => (seq * 37 + i * 11 + cards.size) & 255);
      const { order, eligible: e } = mintOrder(input, { ulid: ulid(Date.parse(now()) + seq, random), now: now(), executors: opts.executors ?? [] });
      eligible.set(order.id, e);
      persist([order]);
      return cards.get(order.id) as unknown as OrderCard;
    },
  };
}
