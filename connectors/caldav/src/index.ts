import { HeadClient, fileCursor, fileState, runProducer } from '@pbcp/client';
import { createDAVClient, type DAVCalendar } from 'tsdav';
import { calendarProducer, slug, type State } from './agenda.js';

const required = (name: string): never => { throw new Error(`${name} is required`); };
const env = (name: string, fallback?: string): string => process.env[name] || fallback || required(name);
// Floating and all-day times are read in the process time zone, so CALDAV_TZ sets it.
if (process.env.CALDAV_TZ) process.env.TZ = process.env.CALDAV_TZ;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const cursor = env('PBCP_CURSOR', 'pbcp-caldav.cursor.json');
const credentials = { username: env('CALDAV_USER'), password: env('CALDAV_PASSWORD') };
const dav = await createDAVClient({ serverUrl: env('CALDAV_URL'), credentials, authMethod: 'Basic', defaultAccountType: 'caldav' });
const nameOf = (c: DAVCalendar) => (typeof c.displayName === 'string' && c.displayName) || c.url.split('/').filter(Boolean).at(-1) || c.url;
const [calendars, want] = [await dav.fetchCalendars(), process.env.CALDAV_CALENDAR];
const calendar = want ? calendars.find((c) => c.url === want || nameOf(c) === want) : calendars[0];
if (!calendar) throw new Error(`no calendar ${want ?? ''}; found: ${calendars.map(nameOf).join(', ')}`);
const head = new HeadClient({ baseUrl: env('PBCP_HEAD_URL'), token: env('PBCP_TOKEN') });
const toPerson = process.env.PBCP_TO_PERSON || (await head.describe()).owner;
const cal = calendarProducer(head, {
  state: fileState<State>(env('PBCP_STATE', `${cursor.replace(/\.cursor\.json$/, '')}.state.json`)),
  fetch: async (from, to) => {
    const objects = await dav.fetchCalendarObjects({ calendar, timeRange: { start: from.toISOString(), end: to.toISOString() } });
    return objects.map((o) => (typeof o.data === 'string' ? o.data : '')).filter(Boolean);
  },
}, { slug: slug(nameOf(calendar)), toPerson, tz, agendaAt: env('CALDAV_AGENDA_AT', '06:00') });

const intervalMs = Number(env('CALDAV_INTERVAL_S', '300')) * 1000;
const run = runProducer({ ...cal, cursor: fileCursor(cursor), onDecision: async () => {}, intervalMs });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void run.stop().then(() => process.exit(0)));
