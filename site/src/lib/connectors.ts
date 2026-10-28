// One row per connector in `connectors/`, read from its README at build time:
// - what it produces: the README's first paragraph of prose (not a heading, code block, list or table);
// - its settings: the first column of the first table under a `Configuration` or `Credentials` heading, or else the
//   variables set with `export` in the README's first shell block.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Marked, type Token, type Tokens } from 'marked';
import { REPO_ROOT, REPO_URL } from '../config';

export interface Connector { dir: string; url: string; produces: string; settings: string[]; /** The README's generated Setup section (from the connector's connect()), when it has one. */ setup?: string }

const inline = new Marked({ gfm: true });

/** `IMAP_HOST`, `IMAP_PORT` → both; `Head URL` → itself. */
function names(cell: string): string[] {
  const code = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  return code.length ? code : [cell.trim()].filter(Boolean);
}

function settingsOf(tokens: Token[]): string[] {
  const at = tokens.findIndex((t) => t.type === 'heading' && /^(configuration|credentials)\b/i.test((t as Tokens.Heading).text));
  if (at >= 0) {
    for (const t of tokens.slice(at + 1)) {
      if (t.type === 'heading') break;
      if (t.type === 'table') return (t as Tokens.Table).rows.flatMap((r) => names(r[0]!.text));
    }
  }
  const sh = tokens.find((t): t is Tokens.Code => t.type === 'code' && /^(sh|bash|shell)?$/.test(t.lang ?? ''));
  return [...new Set([...(sh?.text ?? '').matchAll(/^export\s+(.+)$/gm)].flatMap((m) => [...m[1]!.matchAll(/([A-Z][A-Z0-9_]+)=/g)].map((v) => v[1]!)))];
}

export function connectors(): Connector[] {
  const root = resolve(REPO_ROOT, 'connectors');
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(root, d.name, 'README.md')))
    .map((d) => {
      const readme = readFileSync(resolve(root, d.name, 'README.md'), 'utf8');
      const tokens = new Marked({ gfm: true }).lexer(readme);
      const para = tokens.find((t): t is Tokens.Paragraph => t.type === 'paragraph');
      return {
        dir: d.name,
        url: `${REPO_URL}/tree/main/connectors/${d.name}`,
        produces: para ? (inline.parseInline(para.text) as string) : '',
        settings: settingsOf(tokens),
        ...(readme.includes('<!-- setup:') ? { setup: `${REPO_URL}/blob/main/connectors/${d.name}/README.md#setup` } : {}),
      };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}
