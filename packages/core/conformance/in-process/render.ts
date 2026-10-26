// Reference RenderUnderTest for the in-process run. It classifies a body the way §3.1
// requires a head to, without drawing anything: mermaid fences are sanitised, tiered and
// syntax-checked; images and raw HTML are classified. Its "parser" is deliberately shallow
// (a header check plus `pie` data lines). A real head brings a real renderer.

import type { RenderResult, RenderUnderTest, RenderedFence, RenderedImage } from '../types.js';

const CORE = ['flowchart', 'sequenceDiagram', 'stateDiagram-v2', 'gantt', 'timeline', 'pie', 'xychart-beta'];
const EXTENDED = ['classDiagram', 'erDiagram', 'quadrantChart', 'sankey-beta', 'mindmap', 'gitGraph', 'journey'];
const SUPPORTED = new Set([...CORE, ...EXTENDED]);
const MAX_FENCES = 8;

const IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

interface Block {
  kind: 'text' | 'mermaid';
  text: string;
}

function splitFences(body: string): Block[] {
  const blocks: Block[] = [];
  const lines = body.split('\n');
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) blocks.push({ kind: 'text', text: buf.join('\n') });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i]!);
    if (!open) { buf.push(lines[i]!); continue; }
    const fence = open[1]!;
    const close = lines.findIndex((l, j) => j > i && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(l));
    const end = close < 0 ? lines.length : close;
    const inner = lines.slice(i + 1, end).join('\n');
    if (open[2] === 'mermaid') {
      flush();
      blocks.push({ kind: 'mermaid', text: inner });
    } else {
      buf.push(inner); // other code is text
    }
    i = end;
  }
  flush();
  return blocks;
}

/** §3.1 "Declarative only": strip click, URL-loading or htmlLabels init directives, htmlLabels. */
function sanitiseFence(src: string, stripped: Set<string>): string {
  return src
    .split('\n')
    .filter((line) => {
      if (/^\s*click\s/.test(line)) { stripped.add('click'); return false; }
      if (/^\s*%%\{\s*init/.test(line)) {
        if (/htmlLabels/.test(line)) stripped.add('htmlLabels');
        if (/https?:|url\(|@import|htmlLabels/i.test(line)) { stripped.add('init'); return false; }
      }
      return true;
    })
    .join('\n');
}

function diagramType(src: string): string {
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('%%')) continue;
    return t.split(/\s+/)[0]!;
  }
  return '';
}

/** Returns an error message, or null if the fence parses. */
function check(type: string, src: string): string | null {
  if (type !== 'pie') return null;
  const lines = src.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('%%'));
  for (const line of lines.slice(1)) {
    if (/^(title|showData)\b/.test(line)) continue;
    if (!/^"[^"]*"\s*:\s*-?\d+(\.\d+)?$/.test(line)) return `pie: cannot parse data line: ${line}`;
  }
  return null;
}

/** Inline SVG sanitising (§3.1): scripts, event attributes, foreignObject, external hrefs, remote use. */
function sanitiseSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<foreignObject[^>]*\/>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '')
    .replace(/<use\b[^>]*>(?:<\/use>)?/gi, (m) => (/href\s*=\s*["']#/.test(m) ? m : ''));
}

/** §3: raw HTML is stripped; script/style/iframe contents go with their tags. */
function stripHtml(text: string, stripped: Set<string>): string {
  const out = text
    .replace(/<(script|style|iframe)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '');
  if (out !== text) stripped.add('html');
  return out;
}

function classifyImage(alt: string, src: string): RenderedImage {
  if (/^https:/i.test(src)) return { alt, src, class: 'image' };
  if (/^data:image\/png;base64,/i.test(src)) return { alt, src, class: 'image' };
  const svg = /^data:image\/svg\+xml;base64,(.*)$/i.exec(src);
  if (svg) return { alt, src, class: 'image', svg: sanitiseSvg(Buffer.from(svg[1]!, 'base64').toString('utf8')) };
  return { alt, src, class: 'link' };
}

export function referenceRenderer(): RenderUnderTest {
  let cache = new Map<string, true>();
  let draws = 0;

  return {
    async reset() {
      cache = new Map();
      draws = 0;
    },
    async draws() {
      return draws;
    },
    async render(body) {
      const stripped = new Set<string>();
      const fences: RenderedFence[] = [];
      const images: RenderedImage[] = [];
      const text: string[] = [];

      const blocks = splitFences(body);
      for (const [i, block] of blocks.entries()) {
        if (block.kind === 'mermaid') {
          const source = sanitiseFence(block.text, stripped);
          const type = diagramType(source);
          let fence: RenderedFence;
          if (fences.length >= MAX_FENCES) fence = { type, class: 'collapsed', source };
          else if (!SUPPORTED.has(type)) fence = { type, class: 'fallback', source, message: 'diagram not supported' };
          else {
            const err = check(type, source);
            fence = err ? { type, class: 'fallback', source, message: err } : { type, class: 'render', source };
          }
          if (fence.class === 'render' && !cache.has(source)) {
            cache.set(source, true);
            draws++;
          }
          fences.push(fence);
          continue;
        }
        // §3.1: an image with alt `fallback` immediately after a fence (blank lines aside) belongs to it.
        const fence = blocks[i - 1]?.kind === 'mermaid' ? fences.at(-1) : undefined;
        const visible = stripHtml(block.text, stripped).replace(IMAGE, (m: string, alt: string, src: string, at: number, all: string) => {
          const img = classifyImage(alt, src);
          if (fence && alt === 'fallback' && all.slice(0, at).trim() === '') {
            if (fence.class === 'fallback') fence.fallbackImage = true;
            else img.class = 'hidden';
          }
          images.push(img);
          return img.class === 'hidden' ? '' : alt;
        });
        text.push(visible);
      }
      return { text: text.join('\n'), stripped: [...stripped], fences, images } satisfies RenderResult;
    },
  };
}
