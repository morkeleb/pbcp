// RFC §3, restricted YAML. Every scalar is a string; typing happens after, in card.ts.
//
// Accepted: `key: scalar`, `key: [a, b]` (flow sequence of scalars), block sequences
// (`- a`), one level of nested mapping (`source:` + indented `k: v`), and block
// sequences whose items are one-level mappings of scalars (`- id: x` + `  label: y`)
// so §4.4 choice objects can be written as files. Scalars may be plain, 'single' or
// "double" quoted. Full-line and trailing ` #` comments are allowed.
//
// Rejected (400): anchors, aliases, tags, directives, document markers, block scalars
// (| >), flow mappings, multi-line scalars, nesting deeper than the above, tabs in
// indentation, duplicate keys, quoted or complex keys.

import { PbcpError } from './errors.js';

export type YamlMap = { [key: string]: string };
export type YamlSeq = Array<string | YamlMap>;
export type YamlValue = string | YamlSeq | YamlMap;
export type YamlDoc = { [key: string]: YamlValue };

interface Line {
  no: number;
  indent: number;
  text: string; // without indentation
}

const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function fail(no: number, msg: string): never {
  throw new PbcpError('yaml_outside_subset', `line ${no}: ${msg}`);
}

function toLines(src: string): Line[] {
  const out: Line[] = [];
  src.split('\n').forEach((raw, i) => {
    const no = i + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = /^([ \t]*)(.*)$/.exec(line)!;
    const ws = m[1]!;
    const text = m[2]!.trimEnd();
    if (text === '' || text.startsWith('#')) return;
    if (ws.includes('\t')) fail(no, 'tab in indentation');
    if (ws.length === 0 && (text === '---' || text.startsWith('--- ') || text === '...')) fail(no, 'document marker (multi-document streams are not allowed)');
    if (ws.length === 0 && text.startsWith('%')) fail(no, 'directives are not allowed');
    out.push({ no, indent: ws.length, text });
  });
  return out;
}

// --- scalars ---------------------------------------------------------------

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** Reads one scalar starting at s[pos]. Returns the value and the index just after it. */
function readScalar(s: string, pos: number, flow: boolean, no: number): [string, number] {
  const c = s[pos];
  if (c === '"') {
    let out = '';
    let i = pos + 1;
    for (;;) {
      const ch = s[i];
      if (ch === undefined) fail(no, 'unterminated double-quoted string (multi-line scalars are not allowed)');
      if (ch === '"') return [out, i + 1];
      if (ch === '\\') {
        const e = s[i + 1];
        if (e === 'u') {
          const hex = s.slice(i + 2, i + 6);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail(no, 'bad \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const r = e === undefined ? undefined : ESCAPES[e];
        if (r === undefined) fail(no, `unsupported escape \\${e ?? ''}`);
        out += r;
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
  }
  if (c === "'") {
    let out = '';
    let i = pos + 1;
    for (;;) {
      const ch = s[i];
      if (ch === undefined) fail(no, 'unterminated single-quoted string (multi-line scalars are not allowed)');
      if (ch === "'") {
        if (s[i + 1] === "'") { out += "'"; i += 2; continue; }
        return [out, i + 1];
      }
      out += ch;
      i++;
    }
  }
  if (c === '&') fail(no, 'anchors are not allowed');
  if (c === '*') fail(no, 'aliases are not allowed');
  if (c === '!') fail(no, 'tags are not allowed');
  if (c === '|' || c === '>') fail(no, 'block scalars are not allowed');
  if (c === '{') fail(no, 'flow mappings are not allowed');
  if (c === '[') fail(no, flow ? 'nested sequences are not allowed' : 'unexpected [');
  if (c === '%' || c === '@' || c === '`') fail(no, `a plain scalar cannot start with ${c}`);
  if ((c === '-' || c === '?' || c === ':') && (s[pos + 1] === undefined || s[pos + 1] === ' ')) fail(no, `unexpected ${c}`);
  if (flow && (c === ',' || c === ']')) fail(no, 'empty flow sequence entry');
  // Plain scalar: ends at " #", end of line, or (in flow) "," / "]".
  let i = pos;
  for (; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '#' && s[i - 1] === ' ') break;
    if (ch === ':' && (s[i + 1] === undefined || s[i + 1] === ' ' || (flow && (s[i + 1] === ',' || s[i + 1] === ']')))) {
      fail(no, 'a mapping is not allowed here');
    }
    if (flow && (ch === ',' || ch === ']')) break;
    if (flow && (ch === '[' || ch === '{' || ch === '}')) fail(no, `unexpected ${ch} in flow sequence`);
  }
  return [s.slice(pos, i).trimEnd(), i];
}

/** After a quoted scalar in block context only whitespace and a comment may follow. */
function expectLineEnd(s: string, pos: number, no: number): void {
  const rest = s.slice(pos);
  if (rest.trim() === '' || /^\s+#/.test(rest) || (rest.startsWith('#') && s[pos - 1] === ' ')) return;
  fail(no, `unexpected text after value: ${rest.trim()}`);
}

function readBlockScalar(s: string, no: number): string {
  const [v, end] = readScalar(s, 0, false, no);
  expectLineEnd(s, end, no);
  return v;
}

function readFlowSeq(s: string, no: number): string[] {
  // s starts with '['
  const items: string[] = [];
  let i = 1;
  const ws = () => { while (s[i] === ' ') i++; };
  ws();
  if (s[i] === ']') { i++; expectLineEnd(s, i, no); return items; }
  for (;;) {
    ws();
    if (s[i] === undefined) fail(no, 'unterminated flow sequence (multi-line flow is not allowed)');
    if (s[i] === ']') { i++; break; } // trailing comma
    const [v, end] = readScalar(s, i, true, no);
    items.push(v);
    i = end;
    ws();
    if (s[i] === ',') { i++; continue; }
    if (s[i] === ']') { i++; break; }
    fail(no, 'expected , or ] in flow sequence');
  }
  expectLineEnd(s, i, no);
  return items;
}

// --- structure -------------------------------------------------------------

/** Splits `key: rest` / `key:`. Returns null if the line is not a mapping entry. */
function splitKey(text: string, no: number): [string, string] | null {
  if (text.startsWith('"') || text.startsWith("'")) fail(no, 'quoted keys are not allowed');
  if (text.startsWith('? ') || text === '?') fail(no, 'complex keys are not allowed');
  const m = /^([^\s:#]+):(?: (.*)|)$/.exec(text);
  if (!m) return null;
  const key = m[1]!;
  if (!KEY.test(key)) fail(no, `invalid key ${JSON.stringify(key)}`);
  return [key, (m[2] ?? '').trim()];
}

function isSeqItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

function setOnce(obj: Record<string, unknown>, key: string, value: unknown, no: number): void {
  if (Object.hasOwn(obj, key)) fail(no, `duplicate key ${key}`);
  obj[key] = value;
}

export function parseYaml(src: string): YamlDoc {
  const lines = toLines(src);
  const doc: YamlDoc = {};
  let i = 0;

  const scalarOnly = (rest: string, no: number): string => {
    if (rest.startsWith('[')) fail(no, 'nesting deeper than one level is not allowed');
    return readBlockScalar(rest, no);
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent !== 0) fail(line.no, 'unexpected indentation');
    if (isSeqItem(line.text)) fail(line.no, 'a top-level sequence is not allowed');
    const kv = splitKey(line.text, line.no);
    if (!kv) fail(line.no, 'expected key: value');
    const [key, rest] = kv;
    i++;

    if (rest !== '' && !rest.startsWith('#')) {
      setOnce(doc, key, rest.startsWith('[') ? readFlowSeq(rest, line.no) : readBlockScalar(rest, line.no), line.no);
      continue;
    }

    // `key:` — children follow (more-indented lines, or `- ` items at the same indent), or nothing.
    const first = lines[i];
    const hasChildren = first !== undefined && (first.indent > 0 || isSeqItem(first.text));
    if (!hasChildren) {
      setOnce(doc, key, '', line.no);
      continue;
    }
    const childIndent = first.indent;

    if (isSeqItem(first.text)) {
      const seq: YamlSeq = [];
      while (i < lines.length && lines[i]!.indent === childIndent && isSeqItem(lines[i]!.text)) {
        const item = lines[i]!;
        const body = item.text === '-' ? '' : item.text.slice(2).trimStart();
        if (body === '' || body.startsWith('#')) fail(item.no, 'empty sequence item');
        if (body.startsWith('- ') || body === '-') fail(item.no, 'nesting deeper than one level is not allowed');
        i++;
        const ikv = body.startsWith('"') || body.startsWith("'") ? null : splitKey(body, item.no);
        if (!ikv) {
          seq.push(scalarOnly(body, item.no));
          continue;
        }
        // A one-level mapping item: `- k: v` then `  k2: v2` aligned with k.
        const map: YamlMap = {};
        const keyIndent = childIndent + (item.text.length - body.length);
        const put = ([k, v]: [string, string], no: number) => {
          if (v === '' && lines[i] !== undefined && lines[i]!.indent > keyIndent) fail(no, 'nesting deeper than one level is not allowed');
          setOnce(map, k, v === '' ? '' : scalarOnly(v, no), no);
        };
        put(ikv, item.no);
        while (i < lines.length && lines[i]!.indent === keyIndent) {
          const l = lines[i]!;
          if (isSeqItem(l.text)) fail(l.no, 'nesting deeper than one level is not allowed');
          const kv2 = splitKey(l.text, l.no);
          if (!kv2) fail(l.no, 'expected key: value');
          i++;
          put(kv2, l.no);
        }
        seq.push(map);
      }
      if (i < lines.length && lines[i]!.indent > 0) fail(lines[i]!.no, 'unexpected indentation');
      setOnce(doc, key, seq, line.no);
      continue;
    }

    const map: YamlMap = {};
    while (i < lines.length && lines[i]!.indent > 0) {
      const l = lines[i]!;
      if (l.indent !== childIndent) fail(l.no, 'inconsistent indentation (multi-line scalars and deeper nesting are not allowed)');
      if (isSeqItem(l.text)) fail(l.no, 'nesting deeper than one level is not allowed');
      const kv2 = splitKey(l.text, l.no);
      if (!kv2) fail(l.no, 'expected key: value');
      i++;
      const [k, v] = kv2;
      if (v === '' && lines[i] !== undefined && lines[i]!.indent > childIndent) fail(l.no, 'nesting deeper than one level is not allowed');
      setOnce(map, k, v === '' ? '' : scalarOnly(v, l.no), l.no);
    }
    setOnce(doc, key, map, line.no);
  }
  return doc;
}

// --- writer ----------------------------------------------------------------

// Strings a YAML 1.1 or 1.2 parser could read as something other than a string (§3 SHOULD quote).
const COERCIBLE = /^(?:y|n|yes|no|on|off|true|false|null|~|[-+]?\.(?:inf|nan)|[-+.]?\d.*|<<|=)$/i;
const PLAIN_BLOCK = /^[A-Za-z_/][A-Za-z0-9 _./:@,'()?+=&%;-]*$/;
const PLAIN_FLOW = /^[A-Za-z_/][A-Za-z0-9 _./:@'()?+=&%;-]*$/;

function plainSafe(s: string, flow: boolean): boolean {
  if (!(flow ? PLAIN_FLOW : PLAIN_BLOCK).test(s)) return false;
  if (s !== s.trim() || COERCIBLE.test(s)) return false;
  if (s.includes(': ') || s.includes(' #') || s.endsWith(':')) return false;
  return true;
}

/** Plain when unambiguous, otherwise double-quoted (JSON escapes are a subset of YAML's). */
export function yamlScalar(s: string, flow = false): string {
  return plainSafe(s, flow) ? s : JSON.stringify(s);
}

export function stringifyYaml(doc: YamlDoc): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (!KEY.test(key)) throw new PbcpError('yaml_outside_subset', `cannot write key ${JSON.stringify(key)}`);
    if (typeof value === 'string') {
      out.push(`${key}: ${yamlScalar(value)}`);
    } else if (Array.isArray(value)) {
      if (value.every((v) => typeof v === 'string')) {
        out.push(`${key}: [${(value as string[]).map((v) => yamlScalar(v, true)).join(', ')}]`);
      } else {
        out.push(`${key}:`);
        for (const item of value) {
          if (typeof item === 'string') {
            out.push(`  - ${yamlScalar(item)}`);
            continue;
          }
          const entries = Object.entries(item);
          if (entries.length === 0) throw new PbcpError('yaml_outside_subset', `cannot write an empty mapping in ${key}`);
          entries.forEach(([k, v], n) => out.push(`${n === 0 ? '  - ' : '    '}${k}: ${yamlScalar(v)}`));
        }
      }
    } else {
      const entries = Object.entries(value);
      if (entries.length === 0) throw new PbcpError('yaml_outside_subset', `cannot write an empty mapping for ${key}`);
      out.push(`${key}:`);
      for (const [k, v] of entries) out.push(`  ${k}: ${yamlScalar(v)}`);
    }
  }
  return out.map((l) => l + '\n').join('');
}
