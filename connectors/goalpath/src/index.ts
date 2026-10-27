import { HeadClient, fileStore, runProducer } from '@pbcp/client';
import { fixtureSource, loadFixtures } from './fixture-source.js';
import { mcpSource } from './mcp-source.js';
import { goalpathProducer, labelOf } from './producer.js';

const required = (name: string): never => { throw new Error(`${name} is required`); };
const env = (name: string, fallback?: string): string => process.env[name] || fallback || required(name);
const projectId = env('GOALPATH_PROJECT');
// The cursor and the connector's state, in one file. PBCP_CURSOR is the 0.3 name.
const store = fileStore(env('PBCP_STORE', process.env.PBCP_CURSOR || 'pbcp-goalpath.json'));
// GOALPATH_FIXTURES replays recorded tool output instead of calling the MCP; write-backs are then only logged.
const fixtures = process.env.GOALPATH_FIXTURES;
const gp = fixtures ? fixtureSource(loadFixtures(fixtures), projectId) : await mcpSource(env('GOALPATH_MCP_URL'), env('GOALPATH_TOKEN'), projectId);
const head = new HeadClient({ baseUrl: env('PBCP_HEAD_URL'), token: env('PBCP_TOKEN') });
const toPerson = process.env.PBCP_TO_PERSON || (await head.describe()).owner;
const milestones = process.env.GOALPATH_MILESTONES?.split(',').map((s) => s.trim()).filter(Boolean);
// §4.1 labels: GOALPATH_LABEL, else the project's name, else its id, made into a label.
const label = labelOf(process.env.GOALPATH_LABEL || (await gp.projectName()) || projectId);

const producer = goalpathProducer(gp, store, {
  toPerson, projectId, label, milestones, tz: env('GOALPATH_TZ', Intl.DateTimeFormat().resolvedOptions().timeZone),
  digestAt: env('GOALPATH_DIGEST_AT', '20:00'), approvalStatus: env('GOALPATH_APPROVAL_STATUS', 'Finished'),
});
const run = runProducer({ ...producer, head, store, intervalMs: Number(env('GOALPATH_INTERVAL_S', '300')) * 1000 });
const stop = async () => { await run.stop(); if ('close' in gp) await gp.close(); else console.log(JSON.stringify(gp.writes)); process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void stop());
