// RFC §7: a producer's submit and sync, and describe, over HTTP. Decide is the owner's (owner.ts). Orders are out of scope.

import { ClaimRefusal, ERROR_CODES, HeadDescriptionSchema, PbcpError, type Card, type ErrorCode, type HeadDescription, type OrderCard, type ProducerCard } from '@pbcp/core';

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

/** One HTTP request, as a transport receives it. Paths are already joined to the base URL (§7). */
export interface TransportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** The response a transport returns. Header names are lower case; a non-2xx status is a response, not an error. */
export interface TransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

/** How the client sends requests. The default is `fetch`; a host with its own request layer (proxies, logging) supplies one. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** A Transport over a `fetch`-compatible function. */
export function fetchTransport(f: typeof fetch = (input, init) => fetch(input, init)): Transport {
  return async ({ method, url, headers, body }) => {
    const res = await f(url, { method, headers, body });
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  };
}

export interface ClientOptions {
  /** The head's base URL; RFC paths are relative to it (§7). */
  baseUrl: string;
  /** Requests go through `transport` when given, else through `fetch` (default: the global fetch). */
  transport?: Transport;
  fetch?: typeof fetch;
}

export interface HeadClientOptions extends ClientOptions {
  /** The producer token. */
  token: string;
}

/** Sends one request with an Authorization header and decodes a JSON body. Shared by HeadClient and OwnerClient. */
export class Requester {
  /** Where requests go; HeadClient moves it to the description's `api` (§7.5). */
  baseUrl: string;
  private readonly transport: Transport;

  constructor(opts: ClientOptions, private readonly authorization: string) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.transport = opts.transport ?? fetchTransport(opts.fetch);
  }

  /** Statuses in `accept` with a card body are results, statuses in `raw` are returned as they are; other non-2xx responses throw (§7.4). */
  async request(method: string, path: string, json?: unknown, accept: number[] = [], raw: number[] = [], base = this.baseUrl): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { authorization: this.authorization, accept: 'application/json' };
    if (json !== undefined) headers['content-type'] = 'application/json';
    const res = await this.transport({ method, url: `${base}${path}`, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    let body: unknown = res.body;
    try {
      body = res.body === '' ? null : JSON.parse(res.body);
    } catch {
      // not JSON; keep the text for the error
    }
    if ((res.status >= 200 && res.status < 300) || (accept.includes(res.status) && isCard(body)) || raw.includes(res.status)) return { status: res.status, body };
    throw toError(res.status, body, res.headers['retry-after'] ?? null);
  }
}

/** A producer's client: describe, submit and sync with its producer token (§7.1, §7.2, §7.5). */
export class HeadClient {
  /** The URL the head was configured with, where its description is read (§7.5). */
  readonly describeUrl: string;
  private readonly http: Requester;

  constructor(opts: HeadClientOptions) {
    this.http = new Requester(opts, `Bearer ${opts.token}`);
    this.describeUrl = this.http.baseUrl;
  }

  /** Where submit, sync and claim go: the configured URL, or the description's `api` once describe() has read one. */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  private request(method: string, path: string, json?: unknown, accept?: number[], raw?: number[]) {
    return this.http.request(method, path, json, accept, raw);
  }

  /** §7.5. */
  async describe(): Promise<HeadDescription> {
    const { status, body } = await this.http.request('GET', '/', undefined, [], [], this.describeUrl);
    const parsed = HeadDescriptionSchema.safeParse(body);
    if (!parsed.success) throw new HeadHttpError(status, body, 'malformed head description');
    // §7.5: the producer operations live under `api` when the head gives one, resolved against the description's URL.
    if (parsed.data.api !== undefined) this.http.baseUrl = new URL(parsed.data.api, `${this.describeUrl}/`).href.replace(/\/+$/, '');
    return parsed.data;
  }

  /** §7.1. A 409 is a result, not an error: the body carries the decided card. */
  async submit(card: ProducerCard): Promise<SubmitResponse> {
    const { status, body } = await this.request('PUT', `/cards/${encodeURIComponent(card.id)}`, card, [409]);
    if (status !== 200 && status !== 201 && status !== 409) throw new HeadHttpError(status, body, `unexpected status ${status} on submit`);
    return { status, card: expectCard(status, body) };
  }

  /**
   * Orders extension (A.2): claim an order, or renew a lease this producer's root holds. Resolves with the order as
   * the head now holds it (`exec_state`, `claim_seq`, `claim_expires_at`). A `409 lease_held` or `410 order_terminal`
   * throws ClaimRefusal carrying the order; `400 invalid_lease` and the rest throw as any refusal does.
   */
  async claim(id: string, leaseSeconds: number): Promise<OrderCard> {
    const { status, body } = await this.request('POST', `/cards/${encodeURIComponent(id)}/claim`, { lease_seconds: leaseSeconds }, [], [409, 410]);
    if (status === 409 || status === 410) {
      const { error, message, order } = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown; message?: unknown; order?: unknown };
      const code = status === 409 ? 'lease_held' : 'order_terminal';
      if (error !== code || !isCard(order)) throw new HeadHttpError(status, body, `malformed ${status} on claim`);
      throw new ClaimRefusal(code, order as OrderCard, typeof message === 'string' ? message : undefined);
    }
    if (status !== 200) throw new HeadHttpError(status, body, `unexpected status ${status} on claim`);
    return expectCard(status, body) as unknown as OrderCard;
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

}

/** §7.4: a known code bound to this status is a PbcpError; anything else is a HeadHttpError. */
function toError(status: number, body: unknown, retryAfter: string | null): Error {
  const { error, message } = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown; message?: unknown };
  if (typeof error !== 'string' || !Object.hasOwn(ERROR_CODES, error) || ERROR_CODES[error as ErrorCode] !== status) return new HeadHttpError(status, body);
  const seconds = status === 429 && retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : undefined;
  return new PbcpError(error as ErrorCode, typeof message === 'string' ? message : undefined, { retryAfter: seconds });
}

const isCard = (body: unknown) => typeof body === 'object' && body !== null && typeof (body as { id?: unknown }).id === 'string';

export function expectCard(status: number, body: unknown): Card {
  if (!isCard(body)) {
    throw new HeadHttpError(status, body, 'response body is not a card');
  }
  return body as Card;
}
