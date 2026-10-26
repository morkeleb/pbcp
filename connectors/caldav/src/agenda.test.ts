import { HeadClient, memoryCursor, producerPass, type StateStore } from '@pbcp/client';
import { isId } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { stubHead } from '../../../packages/client/test/stub.js';
import { agendaCard, calendarProducer, ganttTitle, occurrences, plan, slug, type Occurrence, type State } from './agenda.js';

const tz = 'Europe/Copenhagen';
const cfg = { slug: 'work', toPerson: 'morten', tz };
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
    expect(next.seen).toEqual({ 'standup@example.com/2026-10-26T09:15:00': '2026-10-26T08:20:00.000Z' });
    expect(plan([at('2026-10-26T08:20:00Z')], next, cfg, nine).cards).toEqual([]);
    expect(plan([at('2026-10-26T08:25:00Z')], next, cfg, nine).cards[0]!.id).not.toBe(cards[0]!.id);
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
  const memoryState = (): StateStore<State> & { data: Map<string, State> } => {
    const data = new Map<string, State>();
    return { data, get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) };
  };

  it('stores the agenda, signals a move, and a repeat pass is a no-op', async () => {
    const stub = stubHead();
    const head = new HeadClient({ baseUrl: 'https://head.test', token: 't', fetch: stub.fetch });
    let ics = [vcal(standup), ...others];
    let clock = now;
    const state = memoryState();
    const cal = calendarProducer(head, { fetch: async () => ics, state, now: () => clock }, cfg);
    const opts = { ...cal, cursor: memoryCursor(), onDecision: async () => {}, onError: (e: unknown) => { throw e; } };
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
    const stub = stubHead();
    const head = new HeadClient({ baseUrl: 'https://head.test', token: 't', fetch: stub.fetch });
    const state = memoryState();
    const cal = calendarProducer(head, { fetch: async () => [], state, now: () => now }, cfg);
    const opts = { ...cal, cursor: memoryCursor(), onDecision: async () => {}, onError: () => {} };
    stub.script(500, { error: 'boom' });
    await producerPass(opts);
    expect(state.data.size).toBe(0);
    await producerPass(opts);
    expect(stub.cards.get('cal:work:2026-10-26')?.title).toBe('Mon 26 Oct: nothing scheduled');
    expect(state.data.get('state')?.agenda).toBe('2026-10-26');
  });
});
