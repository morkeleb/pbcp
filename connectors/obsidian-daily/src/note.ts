import { card } from '@pbcp/client';
import { CARD_LIMIT_BYTES, type ProducerCard } from '@pbcp/core';

export interface NoteConfig { vault: string; toPerson: string }

/** A grammar-valid namespace (§5) from a vault folder name. */
export const namespaceOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'vault';

/** `YYYY-MM-DD` of a daily-note file name, or undefined when the name is not a real date. */
export function dateOf(file: string): string | undefined {
  const d = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(file)?.[1];
  return d && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d) ? d : undefined;
}

/** ISO-8601 week of a date, e.g. `2026-W44`: the week-year is the year of that week's Thursday. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const week = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5 / 7) + 1;
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** `[[P]]` → P, `[[P|a]]` → a, `[[P#H]]` → P > H, `[[P#^block]]` → P; embeds (`![[x]]`) alike. */
export const unlink = (md: string) =>
  md.replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) =>
    alias?.trim() || target.split('#').map((s) => s.trim()).filter((s) => s && !s.startsWith('^')).join(' > '));

/** Drops a leading YAML front-matter block (Obsidian properties). */
export const stripFrontMatter = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');

const TRUNCATED = '\n\n_Truncated: the note is longer than a card allows. The full text is in the vault._';
const size = (c: ProducerCard) => Buffer.byteLength(JSON.stringify(c));

/** One daily note → one log artifact (§11.1), cut to fit the 64 KiB wire limit (§3). */
export function toCard(text: string, date: string, cfg: NoteConfig, limit = CARD_LIMIT_BYTES): ProducerCard {
  const make = (body: string) => card({
    producer: 'obsidian', namespace: cfg.vault, upstream: date, kind: 'artifact', to_person: cfg.toPerson,
    thread: isoWeek(date), urgency: 'log', title: `Daily note ${date}`, body,
  });
  const full = unlink(stripFrontMatter(text)).trim();
  let c = make(full);
  for (let keep = full.length; size(c) > limit && keep > 0; ) {
    keep = Math.floor((keep * limit) / size(c)) - TRUNCATED.length - 64;
    c = make(full.slice(0, Math.max(0, keep)).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + TRUNCATED);
  }
  return c;
}
