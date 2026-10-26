// RFC §7: submit, sync, decide over HTTP. Orders (claim, renew) are out of scope here.

import { ERROR_CODES, PbcpError, type Card, type Decision, type ErrorCode, type ProducerCard } from '@pbcp/core';

export interface SubmitResponse {
  status: 200 | 201 | 409;
  card: Card;
}

export interface Change {
  seq: number;
  card: Card;
}

export interface SyncResponse {
  changes: Change[];
  next: number;
}

/** A non-protocol HTTP failure (404, 5xx, unexpected bodies). Protocol refusals are PbcpErrors. */
export class HeadHttpError extends Error {
  override readonly name = 'HeadHttpError';
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `head responded ${status}`);
    this.status = status;
    this.body = body;
  }
}

const FALLBACK_CODES: Record<number, ErrorCode> = {
  400: 'invalid_card',
  401: 'unauthorized',
  403: 'outside_root',
  409: 'locked',
  413: 'too_large',
  429: 'rate_limited',
};

export interface HeadClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export class HeadClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetch: typeof fetch;

  constructor(opts: HeadClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** §7.1. A 409 is a result, not an error: the body carries the decided card. */
  async submit(card: ProducerCard): Promise<SubmitResponse> {
    const { status, body } = await this.request('PUT', `/cards/${encodeURIComponent(card.id)}`, card, [409]);
    if (status !== 200 && status !== 201 && status !== 409) throw new HeadHttpError(status, body, `unexpected status ${status} on submit`);
    return { status, card: expectCard(status, body) };
  }

  /** §7.2. One page; the caller loops until `next` stops moving. */
  async sync(after: number): Promise<SyncResponse> {
    const { status, body } = await this.request('GET', `/changes?after=${encodeURIComponent(String(after))}`);
    const page = body as Partial<SyncResponse> | null;
    if (!page || !Array.isArray(page.changes) || !Number.isInteger(page.next)) {
      throw new HeadHttpError(status, body, 'malformed sync response');
    }
    return page as SyncResponse;
  }

  /** §7.3. Head-side interfaces only; a producer never decides its own cards. */
  async decide(id: string, d: Decision): Promise<Card> {
    const { status, body } = await this.request('POST', `/cards/${encodeURIComponent(id)}/decision`, d);
    return expectCard(status, body);
  }

  private async request(method: string, path: string, json?: unknown, accept: number[] = []): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json' };
    if (json !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      // not JSON; keep the text for the error
    }
    if (res.ok || accept.includes(res.status)) return { status: res.status, body };
    throw toError(res.status, body);
  }
}

function toError(status: number, body: unknown): Error {
  const fallback = FALLBACK_CODES[status];
  if (fallback === undefined) return new HeadHttpError(status, body);
  const b = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown; message?: unknown };
  const known = typeof b.error === 'string' && Object.hasOwn(ERROR_CODES, b.error) && ERROR_CODES[b.error as ErrorCode] === status;
  const message = typeof b.message === 'string' ? b.message : undefined;
  return new PbcpError(known ? (b.error as ErrorCode) : fallback, message);
}

function expectCard(status: number, body: unknown): Card {
  if (typeof body !== 'object' || body === null || typeof (body as { id?: unknown }).id !== 'string') {
    throw new HeadHttpError(status, body, 'response body is not a card');
  }
  return body as Card;
}
