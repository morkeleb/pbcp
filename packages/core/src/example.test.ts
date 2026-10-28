import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCardOrThrow } from './card.js';
import { exampleCard } from './example.js';

const rfcDir = fileURLToPath(new URL('../../../rfc/', import.meta.url));

/** The newest draft, so a renamed draft is still the one checked. */
const rfc = () => {
  const drafts = readdirSync(rfcDir).filter((f) => /^pbcp-draft-\d+\.\d+\.md$/.test(f));
  const newest = drafts.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)!;
  return readFileSync(rfcDir + newest, 'utf8');
};

/** §3's file-form fence: the first ```markdown block after the "## 3." heading. */
function section3Fence(text: string): string {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l.startsWith('## 3. '));
  const open = lines.findIndex((l, i) => i > from && l === '```markdown');
  const close = lines.findIndex((l, i) => i > open && l === '```');
  expect(from >= 0 && open > from && close > open).toBe(true);
  return lines.slice(open + 1, close).join('\n');
}

describe('exampleCard (§3)', () => {
  it('is the card in the RFC, field for field', () => {
    expect(exampleCard).toEqual(parseCardOrThrow(section3Fence(rfc())));
  });

  it('is a valid card', () => {
    expect(parseCardOrThrow(exampleCard)).toEqual(exampleCard);
  });
});
