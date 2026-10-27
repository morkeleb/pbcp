import { HeadClient, fileStore, runProducer } from '@pbcp/client';
import { createDAVClient, type DAVCalendar } from 'tsdav';
import { calendarProducer, parseCalendars, slug, type State } from './agenda.js';

const required = (name: string): never => { throw new Error(`${name} is required`); };
const env = (name: string, fallback?: string): string => process.env[name] || fallback || required(name);
// Floating and all-day times are read in the process time zone, so CALDAV_TZ sets it.
if (process.env.CALDAV_TZ) process.env.TZ = process.env.CALDAV_TZ;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const store = fileStore(env('PBCP_STORE', env('PBCP_CURSOR', 'pbcp-caldav.store.json')));
const credentials = { username: env('CALDAV_USER'), password: env('CALDAV_PASSWORD') };
const serverUrl = env('CALDAV_URL');
const dav = await createDAVClient({ serverUrl, credentials, authMethod: 'Basic', defaultAccountType: 'caldav' });
const nameOf = (c: DAVCalendar) => (typeof c.displayName === 'string' && c.displayName) || c.url.split('/').filter(Boolean).at(-1) || c.url;
const found = await dav.fetchCalendars();
const missing = (what: string): never => { throw new Error(`no calendar ${what}; found: ${found.map((c) => `${nameOf(c)} <${c.url}>`).join(', ')}`); };
// CALDAV_CALENDARS names each calendar by URL (absolute, or relative to CALDAV_URL); otherwise CALDAV_CALENDAR picks one.
const norm = (u: string) => new URL(u, serverUrl).href.replace(/\/+$/, '');
const list = process.env.CALDAV_CALENDARS;
const chosen = list
  ? parseCalendars(list).map((c) => ({ name: c.name, slug: c.slug, dav: found.find((d) => norm(d.url) === norm(c.url)) ?? missing(c.url) }))
  : [process.env.CALDAV_CALENDAR ? found.find((c) => c.url === process.env.CALDAV_CALENDAR || nameOf(c) === process.env.CALDAV_CALENDAR) : found[0]]
      .map((d) => d ?? missing(process.env.CALDAV_CALENDAR ?? ''))
      .map((d) => ({ name: nameOf(d), slug: slug(nameOf(d)), dav: d }));
const head = new HeadClient({ baseUrl: env('PBCP_HEAD_URL'), token: env('PBCP_TOKEN') });
const toPerson = process.env.PBCP_TO_PERSON || (await head.describe()).owner;
const cal = calendarProducer({
  state: store.kv<State>('calendar'),
  fetch: async (cal, from, to) => {
    const calendar = chosen.find((c) => c.slug === cal.slug)!.dav;
    const objects = await dav.fetchCalendarObjects({ calendar, timeRange: { start: from.toISOString(), end: to.toISOString() } });
    return objects.map((o) => (typeof o.data === 'string' ? o.data : '')).filter(Boolean);
  },
}, { calendars: chosen.map(({ name, slug }) => ({ name, slug })), toPerson, tz, agendaAt: env('CALDAV_AGENDA_AT', '06:00') });
const run = runProducer({ ...cal, head, store, onDecision: async () => {}, intervalMs: Number(env('CALDAV_INTERVAL_S', '300')) * 1000 });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void run.stop().then(() => process.exit(0)));
