import { describe, expect, it } from 'vitest';
import { inProcessHead } from './in-process/head.js';
import { referenceRenderer } from './in-process/render.js';
import { getPath, match } from './match.js';
import { loadFixtures, runFixture } from './runner.js';
import type { Fixture, HeadUnderTest, RenderUnderTest } from './types.js';

describe('match', () => {
  it('matches objects partially and arrays exactly', () => {
    expect(match({ a: 1, b: 2 }, { a: 1 }, {})).toEqual([]);
    expect(match([1, 2], [1], {})).toHaveLength(1);
    expect(match({ a: 1 }, { a: 2 }, {})).toHaveLength(1);
  });

  it('implements every matcher', () => {
    const v = { n: 5 };
    expect(match(5, { $var: 'n' }, v)).toEqual([]);
    expect(match(6, { $gt: { $var: 'n' }, $lt: 7 }, v)).toEqual([]);
    expect(match(4, { $adjacent: { $var: 'n' } }, v)).toEqual([]);
    expect(match(3, { $adjacent: { $var: 'n' } }, v)).toHaveLength(1);
    expect(match({}, { a: { $absent: true } }, v)).toEqual([]);
    expect(match({ a: null }, { a: { $present: true } }, v)).toHaveLength(1);
    expect(match([], { $type: 'array', $len: 0 }, v)).toEqual([]);
    expect(match([{ id: 1 }, { id: 2 }], { $contains: [{ id: 2 }], $none: { id: 3 }, $every: { id: { $type: 'number' } } }, v)).toEqual([]);
    expect(match('x', { $oneOf: ['y', 'x'] }, v)).toEqual([]);
    expect(match('hello', { $includes: 'ell', $excludes: 'z' }, v)).toEqual([]);
    expect(match(['html'], { $includes: 'html' }, v)).toEqual([]);
    expect(() => match(1, { $nope: 1 }, v)).toThrow(/unknown matcher/);
  });

  it('resolves find segments in paths', () => {
    const r = { body: { changes: [{ seq: 1, card: { id: 'a:b:c' } }, { seq: 2, card: { id: 'a:b:d' } }] } };
    expect(getPath(r, 'body.changes.[card.id=a:b:d].seq')).toBe(2);
    expect(getPath(r, 'body.changes.0.card.id')).toBe('a:b:c');
    expect(getPath(r, 'body.missing.x')).toBeUndefined();
  });
});

const core: Record<string, Fixture> = Object.fromEntries(loadFixtures('core').map((f) => [f.name.split(' ')[0], f]));
const render: Record<string, Fixture> = Object.fromEntries(loadFixtures('render').map((f) => [f.name.split(' ')[0], f]));

describe('the in-process head passes at any page size', () => {
  for (const pageSize of [1, 3, 1000]) {
    it(`pageSize ${pageSize}`, async () => {
      for (const f of Object.values(core)) await runFixture(f, { head: inProcessHead({ pageSize }) });
    });
  }
});

// Each sabotaged adapter breaks one MUST; the named fixture has to catch it.
function sabotage(base: HeadUnderTest, over: Partial<HeadUnderTest>): HeadUnderTest {
  return { ...base, ...over };
}

async function fails(f: Fixture | undefined, adapters: { head?: HeadUnderTest; render?: RenderUnderTest }): Promise<void> {
  expect(f).toBeDefined();
  await expect(runFixture(f!, adapters)).rejects.toThrow();
}

describe('the fixtures catch broken heads', () => {
  it('C14: accepting head-owned fields', async () => {
    const h = inProcessHead();
    const strip = (c: unknown) => {
      if (typeof c !== 'object' || c === null) return c;
      const { state, change_seq, decision, received_at, changed_at, seen_at, acknowledged_at, snoozed_until, edited_proposal, comment, decided_at, delegated_to, ...rest } = c as Record<string, unknown>;
      return rest;
    };
    await fails(core.C14, { head: sabotage(h, { put: (t, c) => h.put(t, strip(c)) }) });
  });

  it('C15: accepting another major version', async () => {
    const h = inProcessHead();
    const fix = (c: unknown) => (typeof c === 'object' && c !== null ? { ...c, protocol: 'pbcp/1' } : c);
    await fails(core.C15, { head: sabotage(h, { put: (t, c) => h.put(t, fix(c)) }) });
  });

  it('C10: skipping an entry per page', async () => {
    const h = inProcessHead({ pageSize: 3 });
    const changes: HeadUnderTest['changes'] = async (t, after) => {
      const r = await h.changes(t, after);
      const body = r.body as { changes: unknown[]; next: number };
      return { ...r, body: { ...body, changes: body.changes.slice(1) } };
    };
    await fails(core.C10, { head: sabotage(h, { changes }) });
  });

  it('C02: not clearing seen_at on a revised body', async () => {
    const h = inProcessHead();
    let seenAt: string | undefined;
    const seen: HeadUnderTest['seen'] = async (id) => {
      const r = await h.seen(id);
      seenAt = (r.body as { seen_at?: string }).seen_at;
      return r;
    };
    const put: HeadUnderTest['put'] = async (t, c) => {
      const r = await h.put(t, c);
      return seenAt && r.status === 200 ? { ...r, body: { ...(r.body as object), seen_at: seenAt } } : r;
    };
    await fails(core.C02, { head: sabotage(h, { seen, put }) });
  });

  it('R08: showing a fallback image beside a rendered fence', async () => {
    const r = referenceRenderer();
    const broken: RenderUnderTest = {
      ...r,
      render: async (b) => {
        const out = await r.render(b);
        return { ...out, images: out.images.map((i) => ({ ...i, class: i.class === 'hidden' ? 'image' : i.class })) };
      },
    };
    await fails(render.R08, { render: broken });
  });

  it('C38: leaving summary out of equality', async () => {
    const h = inProcessHead();
    const stored = new Map<string, unknown>();
    // A head that compares without summary answers a changed summary as identical: 200 and the stored card.
    const put: HeadUnderTest['put'] = async (t, c) => {
      const card = c as { id: string; summary?: string };
      const prev = stored.get(card.id) as { summary?: string } | undefined;
      const r = await h.put(t, prev && typeof c === 'object' ? { ...card, summary: prev.summary } : c);
      if (r.status === 201) stored.set(card.id, c);
      return r;
    };
    await fails(core.C38, { head: sabotage(h, { put }) });
  });

  it('C39: accepting a summary with a line break', async () => {
    const h = inProcessHead();
    const put: HeadUnderTest['put'] = async (t, c) =>
      h.put(t, typeof c === 'object' && c !== null && 'summary' in c ? { ...c, summary: String((c as { summary: string }).summary).replace(/[\r\n]/g, ' ') || 'x' } : c);
    await fails(core.C39, { head: sabotage(h, { put }) });
  });

  it('C40: dropping summary from the file form', async () => {
    const h = inProcessHead();
    const put: HeadUnderTest['put'] = async (t, c) => h.put(t, typeof c === 'string' ? c.replace(/^summary: .*\n/m, '') : c);
    await fails(core.C40, { head: sabotage(h, { put }) });
  });

  it('R09–R11: leads that ignore summary, keep headings or keep fences', async () => {
    const r = referenceRenderer();
    const firstLines = (b: string) => b.split('\n\n')[0]!;
    await fails(render.R09, { render: { ...r, lead: async (c) => ({ text: firstLines(c.body), source: 'body' }) } });
    await fails(render.R10, { render: { ...r, lead: async (c) => ({ text: c.summary ?? firstLines(c.body), source: c.summary ? 'summary' : 'body' }) } });
    await fails(render.R11, { render: { ...r, lead: async (c) => ({ text: c.summary ?? firstLines(c.body.replace(/^## .*\n\n/, '')), source: c.summary ? 'summary' : 'body' }) } });
  });

  it('R07: drawing a cached fence twice', async () => {
    const r = referenceRenderer();
    await fails(render.R07, { render: { ...r, draws: async () => (await r.draws()) + 1 } });
  });
});
