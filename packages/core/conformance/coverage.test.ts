// The §14 coverage table: every fixture names a requirement, every named requirement is in the RFC, and the table in the
// RFC is the one scripts/conformance-map.ts makes from them.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coverageTable, fixtureCovers, rfcPath, untested } from '../../../scripts/conformance-map.ts';
import { brief, requirements, resolve, tableOf } from '../../../scripts/coverage.ts';

const rfc = readFileSync(rfcPath(), 'utf8');
const reqs = requirements(rfc);

describe('conformance coverage (§14)', () => {
  it('finds every MUST, MUST NOT, SHOULD and SHOULD NOT in §3–§11 and Appendix A', () => {
    const scope = rfc.slice(rfc.indexOf('\n## 3. '), rfc.indexOf('\n## 12. ')) + rfc.slice(rfc.indexOf('\n## Appendix A'), rfc.indexOf('\n## Appendix B'));
    const prose = scope.replace(/^```[\s\S]*?^```/gm, '');
    const count = (s: string) => (s.match(/\b(MUST NOT|MUST|SHOULD NOT|SHOULD)\b/g) ?? []).length;
    expect(reqs.map((r) => count(r.text)).reduce((a, b) => a + b, 0)).toBe(count(prose));
  });

  it('every fixture names at least one requirement, and each is a sentence of the RFC', () => {
    for (const f of fixtureCovers()) {
      expect(f.covers.length, f.id).toBeGreaterThan(0);
      for (const ref of f.covers) expect(() => resolve(ref, reqs), `${f.id}: ${ref}`).not.toThrow();
    }
  });

  it('every requirement listed as untested is a sentence of the RFC, with a reason', () => {
    for (const u of untested()) {
      expect(() => resolve(u.requirement, reqs), u.requirement).not.toThrow();
      expect(u.why.trim()).not.toBe('');
    }
  });

  it('the table in the RFC is the generated one (node --experimental-strip-types scripts/conformance-map.ts)', () => {
    expect(tableOf(rfc)).toBe(coverageTable(rfc));
  });

  it('refuses a reference that names no sentence, or more than one', () => {
    expect(() => resolve('§5 no such words', reqs)).toThrow(/no requirement sentence/);
    expect(() => resolve('§3.1 MUST', reqs)).toThrow(/requirement sentences/);
    expect(() => resolve('MUST accept JSON', reqs)).toThrow(/§<section>/);
  });

  it('quotes briefly, never inside a code span and never with a raw pipe', () => {
    expect(brief('a `b | c` d', 8)).toBe('a …');
    expect(brief('x'.repeat(10))).toBe('x'.repeat(10));
    expect(brief('a | b')).toBe('a \\| b');
  });
});
