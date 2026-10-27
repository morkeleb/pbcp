// Pieces of the current draft quoted on other pages, taken from the RFC at build time so they never drift from it.

import { Marked, type Token, type Tokens } from 'marked';
import { RFC_FILE } from '../config';
import { readRepo } from './markdown';

const tokens = (): Token[] => new Marked({ gfm: true }).lexer(readRepo(RFC_FILE.path));

/** The tokens of the section whose heading starts with `prefix` (`1. Motivation`), up to the next heading of its level or higher. */
function section(prefix: string): Token[] {
  const all = tokens();
  const at = all.findIndex((t) => t.type === 'heading' && (t as Tokens.Heading).text.startsWith(prefix));
  if (at < 0) throw new Error(`RFC section "${prefix}" not found`);
  const depth = (all[at] as Tokens.Heading).depth;
  const end = all.findIndex((t, i) => i > at && t.type === 'heading' && (t as Tokens.Heading).depth <= depth);
  return all.slice(at + 1, end < 0 ? undefined : end);
}

/** §1's opening paragraph, as markdown. */
export const problem = () => (section('1. Motivation').find((t) => t.type === 'paragraph') as Tokens.Paragraph).text;

/** §3's example card in file form. */
export const exampleCard = () => (section('3. Card format').find((t) => t.type === 'code' && (t as Tokens.Code).lang === 'markdown') as Tokens.Code).text;
