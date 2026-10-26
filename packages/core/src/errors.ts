// RFC §7.4. Every refusal is a PbcpError with the RFC status and a stable code.

export const ERROR_CODES = {
  // 400 — card does not conform
  malformed_json: 400,
  malformed_front_matter: 400,
  yaml_outside_subset: 400,
  invalid_card: 400,
  invalid_id: 400,
  producer_mismatch: 400,
  head_owned_field: 400,
  unsupported_protocol: 400,
  unsupported_kind: 400,
  duplicate_action: 400,
  multiple_defaults: 400,
  invalid_decision: 400,
  not_decidable: 400,
  not_acknowledgeable: 400,
  supersede_self: 400,
  supersede_target_missing: 400,
  id_mismatch: 400,
  invalid_cursor: 400,
  // 401 — any missing or invalid credential: a producer token, or the owner's on decide
  unauthorized: 401,
  // 403 — outside the producer's namespace, or not this head's owner
  outside_root: 403,
  cross_namespace_supersede: 403,
  wrong_person: 403,
  // 404 — no card with this id (decide and other owner-side calls)
  not_found: 404,
  // 409 — a supersede target that is already superseded. A locked card is a 409 that carries the card, not an error body.
  already_superseded: 409,
  // 413, 429
  too_large: 413,
  rate_limited: 429,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export type PbcpStatus = (typeof ERROR_CODES)[ErrorCode];

export class PbcpError extends Error {
  override readonly name = 'PbcpError';
  readonly status: PbcpStatus;
  readonly code: ErrorCode;
  /** Seconds from a `Retry-After` header, for `rate_limited` (§7.4). */
  readonly retryAfter?: number;

  constructor(code: ErrorCode, message?: string, opts: { retryAfter?: number } = {}) {
    super(message ?? code);
    this.code = code;
    this.status = ERROR_CODES[code];
    if (opts.retryAfter !== undefined) this.retryAfter = opts.retryAfter;
  }

  toJSON(): { error: ErrorCode; message: string } {
    return { error: this.code, message: this.message };
  }
}

export const isPbcpError = (e: unknown): e is PbcpError => e instanceof PbcpError;
