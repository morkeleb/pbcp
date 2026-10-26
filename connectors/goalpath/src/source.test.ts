import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureSource, loadFixtures } from './fixture-source.js';
import { toolResult } from './mcp-source.js';
import { parse } from './source.js';

const FIX = fileURLToPath(new URL('../fixtures', import.meta.url));
const M = (n: number) => `7a1e0c2e-4d4b-4c51-9b1a-00000000000${n}`;
const I = (n: string) => `3c9b7f10-2a6e-4e0f-8d3e-0000000000${n}`;

describe('normaliser over the recorded fixtures', () => {
  const gp = fixtureSource(loadFixtures(FIX), 'p-demo');

  it('drops Done milestones and merges each forecast, in either guessed shape', async () => {
    expect(await gp.milestones()).toEqual([
      { id: M(4), name: 'Billing revamp', start: '2026-09-28', deadline: '2026-11-13', projected: '2026-11-24', confidence: 'low', reasons: ['Scope grew by 6 items since 12 Oct', 'Velocity 18 points/week, down from 24'], url: 'https://goalpath.example/m/4' },
      { id: M(5), name: 'Mobile beta', start: '2026-10-12', deadline: '2026-12-11', projected: '2026-12-04', confidence: 'medium', reasons: [], url: undefined },
      { id: M(6), name: 'Rollout', start: '2026-12-01', deadline: '2027-01-15', projected: '2027-01-22', confidence: 'low', reasons: [], url: undefined },
    ]);
  });

  it('normalises item numbers, nested milestones and highlights', async () => {
    const items = await gp.myItems();
    expect(items.map((i) => [i.number, i.status, i.milestoneId, i.highlights])).toEqual([
      ['GP-12', 'Finished', M(4), []],
      ['GP-14', 'Started', M(4), ['Blocked']],
      ['GP-15', 'NotStarted', M(5), ['Question']],
      ['GP-16', 'Started', M(5), []],
      ['GP-10', 'Accepted', M(4), []],
      ['GP-9', 'Accepted', M(4), []],
    ]);
  });

  it('keeps confirmed code links only, with their checks', async () => {
    expect(await gp.codeActivity(I('14'))).toEqual([
      { ref: '#91', title: 'Retry declined payments with backoff', url: 'https://git.example/acme/billing/pull/91', checks: [{ runId: 'gh-run-118842', name: 'ci / test', conclusion: 'failure', url: 'https://git.example/acme/billing/actions/runs/118842' }] },
    ]);
    expect(await gp.codeActivity(I('16'))).toEqual([{ ref: '1b7d0c9', title: 'Opt-in screen', url: undefined, checks: [{ runId: 'gh-run-118850', name: 'ci / build', conclusion: 'success', url: undefined }] }]);
  });

  it('reads the unplanned trend from counts, a ratio, or a percentage; and the dependency edges', async () => {
    expect((await gp.unplannedTrend(4)).map((w) => [w.week, w.ratio])).toEqual([['2026-09-28', 0.1], ['2026-10-05', 0.2], ['2026-10-12', 0.4], ['2026-10-19', 0.25]]);
    expect(await gp.dependencies()).toEqual([{ from: M(4), to: M(6) }, { from: M(5), to: M(6) }]);
  });

  it('treats a failing trend tool as no trend, and a failing forecast as no forecast', async () => {
    const data = loadFixtures(FIX);
    delete data.get_unplanned_work_trend;
    delete (data.get_milestone_forecast as Record<string, unknown>)[M(5)];
    const src = fixtureSource(data);
    expect(await src.unplannedTrend(4)).toEqual([]);
    const m5 = (await src.milestones()).find((m) => m.id === M(5));
    expect([m5?.deadline, m5?.projected]).toEqual(['2026-12-11', undefined]);
  });

  it('accepts bare arrays and ignores entries without ids', () => {
    expect(parse.items([{ id: 'a', number: 'X-1', title: 'two\nlines', status: 'Started' }, { title: 'no id' }])).toMatchObject([{ id: 'a', number: 'X-1', title: 'two lines' }]);
    expect(parse.codeActivity({})).toEqual([]);
  });
});

describe('toolResult', () => {
  it('prefers structuredContent, else parses the text block, else keeps the text', () => {
    expect(toolResult({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] })).toEqual({ a: 1 });
    expect(toolResult({ content: [{ type: 'text', text: '{"a":2}' }] })).toEqual({ a: 2 });
    expect(toolResult({ content: [{ type: 'text', text: 'ok' }] })).toBe('ok');
  });
  it('throws on a tool error', () => {
    expect(() => toolResult({ isError: true, content: [{ type: 'text', text: 'no such item' }] })).toThrow('no such item');
  });
});
