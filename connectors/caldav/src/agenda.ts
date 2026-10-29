import { createHash } from 'node:crypto';
import { card, type KeyValue, type ProducerOptions } from '@pbcp/client';
import type { ProducerCard } from '@pbcp/core';
import ICAL from 'ical.js';

type Time = InstanceType<typeof ICAL.Time>; type Event = InstanceType<typeof ICAL.Event>;
/** A configured calendar: `name` is shown to the person, `slug` is its namespace (§5). */
export interface Calendar { name: string; slug: string }
/** One occurrence; `key` is UID/RECURRENCE-ID. An all-day one carries its local dates, end exclusive. */
export interface Occurrence { key: string; title: string; location?: string; url?: string; start: Date; end: Date; allDay?: { from: string; to: string }; calendar?: Calendar }
/** With one calendar the cards are exactly those of a single-calendar producer; with several, one agenda merges them.
 *  `chart` adds a gantt chart to the agenda; the event list is the content. */
export interface Config { calendars: Calendar[]; toPerson: string; tz: string; agendaAt?: string; chart?: boolean }
/** An occurrence as last seen: its start and end, title, all-day date, the id of the last move reported for it, and a
 *  fingerprint of its occurrence card as last submitted. */
export interface Seen { start: string; end?: string; title: string; all?: string; moved?: string; posted?: string }
/** `agenda`: the last day an agenda was produced; `until`: the end of the last pass's window; `seen`: every occurrence in that
 *  window, keyed per calendar when `several`. */
export interface State { agenda?: string; until?: string; several?: boolean; seen: Record<string, Seen> }

const DAY = 86_400_000;
/** How far ahead new, moved and cancelled events are reported, and so the fetch window: yesterday to a week ahead. */
export const windowOf = (now: Date) => ({ from: new Date(+now - DAY), to: new Date(+now + 7 * DAY) });

const local = (d: Date, tz: string) => d.toLocaleString('sv-SE', { timeZone: tz }); // "YYYY-MM-DD HH:MM:SS"
const dateOf = (d: Date, tz: string) => local(d, tz).slice(0, 10);
const timeOf = (d: Date, tz: string) => local(d, tz).slice(11, 16);
const dayName = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
/** §2: a timestamp in UTC, whole seconds (DTSTART and DTEND carry no fractions). */
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
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
const agendaNs = (cfg: Config) => (several(cfg) ? 'agenda' : cfg.calendars[0]!.slug);
const calendarOf = (o: Occurrence, cfg: Config) => o.calendar ?? cfg.calendars[0]!;
/** A timed occurrence's own card: `cal:<namespace>:<hash>`, the hash of UID/RECURRENCE-ID as for its signals. */
export const occurrenceId = (o: Occurrence, cfg: Config) => `cal:${calendarOf(o, cfg).slug}:${hash(o.key)}`;
/** §4.1 `labels`: a calendar's name as a label (its slug, cut to 32 characters), at most 8 per card. */
const labelsOf = (cals: Calendar[]) => ({ labels: [...new Set(cals.map((c) => c.slug.slice(0, 32).replace(/-+$/, '') || 'calendar'))].slice(0, 8) });

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
    // The event's own URL property (RFC 5545 §3.8.4.6), when it is a web link; the card's `source` (§4.1).
    const raw = ev.component.getFirstPropertyValue('url');
    const url = typeof raw === 'string' && /^https?:\/\//i.test(raw.trim()) ? raw.trim() : undefined;
    out.push({ key: `${ev.uid}/${rid?.toString() ?? ''}`, title: oneLine(ev.summary ?? ''), location, ...(url ? { url } : {}), start, end, allDay: s.isDate ? { from: s.toString(), to: e.toString() } : undefined });
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
  const label = dayName(day);
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
    ...(timed.length && cfg.chart ? ['', '```mermaid', 'gantt', `  title ${label}`, '  dateFormat HH:mm', '  axisFormat %H:%M', ...sections, '```'] : []),
  ].join('\n');
  const overlapNote = clash.length === 0 ? '' : clash.length === 1 ? ', 1 overlap' : `, ${clash.length} overlaps`;
  return card({
    producer: 'cal', namespace: agendaNs(cfg), upstream: day, kind: 'artifact', urgency: 'brief', to_person: cfg.toPerson, thread: `day-${day}`,
    about: day, ...labelsOf(cfg.calendars), // §4.1: the day the agenda is for, and every calendar it merges
    title: events.length === 0 ? `${label}: nothing scheduled` : `${label}: ${count}${timed[0] ? `, first at ${span(timed[0])[0]}` : ''}${overlapNote}`,
    // The first timed event, where it is cheap to say; an empty or all-day-only day has nothing the title does not say.
    summary: timed[0] && clip(`First: ${timed[0].title}, ${span(timed[0]).join('–')}${timed[0].location ? `, ${timed[0].location}` : ''}${multi && timed[0].calendar ? ` (${timed[0].calendar.name})` : ''}.`),
    // §8: the day's timed occurrences, each its own card with `at` and `until`.
    ...(timed.length ? { references: [...new Set(timed.map((o) => occurrenceId(o, cfg)))] } : {}),
    body, emitted_at: now.toISOString(),
  });
}

/** A timed occurrence as a `log` artifact (§4.1a): `about` its local start day, `at` and `until` its start and end, so a head can
 *  lay the day out by time beside other producers' cards (§8). Its time is in `at` and `until`, not in the title. */
export function occurrenceCard(o: Occurrence, cfg: Config, now: Date): ProducerCard {
  const cal = calendarOf(o, cfg);
  const day = dateOf(o.start, cfg.tz);
  const lines = [...(several(cfg) ? [`Calendar: ${cal.name}`] : []), ...(o.location ? [`Where: ${o.location}`] : [])];
  return card({
    producer: 'cal', namespace: cal.slug, upstream: hash(o.key), kind: 'artifact', urgency: 'log', to_person: cfg.toPerson, thread: `day-${day}`,
    about: day, at: iso(o.start), ...(+o.end >= +o.start ? { until: iso(o.end) } : {}), ...labelsOf([cal]),
    title: o.title, body: lines.length ? lines.join('\n\n') : `In ${cal.name}.`,
    ...(o.url ? { source: { url: o.url, label: 'Calendar event' } } : {}),
    emitted_at: now.toISOString(),
  });
}

/** §9: within two hours is immediate, today or tomorrow is for the brief, later is a log. */
function urgencyOf(at: Date, day: string, cfg: Config, now: Date): 'immediate' | 'brief' | 'log' {
  const tomorrow = new Date(Date.parse(`${dateOf(now, cfg.tz)}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
  return +at - +now <= 2 * 3_600_000 ? 'immediate' : day <= tomorrow ? 'brief' : 'log';
}

/** `soon` sets the urgency; `span` is the occurrence's start and end, for `at` and `until` (the new time on a move). */
interface Signal { intent: 'new' | 'moved' | 'cancelled'; upstream: string; cal: Calendar; event: string; title: string; text: string; day: string; soon: Date; span?: [Date, Date | undefined]; location?: string; url?: string; supersedes?: string; agenda?: string }

/** A signal about one event: its calendar's namespace and label, threaded and dated by its day, and pointing at that day's agenda when it exists. */
function eventCard(s: Signal, cfg: Config, now: Date): ProducerCard {
  const cal = several(cfg) ? s.cal : undefined;
  return card({
    producer: 'cal', namespace: s.cal.slug, upstream: s.upstream, intent: s.intent, kind: 'signal', urgency: urgencyOf(s.soon, s.day, cfg, now), to_person: cfg.toPerson,
    thread: `day-${s.day}`, about: s.day, ...labelsOf([s.cal]), // §4.1: the event's local day, and its calendar
    ...(s.span ? { at: iso(s.span[0]), ...(s.span[1] && +s.span[1] >= +s.span[0] ? { until: iso(s.span[1]) } : {}) } : {}),
    title: `${s.title}${cal ? ` (${cal.name})` : ''}`,
    summary: clip(`${s.event}${s.text}${s.location ? `, ${s.location}` : ''}${cal ? `, in ${cal.name}` : ''}.`),
    body: [`**${s.event}**${s.text}.`].concat(cal ? ['', `Calendar: ${cal.name}`] : [], s.location ? ['', `Where: ${s.location}`] : []).join('\n'),
    ...(s.url ? { source: { url: s.url, label: 'Calendar event' } } : {}),
    ...(s.agenda ? { references: [s.agenda] } : {}), ...(s.supersedes ? { supersedes: s.supersedes } : {}),
    emitted_at: now.toISOString(),
  });
}

/** One pass: a card for each timed occurrence in the window that is new or changed since it was last submitted, today's agenda
 *  if not yet produced (and past `agendaAt`), and a signal for each event in the window that is new, moved or gone since the
 *  last pass. New and cancelled are told once per series and pass, at its first occurrence. */
export function plan(occ: Occurrence[], prev: State, cfg: Config, now: Date): { cards: ProducerCard[]; next: State } {
  const today = dateOf(now, cfg.tz);
  const due = prev.agenda !== today && timeOf(now, cfg.tz) >= (cfg.agendaAt ?? '00:00');
  const timedCards: ProducerCard[] = [];
  const cards = due ? [agendaCard(occ, today, cfg, now)] : [];
  const agenda = due ? today : prev.agenda;
  const linked = (...days: string[]) => (agenda && days.includes(agenda) ? `cal:${agendaNs(cfg)}:${agenda}` : undefined);
  // `Fri 30 Oct 09:20`, or the time alone on `day`; an all-day event's day, `all day`.
  const on = (d: Date, day: string) => (dateOf(d, cfg.tz) === day ? '' : `${dayName(dateOf(d, cfg.tz))} `) + timeOf(d, cfg.tz);
  const when = (s: Seen) => (s.all ? `${s.all === today ? 'today' : dayName(s.all)}, all day` : `${dateOf(new Date(s.start), cfg.tz) === today ? 'today ' : ''}${on(new Date(s.start), today)}`);
  const dayOf = (s: Seen) => s.all ?? dateOf(new Date(s.start), cfg.tz);
  const ahead = (s: Seen) => (s.all ? s.all >= today : Date.parse(s.start) > +now);
  // With several calendars a UID may sit in more than one, so the state key carries the namespace (which has no `:`).
  const keyOf = (o: Occurrence) => (several(cfg) && o.calendar ? `${o.calendar.slug}:${o.key}` : o.key);
  const calOf = (k: string) => (several(cfg) ? cfg.calendars.find((c) => k.startsWith(`${c.slug}:`)) : undefined) ?? cfg.calendars[0]!;
  // Without last pass's window, or with its keys made for another number of calendars, nothing is new or gone.
  const until = prev.until && !!prev.several === several(cfg) ? Date.parse(prev.until) : undefined;
  const told = new Set<string>();
  const once = (what: string, k: string) => { const t = `${what} ${k.slice(0, k.lastIndexOf('/'))}`; return !told.has(t) && !!told.add(t); };
  // Earlier versions kept the start alone; such an entry has no title, but it is only read for moves.
  const before = Object.fromEntries(Object.entries(prev.seen).map(([k, v]) => [k, typeof v === 'string' ? { start: v, title: '' } : v]));
  const seen: Record<string, Seen> = {};
  for (const o of occ) {
    const k = keyOf(o);
    const [p, s] = [before[k], { start: o.start.toISOString(), end: o.end.toISOString(), title: o.title, ...(o.allDay ? { all: o.allDay.from } : {}) }];
    seen[k] = { ...s, ...(p?.moved ? { moved: p.moved } : {}), ...(p?.posted ? { posted: p.posted } : {}) };
    // The occurrence's own card, submitted when its content differs from the last one submitted: a moved time re-PUTs it (§5).
    if (!o.allDay) {
      const c = occurrenceCard(o, cfg, now);
      const posted = hash(JSON.stringify({ ...c, emitted_at: undefined }));
      if (p?.posted !== posted) timedCards.push(c);
      seen[k]!.posted = posted;
    }
    const at = { cal: calendarOf(o, cfg), event: o.title, location: o.location, url: o.url, upstream: hash(o.key), ...(o.allDay ? {} : { span: [o.start, o.end] as [Date, Date] }) };
    // New: absent last pass although inside its window; on the first pass, or one that has only come into the window, nothing is.
    if (!p && until && +o.start < until && ahead(s) && once('new', k)) {
      const end = o.allDay ? '' : `–${timeOf(o.end, cfg.tz)}`;
      cards.push(eventCard({ ...at, intent: 'new', title: `New: ${o.title}, ${when(s)}`, text: ` is on the calendar, ${when(s)}${end}`, day: dayOf(s), soon: o.start, agenda: linked(dayOf(s)) }, cfg, now));
    } else if (p && !o.allDay && p.start !== s.start && ahead(s)) {
      const [was, day] = [new Date(p.start), dayOf(s)];
      const soon = [o.start, was].filter((d) => +d > +now).sort((a, b) => +a - +b)[0]!;
      const moved = eventCard({
        ...at, intent: 'moved', upstream: `${at.upstream}-${s.start.replace(/[-:]/g, '').slice(0, 13)}Z`, title: `Moved: ${o.title} now at ${on(o.start, today)}`,
        text: ` now starts at ${on(o.start, today)}–${on(o.end, day)} (was ${on(was, day)})`, day, soon, agenda: linked(day, dateOf(was, cfg.tz)),
        supersedes: p.moved, // a later move replaces the earlier one's card (§8)
      }, cfg, now);
      cards.push(moved);
      seen[k]!.moved = moved.id;
    }
  }
  // Gone: seen last pass, still ahead, and no longer there (deleted, STATUS:CANCELLED, or moved out of the window).
  for (const [k, p] of Object.entries(before)) {
    if (k in seen || !until || !ahead(p) || !once('cancelled', k)) continue;
    const key = several(cfg) ? k.slice(k.indexOf(':') + 1) : k;
    cards.push(eventCard({ cal: calOf(k), event: p.title || '(untitled)', upstream: hash(key), intent: 'cancelled', title: `Cancelled: ${p.title || '(untitled)'}, ${when(p)}`,
      text: `, ${when(p)}, is no longer on the calendar`, day: dayOf(p), soon: new Date(p.start), agenda: linked(dayOf(p)),
      ...(p.all ? {} : { span: [new Date(p.start), p.end ? new Date(p.end) : undefined] as [Date, Date | undefined] }) }, cfg, now));
  }
  return { cards: [...timedCards, ...cards], next: { agenda, until: windowOf(now).to.toISOString(), ...(several(cfg) ? { several: true } : {}), seen } };
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
      const { from, to } = windowOf(now);
      const occ = (await Promise.all(cfg.calendars.map(async (cal) => occurrences(await src.fetch(cal, from, to), from, to).map((o) => ({ ...o, calendar: cal }))))).flat();
      const { cards, next } = plan(occ, (await src.state.get('state')) ?? { seen: {} }, cfg, now);
      answered.clear();
      yield* cards;
      if (cards.every((c) => answered.has(c.id) || parked.has(c.id))) await src.state.set('state', next);
    },
  };
}
