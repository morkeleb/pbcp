import type { Decision, Urgency } from '../src/index.js';

export interface Response {
  status: number;
  body: unknown;
}

/**
 * A head driven by the core fixtures. Every call is made as the producer holding `token`, or as the owner.
 * A `token` of `null` means no credential at all (no Authorization header); any other string is sent as a
 * producer token, including ones the head never issued.
 */
export interface HeadUnderTest {
  reset(): Promise<void>;
  /** A producer token bound to `root`; `ceiling` is the producer's urgency ceiling (§9). */
  token(root: string, opts?: { executor?: boolean; ceiling?: Urgency }): Promise<string>;
  /** `GET /` (§7.5), sent with `token` in case the head requires one. */
  describe(token: string | null): Promise<Response>;
  /** `card` is a JSON object (application/json) or a front-matter string (text/markdown). */
  put(token: string | null, card: unknown): Promise<Response>;
  /** `after` is sent as given; a string lets a fixture send a malformed cursor (§7.2). */
  changes(token: string | null, after: number | string): Promise<Response>;
  /** Decide as the owner, with the owner's credential (§7.3). */
  decide(cardId: string, d: Decision): Promise<Response>;
  /** Decide sent with a producer token in place of the owner's credential; §7.3 requires a 401. */
  decideWithToken(token: string, cardId: string, d: Decision): Promise<Response>;
  /** The head presents the card to its owner (sets `seen_at`, §4.2). */
  seen(cardId: string): Promise<Response>;
  /** The owner explicitly acknowledges an artifact or signal (§4.2). */
  acknowledge(cardId: string): Promise<Response>;
  /** Orders extension (milestone 3); unused by C01–C15. */
  claim?(token: string, cardId: string, lease: number): Promise<Response>;
  clock: { set(iso: string): void };
}

export interface RenderedFence {
  type: string;
  class: 'render' | 'fallback' | 'collapsed';
  source: string;
  message?: string;
  fallbackImage?: boolean;
}

export interface RenderedImage {
  alt: string;
  src: string;
  class: 'image' | 'link' | 'hidden';
  svg?: string;
}

export interface RenderResult {
  text: string;
  stripped: string[];
  fences: RenderedFence[];
  images: RenderedImage[];
}

/** A head's body renderer, driven by the render fixtures (§3.1, §14). */
export interface RenderUnderTest {
  reset(): Promise<void>;
  render(body: string): Promise<RenderResult>;
  /** Diagrams drawn since reset (cache misses). */
  draws(): Promise<number>;
}

export interface Step {
  op: string;
  args?: Record<string, unknown>;
  expect?: { status?: unknown; body?: unknown };
  save?: Record<string, string>;
}

export interface Fixture {
  name: string;
  rfc?: string[];
  /** Absent means MUST. A SHOULD fixture checks a recommendation; a head may fail it and still conform. */
  level?: 'MUST' | 'SHOULD';
  steps: Step[];
}
