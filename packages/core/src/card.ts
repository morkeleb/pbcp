// RFC §3 (forms), §4 (fields), §4.4 (choice lists), §5 (equality).

import { z } from 'zod';
import { PbcpError } from './errors.js';
import { isId, isIntent, parseId } from './id.js';
import { parseYaml, stringifyYaml, type YamlDoc, type YamlMap, type YamlValue } from './yaml.js';

export const PROTOCOL = 'pbcp/1';
export const KINDS = ['decision', 'artifact', 'signal'] as const;
export const URGENCIES = ['immediate', 'brief', 'log'] as const;
export const STATES = ['open', 'decided', 'superseded'] as const;
/** Decision values the protocol defines (§4.3). */
export const BUILTIN_DECISIONS = ['dismissed', 'edited', 'delegated'] as const;
/** The choice-list entry meaning "none of these" (§4.4); recorded as `edited`. */
export const EDIT_ACTION = 'edit';
export const DEFAULT_ACTIONS = ['approve', 'reject'] as const;
/** §3.1 size floor: a head MUST accept a card whose JSON wire form is up to this many bytes. */
export const CARD_LIMIT_BYTES = 64 * 1024;

export type Kind = (typeof KINDS)[number];
export type Urgency = (typeof URGENCIES)[number];
export type State = (typeof STATES)[number];

const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]00:00)$/;

/** RFC 3339 in UTC (§2): the shape, and a date and time that exist (a leap second is allowed). */
function isUtcTimestamp(s: string): boolean {
  const m = RFC3339_UTC.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days && h <= 23 && mi <= 59 && sec <= 60;
}

const Timestamp = z.string().refine(isUtcTimestamp, 'must be an RFC 3339 UTC timestamp');
const Id = z.string().refine(isId, 'must match the id grammar (§5)');
const NonEmpty = z.string().min(1);

export const ActionObjectSchema = z.looseObject({
  id: z.string().refine(isIntent, 'must match the intent grammar (§5)'),
  label: z.string().optional(),
  body: z.string().optional(),
  default: z.boolean().optional(),
});
export const ActionSchema = z.union([z.string().refine(isIntent, 'must match the intent grammar (§5)'), ActionObjectSchema]);

/** §4.1. Unknown producer fields (extensions, `x-…`) pass through and are preserved. */
export const ProducerCardSchema = z.looseObject({
  protocol: z.literal(PROTOCOL),
  id: Id,
  kind: z.enum(KINDS),
  to_person: NonEmpty,
  producer: NonEmpty,
  title: z.string().min(1).refine((s) => !/[\r\n]/.test(s), 'must be one line'),
  body: z.string(),
  urgency: z.enum(URGENCIES).optional(),
  thread: NonEmpty.optional(),
  references: z.array(Id).optional(),
  supersedes: Id.optional(),
  actions: z.array(ActionSchema).optional(),
  emitted_at: Timestamp,
  source: z.looseObject({ url: NonEmpty, label: z.string().optional() }).optional(),
});

/** §4.2, plus the head-owned fields of the orders extension (A.1), which no producer may submit either. */
export const HeadFieldsSchema = z.object({
  state: z.enum(STATES),
  change_seq: z.number().int().nonnegative(),
  received_at: Timestamp,
  changed_at: Timestamp,
  /** §4.2, §9: `urgency` clamped to the producer's ceiling when the content was stored. */
  delivery: z.enum(URGENCIES),
  seen_at: Timestamp.optional(),
  acknowledged_at: Timestamp.optional(),
  snoozed_until: Timestamp.optional(),
  decision: z.string().optional(),
  edited_proposal: z.string().optional(),
  comment: z.string().optional(),
  decided_at: Timestamp.optional(),
  delegated_to: z.string().optional(),
  to_producer: z.string().optional(),
  exec_state: z.enum(['open', 'claimed', 'done', 'failed', 'cancelled']).optional(),
  claimed_by: z.string().optional(),
  claim_expires_at: Timestamp.optional(),
  claim_seq: z.number().int().optional(),
});

export const HEAD_OWNED_FIELDS: readonly string[] = Object.keys(HeadFieldsSchema.shape);

export type ActionObject = z.infer<typeof ActionObjectSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type ProducerCard = z.infer<typeof ProducerCardSchema>;
export type HeadFields = z.infer<typeof HeadFieldsSchema>;
export type Card = ProducerCard & HeadFields;

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// --- parsing ---------------------------------------------------------------

/** JSON object, JSON text, or front-matter text. Never throws; refusals are PbcpErrors (400). */
export function parseCard(input: unknown): Result<ProducerCard, PbcpError> {
  try {
    return { ok: true, value: parseCardOrThrow(input) };
  } catch (e) {
    if (e instanceof PbcpError) return { ok: false, error: e };
    throw e;
  }
}

export function parseCardOrThrow(input: unknown): ProducerCard {
  let raw: unknown = input;
  if (typeof input === 'string') {
    const text = input.replace(/^﻿/, '');
    if (/^---\r?\n/.test(text)) raw = fromFrontMatter(text);
    else {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new PbcpError('malformed_json', 'card is neither JSON nor front-matter text');
      }
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new PbcpError('invalid_card', 'card must be an object');
  const obj = raw as Record<string, unknown>;

  const headOwned = Object.keys(obj).filter((k) => HEAD_OWNED_FIELDS.includes(k));
  if (headOwned.length > 0) throw new PbcpError('head_owned_field', `head-owned fields are not accepted: ${headOwned.join(', ')}`);

  if (obj.protocol !== PROTOCOL) {
    throw new PbcpError(
      typeof obj.protocol === 'string' ? 'unsupported_protocol' : 'invalid_card',
      `protocol must be ${PROTOCOL}, got ${JSON.stringify(obj.protocol)}`,
    );
  }
  if (typeof obj.kind === 'string' && !(KINDS as readonly string[]).includes(obj.kind)) {
    throw new PbcpError('unsupported_kind', `kind ${JSON.stringify(obj.kind)} is not supported`);
  }

  const parsed = ProducerCardSchema.safeParse(obj);
  if (!parsed.success) {
    const idIssue = parsed.error.issues.find((i) => ['id', 'supersedes', 'references'].includes(String(i.path[0])));
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(card)'}: ${i.message}`).join('; ');
    throw new PbcpError(idIssue ? 'invalid_id' : 'invalid_card', msg);
  }
  const card = parsed.data;

  if (parseId(card.id)!.producer !== card.producer) {
    throw new PbcpError('producer_mismatch', `producer ${JSON.stringify(card.producer)} does not match the id's root`);
  }
  if (card.actions !== undefined && card.kind !== 'decision') {
    throw new PbcpError('invalid_card', `actions are only for kind: decision; ${card.kind} cards never carry them`);
  }
  checkActions(card.actions);
  return card;
}

/** §4.4: at most one default, no duplicate ids (a string and an object with the same id are the same option). */
function checkActions(actions: Action[] | undefined): void {
  if (!actions) return;
  const ids = actions.map(actionId);
  const reserved = ids.find((id) => (BUILTIN_DECISIONS as readonly string[]).includes(id));
  if (reserved !== undefined) throw new PbcpError('invalid_card', `${reserved} is a protocol decision and cannot be an action id`);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) throw new PbcpError('duplicate_action', `duplicate action id ${dup}`);
  if (actions.filter((a) => typeof a === 'object' && a.default === true).length > 1) {
    throw new PbcpError('multiple_defaults', 'at most one action may be the default');
  }
}

export const actionId = (a: Action): string => (typeof a === 'string' ? a : a.id);

/** The actions a decision card offers, applying the §4.1 default. */
export function effectiveActions(card: ProducerCard): Action[] {
  return card.actions ?? (card.kind === 'decision' ? [...DEFAULT_ACTIONS] : []);
}

// --- file form -------------------------------------------------------------

function fromFrontMatter(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  const close = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, '') === '---');
  if (close < 0) throw new PbcpError('malformed_front_matter', 'front matter is not closed with ---');
  const doc = parseYaml(lines.slice(1, close).join('\n'));
  if ('body' in doc) throw new PbcpError('invalid_card', 'body belongs after the front matter, not in it');
  let body = lines.slice(close + 1).join('\n');
  body = body.replace(/^\r?\n/, ''); // the blank separator line
  return { ...typedFromYaml(doc), body };
}

/** YAML gives strings; the few non-string core fields are converted here (§3: YAML → strings → validation). */
function typedFromYaml(doc: YamlDoc): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc };
  if (Array.isArray(doc.actions)) {
    out.actions = doc.actions.map((a) => {
      if (typeof a === 'string' || !('default' in a)) return a;
      const d = a.default;
      if (d !== 'true' && d !== 'false') throw new PbcpError('invalid_card', 'actions.default must be true or false');
      return { ...a, default: d === 'true' };
    });
  }
  return out;
}

const FIELD_ORDER = [
  'protocol', 'id', 'kind', 'to_person', 'producer', 'thread', 'urgency', 'title', 'actions',
  'references', 'supersedes', 'emitted_at', 'source',
];

function ordered<T extends Record<string, unknown>>(c: T): T {
  const keys = Object.keys(c);
  const known = FIELD_ORDER.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !FIELD_ORDER.includes(k) && k !== 'body');
  const out: Record<string, unknown> = {};
  for (const k of [...known, ...rest, ...(keys.includes('body') ? ['body'] : [])]) out[k] = c[k];
  return out as T;
}

function toYamlValue(key: string, v: unknown): YamlValue {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((item) => (typeof item === 'object' && item !== null ? toYamlMap(key, item) : String(item)));
  if (typeof v === 'object' && v !== null) return toYamlMap(key, v);
  throw new PbcpError('invalid_card', `${key} cannot be written in the file form`);
}

function toYamlMap(key: string, v: object): YamlMap {
  const out: YamlMap = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;
    if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[k] = String(x);
    else throw new PbcpError('invalid_card', `${key}.${k} is nested too deeply for the file form`);
  }
  return out;
}

/** The file form (§3): YAML header between `---` lines, a blank line, then the body. */
export function toFrontMatter(c: ProducerCard): string {
  const header: YamlDoc = {};
  for (const [k, v] of Object.entries(ordered(c))) {
    if (k === 'body' || v === undefined) continue;
    header[k] = toYamlValue(k, v);
  }
  return `---\n${stringifyYaml(header)}---\n\n${c.body}`;
}

/** The wire form (§3). Key order follows the RFC's examples. */
export function toJSON(c: ProducerCard | Card): string {
  return JSON.stringify(ordered(c));
}

export function wireSize(c: ProducerCard | Card): number {
  return new TextEncoder().encode(toJSON(c)).length;
}

/** The producer-owned part of a stored card. */
export function producerPart(c: Card): ProducerCard {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (!HEAD_OWNED_FIELDS.includes(k)) out[k] = v;
  return out as ProducerCard;
}

// --- equality --------------------------------------------------------------

/**
 * §5: every producer-owned field except `emitted_at`, compared on parsed values.
 * Defaults are applied before comparing (urgency `brief`, references `[]`, decision
 * actions `[approve, reject]`), a bare action string equals `{ id }`, `default: false`
 * equals no default, and trailing whitespace at the end of the body is not significant.
 */
export function equal(a: ProducerCard, b: ProducerCard): boolean {
  return canonical(normalise(a)) === canonical(normalise(b));
}

function normalise(c: ProducerCard): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'emitted_at' || v === undefined || HEAD_OWNED_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  out.urgency = c.urgency ?? 'brief';
  out.references = c.references ?? [];
  out.body = c.body.replace(/\s+$/, '');
  out.actions = effectiveActions(c).map((a) => {
    const o: Record<string, unknown> = typeof a === 'string' ? { id: a } : { ...a };
    if (o.default === false) delete o.default;
    return o;
  });
  return out;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
