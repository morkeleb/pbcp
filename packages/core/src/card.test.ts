import { describe, expect, it } from 'vitest';
import { equal, HEAD_OWNED_FIELDS, parseCard, parseCardOrThrow, toFrontMatter, toJSON, type ProducerCard } from './card.js';
import type { ErrorCode } from './errors.js';

const RFC_FILE = `---
protocol: pbcp/1
id: hermes:gmail:19a4f2e7c3b1
kind: decision
to_person: morten
producer: hermes
thread: gmail:19a4f2e7c3b1
labels: [billing-revamp]
urgency: brief
title: Reply to Anna re invoice timing
summary: Anna asks to pay the September invoice on the 20th instead of the 15th. The proposed reply agrees for September only.
actions: [approve, reject, edit]
references: []
emitted_at: "2026-10-07T13:02:11Z"
source:
  url: https://mail.google.com/mail/u/0/#inbox/19a4f2e7c3b1
  label: Gmail thread
---

Anna (Nordic Supply) asks whether the September invoice can be paid on the 20th instead of the 15th.

## Proposed reply

> Hi Anna — the 20th is fine for September.
`;

const RFC_WIRE: ProducerCard = {
  protocol: 'pbcp/1',
  id: 'hermes:gmail:19a4f2e7c3b1',
  kind: 'decision',
  to_person: 'morten',
  producer: 'hermes',
  thread: 'gmail:19a4f2e7c3b1',
  labels: ['billing-revamp'],
  urgency: 'brief',
  title: 'Reply to Anna re invoice timing',
  summary: 'Anna asks to pay the September invoice on the 20th instead of the 15th. The proposed reply agrees for September only.',
  actions: ['approve', 'reject', 'edit'],
  references: [],
  emitted_at: '2026-10-07T13:02:11Z',
  source: { url: 'https://mail.google.com/mail/u/0/#inbox/19a4f2e7c3b1', label: 'Gmail thread' },
  body: 'Anna (Nordic Supply) asks whether the September invoice can be paid on the 20th instead of the 15th.\n\n## Proposed reply\n\n> Hi Anna — the 20th is fine for September.\n',
};

const minimal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: 'pbcp/1',
  id: 'goalpath:item:4421',
  kind: 'decision',
  to_person: 'morten',
  producer: 'goalpath',
  title: 'Ship 4421?',
  body: 'Evidence.\n\n## Proposal\n\nShip it.',
  emitted_at: '2026-10-07T06:05:00Z',
  ...over,
});

function refused(input: unknown, code: ErrorCode, status = 400): void {
  const r = parseCard(input);
  expect(r.ok, JSON.stringify(input)).toBe(false);
  if (!r.ok) {
    expect(r.error.code).toBe(code);
    expect(r.error.status).toBe(status);
  }
}

describe('parseCard', () => {
  it('reads the RFC §3 file form and wire form to the same card', () => {
    const file = parseCardOrThrow(RFC_FILE);
    expect(file).toEqual(RFC_WIRE);
    expect(parseCardOrThrow(RFC_WIRE)).toEqual(RFC_WIRE);
    expect(parseCardOrThrow(JSON.stringify(RFC_WIRE))).toEqual(RFC_WIRE);
  });

  it('round-trips both forms field for field', () => {
    expect(parseCardOrThrow(toFrontMatter(RFC_WIRE))).toEqual(RFC_WIRE);
    expect(parseCardOrThrow(toJSON(RFC_WIRE))).toEqual(RFC_WIRE);
    const choices = parseCardOrThrow(minimal({
      actions: [{ id: 'ship-friday', label: 'Ship Friday', body: "Needs Anna's sign-off.", default: true }, { id: 'hold' }, 'edit'],
    }));
    expect(parseCardOrThrow(toFrontMatter(choices))).toEqual(choices);
  });

  it('preserves unknown and extension fields', () => {
    const c = parseCardOrThrow(minimal({ 'x-trace': 'abc', 'orders.claim_seq': 2, extra: { a: 1 } }));
    expect(c['x-trace']).toBe('abc');
    expect(c['orders.claim_seq']).toBe(2);
    expect(c.extra).toEqual({ a: 1 });
  });

  it('rejects every head-owned field (§4.2)', () => {
    for (const f of HEAD_OWNED_FIELDS) refused(minimal({ [f]: 'x' }), 'head_owned_field');
    refused(RFC_FILE.replace('urgency: brief', 'state: open'), 'head_owned_field');
  });

  it('rejects an unknown major version and malformed protocol (§2)', () => {
    refused(minimal({ protocol: 'pbcp/2' }), 'unsupported_protocol');
    refused(minimal({ protocol: 'pbcp/1.1' }), 'unsupported_protocol');
    refused(minimal({ protocol: undefined }), 'invalid_card');
  });

  it('rejects bad ids, producer mismatch and missing fields', () => {
    refused(minimal({ id: 'goalpath:item' }), 'invalid_id');
    refused(minimal({ supersedes: 'nope' }), 'invalid_id');
    refused(minimal({ references: ['ok:a:b', 'bad'] }), 'invalid_id');
    refused(minimal({ producer: 'hermes' }), 'producer_mismatch');
    for (const f of ['id', 'kind', 'to_person', 'producer', 'title', 'body', 'emitted_at']) {
      refused(minimal({ [f]: undefined }), f === 'id' ? 'invalid_id' : 'invalid_card');
    }
  });

  it('rejects bad values', () => {
    refused(minimal({ kind: 'memo' }), 'unsupported_kind');
    refused(minimal({ kind: 'order' }), 'unsupported_kind');
    refused(minimal({ kind: 'artifact', actions: ['archive', 'keep'] }), 'invalid_card');
    refused(minimal({ kind: 'signal', actions: [] }), 'invalid_card');
    refused(minimal({ urgency: 'now' }), 'invalid_card');
    refused(minimal({ emitted_at: '2026-10-07 06:05' }), 'invalid_card');
    refused(minimal({ emitted_at: '2026-10-07T06:05:00+02:00' }), 'invalid_card');
    refused(minimal({ emitted_at: '2026-13-45T99:99:99Z' }), 'invalid_card');
    refused(minimal({ emitted_at: '2026-02-30T00:00:00Z' }), 'invalid_card');
    expect(parseCard(minimal({ emitted_at: '2024-02-29T23:59:60Z' })).ok).toBe(true);
    expect(parseCard(minimal({ emitted_at: '2026-10-07T06:05:00.123-00:00' })).ok).toBe(true);
    refused(minimal({ title: 'two\nlines' }), 'invalid_card');
    refused(minimal({ summary: 'two\nlines' }), 'invalid_card');
    refused(minimal({ summary: 'carriage\rreturn' }), 'invalid_card');
    refused(minimal({ summary: '' }), 'invalid_card');
    refused(minimal({ summary: 42 }), 'invalid_card');
    // §4.1: markdown in summary is a rendering rule, not a validation one.
    expect(parseCard(minimal({ summary: 'Ship **4421** now? See [it](https://x).' })).ok).toBe(true);
    refused(minimal({ source: { label: 'no url' } }), 'invalid_card');
    refused(minimal({ actions: ['ship friday'] }), 'invalid_card');
    refused('[]', 'invalid_card');
    refused('not a card', 'malformed_json');
  });

  it('enforces the choice-list rules (§4.4)', () => {
    refused(minimal({ actions: [{ id: 'a', default: true }, { id: 'b', default: true }] }), 'multiple_defaults');
    refused(minimal({ actions: ['a', { id: 'a', label: 'A' }] }), 'duplicate_action');
    refused(minimal({ actions: ['a', 'a'] }), 'duplicate_action');
    for (const reserved of ['dismissed', 'edited', 'delegated']) refused(minimal({ actions: ['a', reserved] }), 'invalid_card');
    refused(minimal({ actions: [{ id: 'edited' }] }), 'invalid_card');
    expect(parseCard(minimal({ actions: [{ id: 'a', default: true }, { id: 'b', default: false }] })).ok).toBe(true);
  });

  it('accepts labels within the rules and refuses the rest with invalid_card (§4.1)', () => {
    expect(parseCardOrThrow(minimal({ labels: ['billing-revamp', 'q4-2026', 'a'.repeat(32)] })).labels).toEqual(['billing-revamp', 'q4-2026', 'a'.repeat(32)]);
    expect(parseCardOrThrow(minimal({ labels: Array.from({ length: 8 }, (_, i) => `l${i}`) })).labels).toHaveLength(8);
    expect(parseCardOrThrow(minimal({ labels: [] })).labels).toEqual([]);
    refused(minimal({ labels: Array.from({ length: 9 }, (_, i) => `l${i}`) }), 'invalid_card');
    refused(minimal({ labels: ['a', 'a'] }), 'invalid_card');
    for (const bad of ['Billing', 'billing revamp', 'billing_revamp', 'a'.repeat(33), '', 'é']) refused(minimal({ labels: [bad] }), 'invalid_card');
    refused(minimal({ labels: 'billing-revamp' }), 'invalid_card');
  });

  it('accepts about as a calendar date that exists, and nothing else (§2, §4.1)', () => {
    expect(parseCardOrThrow(minimal({ about: '2026-10-08' })).about).toBe('2026-10-08');
    expect(parseCardOrThrow(minimal({ about: '2028-02-29' })).about).toBe('2028-02-29');
    for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-10-8', '2026-10-08T00:00:00Z', '08/10/2026', '']) refused(minimal({ about: bad }), 'invalid_card');
  });

  it('reads labels as a flow or a block sequence, and about plain or quoted, in the file form (§3)', () => {
    const file = (header: string) => `---\nprotocol: pbcp/1\nid: goalpath:item:4421\nkind: artifact\nto_person: morten\nproducer: goalpath\ntitle: T\nemitted_at: "2026-10-07T06:05:00Z"\n${header}---\n\nBody.\n`;
    const flow = parseCardOrThrow(file('labels: [billing-revamp, nordic-supply]\nabout: 2026-10-08\n'));
    const block = parseCardOrThrow(file('labels:\n  - billing-revamp\n  - nordic-supply\nabout: "2026-10-08"\n'));
    expect(flow).toMatchObject({ labels: ['billing-revamp', 'nordic-supply'], about: '2026-10-08' });
    expect(equal(flow, block)).toBe(true);
    const written = toFrontMatter(flow);
    expect(written).toContain('labels: [billing-revamp, nordic-supply]\nabout: "2026-10-08"\n');
    expect(equal(parseCardOrThrow(written), flow)).toBe(true);
  });

  it('rejects malformed front matter', () => {
    refused('---\nprotocol: pbcp/1\n', 'malformed_front_matter');
    refused(RFC_FILE.replace('urgency: brief', 'urgency: &u brief'), 'yaml_outside_subset');
    refused(RFC_FILE.replace('urgency: brief', 'body: inline'), 'invalid_card');
    refused(RFC_FILE.replace('actions: [approve, reject, edit]', 'actions:\n  - id: a\n    default: yes'), 'invalid_card');
  });
});

describe('equal (§5)', () => {
  const base = parseCardOrThrow(minimal());

  it('ignores emitted_at', () => {
    expect(equal(base, { ...base, emitted_at: '2027-01-01T00:00:00Z' })).toBe(true);
  });

  it('compares every other producer field', () => {
    expect(equal(base, { ...base, title: 'Other' })).toBe(false);
    expect(equal(base, { ...base, summary: 'Ship it.' })).toBe(false);
    expect(equal({ ...base, summary: 'a' }, { ...base, summary: 'b' })).toBe(false);
    expect(equal({ ...base, summary: 'a' }, { ...base, summary: 'a', emitted_at: '2027-01-01T00:00:00Z' })).toBe(true);
    expect(equal(base, { ...base, body: 'Other' })).toBe(false);
    expect(equal(base, { ...base, thread: 't' })).toBe(false);
    expect(equal(base, { ...base, 'x-trace': 'a' })).toBe(false);
    expect(equal(base, { ...base, source: { url: 'https://a' } })).toBe(false);
    expect(equal(base, { ...base, references: ['a:b:c'] })).toBe(false);
    expect(equal(base, { ...base, labels: ['billing-revamp'] })).toBe(false);
    expect(equal({ ...base, labels: ['a', 'b'] }, { ...base, labels: ['b', 'a'] })).toBe(false);
    expect(equal(base, { ...base, about: '2026-10-08' })).toBe(false);
    expect(equal({ ...base, about: '2026-10-08' }, { ...base, about: '2026-10-09' })).toBe(false);
  });

  it('is semantic, not byte-for-byte', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as ProducerCard;
    expect(equal(base, reordered)).toBe(true);
    expect(equal(base, { ...base, urgency: 'brief' })).toBe(true);
    expect(equal(base, { ...base, references: [] })).toBe(true);
    expect(equal(base, { ...base, labels: [] })).toBe(true);
    expect(equal(base, { ...base, actions: ['approve', 'reject'] })).toBe(true);
    expect(equal(base, { ...base, actions: [{ id: 'approve' }, 'reject'] })).toBe(true);
    expect(equal(base, { ...base, actions: ['reject', 'approve'] })).toBe(false);
    expect(equal(base, { ...base, body: base.body + '\n' })).toBe(true);
    expect(equal(parseCardOrThrow(RFC_FILE), RFC_WIRE)).toBe(true);
    expect(equal(parseCardOrThrow(toFrontMatter(RFC_WIRE)), RFC_WIRE)).toBe(true);
  });

  it('treats default: false as no default', () => {
    expect(equal({ ...base, actions: [{ id: 'a', default: false }] }, { ...base, actions: ['a'] })).toBe(true);
    expect(equal({ ...base, actions: [{ id: 'a', default: true }] }, { ...base, actions: ['a'] })).toBe(false);
  });
});
