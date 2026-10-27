// Runs the JSON fixtures against a HeadUnderTest / RenderUnderTest.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Decision, Urgency } from '../src/index.js';
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

/** Sent where a fixture asks for a producer token the head never issued. */
export const INVALID_TOKEN = 'pbcp-conformance-invalid-token';

/** Runs one fixture from a clean head. Throws an Error describing the first failing step. */
export async function runFixture(fixture: Fixture, adapters: Adapters): Promise<void> {
  const { head, render } = adapters;
  await head?.reset();
  await render?.reset();
  const tokens = new Map<string, string>();
  const vars: Vars = {};

  /** `instance` names a further token under the same root, so a fixture can act as two installations of one producer. */
  const tokenFor = async (root: unknown, ceiling?: unknown, executor?: unknown, instance?: unknown): Promise<string> => {
    if (!head) throw new Error('no HeadUnderTest');
    const key = `${String(root)}|${String(ceiling ?? '')}|${executor === true}|${String(instance ?? '')}`;
    const opts = { ...(ceiling === undefined ? {} : { ceiling: ceiling as Urgency }), ...(executor === true ? { executor: true } : {}) };
    if (!tokens.has(key)) tokens.set(key, await head.token(String(root), Object.keys(opts).length ? opts : undefined));
    return tokens.get(key)!;
  };
  /** `credential: "none"` sends no credential, `"invalid"` a token the head never issued; otherwise `token` (and `ceiling`) name one. */
  const credential = async (args: Record<string, unknown>): Promise<string | null> => {
    if (args.credential === 'none') return null;
    if (args.credential === 'invalid') return INVALID_TOKEN;
    return tokenFor(args.token, args.ceiling, args.executor, args.instance);
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
      case 'describe':
        res = await needHead().describe(await credential(args));
        break;
      case 'put':
        res = await needHead().put(await credential(args), args.card);
        break;
      case 'changes':
        res = await needHead().changes(await credential(args), typeof args.after === 'string' ? args.after : Number(args.after));
        break;
      case 'syncAll':
        res = await syncAll(needHead(), await credential(args), Number(args.after));
        break;
      case 'decide':
        res = await needHead().decide(String(args.id), args.decision as Decision);
        break;
      case 'order': {
        const h = needHead();
        if (!h.order) throw new Error('fixture needs HeadUnderTest.order (orders extension)');
        res = await h.order({ to_producer: String(args.to_producer), title: String(args.title), body: String(args.body ?? '') });
        break;
      }
      case 'claim': {
        const h = needHead();
        if (!h.claim) throw new Error('fixture needs HeadUnderTest.claim (orders extension)');
        res = await h.claim(await tokenFor(args.token, args.ceiling, args.executor, args.instance), String(args.id), Number(args.lease));
        break;
      }
      case 'decideWithToken':
        res = await needHead().decideWithToken(await tokenFor(args.token, args.ceiling, args.executor), String(args.id), args.decision as Decision);
        break;
      case 'seen':
        res = await needHead().seen(String(args.id));
        break;
      case 'acknowledge':
        res = await needHead().acknowledge(String(args.id));
        break;
      case 'snooze':
        res = await needHead().snooze(String(args.id), args.until === null || args.until === undefined ? null : String(args.until));
        break;
      case 'clock':
        await needHead().clock.set(String(args.set));
        res = { status: 200, body: {} };
        break;
      case 'render':
        res = { status: 200, body: await needRender().render(String(args.body)) };
        break;
      case 'lead':
        res = { status: 200, body: await needRender().lead(args.card as { summary?: string; body: string }) };
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
async function syncAll(head: HeadUnderTest, token: string | null, after: number): Promise<Response> {
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
