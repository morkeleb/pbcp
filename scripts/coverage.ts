// The RFC's conformance coverage table (§14): every MUST, MUST NOT, SHOULD and SHOULD NOT sentence in §3–§11 and Appendix A,
// with the fixtures whose `covers` name it, or why it is untested. scripts/conformance-map.ts writes the table into the RFC;
// packages/core/conformance/coverage.test.ts checks that the table, the fixtures and the RFC agree.

export interface Requirement {
  /** `7.1`, `4.1a`, `A.2`. */
  section: string;
  /** The sentence, markdown as written. */
  text: string;
}

export interface Untested {
  /** `§<section> <words from the sentence>`, as in a fixture's `covers`. */
  requirement: string;
  why: string;
}

export const BEGIN = '<!-- coverage: generated from the fixtures by scripts/conformance-map.ts; edit their `covers` or packages/core/conformance/untested.json, not this table -->';
export const END = '<!-- /coverage -->';

const KEYWORD = /\b(MUST NOT|MUST|SHOULD NOT|SHOULD)\b/;

/** `## 7. Operations` → `7`, `### 4.1a Choosing…` → `4.1a`, `## Appendix A. …` → `A`, `### A.2 …` → `A.2`. */
function sectionOf(heading: string): string | undefined {
  const m = /^#{2,3}\s+(?:Appendix\s+([A-Z])\.|(\d+(?:\.\d+)*[a-z]?|[A-Z](?:\.\d+)+)\.?\s)/.exec(heading);
  return m?.[1] ?? m?.[2];
}

const inScope = (section: string) => /^A(\.|$)/.test(section) || (Number(section.split('.')[0]) >= 3 && Number(section.split('.')[0]) <= 11);

/** Paragraphs, list items and table rows outside code fences, with their section; a table row also has its first cell. */
function blocks(rfc: string): { section: string; text: string; row?: string }[] {
  const out: { section: string; text: string; row?: string }[] = [];
  let section: string | undefined;
  let fence = false;
  let current: string[] = [];
  const flush = () => {
    const row = /^\|/.test(current[0] ?? '') ? current[0]!.split('|')[1]!.trim() : undefined;
    if (section && current.length && inScope(section)) out.push({ section, text: current.join(' ').replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, ' | '), ...(row ? { row } : {}) });
    current = [];
  };
  for (const line of rfc.split('\n')) {
    if (/^\s*```/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) continue;
    if (/^#{1,6}\s/.test(line)) { flush(); section = sectionOf(line) ?? (/^##\s/.test(line) ? undefined : section); continue; }
    if (line.trim() === '' || /^\s*\|?\s*-{3,}/.test(line)) { flush(); continue; }
    if (/^\s*([-*]|\d+\.)\s/.test(line) || /^\s*\|/.test(line)) flush(); // each list item and table row is its own block
    current.push(line.trim());
  }
  flush();
  return out;
}

/** Sentences end at `.`, `;` is kept inside; a full stop before a capital, `*`, `` ` `` or `(` ends one. */
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z*`(])(?<!\be\.g\.\s+)(?<!\bi\.e\.\s+)/);

/** Every requirement sentence in §3–§11 and Appendix A, in order. A sentence from a table row that does not start with the
 *  row's first cell (a field's name) is prefixed with it, so `MUST NOT be empty` says whose. */
export function requirements(rfc: string): Requirement[] {
  return blocks(rfc).flatMap((b) => sentences(b.text).filter((s) => KEYWORD.test(s)).map((s) => {
    const text = s.trim();
    return { section: b.section, text: b.row && !text.startsWith(b.row) ? `${b.row}: ${text}` : text };
  }));
}

/** Plain words for matching: no markdown emphasis, code ticks or link targets, spaces collapsed, lower case. */
export const plain = (s: string) =>
  s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The requirement a `§<section> <words>` reference names: exactly one sentence of that section contains the words. */
export function resolve(ref: string, reqs: Requirement[]): Requirement {
  const m = /^§(\S+)\s+(.+)$/.exec(ref.trim());
  if (!m) throw new Error(`"${ref}": a requirement is "§<section> <words from the sentence>"`);
  const [, section, words] = m as unknown as [string, string, string];
  const hits = reqs.filter((r) => r.section === section && plain(r.text).includes(plain(words)));
  if (hits.length !== 1) {
    throw new Error(`"${ref}": ${hits.length === 0 ? 'no requirement sentence' : `${hits.length} requirement sentences`} in §${section} ${hits.length === 0 ? 'contains' : 'contain'} those words`);
  }
  return hits[0]!;
}

/** The sentence, cut to about `max` characters at a word, for the table: no pipes, no line breaks. */
export function brief(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  // Never end inside an open code span.
  let out = cut.slice(0, at > 0 ? at : max);
  if ((out.match(/`/g) ?? []).length % 2) out = out.slice(0, out.lastIndexOf('`')).trimEnd();
  return `${out.replace(/[,;:(]+$/, '')} …`;
}

export interface FixtureCovers {
  /** `C01`, `R09`: the first word of the fixture's name. */
  id: string;
  covers: string[];
}

/** The table, as markdown between BEGIN and END. Throws when a reference does not resolve or a requirement has neither. */
export function table(rfc: string, fixtures: FixtureCovers[], untested: Untested[]): string {
  const reqs = requirements(rfc);
  const covered = new Map<Requirement, string[]>();
  for (const f of fixtures) {
    if (f.covers.length === 0) throw new Error(`${f.id}: covers names no requirement`);
    for (const ref of f.covers) {
      const r = resolve(ref, reqs);
      const ids = covered.get(r) ?? [];
      if (!ids.includes(f.id)) covered.set(r, [...ids, f.id]);
    }
  }
  const why = new Map<Requirement, string>();
  for (const u of untested) {
    const r = resolve(u.requirement, reqs);
    if (covered.has(r)) throw new Error(`"${u.requirement}" is listed as untested, but ${covered.get(r)!.join(', ')} cover it`);
    if (why.has(r)) throw new Error(`"${u.requirement}" is listed as untested twice`);
    why.set(r, u.why);
  }
  const missing = reqs.filter((r) => !covered.has(r) && !why.has(r));
  if (missing.length) throw new Error(`no fixture covers, and untested.json does not list:\n${missing.map((r) => `  §${r.section} ${brief(r.text, 100)}`).join('\n')}`);
  const order = (id: string) => [id[0] === 'C' ? 0 : 1, Number(id.slice(1))] as const;
  const sorted = (ids: string[]) => [...ids].sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
  const tested = reqs.filter((r) => covered.has(r)).length;
  return [
    `${reqs.length} requirements: ${tested} exercised by a fixture, ${reqs.length - tested} untested.`,
    '',
    '| § | Requirement | Fixtures |',
    '| --- | --- | --- |',
    ...reqs.map((r) => `| ${r.section} | ${brief(r.text)} | ${covered.has(r) ? sorted(covered.get(r)!).join(', ') : `untested: ${why.get(r)}`} |`),
  ].join('\n');
}

/** The RFC with the text between BEGIN and END replaced by `md`. */
export function withTable(rfc: string, md: string): string {
  const [from, to] = [rfc.indexOf(BEGIN), rfc.indexOf(END)];
  if (from < 0 || to < from) throw new Error(`the RFC has no ${BEGIN} … ${END} block`);
  return `${rfc.slice(0, from + BEGIN.length)}\n\n${md}\n\n${rfc.slice(to)}`;
}

/** The text between BEGIN and END, trimmed. */
export function tableOf(rfc: string): string | undefined {
  const [from, to] = [rfc.indexOf(BEGIN), rfc.indexOf(END)];
  return from < 0 || to < from ? undefined : rfc.slice(from + BEGIN.length, to).trim();
}
