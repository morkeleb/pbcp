import { describe, expect, it } from 'vitest';
import { PbcpError } from './errors.js';
import { parseYaml, stringifyYaml, type YamlDoc } from './yaml.js';

const RFC_HEADER = `protocol: pbcp/1
id: hermes:gmail:19a4f2e7c3b1
kind: decision
to_person: morten
producer: hermes
thread: gmail:19a4f2e7c3b1
urgency: brief
title: Reply to Anna re invoice timing
actions: [approve, reject, edit]
references: []
emitted_at: "2026-10-07T13:02:11Z"
source:
  url: https://mail.google.com/mail/u/0/#inbox/19a4f2e7c3b1
  label: Gmail thread
`;

function rejects(src: string, pattern?: RegExp): void {
  let err: unknown;
  try {
    parseYaml(src);
  } catch (e) {
    err = e;
  }
  expect(err, src).toBeInstanceOf(PbcpError);
  expect((err as PbcpError).status).toBe(400);
  expect((err as PbcpError).code).toBe('yaml_outside_subset');
  if (pattern) expect((err as PbcpError).message).toMatch(pattern);
}

describe('parseYaml', () => {
  it('reads the RFC §3 example header', () => {
    expect(parseYaml(RFC_HEADER)).toEqual({
      protocol: 'pbcp/1',
      id: 'hermes:gmail:19a4f2e7c3b1',
      kind: 'decision',
      to_person: 'morten',
      producer: 'hermes',
      thread: 'gmail:19a4f2e7c3b1',
      urgency: 'brief',
      title: 'Reply to Anna re invoice timing',
      actions: ['approve', 'reject', 'edit'],
      references: [],
      emitted_at: '2026-10-07T13:02:11Z',
      source: { url: 'https://mail.google.com/mail/u/0/#inbox/19a4f2e7c3b1', label: 'Gmail thread' },
    });
  });

  it('parses every scalar as a string, whatever it looks like', () => {
    expect(parseYaml('a: no\nb: 1.0\nc: 2026-10-07\nd: null\ne: true\nf: ~\ng: 0x1F\nh: .inf\n')).toEqual({
      a: 'no', b: '1.0', c: '2026-10-07', d: 'null', e: 'true', f: '~', g: '0x1F', h: '.inf',
    });
  });

  it('reads quoted scalars and escapes', () => {
    expect(parseYaml(`a: "x \\"y\\" \\n \\u00e9"\nb: 'it''s: #fine'\nc: "# not a comment"\n`)).toEqual({
      a: 'x "y" \n é', b: "it's: #fine", c: '# not a comment',
    });
  });

  it('treats " #" as a comment, as YAML does', () => {
    expect(parseYaml('# leading\ntitle: Fix bug #12\nurl: a#b\n')).toEqual({ title: 'Fix bug', url: 'a#b' });
  });

  it('reads block sequences, indented or not', () => {
    expect(parseYaml('a:\n  - x\n  - "y, z"\nb:\n- p\n- q\n')).toEqual({ a: ['x', 'y, z'], b: ['p', 'q'] });
  });

  it('reads flow sequences with quoting and a trailing comma', () => {
    expect(parseYaml('a: [x, "y, z", \'w\', ]\nb: [ ]\n')).toEqual({ a: ['x', 'y, z', 'w'], b: [] });
  });

  it('reads choice objects as a block sequence of one-level mappings (§4.4)', () => {
    const src = `actions:
  - id: ship-friday
    label: Ship Friday
    body: "Needs Anna's sign-off by Thursday."
    default: "true"
  - id: hold
  - edit
`;
    expect(parseYaml(src)).toEqual({
      actions: [
        { id: 'ship-friday', label: 'Ship Friday', body: "Needs Anna's sign-off by Thursday.", default: 'true' },
        { id: 'hold' },
        'edit',
      ],
    });
  });

  it('reads an empty value as the empty string', () => {
    expect(parseYaml('a:\nb: x\n')).toEqual({ a: '', b: 'x' });
  });

  it('accepts CRLF line endings', () => {
    expect(parseYaml('a: x\r\nb: [y]\r\n')).toEqual({ a: 'x', b: ['y'] });
  });

  describe('rejects anything outside the subset with 400', () => {
    it.each([
      ['anchor', 'a: &x foo\n', /anchor/],
      ['anchor on a block', 'source: &s\n  url: x\n', /anchor/],
      ['alias', 'a: x\nb: *x\n', /alias/],
      ['tag', 'a: !!str 1\n', /tag/],
      ['custom tag', 'a: !card x\n', /tag/],
      ['multi-document', 'a: x\n---\nb: y\n', /document/],
      ['document end', 'a: x\n...\n', /document/],
      ['directive', '%YAML 1.2\na: x\n', /directive/],
      ['literal block scalar', 'a: |\n  x\n', /block scalar/],
      ['folded block scalar', 'a: >\n  x\n', /block scalar/],
      ['flow mapping', 'a: {b: c}\n', /flow mapping/],
      ['flow mapping in sequence', 'a: [{b: c}]\n', /flow mapping/],
      ['nested flow sequence', 'a: [[b]]\n', /nested/],
      ['two levels of mapping', 'a:\n  b:\n    c: d\n', /deeper/],
      ['sequence inside nested mapping', 'a:\n  b:\n    - c\n', /deeper/],
      ['flow sequence inside nested mapping', 'a:\n  b: [c]\n', /deeper/],
      ['sequence of sequences', 'a:\n  - - b\n', /deeper/],
      ['mapping inside a sequence item mapping', 'a:\n  - id: x\n    more:\n      deep: y\n', /deeper/],
      ['multi-line plain scalar', 'a: one\n  two\n', /indentation/],
      ['multi-line quoted scalar', 'a: "one\n  two"\n', /unterminated/],
      ['multi-line flow sequence', 'a: [x,\n  y]\n', /unterminated/],
      ['tab indentation', 'a:\n\tb: c\n', /tab/],
      ['duplicate key', 'a: x\na: y\n', /duplicate/],
      ['duplicate nested key', 'a:\n  b: x\n  b: y\n', /duplicate/],
      ['quoted key', '"a": x\n', /quoted key/],
      ['complex key', '? a\n: b\n', /complex/],
      ['top-level sequence', '- a\n', /top-level/],
      ['mapping in a plain value', 'a: b: c\n', /mapping/],
      ['bad escape', 'a: "\\x41"\n', /escape/],
      ['text after quoted value', 'a: "x" y\n', /unexpected text/],
      ['unexpected indentation', '  a: x\n', /indentation/],
      ['not a mapping', 'just text\n', /key: value/],
      ['plain scalar starting with ]', 'a: ]x\n', /cannot start/],
      ['plain scalar starting with }', 'a: }x\n', /cannot start/],
      ['plain scalar starting with ,', 'a: ,x\n', /cannot start/],
      ['tab after the colon', 'a:\tb\n', /key: value/],
      ['key starting with -', '-x: a\n', /top-level sequence|invalid key|key: value/],
    ])('%s', (_name, src, pattern) => rejects(src, pattern));
  });
});

describe('stringifyYaml', () => {
  it('round-trips the RFC header', () => {
    const doc = parseYaml(RFC_HEADER);
    expect(parseYaml(stringifyYaml(doc))).toEqual(doc);
  });

  it('quotes anything a YAML parser might coerce (§3 SHOULD)', () => {
    const out = stringifyYaml({ a: 'no', b: '1.0', c: '2026-10-07T13:02:11Z', d: 'null', e: 'true', f: '', g: 'pbcp/1' });
    expect(out).toBe('a: "no"\nb: "1.0"\nc: "2026-10-07T13:02:11Z"\nd: "null"\ne: "true"\nf: ""\ng: pbcp/1\n');
  });

  it('quotes indicators, comments, colons and newlines', () => {
    const doc: YamlDoc = {
      a: '#x', b: 'x #y', c: 'k: v', d: '- x', e: '&a', f: 'line\nbreak', g: ' padded', h: 'a,b', i: "it's",
      seq: ['a,b', 'c]', 'x y', 'yes'],
    };
    const out = stringifyYaml(doc);
    expect(parseYaml(out)).toEqual(doc);
    expect(out).toContain('seq: ["a,b", "c]", x y, "yes"]');
  });

  it('writes choice objects as block sequences of one-level mappings', () => {
    const doc: YamlDoc = { actions: [{ id: 'ship-friday', label: 'Ship Friday', default: 'true' }, 'edit'] };
    const out = stringifyYaml(doc);
    expect(out).toBe('actions:\n  - id: ship-friday\n    label: Ship Friday\n    default: "true"\n  - edit\n');
    expect(parseYaml(out)).toEqual(doc);
  });

  it('reads at and until as strings, quoted or not, and writes them back the same (§3, §4.1)', () => {
    const doc = parseYaml('at: 2026-11-03T09:15:00Z\nuntil: "2026-11-03T09:30:00Z"\n');
    expect(doc).toEqual({ at: '2026-11-03T09:15:00Z', until: '2026-11-03T09:30:00Z' });
    expect(parseYaml(stringifyYaml(doc))).toEqual(doc);
  });

  it('round-trips arbitrary strings', () => {
    const samples = ['', ' ', 'a', '"', "'", '\\', '\t', 'é ü 中文', 'a: b', '[x]', '{y}', '*z', '!t', '|', '>', '%', '@', '`', '?', '-', ':', '0', '-1', 'NO', 'Off', '~', '\u0007', 'x\r\ny'];
    for (const s of samples) {
      const doc: YamlDoc = { k: s, l: [s], m: { n: s } };
      expect(parseYaml(stringifyYaml(doc)), JSON.stringify(s)).toEqual(doc);
    }
  });
});
