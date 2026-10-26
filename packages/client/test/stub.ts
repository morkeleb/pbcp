// A scripted in-memory stand-in for a head's HTTP surface. Not a head: just enough to drive the client.

import { equal, producerPart, type Card, type Decision, type ProducerCard } from '@pbcp/core';

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Stub {
  fetch: typeof fetch;
  cards: Map<string, Card>;
  requests: Recorded[];
  /** Answer the next request with this instead of the routes. */
  script(status: number, body: unknown): void;
  decideHere(id: string, d: Decision): void;
}

const NOW = '2026-10-26T12:00:00Z';

export function stubHead(opts: { pageSize?: number } = {}): Stub {
  const cards = new Map<string, Card>();
  const requests: Recorded[] = [];
  const scripted: { status: number; body: unknown }[] = [];
  let seq = 0;

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const decideHere = (id: string, d: Decision) => {
    const c = cards.get(id);
    if (!c) throw new Error(`no card ${id}`);
    cards.set(id, { ...c, ...d, state: 'decided', decided_at: NOW, changed_at: NOW, change_seq: ++seq });
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body });

    const next = scripted.shift();
    if (next) return json(next.status, next.body);

    const put = method === 'PUT' && /^\/cards\/([^/]+)$/.exec(url.pathname);
    if (put) {
      const id = decodeURIComponent(put[1]!);
      const incoming = body as ProducerCard;
      const stored = cards.get(id);
      if (!stored) {
        const c: Card = { ...incoming, state: 'open', change_seq: ++seq, received_at: NOW, changed_at: NOW };
        cards.set(id, c);
        return json(201, c);
      }
      const same = equal(producerPart(stored), incoming);
      if (stored.state !== 'open') return json(same ? 200 : 409, stored);
      if (!same) cards.set(id, { ...stored, ...incoming, change_seq: ++seq });
      return json(200, cards.get(id));
    }

    if (method === 'GET' && url.pathname === '/changes') {
      const after = Number(url.searchParams.get('after'));
      const changed = [...cards.values()]
        .filter((c) => c.change_seq > after)
        .sort((a, b) => a.change_seq - b.change_seq)
        .slice(0, opts.pageSize ?? Infinity)
        .map((c) => ({ seq: c.change_seq, card: c }));
      return json(200, { changes: changed, next: changed.at(-1)?.seq ?? after });
    }

    const decision = method === 'POST' && /^\/cards\/([^/]+)\/decision$/.exec(url.pathname);
    if (decision) {
      const id = decodeURIComponent(decision[1]!);
      if (!cards.has(id)) return json(404, { error: 'not_found', message: id });
      decideHere(id, body as Decision);
      return json(200, cards.get(id));
    }

    return json(404, { error: 'not_found', message: url.pathname });
  };

  return { fetch: fetchImpl, cards, requests, script: (status, body) => scripted.push({ status, body }), decideHere };
}
