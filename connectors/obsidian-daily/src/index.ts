import { HeadClient, fileStore, runProducer } from '@pbcp/client';
import { dailyNotes } from './vault.js';

const env = (name: string, fallback?: string): string =>
  process.env[name] || fallback || (() => { throw new Error(`${name} is required`); })();

const store = fileStore(env('PBCP_STORE', env('PBCP_CURSOR', 'pbcp-obsidian-daily.store.json')));
const head = new HeadClient({ baseUrl: env('PBCP_HEAD_URL'), token: env('PBCP_TOKEN') });
const toPerson = process.env.PBCP_TO_PERSON || (await head.describe()).owner;
const run = runProducer({
  ...dailyNotes({ vault: env('OBSIDIAN_VAULT'), folder: env('OBSIDIAN_DAILY_FOLDER', 'Daily'), toPerson, state: store.kv('notes') }),
  head,
  store,
  intervalMs: Number(env('PBCP_INTERVAL_S', '60')) * 1000,
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void run.stop().then(() => process.exit(0)));
