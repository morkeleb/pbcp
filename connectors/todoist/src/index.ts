import { HeadClient, fileStore, runExecutor } from '@pbcp/client';
import { todoistRun, zoneOf } from './executor.js';
import { restSource } from './source.js';

const required = (name: string): never => { throw new Error(`${name} is required`); };
const env = (name: string, fallback?: string): string => process.env[name] || fallback || required(name);
const src = restSource(env('TODOIST_TOKEN'), { project: process.env.TODOIST_PROJECT });
const run = runExecutor({
  head: new HeadClient({ baseUrl: env('PBCP_HEAD_URL'), token: env('PBCP_TOKEN') }),
  store: fileStore(env('PBCP_STORE', 'pbcp-todoist.json')),
  producer: 'todoist',
  // Where outcome cards are addressed; unset, the head's owner from GET / (§7.5, §10).
  toPerson: process.env.PBCP_TO_PERSON || undefined,
  leaseSeconds: Number(env('PBCP_LEASE_S', '60')),
  // Orders wait days for the person, so many run at once.
  concurrency: Number(env('PBCP_CONCURRENCY', '50')),
  run: todoistRun(src, { pollMs: Number(env('TODOIST_POLL_S', '60')) * 1000, timeZone: zoneOf(process.env.TODOIST_TZ) }),
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void run.stop().then(() => process.exit(0)));
