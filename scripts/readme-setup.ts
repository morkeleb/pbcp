// Writes each connector's README "Setup" section from its connect() (src/connect.ts), with placeholders.
// Run after the packages are built: connect.ts imports @pbcp/client, which resolves to its dist.
//   node --experimental-strip-types scripts/readme-setup.ts           write
//   node --experimental-strip-types scripts/readme-setup.ts --check   exit 1 if a README is out of date

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLACEHOLDERS, setupOf, withSetup } from './setup-section.ts';

const root = fileURLToPath(new URL('../connectors/', import.meta.url));
const check = process.argv.includes('--check');
let stale = 0;

for (const dir of readdirSync(root).sort()) {
  const source = join(root, dir, 'src', 'connect.ts');
  if (!existsSync(source)) continue;
  const { connect } = (await import(pathToFileURL(source).href)) as { connect: (c: typeof PLACEHOLDERS) => string };
  const readmePath = join(root, dir, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');
  const md = connect(PLACEHOLDERS);
  if (setupOf(readme) === md.trim()) continue;
  if (check) {
    console.error(`connectors/${dir}/README.md: the Setup section is out of date; run node --experimental-strip-types scripts/readme-setup.ts`);
    stale++;
  } else {
    writeFileSync(readmePath, withSetup(readme, md));
    console.log(`connectors/${dir}/README.md: Setup written`);
  }
}
process.exit(stale ? 1 : 0);
