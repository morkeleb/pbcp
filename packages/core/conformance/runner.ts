// Runs the JSON fixtures against a HeadUnderTest / RenderUnderTest.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Decision } from '../src/index.js';
import { getPath, match, resolve, type Vars } from './match.js';
import type { Fixture, HeadUnderTest, RenderUnderTest, Response } from './types.js';

export const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url).href.replace('/dist/conformance/', '/conformance/'));

export function loadFixtures(group: 'core' | 'render', dir = FIXTURES_DIR): Fixture[] {
  const d = join(dir, group);
  return readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as Fixture);
}

export interface Adapters {
  head?: HeadUnderTest;
  render?: RenderUnderTest;
}

const MAX_PAGES = 10_000;

/** Runs one fixture from a clean head. Throws an Error describing the first failing step. */
export async function runFixture(fixture: Fixture, adapters: Adapters): Promise<void> {
  const { head, render } = adapters;
  await head?.reset();
  await render?.reset();
  const tokens = new Map<string, string>();
  const vars: Vars = {};

  const tokenFor = async (root: unknown): Promise<string> => {
    if (!head) throw new Error('no HeadUnderTest');
    const r = String(root);
    if (!tokens.has(r)) tokens.set(r, await head.token(r));
    return tokens.get(r)!;
  };
  const needHead = (): HeadUnderTest => {
    if (!head) throw new Error('fixture needs a HeadUnderTest');
    return head;
  };
  const needRender = (): RenderUnderTest => {
    if (!render) throw new Error('fixture needs a RenderUnderTest');
    return render;
  };

  for (const [i, step] of fixture.steps.entries()) {
    const args = (resolve(step.args ?? {}, vars) ?? {}) as Record<string, unknown>;
    let res: Response;
    switch (step.op) {
      case 'put':
        res = await needHead().put(await tokenFor(args.token), args.card);
        break;
      case 'changes':
        res = await needHead().changes(await tokenFor(args.token), Number(args.after));
        break;
      case 'syncAll':
        res = await syncAll(needHead(), await tokenFor(args.token), Number(args.after));
        break;
      case 'decide':
        res = await needHead().decide(String(args.id), args.decision as Decision);
        break;
      case 'seen':
        res = await needHead().seen(String(args.id));
        break;
      case 'acknowledge':
        res = await needHead().acknowledge(String(args.id));
        break;
      case 'clock':
        needHead().clock.set(String(args.set));
        res = { status: 200, body: {} };
        break;
      case 'render':
        res = { status: 200, body: await needRender().render(String(args.body)) };
        break;
      case 'draws':
        res = { status: 200, body: { count: await needRender().draws() } };
        break;
      default:
        throw new Error(`step ${i + 1}: unknown op ${step.op}`);
    }

    if (step.expect) {
      const problems = match(res, step.expect, vars, 'result');
      if (problems.length > 0) {
        throw new Error(
          `${fixture.name}\n  step ${i + 1} (${step.op}) failed:\n    ${problems.join('\n    ')}\n  response: ${JSON.stringify(res).slice(0, 1500)}`,
        );
      }
    }
    for (const [name, path] of Object.entries(step.save ?? {})) vars[name] = getPath(res, path);
  }
}

/** Runner composite op: page through `changes` until `next` stops moving (§7.2). */
async function syncAll(head: HeadUnderTest, token: string, after: number): Promise<Response> {
  const changes: Array<{ seq: number }> = [];
  let cursor = after;
  let pages = 0;
  for (;;) {
    const r = await head.changes(token, cursor);
    if (r.status !== 200) return r;
    pages++;
    const body = r.body as { changes: Array<{ seq: number }>; next: number };
    changes.push(...body.changes);
    if (body.next === cursor || pages >= MAX_PAGES) break;
    cursor = body.next;
  }
  const ascending = changes.every((c, i) => i === 0 || c.seq > changes[i - 1]!.seq);
  return { status: 200, body: { changes, next: cursor, pages, ascending } };
}
