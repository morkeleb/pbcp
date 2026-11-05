import { HeadClient, fileStore, runExecutor, runProducer } from '@pbcp/client';
import { todoistRun, zoneOf } from './executor.js';
import { todoistReader, type Rec } from './reader.js';
import { restSource } from './source.js';

const required = (name: string): never => { throw new Error(`${name} is required`); };
const env = (name: string, fallback?: string): string => process.env[name] || fallback || required(name);
const mode = env('TODOIST_MODE', 'executor');
if (mode !== 'executor' && mode !== 'reader') throw new Error(`TODOIST_MODE is executor or reader, not ${mode}`);
const src = restSource(env('TODOIST_TOKEN'), { project: process.env.TODOIST_PROJECT });
const head = new HeadClient({ baseUrl: env('PBCP_HEAD_URL'), token: env('PBCP_TOKEN') });
const store = fileStore(env('PBCP_STORE', mode === 'reader' ? 'pbcp-todoist-reader.json' : 'pbcp-todoist.json'));
const [pollMs, timeZone] = [Number(env('TODOIST_POLL_S', '60')) * 1000, zoneOf(process.env.TODOIST_TZ)];
const run = mode === 'reader'
  // §11.1 a task reader: a producer under the same root, with its own token and store.
  ? runProducer({ head, store, intervalMs: pollMs, ...todoistReader(src, store.kv<Rec>('tasks'), { toPerson: process.env.PBCP_TO_PERSON || (await head.describe()).owner, timeZone }) })
  : runExecutor({
    head, store,
    producer: 'todoist',
    // Where outcome cards are addressed; unset, the head's owner from GET / (§7.5, §10).
    toPerson: process.env.PBCP_TO_PERSON || undefined,
    leaseSeconds: Number(env('PBCP_LEASE_S', '60')),
    // Orders wait days for the person, so many run at once.
    concurrency: Number(env('PBCP_CONCURRENCY', '50')),
    run: todoistRun(src, { pollMs, timeZone }),
  });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void run.stop().then(() => process.exit(0)));
