// RFC §7: submit, sync, decide over HTTP. Orders (claim, renew) are out of scope here.

import { ERROR_CODES, HeadDescriptionSchema, PbcpError, type Card, type Decision, type ErrorCode, type HeadDescription, type ProducerCard } from '@pbcp/core';

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

/** A failure without a protocol error body (5xx, unknown codes, unexpected bodies). Protocol refusals are PbcpErrors (§7.4). */
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

  /** §7.5. */
  async describe(): Promise<HeadDescription> {
    const { status, body } = await this.request('GET', '/');
    const parsed = HeadDescriptionSchema.safeParse(body);
    if (!parsed.success) throw new HeadHttpError(status, body, 'malformed head description');
    return parsed.data;
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
  async decide(id: string, d: Decision): Promise<{ status: 200 | 409; card: Card }> {
    const { status, body } = await this.request('POST', `/cards/${encodeURIComponent(id)}/decision`, d, [409]);
    if (status !== 200 && status !== 409) throw new HeadHttpError(status, body, `unexpected status ${status} on decide`);
    return { status, card: expectCard(status, body) };
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
    if (res.ok || (accept.includes(res.status) && isCard(body))) return { status: res.status, body };
    throw toError(res.status, body, res.headers.get('retry-after'));
  }
}

/** §7.4: a known code bound to this status is a PbcpError; anything else is a HeadHttpError. */
function toError(status: number, body: unknown, retryAfter: string | null): Error {
  const { error, message } = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown; message?: unknown };
  if (typeof error !== 'string' || !Object.hasOwn(ERROR_CODES, error) || ERROR_CODES[error as ErrorCode] !== status) return new HeadHttpError(status, body);
  const seconds = status === 429 && retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : undefined;
  return new PbcpError(error as ErrorCode, typeof message === 'string' ? message : undefined, { retryAfter: seconds });
}

const isCard = (body: unknown) => typeof body === 'object' && body !== null && typeof (body as { id?: unknown }).id === 'string';

function expectCard(status: number, body: unknown): Card {
  if (!isCard(body)) {
    throw new HeadHttpError(status, body, 'response body is not a card');
  }
  return body as Card;
}
