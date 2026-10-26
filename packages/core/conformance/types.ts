import type { Decision, Urgency } from '../src/index.js';

export interface Response {
  status: number;
  body: unknown;
}

/** A head driven by the core fixtures. Every call is made as the producer holding `token`, or as the owner. */
export interface HeadUnderTest {
  reset(): Promise<void>;
  token(root: string, opts?: { executor?: boolean; ceiling?: Urgency }): Promise<string>;
  /** `card` is a JSON object (application/json) or a front-matter string (text/markdown). */
  put(token: string, card: unknown): Promise<Response>;
  changes(token: string, after: number): Promise<Response>;
  decide(cardId: string, d: Decision): Promise<Response>;
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
