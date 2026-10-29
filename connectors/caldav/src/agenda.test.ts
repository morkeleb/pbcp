import { createHash } from 'node:crypto';
import { HeadClient, memoryStore, producerPass, type Parked } from '@pbcp/client';
import { stubHead } from '@pbcp/client/testing';
import { isId, type ProducerCard } from '@pbcp/core';
import { describe, expect, it, vi } from 'vitest';
import { agendaCard, calendarProducer, ganttTitle, occurrenceCard, occurrenceId, occurrences, overlaps, parseCalendars, plan, slug, type Calendar, type Occurrence, type State } from './agenda.js';

const tz = 'Europe/Copenhagen';
const cfg = { calendars: [{ name: 'Work', slug: 'work' }], toPerson: 'morten', tz };
/** planned() without the per-occurrence cards (kind artifact with `at`), which have their own tests below. */
const planned = (...args: Parameters<typeof plan>) => {
  const r = plan(...args);
  return { ...r, cards: r.cards.filter((c) => !(c.kind === 'artifact' && 'at' in c)) };
};
const VTIMEZONE = `BEGIN:VTIMEZONE
TZID:Europe/Copenhagen
BEGIN:STANDARD
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
END:DAYLIGHT
END:VTIMEZONE`;
const vcal = (...parts: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', VTIMEZONE, ...parts, 'END:VCALENDAR'].join('\r\n');
const vevent = (lines: Record<string, string>) => ['BEGIN:VEVENT', ...Object.entries(lines).map(([k, v]) => `${k}:${v}`), 'END:VEVENT'].join('\r\n');

const standup = vevent({ UID: 'standup@example.com', 'DTSTART;TZID=Europe/Copenhagen': '20261001T091500', 'DTEND;TZID=Europe/Copenhagen': '20261001T093000', RRULE: 'FREQ=DAILY', SUMMARY: 'Standup' });
const standupMoved = (hhmm: string) =>
  vevent({ UID: 'standup@example.com', 'RECURRENCE-ID;TZID=Europe/Copenhagen': '20261026T091500', 'DTSTART;TZID=Europe/Copenhagen': `20261026T${hhmm}00`, 'DTEND;TZID=Europe/Copenhagen': '20261026T100000', SUMMARY: 'Standup' });
const others = [
  vcal(vevent({ UID: 'holiday', 'DTSTART;VALUE=DATE': '20261026', 'DTEND;VALUE=DATE': '20261027', SUMMARY: 'Office closed' })),
  vcal(vevent({ UID: 'review', DTSTART: '20261026T130000Z', DTEND: '20261026T140000Z', SUMMARY: 'Q4: review #2; budget | plan', LOCATION: 'Room 3\\, 2nd floor' })),
  vcal(vevent({ UID: 'late', DTSTART: '20261026T223000Z', DTEND: '20261026T233000Z', SUMMARY: 'Deploy' })),
  vcal(vevent({ UID: 'gone', DTSTART: '20261026T100000Z', DTEND: '20261026T110000Z', SUMMARY: 'Cancelled', STATUS: 'CANCELLED' })),
  vcal(vevent({ UID: 'tomorrow', DTSTART: '20261027T080000Z', DTEND: '20261027T090000Z', SUMMARY: 'Not today' })),
];
const from = new Date('2026-10-25T07:00:00Z');
const to = new Date('2026-10-28T07:00:00Z');
const now = new Date('2026-10-26T05:30:00Z'); // 06:30 in Copenhagen

describe('occurrences', () => {
  it('expands a recurring event, applies its exception and keeps all-day dates', () => {
    const occ = occurrences([vcal(standup, standupMoved('0920')), ...others], from, to);
    const standups = occ.filter((o) => o.title === 'Standup').map((o) => [o.key, o.start.toISOString()]);
    expect(standups).toEqual([
      ['standup@example.com/2026-10-25T09:15:00', '2026-10-25T08:15:00.000Z'],
      ['standup@example.com/2026-10-26T09:15:00', '2026-10-26T08:20:00.000Z'],
      ['standup@example.com/2026-10-27T09:15:00', '2026-10-27T08:15:00.000Z'],
    ]);
    const holiday = occ.find((o) => o.key === 'holiday/');
    expect(holiday?.allDay).toEqual({ from: '2026-10-26', to: '2026-10-27' });
    expect(occ.find((o) => o.key === 'review/')).toMatchObject({ location: 'Room 3, 2nd floor' });
  });
});

describe('agendaCard', () => {
  it('renders the day as a table, and a gantt fence with CALDAV_CHART', () => {
    const occ = occurrences([vcal(standup), ...others], from, to);
    expect(agendaCard(occ, '2026-10-26', cfg, now).body).not.toContain('mermaid');
    const c = agendaCard(occ, '2026-10-26', { ...cfg, chart: true }, now);
    expect(isId(c.id)).toBe(true);
    expect(c).toMatchObject({ id: 'cal:work:2026-10-26', kind: 'artifact', urgency: 'brief', thread: 'day-2026-10-26', title: 'Mon 26 Oct: 4 events, first at 09:15' });
    expect(c.summary).toBe('First: Standup, 09:15–09:30.');
    expect(c).toMatchObject({ about: '2026-10-26', labels: ['work'] });
    expect('actions' in c).toBe(false);
    expect(c.body).toBe(
      [
        '| Time | Event | Where |',
        '| --- | --- | --- |',
        '| all day | Office closed |  |',
        '| 09:15–09:30 | Standup |  |',
        '| 14:00–15:00 | Q4: review #2; budget \\| plan | Room 3, 2nd floor |',
        '| 23:30–23:59 | Deploy |  |',
        '',
        '```mermaid',
        'gantt',
        '  title Mon 26 Oct',
        '  dateFormat HH:mm',
        '  axisFormat %H:%M',
        '  Standup :09:15, 09:30',
        '  Q4 review 2 budget | plan :14:00, 15:00',
        '  Deploy :23:30, 23:59',
        '```',
      ].join('\n'),
    );
  });

  it('says so on an empty day, and leaves out the gantt for all-day only', () => {
    expect(agendaCard([], '2026-10-26', cfg, now)).toMatchObject({ title: 'Mon 26 Oct: nothing scheduled', body: 'Nothing scheduled.' });
    const allDay = agendaCard(occurrences([others[0]!], from, to), '2026-10-26', { ...cfg, chart: true }, now);
    expect(allDay.title).toBe('Mon 26 Oct: 1 event');
    expect(allDay.body).not.toContain('mermaid');
    expect('summary' in allDay).toBe(false);
    expect('summary' in agendaCard([], '2026-10-26', cfg, now)).toBe(false);
  });
});

describe('ganttTitle and slug', () => {
  it('strips gantt syntax and guards keywords', () => {
    expect(ganttTitle('a:b#c;d%%e')).toBe('a b c d e');
    expect(ganttTitle('section planning')).toBe('· section planning');
    expect(ganttTitle('  ')).toBe('(untitled)');
    expect(ganttTitle('x'.repeat(60))).toHaveLength(40);
    expect(slug('Work Calendar (shared)')).toBe('work-calendar-shared');
    expect(slug('—')).toBe('calendar');
  });
});

describe('plan', () => {
  const at = (iso: string): Occurrence => ({ key: 'standup@example.com/2026-10-26T09:15:00', title: 'Standup', start: new Date(iso), end: new Date(+new Date(iso) + 15 * 60_000) });
  const prev: State = { agenda: '2026-10-26', seen: { 'standup@example.com/2026-10-26T09:15:00': { start: '2026-10-26T08:15:00.000Z', title: 'Standup' } } };
  const nine = new Date('2026-10-26T08:00:00Z');

  it('signals a move, once per new start', () => {
    const { cards, next } = planned([at('2026-10-26T08:20:00Z')], prev, cfg, nine);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'signal', urgency: 'immediate', thread: 'day-2026-10-26', title: 'Moved: Standup now at 09:20', about: '2026-10-26', labels: ['work'] });
    expect(cards[0]!.id).toMatch(/^cal:work:[0-9a-f]{16}-20261026T0820Z:moved$/);
    expect(isId(cards[0]!.id)).toBe(true);
    expect(cards[0]!.body).toBe('**Standup** now starts at 09:20–09:35 (was 09:15).');
    expect(cards[0]!.summary).toBe('Standup now starts at 09:20–09:35 (was 09:15).');
    expect(next.seen).toEqual({ 'standup@example.com/2026-10-26T09:15:00': { start: '2026-10-26T08:20:00.000Z', end: '2026-10-26T08:35:00.000Z', title: 'Standup', moved: cards[0]!.id, posted: expect.stringMatching(/^[0-9a-f]{16}$/) } });
    expect(planned([at('2026-10-26T08:20:00Z')], next, cfg, nine).cards).toEqual([]);
    expect(planned([at('2026-10-26T08:25:00Z')], next, cfg, nine).cards[0]!.id).not.toBe(cards[0]!.id);
  });

  it('names the day, readably, of a previous start or an end on another day', () => {
    const late = { ...at('2026-10-26T08:20:00Z'), end: new Date('2026-10-26T23:30:00Z') };
    const moved = planned([late], { ...prev, seen: { [late.key]: { start: '2026-10-25T08:15:00.000Z', title: 'Standup' } } }, cfg, nine).cards[0]!;
    expect(moved.body).toBe('**Standup** now starts at 09:20–Tue 27 Oct 00:30 (was Sun 25 Oct 09:15).');
  });

  it('links the moved card to the event when it has a web URL, and not otherwise', () => {
    const moved = (o: Occurrence) => planned([o], prev, cfg, nine).cards[0]!;
    expect(moved({ ...at('2026-10-26T08:20:00Z'), url: 'https://cal.example.com/event/standup' }).source).toEqual({ url: 'https://cal.example.com/event/standup', label: 'Calendar event' });
    expect('source' in moved(at('2026-10-26T08:20:00Z'))).toBe(false);
    const parsed = (url: string) => occurrences([vcal(vevent({ UID: 'u', DTSTART: '20261026T080000Z', DTEND: '20261026T090000Z', SUMMARY: 'S', URL: url }))], from, to)[0]!.url;
    expect(parsed('https://cal.example.com/e/1')).toBe('https://cal.example.com/e/1');
    expect(parsed('mailto:x@y')).toBeUndefined();
  });

  it('ignores a first sighting and a move to a past start', () => {
    expect(planned([at('2026-10-26T08:20:00Z')], { ...prev, seen: {} }, cfg, nine).cards).toEqual([]);
    expect(planned([at('2026-10-26T07:50:00Z')], prev, cfg, nine).cards).toEqual([]);
  });

  it('reads a start kept alone by an earlier version', () => {
    const old = { agenda: '2026-10-26', seen: { [at('2026-10-26T08:15:00Z').key]: '2026-10-26T08:15:00.000Z' } } as unknown as State;
    expect(planned([at('2026-10-26T08:20:00Z')], old, cfg, nine).cards.map((c) => c.title)).toEqual(['Moved: Standup now at 09:20']);
  });

  it('reports a move in the next 7 days, with an urgency by how soon it is', () => {
    const thursday = { ...prev, seen: { [at('x').key]: { start: '2026-10-29T08:15:00.000Z', title: 'Standup' } } };
    const moved = (iso: string) => planned([at(iso)], thursday, cfg, nine).cards[0]!;
    expect(moved('2026-10-26T10:00:00Z')).toMatchObject({ urgency: 'immediate', title: 'Moved: Standup now at 11:00' });
    expect(moved('2026-10-26T12:00:00Z')).toMatchObject({ urgency: 'brief', title: 'Moved: Standup now at 13:00' });
    expect(moved('2026-10-27T12:00:00Z')).toMatchObject({ urgency: 'brief', title: 'Moved: Standup now at Tue 27 Oct 13:00', about: '2026-10-27', thread: 'day-2026-10-27' });
    const friday = moved('2026-10-30T12:00:00Z');
    expect(friday).toMatchObject({ urgency: 'log', title: 'Moved: Standup now at Fri 30 Oct 13:00', about: '2026-10-30' });
    expect(friday.summary).toBe('Standup now starts at Fri 30 Oct 13:00–13:15 (was Thu 29 Oct 09:15).');
    // The old start is the sooner one: a meeting moved away from the next hour is still news now.
    const away = planned([at('2026-10-30T12:00:00Z')], { ...prev, seen: { [at('x').key]: { start: '2026-10-26T08:30:00.000Z', title: 'Standup' } } }, cfg, nine);
    expect(away.cards[0]!.urgency).toBe('immediate');
  });

  it('supersedes the card of the earlier move, and references the agenda of the day it left or joined', () => {
    const first = planned([at('2026-10-26T10:00:00Z')], prev, cfg, nine);
    expect(first.cards[0]!.references).toEqual(['cal:work:2026-10-26']);
    expect('supersedes' in first.cards[0]!).toBe(false);
    const second = planned([at('2026-10-27T10:00:00Z')], first.next, cfg, nine);
    expect(second.cards[0]).toMatchObject({ supersedes: first.cards[0]!.id, references: ['cal:work:2026-10-26'] });
    expect(second.next.seen[at('x').key]!.moved).toBe(second.cards[0]!.id);
    const third = planned([at('2026-10-28T10:00:00Z')], second.next, cfg, nine);
    expect(third.cards[0]!.supersedes).toBe(second.cards[0]!.id);
    expect('references' in third.cards[0]!).toBe(false); // no agenda for Tue or Wed yet
  });

  it('produces the agenda once a day, from agendaAt', () => {
    expect(planned([], { seen: {} }, { ...cfg, agendaAt: '06:00' }, new Date('2026-10-26T04:30:00Z')).cards).toEqual([]);
    const { cards, next } = planned([], { seen: {} }, { ...cfg, agendaAt: '06:00' }, now);
    expect(cards.map((c) => c.id)).toEqual(['cal:work:2026-10-26']);
    expect(planned([], next, cfg, now).cards).toEqual([]);
  });
});

describe('new and cancelled', () => {
  const nine = new Date('2026-10-26T08:00:00Z');
  const event = (key: string, iso: string, title = 'Dentist'): Occurrence => ({ key, title, location: 'Clinic', start: new Date(iso), end: new Date(+new Date(iso) + 45 * 60_000) });
  const was = { agenda: '2026-10-26', until: '2026-11-02T07:55:00.000Z', seen: {} } satisfies State;
  const id = (key: string, intent: string) => `cal:work:${createHash('sha256').update(key).digest('hex').slice(0, 16)}:${intent}`;

  it('signals an event that appears inside last pass\'s window, once', () => {
    const { cards, next } = planned([event('dentist/', '2026-10-26T13:00:00Z')], was, cfg, nine);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: id('dentist/', 'new'), kind: 'signal', urgency: 'brief', title: 'New: Dentist, today 14:00', about: '2026-10-26', thread: 'day-2026-10-26',
      labels: ['work'], references: ['cal:work:2026-10-26'], summary: 'Dentist is on the calendar, today 14:00–14:45, Clinic.',
    });
    expect(isId(cards[0]!.id)).toBe(true);
    expect(cards[0]!.body).toBe('**Dentist** is on the calendar, today 14:00–14:45.\n\nWhere: Clinic');
    expect(planned([event('dentist/', '2026-10-26T13:00:00Z')], next, cfg, nine).cards).toEqual([]);
    expect(planned([event('dentist/', '2026-10-30T13:00:00Z')], was, cfg, nine).cards[0]).toMatchObject({ urgency: 'log', title: 'New: Dentist, Fri 30 Oct 14:00' });
    expect('references' in planned([event('dentist/', '2026-10-30T13:00:00Z')], was, cfg, nine).cards[0]!).toBe(false);
  });

  it('does not call new what only came into the window, what has passed, or anything on the first pass', () => {
    expect(planned([event('dentist/', '2026-11-02T09:00:00Z')], was, cfg, nine).cards).toEqual([]);
    expect(planned([event('dentist/', '2026-10-26T07:00:00Z')], was, cfg, nine).cards).toEqual([]);
    expect(planned([event('dentist/', '2026-10-26T13:00:00Z')], { agenda: '2026-10-26', seen: {} }, cfg, nine).cards).toEqual([]);
  });

  it('tells a new series once, at its first occurrence', () => {
    const series = ['26', '27', '28'].map((d) => event(`gym/2026-10-${d}T18:00:00`, `2026-10-${d}T17:00:00Z`, 'Gym'));
    expect(planned(series, was, cfg, nine).cards.map((c) => c.title)).toEqual(['New: Gym, today 18:00']);
  });

  it('signals an event that is gone before it began, and not one that has passed', () => {
    const seen = { 'dentist/': { start: '2026-10-27T13:00:00.000Z', title: 'Dentist' }, 'past/': { start: '2026-10-26T07:00:00.000Z', title: 'Past' }, 'trip/': { start: '2026-10-25T23:00:00.000Z', title: 'Trip', all: '2026-10-26' } };
    const { cards, next } = planned([], { ...was, seen }, cfg, nine);
    expect(cards.map((c) => [c.id, c.urgency, c.title])).toEqual([
      [id('dentist/', 'cancelled'), 'brief', 'Cancelled: Dentist, Tue 27 Oct 14:00'],
      [id('trip/', 'cancelled'), 'immediate', 'Cancelled: Trip, today, all day'],
    ]);
    expect(cards[0]).toMatchObject({ about: '2026-10-27', thread: 'day-2026-10-27', summary: 'Dentist, Tue 27 Oct 14:00, is no longer on the calendar.' });
    expect(cards[1]!.references).toEqual(['cal:work:2026-10-26']);
    expect(next.seen).toEqual({});
    expect(planned([], { agenda: '2026-10-26', seen }, cfg, nine).cards).toEqual([]);
  });

  it('keeps each calendar\'s namespace with several calendars', () => {
    const two = { calendars: [{ name: 'Work', slug: 'work' }, { name: 'Home', slug: 'home' }], toPerson: 'morten', tz };
    const seen = { 'home:dentist/': { start: '2026-10-27T13:00:00.000Z', title: 'Dentist' } };
    expect(planned([], { ...was, seen }, two, nine).cards).toEqual([]); // a store made for one calendar
    const gone = planned([], { ...was, several: true, seen }, two, nine).cards[0]!;
    expect(gone).toMatchObject({ id: id('dentist/', 'cancelled').replace('cal:work:', 'cal:home:'), title: 'Cancelled: Dentist, Tue 27 Oct 14:00 (Home)', labels: ['home'] });
    const added = planned([{ ...event('dentist/', '2026-10-26T13:00:00Z'), calendar: two.calendars[1]! }], { ...was, several: true }, two, nine).cards[0]!;
    expect(added).toMatchObject({ id: id('dentist/', 'new').replace('cal:work:', 'cal:home:'), references: ['cal:agenda:2026-10-26'], summary: 'Dentist is on the calendar, today 14:00–14:45, Clinic, in Home.' });
  });
});

describe('occurrence cards (§4.1 at and until, §8)', () => {
  const nine = new Date('2026-10-26T08:00:00Z');
  const ev = (key: string, iso: string, mins = 45, extra: Partial<Occurrence> = {}): Occurrence => ({ key, title: 'Dentist', location: 'Clinic', start: new Date(iso), end: new Date(+new Date(iso) + mins * 60_000), ...extra });
  const hashOf = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);
  const own = (r: { cards: ProducerCard[] }) => r.cards.filter((c) => c.kind === 'artifact' && 'at' in c);

  it('is a log artifact on its local day, with at and until in UTC and the time nowhere else', () => {
    const c = occurrenceCard(ev('dentist/', '2026-10-26T22:30:00Z', 45, { url: 'https://cal.example.com/e/1' }), cfg, nine);
    expect(c).toMatchObject({
      id: `cal:work:${hashOf('dentist/')}`, kind: 'artifact', urgency: 'log', about: '2026-10-26', thread: 'day-2026-10-26', labels: ['work'],
      at: '2026-10-26T22:30:00Z', until: '2026-10-26T23:15:00Z', title: 'Dentist', body: 'Where: Clinic', source: { url: 'https://cal.example.com/e/1', label: 'Calendar event' },
    });
    expect(isId(c.id)).toBe(true);
    expect(`${c.title} ${c.summary ?? ''} ${c.body}`).not.toMatch(/\d{2}:\d{2}/);
    // Midnight in Copenhagen is still the 27th's in UTC terms only after 23:00Z: about is the local day.
    expect(occurrenceCard(ev('late/', '2026-10-26T23:30:00Z'), cfg, nine)).toMatchObject({ about: '2026-10-27', thread: 'day-2026-10-27' });
  });

  it('is submitted once, again when its time changes, and never for an all-day event', () => {
    const allDay: Occurrence = { key: 'holiday/', title: 'Office closed', start: new Date('2026-10-25T23:00:00Z'), end: new Date('2026-10-26T23:00:00Z'), allDay: { from: '2026-10-26', to: '2026-10-27' } };
    const first = plan([ev('dentist/', '2026-10-26T13:00:00Z'), allDay], { agenda: '2026-10-26', seen: {} }, cfg, nine);
    expect(own(first).map((c) => c.id)).toEqual([`cal:work:${hashOf('dentist/')}`]);
    expect(own(plan([ev('dentist/', '2026-10-26T13:00:00Z'), allDay], first.next, cfg, nine))).toEqual([]);
    const later = own(plan([ev('dentist/', '2026-10-26T14:00:00Z'), allDay], first.next, cfg, nine));
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ id: `cal:work:${hashOf('dentist/')}`, at: '2026-10-26T14:00:00Z', until: '2026-10-26T14:45:00Z' });
    expect(own(plan([ev('dentist/', '2026-10-26T13:00:00Z', 60), allDay], first.next, cfg, nine))[0]).toMatchObject({ until: '2026-10-26T14:00:00Z' });
  });

  it('comes before the agenda, which references the day\'s timed occurrences, each in its own calendar\'s namespace', () => {
    const one = plan([ev('dentist/', '2026-10-26T13:00:00Z'), ev('gym/', '2026-10-27T16:00:00Z')], { seen: {} }, cfg, now);
    expect(one.cards.map((c) => c.id)).toEqual([`cal:work:${hashOf('dentist/')}`, `cal:work:${hashOf('gym/')}`, 'cal:work:2026-10-26']);
    expect(one.cards[2]!.references).toEqual([`cal:work:${hashOf('dentist/')}`]);
    expect('references' in agendaCard([], '2026-10-26', cfg, now)).toBe(false);
    const two = { calendars: [{ name: 'Work', slug: 'work' }, { name: 'Home', slug: 'home' }], toPerson: 'morten', tz };
    const home = { ...ev('dentist/', '2026-10-26T13:00:00Z'), calendar: two.calendars[1]! };
    expect(occurrenceId(home, two)).toBe(`cal:home:${hashOf('dentist/')}`);
    expect(agendaCard([home], '2026-10-26', two, now).references).toEqual([`cal:home:${hashOf('dentist/')}`]);
    expect(occurrenceCard(home, two, now).body).toBe('Calendar: Home\n\nWhere: Clinic');
  });

  it('gives new, moved and cancelled signals the occurrence\'s at and until, the new time on a move', () => {
    const was: State = { agenda: '2026-10-26', until: '2026-11-02T07:55:00.000Z', seen: {} };
    const added = planned([ev('dentist/', '2026-10-26T13:00:00Z')], was, cfg, nine).cards[0]!;
    expect(added).toMatchObject({ kind: 'signal', at: '2026-10-26T13:00:00Z', until: '2026-10-26T13:45:00Z' });
    const seen = { 'dentist/': { start: '2026-10-26T13:00:00.000Z', end: '2026-10-26T13:45:00.000Z', title: 'Dentist' } };
    const moved = planned([ev('dentist/', '2026-10-27T13:00:00Z')], { ...was, seen }, cfg, nine).cards[0]!;
    expect(moved).toMatchObject({ id: expect.stringMatching(/:moved$/), at: '2026-10-27T13:00:00Z', until: '2026-10-27T13:45:00Z' });
    const gone = planned([], { ...was, seen }, cfg, nine).cards[0]!;
    expect(gone).toMatchObject({ id: expect.stringMatching(/:cancelled$/), at: '2026-10-26T13:00:00Z', until: '2026-10-26T13:45:00Z' });
    // A state from before 0.8 kept no end: the cancelled signal has at alone.
    const old = planned([], { ...was, seen: { 'dentist/': { start: '2026-10-26T13:00:00.000Z', title: 'Dentist' } } }, cfg, nine).cards[0]!;
    expect(old.at).toBe('2026-10-26T13:00:00Z');
    expect('until' in old).toBe(false);
    const allDay = planned([], { ...was, seen: { 'trip/': { start: '2026-10-25T23:00:00.000Z', title: 'Trip', all: '2026-10-26' } } }, cfg, nine).cards[0]!;
    expect('at' in allDay).toBe(false);
  });
});

describe('end to end against the stub head', () => {
  const setup = () => {
    const stub = stubHead();
    const head = new HeadClient({ baseUrl: 'https://head.test', token: 't', fetch: stub.fetch });
    const store = memoryStore();
    return { stub, head, store, state: store.kv<State>('calendar') };
  };

  it('stores the agenda, signals a move, and a repeat pass is a no-op', async () => {
    const { stub, head, store, state } = setup();
    let ics = [vcal(standup), ...others];
    let clock = now;
    const cal = calendarProducer({ fetch: async () => ics, state, now: () => clock }, cfg);
    const opts = { ...cal, head, store, onDecision: async () => {}, onError: (e: unknown) => { throw e; } };
    const puts = () => stub.requests.filter((r) => r.method === 'PUT').length;

    await producerPass(opts);
    const agenda = stub.cards.get('cal:work:2026-10-26')!;
    expect(agenda).toMatchObject({ kind: 'artifact', state: 'open' });
    const timed = [...stub.cards.values()].filter((c) => 'at' in c);
    // The window's timed occurrences, each once: standups (25th–1 Nov), the review, the deploy and tomorrow's meeting.
    expect(timed.length).toBeGreaterThan(4);
    expect(timed.every((c) => c.kind === 'artifact' && c.urgency === 'log')).toBe(true);
    expect(agenda.references).toEqual(expect.arrayContaining([expect.stringMatching(/^cal:work:[0-9a-f]{16}$/)]));
    expect(agenda.references!.every((id) => stub.cards.has(id))).toBe(true);
    const first = puts();
    expect(first).toBe(1 + timed.length);

    ics = [vcal(standup, standupMoved('0920')), ...others];
    clock = new Date('2026-10-26T08:00:00Z');
    await producerPass(opts);
    expect(puts()).toBe(first + 2); // the moved signal, and the standup's own card with its new time (§5: replaced while open)
    const signal = [...stub.cards.values()].find((c) => c.kind === 'signal');
    expect(signal).toMatchObject({ urgency: 'immediate', title: 'Moved: Standup now at 09:20', at: '2026-10-26T08:20:00Z', until: '2026-10-26T09:00:00Z' });
    const moved = [...stub.cards.values()].find((c) => c.kind === 'artifact' && c.at === '2026-10-26T08:20:00Z');
    expect(moved).toMatchObject({ title: 'Standup', until: '2026-10-26T09:00:00Z', state: 'open' });

    await producerPass(opts);
    expect(puts()).toBe(first + 2);
  });

  it('keeps state when a submit fails, so the next pass retries', async () => {
    const { stub, head, store, state } = setup();
    const cal = calendarProducer({ fetch: async () => [], state, now: () => now }, cfg);
    const opts = { ...cal, head, store, onDecision: async () => {}, onError: () => {} };
    stub.script(500, { error: 'boom' });
    await producerPass(opts);
    expect(await state.keys()).toEqual([]);
    await producerPass(opts);
    expect(stub.cards.get('cal:work:2026-10-26')?.title).toBe('Mon 26 Oct: nothing scheduled');
    expect((await state.get('state'))?.agenda).toBe('2026-10-26');
  });

  it('saves state once a card the head keeps refusing is parked', async () => {
    const { stub, head, store, state } = setup();
    const cal = calendarProducer({ fetch: async () => [], state, now: () => now }, { ...cfg, toPerson: 'someone-else' });
    const parked: Parked[] = [];
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onParked = async (p: Parked, e: unknown) => {
      parked.push(p);
      await cal.onParked!(p, e);
    };
    const opts = { ...cal, head, store, onDecision: async () => {}, onError: () => {}, maxAttempts: 2, onParked };
    const attempts = new Map<string, number>();
    await producerPass(opts, undefined, attempts);
    expect(await state.get('state')).toBeUndefined();
    await producerPass(opts, undefined, attempts);
    expect(parked.map((p) => p.card.id)).toEqual(['cal:work:2026-10-26']);
    expect(stub.cards.size).toBe(0);
    expect((await state.get('state'))?.agenda).toBe('2026-10-26');
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});

describe('several calendars', () => {
  const work: Calendar = { name: 'Work', slug: 'work' };
  const home: Calendar = { name: 'Home | family', slug: 'home-family' };
  const two = { calendars: [work, home], toPerson: 'morten', tz };
  const ics: Record<string, string[]> = {
    work: [vcal(standup), vcal(vevent({ UID: 'budget', DTSTART: '20261026T130000Z', DTEND: '20261026T140000Z', SUMMARY: 'Budget review' }))],
    'home-family': [
      vcal(vevent({ UID: 'dentist', DTSTART: '20261026T080000Z', DTEND: '20261026T084500Z', SUMMARY: 'Dentist', LOCATION: 'Clinic' })),
      vcal(vevent({ UID: 'school', 'DTSTART;VALUE=DATE': '20261026', 'DTEND;VALUE=DATE': '20261027', SUMMARY: 'School holiday' })),
      vcal(vevent({ UID: 'plumber', DTSTART: '20261026T133000Z', DTEND: '20261026T134500Z', SUMMARY: 'Call with plumber' })),
      vcal(vevent({ UID: 'gym', DTSTART: '20261026T160000Z', DTEND: '20261026T170000Z', SUMMARY: 'Gym' })),
    ],
  };
  const tagged = (texts: Record<string, string[]>) =>
    two.calendars.flatMap((c) => occurrences(texts[c.slug] ?? [], from, to).map((o) => ({ ...o, calendar: c })));

  it('merges the day into one agenda with a calendar column, a gantt section per calendar, and overlaps marked', () => {
    const c = agendaCard(tagged(ics), '2026-10-26', { ...two, chart: true }, now);
    expect(isId(c.id)).toBe(true);
    expect(c).toMatchObject({ id: 'cal:agenda:2026-10-26', kind: 'artifact', urgency: 'brief', thread: 'day-2026-10-26', title: 'Mon 26 Oct: 6 events, first at 09:00, 2 overlaps' });
    expect(c.summary).toBe('First: Dentist, 09:00–09:45, Clinic (Home | family).');
    expect(c).toMatchObject({ about: '2026-10-26', labels: ['work', 'home-family'] });
    expect(c.body).toBe(
      [
        '| Time | Calendar | Event | Where |',
        '| --- | --- | --- | --- |',
        '| all day | Home \\| family | School holiday |  |',
        '| 09:00–09:45 ⚠ | Home \\| family | Dentist | Clinic |',
        '| 09:15–09:30 ⚠ | Work | Standup |  |',
        '| 14:00–15:00 ⚠ | Work | Budget review |  |',
        '| 14:30–14:45 ⚠ | Home \\| family | Call with plumber |  |',
        '| 17:00–18:00 | Home \\| family | Gym |  |',
        '',
        '⚠ Overlapping across calendars:',
        '',
        '- 09:15–09:30: Dentist (Home \\| family) and Standup (Work)',
        '- 14:30–14:45: Budget review (Work) and Call with plumber (Home \\| family)',
        '',
        '```mermaid',
        'gantt',
        '  title Mon 26 Oct',
        '  dateFormat HH:mm',
        '  axisFormat %H:%M',
        '  section Work',
        '  Standup :crit, 09:15, 09:30',
        '  Budget review :crit, 14:00, 15:00',
        '  section Home | family',
        '  Dentist :crit, 09:00, 09:45',
        '  · Call with plumber :crit, 14:30, 14:45',
        '  Gym :17:00, 18:00',
        '```',
      ].join('\n'),
    );
  });

  it('does not count events in one calendar, all-day events, touching ends, or one occurrence in two calendars as overlaps', () => {
    const occ = tagged({
      work: [vcal(vevent({ UID: 'a', DTSTART: '20261026T080000Z', DTEND: '20261026T090000Z', SUMMARY: 'A' })), vcal(vevent({ UID: 'b', DTSTART: '20261026T083000Z', DTEND: '20261026T093000Z', SUMMARY: 'B' }))],
      'home-family': [
        vcal(vevent({ UID: 'c', DTSTART: '20261026T093000Z', DTEND: '20261026T100000Z', SUMMARY: 'C' })),
        vcal(vevent({ UID: 'day', 'DTSTART;VALUE=DATE': '20261026', 'DTEND;VALUE=DATE': '20261027', SUMMARY: 'Day' })),
      ],
    });
    expect(overlaps(occ)).toEqual([]);
    const c = agendaCard(occ, '2026-10-26', two, now);
    expect(c.title).toBe('Mon 26 Oct: 4 events, first at 09:00');
    expect(c.body).not.toContain('⚠');
    expect(c.body).not.toContain('crit');
    const a = vcal(vevent({ UID: 'a', DTSTART: '20261026T080000Z', DTEND: '20261026T090000Z', SUMMARY: 'A' }));
    expect(overlaps(tagged({ work: [a], 'home-family': [a] }))).toEqual([]);
  });

  it('leaves out the section of a calendar with nothing timed that day', () => {
    const c = agendaCard(tagged({ work: ics.work! }), '2026-10-26', { ...two, chart: true }, now);
    expect(c.body).toContain('  section Work');
    expect(c.body).not.toContain('section Home');
    expect(agendaCard([], '2026-10-26', two, now)).toMatchObject({ id: 'cal:agenda:2026-10-26', title: 'Mon 26 Oct: nothing scheduled', body: 'Nothing scheduled.' });
  });

  it('signals a move in its own calendar namespace, with the calendar name, keyed per calendar', () => {
    const shared = (hhmm: string) => vcal(vevent({ UID: 'sync', 'DTSTART;TZID=Europe/Copenhagen': `20261026T${hhmm}00`, 'DTEND;TZID=Europe/Copenhagen': '20261026T100000', SUMMARY: 'Planning' }));
    const nine = new Date('2026-10-26T08:00:00Z');
    const first = planned(tagged({ work: [shared('0915')], 'home-family': [shared('0915')] }), { agenda: '2026-10-26', seen: {} }, two, nine);
    expect(first.cards).toEqual([]);
    expect(Object.keys(first.next.seen).sort()).toEqual(['home-family:sync/', 'work:sync/']);
    const { cards } = planned(tagged({ work: [shared('0920')], 'home-family': [shared('0915')] }), first.next, two, nine);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toMatch(/^cal:work:[0-9a-f]{16}-20261026T0820Z:moved$/);
    expect(cards[0]).toMatchObject({ title: 'Moved: Planning now at 09:20 (Work)', thread: 'day-2026-10-26', about: '2026-10-26', labels: ['work'] });
    expect(cards[0]!.body).toBe('**Planning** now starts at 09:20–10:00 (was 09:15).\n\nCalendar: Work');
    expect(cards[0]!.summary).toBe('Planning now starts at 09:20–10:00 (was 09:15), in Work.');
  });

  it('parses CALDAV_CALENDARS and refuses lists that cannot work', () => {
    expect(parseCalendars('[{"name":"Work","url":"/dav/work/"},{"name":" Home ","url":"https://cal.example/dav/home/"}]')).toEqual([
      { name: 'Work', url: '/dav/work/', slug: 'work' },
      { name: 'Home', url: 'https://cal.example/dav/home/', slug: 'home' },
    ]);
    expect(() => parseCalendars('[]')).toThrow(/non-empty/);
    expect(() => parseCalendars('[{"name":"Work"}]')).toThrow(/name and a url/);
    expect(() => parseCalendars('[{"name":"Work","url":"a"},{"name":"work!","url":"b"}]')).toThrow(/namespace work/);
  });

  it('stores one merged agenda end to end, fetching each calendar', async () => {
    const stub = stubHead();
    const head = new HeadClient({ baseUrl: 'https://head.test', token: 't', fetch: stub.fetch });
    const store = memoryStore();
    const fetched: string[] = [];
    const cal = calendarProducer({ fetch: async (c) => (fetched.push(c.slug), ics[c.slug] ?? []), state: store.kv<State>('calendar'), now: () => now }, two);
    await producerPass({ ...cal, head, store, onDecision: async () => {}, onError: (e: unknown) => { throw e; } });
    expect(fetched.sort()).toEqual(['home-family', 'work']);
    expect([...stub.cards.keys()].filter((id) => !/^cal:[a-z-]+:[0-9a-f]{16}$/.test(id))).toEqual(['cal:agenda:2026-10-26']);
    expect(stub.cards.get('cal:agenda:2026-10-26')).toMatchObject({ title: 'Mon 26 Oct: 6 events, first at 09:00, 2 overlaps' });
  });
});
