import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toolSource, type GoalPathSource } from './source.js';

/** Raw tool output by tool name. Per-entity tools are keyed further by `milestoneId` or `itemId`. */
export type Fixtures = Record<string, unknown>;
const KEYED: Record<string, string> = { get_milestone_forecast: 'milestoneId', list_code_activity: 'itemId' };

/** Reads one JSON file, or a directory of `<tool>.json` files. */
export function loadFixtures(path: string): Fixtures {
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as unknown;
  if (!statSync(path).isDirectory()) return read(path) as Fixtures;
  return Object.fromEntries(readdirSync(path).filter((f) => f.endsWith('.json')).map((f) => [f.slice(0, -5), read(join(path, f))]));
}

/** A source over recorded output, read on every call so a test can change it between passes. Write-backs are recorded, not applied. */
export function fixtureSource(data: Fixtures, projectId = 'fixture'): GoalPathSource & { writes: [string, Record<string, unknown>][] } {
  const writes: [string, Record<string, unknown>][] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    if (tool === 'set_item_status' || tool === 'add_comment') return void writes.push([tool, args]);
    const raw = data[tool], key = KEYED[tool];
    const out = key === undefined ? raw : (raw as Record<string, unknown> | undefined)?.[String(args[key])];
    if (out === undefined) throw new Error(`no fixture for ${tool} ${JSON.stringify(args)}`);
    return out;
  };
  return { ...toolSource(call, projectId), writes };
}
