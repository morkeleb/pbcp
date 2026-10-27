// Markdown from the repository rendered at build time: heading anchors, a table of contents, and `§7.3`-style
// references linked to the RFC's sections. Headings inside code fences are code, not sections, because they are
// taken from the parsed tokens.

import { readFileSync } from 'node:fs';
import { Marked, type Token, type Tokens } from 'marked';
import { RFC_FILE, href } from '../config';

export interface TocEntry { id: string; text: string; depth: number }

/** GitHub's anchor rule, so a fragment copied from the repository's rendered markdown works here too. */
export function slug(text: string, seen: Map<string, number>): string {
  const base = text.toLowerCase().trim().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/** Heading text without inline markup: `` `summary` `` → `summary`. */
const plain = (t: Tokens.Heading) => t.text.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*|\*([^*]*)\*/g, '$1$2');

/** The section number a heading starts with: `7.1 Submit` → `7.1`, `Appendix A. Extension: Orders` → `A`, `A.2 Claims…` → `A.2`. */
const sectionNumber = (text: string) => /^(?:Appendix\s+([A-Z])\.|(\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)\.?\s)/.exec(text)?.slice(1).find(Boolean);

function headings(tokens: Token[]): { token: Tokens.Heading; id: string; text: string }[] {
  const seen = new Map<string, number>();
  return tokens.filter((t): t is Tokens.Heading => t.type === 'heading').map((token) => ({ token, text: plain(token), id: slug(plain(token), seen) }));
}

/** Section number → anchor id in the current RFC draft. */
let rfcSectionsCache: Map<string, string> | undefined;
export function rfcSections(): Map<string, string> {
  rfcSectionsCache ??= new Map(headings(new Marked({ gfm: true }).lexer(readFileSync(RFC_FILE.path, 'utf8'))).flatMap((h) => {
    const n = sectionNumber(h.text);
    return n ? [[n, h.id] as const] : [];
  }));
  return rfcSectionsCache;
}

/** Links `§N` and `§N.N` outside code, links and headings. `page` is the path of the page the anchors live on. */
function linkSections(html: string, sections: Map<string, string>, page: string): string {
  return html
    .split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|<a\s[\s\S]*?<\/a>|<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/)
    .map((part, i) => (i % 2 ? part : part.replace(/§(\d+(?:\.\d+)*)/g, (m, n: string) => {
      const id = sections.get(n);
      return id ? `<a href="${page}#${id}">${m}</a>` : m;
    })))
    .join('');
}

export interface Rendered { html: string; toc: TocEntry[] }

/**
 * `sectionsOn`: the page whose anchors `§` references point at; `''` for the page itself (the RFC), else e.g.
 * `href('/rfc/')`. `rewrite` maps a link target in the source (`pbcp-draft-0.7.md`) to one on this site.
 */
export function render(md: string, opts: { sectionsOn?: string; rewrite?: (url: string) => string } = {}): Rendered {
  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(md);
  const hs = headings(tokens);
  const ids = new Map(hs.map((h) => [h.token, h.id]));
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Token[]): string } }, t: Tokens.Heading) {
        const id = ids.get(t) ?? '';
        return `<h${t.depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${this.parser.parseInline(t.tokens)}</h${t.depth}>\n`;
      },
      link(this: { parser: { parseInline(t: Token[]): string } }, t: Tokens.Link) {
        const url = opts.rewrite ? opts.rewrite(t.href) : t.href;
        const ext = /^https?:/.test(url);
        return `<a href="${url}"${ext ? ' rel="noopener"' : ''}>${this.parser.parseInline(t.tokens)}</a>`;
      },
    },
  });
  let html = marked.parser(tokens);
  if (opts.sectionsOn !== undefined) html = linkSections(html, rfcSections(), opts.sectionsOn);
  return { html, toc: hs.filter((h) => h.token.depth >= 2 && h.token.depth <= 3).map((h) => ({ id: h.id, text: h.text, depth: h.token.depth })) };
}

export const readRepo = (path: string) => readFileSync(path, 'utf8');
export { href };
