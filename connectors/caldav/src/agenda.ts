import { createHash } from 'node:crypto';
import { card, type KeyValue, type ProducerOptions } from '@pbcp/client';
import type { ProducerCard } from '@pbcp/core';
import ICAL from 'ical.js';

type Time = InstanceType<typeof ICAL.Time>; type Event = InstanceType<typeof ICAL.Event>;
/** A configured calendar: `name` is shown to the person, `slug` is its namespace (§5). */
export interface Calendar { name: string; slug: string }
/** One occurrence; `key` is UID/RECURRENCE-ID. An all-day one carries its local dates, end exclusive. */
export interface Occurrence { key: string; title: string; location?: string; start: Date; end: Date; allDay?: { from: string; to: string }; calendar?: Calendar }
/** With one calendar the cards are exactly those of a single-calendar producer; with several, one agenda merges them. */
export interface Config { calendars: Calendar[]; toPerson: string; tz: string; agendaAt?: string; leadMinutes?: number }
/** `agenda`: the last day an agenda was produced; `seen`: last-seen start per occurrence key, for the fetch window only. */
export interface State { agenda?: string; seen: Record<string, string> }

const local = (d: Date, tz: string) => d.toLocaleString('sv-SE', { timeZone: tz }); // "YYYY-MM-DD HH:MM:SS"
const dateOf = (d: Date, tz: string) => local(d, tz).slice(0, 10);
const timeOf = (d: Date, tz: string) => local(d, tz).slice(11, 16);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim() || '(untitled)';
/** §4.1 `summary`: plain text on one line, at most 280 characters. */
const clip = (s: string) => (s.length > 280 ? `${s.slice(0, 279)}…` : s);
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const KEYWORD = /^(title|section|dateformat|axisformat|tickinterval|excludes|includes|todaymarker|weekday|weekend|inclusiveenddates|topaxis|click|call|href|acc\w*)\b/i;

/** A grammar-valid namespace (§5) from a calendar name. */
export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'calendar';
/** A gantt task name: no `:` `#` `;` `%` (task-data, comment and statement syntax), no leading keyword, at most 40 characters. */
export const ganttTitle = (s: string) => oneLine(s.replace(/[:#;%]/g, ' ')).replace(KEYWORD, '· $1').slice(0, 40);
const cell = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
const several = (cfg: Config) => cfg.calendars.length > 1;

/** `CALDAV_CALENDARS`: a JSON list of `{ name, url }`. Names must give distinct namespaces, since moved signals use them. */
export function parseCalendars(json: string): { name: string; url: string; slug: string }[] {
  const list: unknown = JSON.parse(json);
  if (!Array.isArray(list) || list.length === 0) throw new Error('CALDAV_CALENDARS must be a non-empty JSON list of { name, url }');
  const out = list.map((c: { name?: unknown; url?: unknown }) => {
    if (typeof c?.name !== 'string' || !c.name.trim() || typeof c.url !== 'string' || !c.url) throw new Error(`CALDAV_CALENDARS: each entry needs a name and a url, got ${JSON.stringify(c)}`);
    return { name: c.name.trim(), url: c.url, slug: slug(c.name) };
  });
  const dup = out.find((c, i) => out.findIndex((d) => d.slug === c.slug) !== i);
  if (dup) throw new Error(`CALDAV_CALENDARS: two calendars give the namespace ${dup.slug}; rename one`);
  return out;
}

/** Occurrences overlapping [from, to) in some iCalendar texts. Recurrences are expanded, at most `cap` steps per series. */
export function occurrences(ics: string[], from: Date, to: Date, cap = 10_000): Occurrence[] {
  const out: Occurrence[] = [];
  const push = (ev: Event, s: Time, e: Time, rid?: Time | null) => {
    const [start, end] = [s.toJSDate(), e.toJSDate()];
    if (start >= to || (end <= from && start < from) || ev.component.getFirstPropertyValue('status') === 'CANCELLED') return;
    const location = ev.location ? oneLine(ev.location) : undefined;
    out.push({ key: `${ev.uid}/${rid?.toString() ?? ''}`, title: oneLine(ev.summary ?? ''), location, start, end, allDay: s.isDate ? { from: s.toString(), to: e.toString() } : undefined });
  };
  for (const text of ics) {
    const comp = new ICAL.Component(ICAL.parse(text));
    for (const tz of comp.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);
    const all = comp.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v));
    const series = all.filter((e) => !e.isRecurrenceException());
    for (const ex of all.filter((e) => e.isRecurrenceException())) {
      const master = series.find((m) => m.uid === ex.uid && m.isRecurring());
      if (master) master.relateException(ex); else series.push(ex);
    }
    for (const ev of series) {
      if (!ev.isRecurring()) push(ev, ev.startDate, ev.endDate, ev.recurrenceId);
      else for (let it = ev.iterator(), t = it.next(), n = 0; t && n < cap && t.toJSDate() < to; t = it.next(), n++) {
        const { item, startDate, endDate, recurrenceId } = ev.getOccurrenceDetails(t);
        push(item, startDate, endDate, recurrenceId);
      }
    }
  }
  return out;
}

const onDay = (o: Occurrence, day: string, tz: string) =>
  o.allDay ? o.allDay.from <= day && day < o.allDay.to : dateOf(o.start, tz) <= day && day <= dateOf(new Date(Math.max(+o.start, +o.end - 1)), tz);

/** Timed events of different calendars whose times intersect; the same occurrence in two calendars is not an overlap. */
export function overlaps(events: Occurrence[]): [Occurrence, Occurrence][] {
  const timed = events.filter((o) => !o.allDay);
  return timed.flatMap((a, i) => timed.slice(i + 1)
    .filter((b) => a.calendar?.slug !== b.calendar?.slug && a.key !== b.key && +a.start < +b.end && +b.start < +a.end)
    .map((b): [Occurrence, Occurrence] => [a, b]));
}

/** The day's agenda as a table and a gantt fence; times are clipped to the day. With several calendars, the table gains a
 *  calendar column, the gantt a section per calendar, and events that overlap across calendars are marked. */
export function agendaCard(occ: Occurrence[], day: string, cfg: Config, now: Date): ProducerCard {
  const multi = several(cfg);
  const events = occ.filter((o) => onDay(o, day, cfg.tz)).sort((a, b) => Number(!!b.allDay) - Number(!!a.allDay) || +a.start - +b.start);
  const span = (o: Occurrence) => [dateOf(o.start, cfg.tz) < day ? '00:00' : timeOf(o.start, cfg.tz), dateOf(o.end, cfg.tz) > day ? '23:59' : timeOf(o.end, cfg.tz)];
  const timed = events.filter((o) => !o.allDay);
  const clash = multi ? overlaps(events) : [];
  const marked = new Set(clash.flat());
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const count = events.length === 1 ? '1 event' : `${events.length} events`;
  const time = (o: Occurrence) => (o.allDay ? 'all day' : span(o).join('–')) + (marked.has(o) ? ' ⚠' : '');
  const task = (o: Occurrence) => `  ${ganttTitle(o.title)} :${marked.has(o) ? 'crit, ' : ''}${span(o).join(', ')}`;
  const sections = multi
    ? cfg.calendars.flatMap((c) => { const own = timed.filter((o) => o.calendar?.slug === c.slug); return own.length ? [`  section ${ganttTitle(c.name)}`, ...own.map(task)] : []; })
    : timed.map(task);
  const both = (a: Occurrence, b: Occurrence) => {
    const [from, until] = [new Date(Math.max(+a.start, +b.start)), new Date(Math.min(+a.end, +b.end))];
    const at = (d: Date, edge: string) => (dateOf(d, cfg.tz) === day ? timeOf(d, cfg.tz) : edge);
    return `- ${at(from, '00:00')}–${at(until, '23:59')}: ${cell(a.title)} (${cell(a.calendar!.name)}) and ${cell(b.title)} (${cell(b.calendar!.name)})`;
  };
  const body = events.length === 0 ? 'Nothing scheduled.' : [
    ...(multi
      ? ['| Time | Calendar | Event | Where |', '| --- | --- | --- | --- |', ...events.map((o) => `| ${time(o)} | ${cell(o.calendar?.name ?? '')} | ${cell(o.title)} | ${cell(o.location ?? '')} |`)]
      : ['| Time | Event | Where |', '| --- | --- | --- |', ...events.map((o) => `| ${time(o)} | ${cell(o.title)} | ${cell(o.location ?? '')} |`)]),
    ...(clash.length ? ['', '⚠ Overlapping across calendars:', '', ...clash.map(([a, b]) => both(a, b))] : []),
    ...(timed.length ? ['', '```mermaid', 'gantt', `  title ${label}`, '  dateFormat HH:mm', '  axisFormat %H:%M', ...sections, '```'] : []),
  ].join('\n');
  const overlapNote = clash.length === 0 ? '' : clash.length === 1 ? ', 1 overlap' : `, ${clash.length} overlaps`;
  return card({
    producer: 'cal', namespace: multi ? 'agenda' : cfg.calendars[0]!.slug, upstream: day, kind: 'artifact', urgency: 'brief', to_person: cfg.toPerson, thread: `day-${day}`,
    title: events.length === 0 ? `${label}: nothing scheduled` : `${label}: ${count}${timed[0] ? `, first at ${span(timed[0])[0]}` : ''}${overlapNote}`,
    // The first timed event, where it is cheap to say; an empty or all-day-only day has nothing the title does not say.
    summary: timed[0] && clip(`First: ${timed[0].title}, ${span(timed[0]).join('–')}${timed[0].location ? `, ${timed[0].location}` : ''}${multi && timed[0].calendar ? ` (${timed[0].calendar.name})` : ''}.`),
    body, emitted_at: now.toISOString(),
  });
}

/** An occurrence whose start changed to within the lead time; one id per move. */
export function movedCard(o: Occurrence, was: Date, cfg: Config, now: Date): ProducerCard {
  const day = dateOf(o.start, cfg.tz);
  const cal = several(cfg) ? o.calendar : undefined;
  const at = (d: Date) => (dateOf(d, cfg.tz) === day ? timeOf(d, cfg.tz) : local(d, cfg.tz).slice(0, 16));
  return card({
    producer: 'cal', namespace: (o.calendar ?? cfg.calendars[0]!).slug, upstream: `${hash(o.key)}-${o.start.toISOString().replace(/[-:]/g, '').slice(0, 13)}Z`, intent: 'moved',
    kind: 'signal', urgency: 'immediate', to_person: cfg.toPerson, thread: `day-${day}`,
    title: `Moved: ${o.title} now at ${timeOf(o.start, cfg.tz)}${cal ? ` (${cal.name})` : ''}`,
    summary: clip(`${o.title} now starts at ${timeOf(o.start, cfg.tz)}–${at(o.end)} (was ${at(was)})${o.location ? `, ${o.location}` : ''}${cal ? `, in ${cal.name}` : ''}.`),
    body: [`**${o.title}** now starts at ${timeOf(o.start, cfg.tz)}–${at(o.end)} (was ${at(was)}).`]
      .concat(cal ? ['', `Calendar: ${cal.name}`] : [], o.location ? ['', `Where: ${o.location}`] : []).join('\n'),
    emitted_at: now.toISOString(),
  });
}

/** One pass: today's agenda if not yet produced (and past `agendaAt`), plus a signal per occurrence moved into the lead window. */
export function plan(occ: Occurrence[], prev: State, cfg: Config, now: Date): { cards: ProducerCard[]; next: State } {
  const day = dateOf(now, cfg.tz);
  const due = prev.agenda !== day && timeOf(now, cfg.tz) >= (cfg.agendaAt ?? '00:00');
  const cards = due ? [agendaCard(occ, day, cfg, now)] : [];
  const seen: Record<string, string> = {};
  // With several calendars a UID may sit in more than one, so the state key carries the namespace (which has no `:`).
  const keyOf = (o: Occurrence) => (several(cfg) && o.calendar ? `${o.calendar.slug}:${o.key}` : o.key);
  for (const o of occ) {
    const k = keyOf(o);
    const [was, lead] = [prev.seen[k], +o.start - +now];
    seen[k] = o.start.toISOString();
    if (!o.allDay && was !== undefined && was !== seen[k] && lead > 0 && lead <= (cfg.leadMinutes ?? 30) * 60_000) cards.push(movedCard(o, new Date(was), cfg, now));
  }
  return { cards, next: { agenda: due ? day : prev.agenda, seen } };
}

/** `fetch` returns the iCalendar texts of one configured calendar for the window. */
export interface Source { fetch(cal: Calendar, from: Date, to: Date): Promise<string[]>; state: KeyValue<State>; now?: () => Date }

/** `produce`, `onSubmitted` and `onParked` for runProducer. State is saved only when the head answered every card of the pass
 *  (onSubmitted runs before produce resumes), so a failed submit is retried; a parked card counts as answered. */
export function calendarProducer(src: Source, cfg: Config): Pick<ProducerOptions, 'produce' | 'onSubmitted' | 'onParked'> {
  const [answered, parked] = [new Set<string>(), new Set<string>()];
  return {
    onSubmitted: (c) => void answered.add(c.id),
    onParked: (p, e) => { if (p.from === 'submit') parked.add(p.card.id); console.error(`pbcp: parked ${p.card.id}`, e); },
    async *produce() {
      const now = src.now?.() ?? new Date();
      const [from, to] = [new Date(+now - 86_400_000), new Date(+now + 2 * 86_400_000)];
      const occ = (await Promise.all(cfg.calendars.map(async (cal) => occurrences(await src.fetch(cal, from, to), from, to).map((o) => ({ ...o, calendar: cal }))))).flat();
      const { cards, next } = plan(occ, (await src.state.get('state')) ?? { seen: {} }, cfg, now);
      answered.clear();
      yield* cards;
      if (cards.every((c) => answered.has(c.id) || parked.has(c.id))) await src.state.set('state', next);
    },
  };
}
