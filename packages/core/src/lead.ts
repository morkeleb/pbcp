// RFC §3.1 "Lead": what a person reads to decide whether to open a card. Line-based, so every head picks the same lead;
// this module splits the body and renders nothing.

export interface Lead {
  text: string;
  source: 'summary' | 'body';
}

const BLANK = /^\s*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const STARTS_BLOCK = /^ {0,3}(?:>|[-*+][ \t]|\d{1,9}[.)][ \t]|\|)/;

/** `summary` when present; otherwise the body's first paragraph (§3.1), each line trimmed. Empty when the body has none. */
export function leadOf(card: { summary?: string; body: string }): Lead {
  if (card.summary !== undefined) return { text: card.summary, source: 'summary' };
  const lines = card.body.split(/\r?\n/);
  let i = 0;
  // Step 1: skip blank lines, headings, thematic breaks and fenced blocks.
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const [ch, n] = [fence[1]![0]!, fence[1]!.length];
      const close = new RegExp(`^ {0,3}\\${ch}{${n},}[ \\t]*$`);
      for (i++; i < lines.length && !close.test(lines[i]!); i++);
      i++;
    } else if (BLANK.test(line) || HEADING.test(line) || BREAK.test(line)) i++;
    else break;
  }
  // Step 2: the first line not skipped, up to a blank line or the start of another block.
  const lead: string[] = [];
  for (let j = i; j < lines.length; j++) {
    const line = lines[j]!;
    const ends = BLANK.test(line) || HEADING.test(line) || BREAK.test(line) || FENCE.test(line) || STARTS_BLOCK.test(line);
    if (j > i && ends) break;
    lead.push(line.trim());
  }
  return { text: lead.join('\n'), source: 'body' };
}
