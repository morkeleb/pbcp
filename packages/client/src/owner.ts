// The owner's side of a head (RFC §7.3): decide, and the owner-side fields of §4.2 (seen, acknowledge, snooze). The protocol defines
// no credential for these, so this client sends whatever Authorization value the head's own interface issues.

import type { Card, Decision } from '@pbcp/core';
import { HeadHttpError, Requester, expectCard, type ClientOptions } from './head.js';

export interface OwnerClientOptions extends ClientOptions {
  /** The full Authorization header value of an owner session, e.g. `Session abc…`. Never a producer token: §7.3 refuses it with 401. */
  credential: string;
  /** Where this head mounts the owner operations. Decide defaults to the RFC path; seen, acknowledge and snooze are head-defined. */
  paths?: { decide?: (id: string) => string; seen?: (id: string) => string; acknowledge?: (id: string) => string; snooze?: (id: string) => string };
}

const segment = (id: string) => `/cards/${encodeURIComponent(id)}`;

/** For tools and tests acting as the person. Which operations a head exposes this way, and where, is up to the head. */
export class OwnerClient {
  readonly baseUrl: string;
  private readonly http: Requester;
  private readonly paths: Required<NonNullable<OwnerClientOptions['paths']>>;

  constructor(opts: OwnerClientOptions) {
    this.http = new Requester(opts, opts.credential);
    this.baseUrl = this.http.baseUrl;
    this.paths = {
      decide: opts.paths?.decide ?? ((id) => `${segment(id)}/decision`),
      seen: opts.paths?.seen ?? ((id) => `${segment(id)}/seen`),
      acknowledge: opts.paths?.acknowledge ?? ((id) => `${segment(id)}/acknowledge`),
      snooze: opts.paths?.snooze ?? ((id) => `${segment(id)}/snooze`),
    };
  }

  /** §7.3. A 409 is a result: the card was already decided or superseded, and the body is the stored card. */
  async decide(id: string, d: Decision): Promise<{ status: 200 | 409; card: Card }> {
    const { status, body } = await this.http.request('POST', this.paths.decide(id), d, [409]);
    if (status !== 200 && status !== 409) throw new HeadHttpError(status, body, `unexpected status ${status} on decide`);
    return { status, card: expectCard(status, body) };
  }

  /** §4.2 `seen_at`: the head presented the card to its owner. */
  async seen(id: string): Promise<Card> {
    const { status, body } = await this.http.request('POST', this.paths.seen(id));
    return expectCard(status, body);
  }

  /** §4.2 `acknowledged_at`, for an artifact or signal. */
  async ack(id: string): Promise<Card> {
    const { status, body } = await this.http.request('POST', this.paths.acknowledge(id));
    return expectCard(status, body);
  }

  /**
   * §4.2 `snoozed_until`: hides an open card from the brief until `until`; `null` clears it. Sent as `{ until }`.
   * A 409 is a result: the card is no longer open, and the body is the stored card. A past `until` is 400 `invalid_snooze`.
   */
  async snooze(id: string, until: string | null): Promise<{ status: 200 | 409; card: Card }> {
    const { status, body } = await this.http.request('POST', this.paths.snooze(id), { until }, [409]);
    if (status !== 200 && status !== 409) throw new HeadHttpError(status, body, `unexpected status ${status} on snooze`);
    return { status, card: expectCard(status, body) };
  }
}
