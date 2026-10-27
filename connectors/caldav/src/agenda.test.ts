import { HeadClient, memoryStore, producerPass, type Parked } from '@pbcp/client';
import { stubHead } from '@pbcp/client/testing';
import { isId } from '@pbcp/core';
import { describe, expect, it, vi } from 'vitest';
import { agendaCard, calendarProducer, ganttTitle, occurrences, overlaps, parseCalendars, plan, slug, type Calendar, type Occurrence, type State } from './agenda.js';

const tz = 'Europe/Copenhagen';
const cfg = { calendars: [{ name: 'Work', slug: 'work' }], toPerson: 'morten', tz };
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
  it('renders the day as a table and a gantt fence', () => {
    const c = agendaCard(occurrences([vcal(standup), ...others], from, to), '2026-10-26', cfg, now);
    expect(isId(c.id)).toBe(true);
    expect(c).toMatchObject({ id: 'cal:work:2026-10-26', kind: 'artifact', urgency: 'brief', thread: 'day-2026-10-26', title: 'Mon 26 Oct: 4 events, first at 09:15' });
    expect(c.summary).toBe('First: Standup, 09:15–09:30.');
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
    const allDay = agendaCard(occurrences([others[0]!], from, to), '2026-10-26', cfg, now);
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
  const prev: State = { agenda: '2026-10-26', seen: { 'standup@example.com/2026-10-26T09:15:00': '2026-10-26T08:15:00.000Z' } };
  const nine = new Date('2026-10-26T08:00:00Z');

  it('signals a move into the next 30 minutes, once per new start', () => {
    const { cards, next } = plan([at('2026-10-26T08:20:00Z')], prev, cfg, nine);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'signal', urgency: 'immediate', thread: 'day-2026-10-26', title: 'Moved: Standup now at 09:20' });
    expect(cards[0]!.id).toMatch(/^cal:work:[0-9a-f]{16}-20261026T0820Z:moved$/);
    expect(isId(cards[0]!.id)).toBe(true);
    expect(cards[0]!.body).toBe('**Standup** now starts at 09:20–09:35 (was 09:15).');
    expect(cards[0]!.summary).toBe('Standup now starts at 09:20–09:35 (was 09:15).');
    expect(next.seen).toEqual({ 'standup@example.com/2026-10-26T09:15:00': '2026-10-26T08:20:00.000Z' });
    expect(plan([at('2026-10-26T08:20:00Z')], next, cfg, nine).cards).toEqual([]);
    expect(plan([at('2026-10-26T08:25:00Z')], next, cfg, nine).cards[0]!.id).not.toBe(cards[0]!.id);
  });

  it('names the day, readably, of a previous start or an end on another day', () => {
    const late = { ...at('2026-10-26T08:20:00Z'), end: new Date('2026-10-26T23:30:00Z') };
    const moved = plan([late], { ...prev, seen: { [late.key]: '2026-10-25T08:15:00.000Z' } }, cfg, nine).cards[0]!;
    expect(moved.body).toBe('**Standup** now starts at 09:20–Tue 27 Oct 00:30 (was Sun 25 Oct 09:15).');
  });

  it('links the moved card to the event when it has a web URL, and not otherwise', () => {
    const moved = (o: Occurrence) => plan([o], prev, cfg, nine).cards[0]!;
    expect(moved({ ...at('2026-10-26T08:20:00Z'), url: 'https://cal.example.com/event/standup' }).source).toEqual({ url: 'https://cal.example.com/event/standup', label: 'Calendar event' });
    expect('source' in moved(at('2026-10-26T08:20:00Z'))).toBe(false);
    const parsed = (url: string) => occurrences([vcal(vevent({ UID: 'u', DTSTART: '20261026T080000Z', DTEND: '20261026T090000Z', SUMMARY: 'S', URL: url }))], from, to)[0]!.url;
    expect(parsed('https://cal.example.com/e/1')).toBe('https://cal.example.com/e/1');
    expect(parsed('mailto:x@y')).toBeUndefined();
  });

  it('ignores a move further out, a first sighting and a past start', () => {
    expect(plan([at('2026-10-26T10:00:00Z')], prev, cfg, nine).cards).toEqual([]);
    expect(plan([at('2026-10-26T08:20:00Z')], { ...prev, seen: {} }, cfg, nine).cards).toEqual([]);
    expect(plan([at('2026-10-26T07:50:00Z')], prev, cfg, nine).cards).toEqual([]);
  });

  it('produces the agenda once a day, from agendaAt', () => {
    expect(plan([], { seen: {} }, { ...cfg, agendaAt: '06:00' }, new Date('2026-10-26T04:30:00Z')).cards).toEqual([]);
    const { cards, next } = plan([], { seen: {} }, { ...cfg, agendaAt: '06:00' }, now);
    expect(cards.map((c) => c.id)).toEqual(['cal:work:2026-10-26']);
    expect(plan([], next, cfg, now).cards).toEqual([]);
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
    expect(stub.cards.get('cal:work:2026-10-26')).toMatchObject({ kind: 'artifact', state: 'open' });
    expect(puts()).toBe(1);

    ics = [vcal(standup, standupMoved('0920')), ...others];
    clock = new Date('2026-10-26T08:00:00Z');
    await producerPass(opts);
    expect(puts()).toBe(2);
    const signal = [...stub.cards.values()].find((c) => c.kind === 'signal');
    expect(signal).toMatchObject({ urgency: 'immediate', title: 'Moved: Standup now at 09:20' });

    await producerPass(opts);
    expect(puts()).toBe(2);
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
    const c = agendaCard(tagged(ics), '2026-10-26', two, now);
    expect(isId(c.id)).toBe(true);
    expect(c).toMatchObject({ id: 'cal:agenda:2026-10-26', kind: 'artifact', urgency: 'brief', thread: 'day-2026-10-26', title: 'Mon 26 Oct: 6 events, first at 09:00, 2 overlaps' });
    expect(c.summary).toBe('First: Dentist, 09:00–09:45, Clinic (Home | family).');
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
    const c = agendaCard(tagged({ work: ics.work! }), '2026-10-26', two, now);
    expect(c.body).toContain('  section Work');
    expect(c.body).not.toContain('section Home');
    expect(agendaCard([], '2026-10-26', two, now)).toMatchObject({ id: 'cal:agenda:2026-10-26', title: 'Mon 26 Oct: nothing scheduled', body: 'Nothing scheduled.' });
  });

  it('signals a move in its own calendar namespace, with the calendar name, keyed per calendar', () => {
    const shared = (hhmm: string) => vcal(vevent({ UID: 'sync', 'DTSTART;TZID=Europe/Copenhagen': `20261026T${hhmm}00`, 'DTEND;TZID=Europe/Copenhagen': '20261026T100000', SUMMARY: 'Planning' }));
    const nine = new Date('2026-10-26T08:00:00Z');
    const first = plan(tagged({ work: [shared('0915')], 'home-family': [shared('0915')] }), { agenda: '2026-10-26', seen: {} }, two, nine);
    expect(first.cards).toEqual([]);
    expect(Object.keys(first.next.seen).sort()).toEqual(['home-family:sync/', 'work:sync/']);
    const { cards } = plan(tagged({ work: [shared('0920')], 'home-family': [shared('0915')] }), first.next, two, nine);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toMatch(/^cal:work:[0-9a-f]{16}-20261026T0820Z:moved$/);
    expect(cards[0]).toMatchObject({ title: 'Moved: Planning now at 09:20 (Work)', thread: 'day-2026-10-26' });
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
    expect([...stub.cards.keys()]).toEqual(['cal:agenda:2026-10-26']);
    expect(stub.cards.get('cal:agenda:2026-10-26')).toMatchObject({ title: 'Mon 26 Oct: 6 events, first at 09:00, 2 overlaps' });
  });
});
