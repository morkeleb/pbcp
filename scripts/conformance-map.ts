// Writes the conformance coverage table into §14 of the newest RFC draft, from the fixtures' `covers` and
// packages/core/conformance/untested.json (see scripts/coverage.ts).
//   node --experimental-strip-types scripts/conformance-map.ts           write
//   node --experimental-strip-types scripts/conformance-map.ts --check   exit 1 if the table is out of date

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { table, tableOf, withTable, type FixtureCovers, type Untested } from './coverage.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const conformance = join(root, 'packages/core/conformance');

/** The newest draft, so a renamed draft is still the one written. */
export function rfcPath(): string {
  const drafts = readdirSync(join(root, 'rfc')).filter((f) => /^pbcp-draft-\d+\.\d+\.md$/.test(f));
  return join(root, 'rfc', drafts.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)!);
}

export function fixtureCovers(): FixtureCovers[] {
  return ['core', 'render'].flatMap((dir) => readdirSync(join(conformance, 'fixtures', dir)).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const fx = JSON.parse(readFileSync(join(conformance, 'fixtures', dir, f), 'utf8')) as { name: string; covers?: string[] };
    return { id: fx.name.split(' ')[0]!, covers: fx.covers ?? [] };
  }));
}

export const untested = (): Untested[] => JSON.parse(readFileSync(join(conformance, 'untested.json'), 'utf8')) as Untested[];

export const coverageTable = (rfc: string) => table(rfc, fixtureCovers(), untested());

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = rfcPath();
  const rfc = readFileSync(path, 'utf8');
  const md = coverageTable(rfc);
  if (tableOf(rfc) === md) process.exit(0);
  if (process.argv.includes('--check')) {
    console.error(`${path}: the coverage table is out of date; run node --experimental-strip-types scripts/conformance-map.ts`);
    process.exit(1);
  }
  writeFileSync(path, withTable(rfc, md));
  console.log(`${path}: coverage table written`);
}
