import { card } from '@pbcp/client';
import { toFrontMatter, toJSON } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { stubHead } from '../../client/test/stub.js';
import { main, type Io } from './index.js';

const sample = (title = 'Hi') =>
  card({ producer: 'mail', namespace: 'acct', upstream: 'm1', kind: 'decision', to_person: 'morten', title, body: 'b', emitted_at: '2026-10-26T10:00:00Z' });

function setup(files: Record<string, string> = {}, env: Record<string, string> = { PBCP_HEAD_URL: 'https://head.test', PBCP_TOKEN: 'tok' }) {
  const stub = stubHead({ pageSize: 2 });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    fetch: stub.fetch,
    readFile: async (p) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return files[p]!;
    },
  };
  const run = (...argv: string[]) => main(argv, io);
  return { stub, out, err, io, run };
}

describe('pbcp describe', () => {
  it('prints the head description', async () => {
    const { run, out, stub } = setup();
    expect(await run('describe')).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ protocol: 'pbcp/1', owner: 'morten' });
    expect(stub.requests[0]).toMatchObject({ method: 'GET', url: 'https://head.test/', headers: { authorization: 'Bearer tok' } });
  });

  it('lets flags override the environment', async () => {
    const { run, stub } = setup();
    await run('describe', '--head', 'https://other.test/', '--token', 'flag');
    expect(stub.requests[0]).toMatchObject({ url: 'https://other.test/', headers: { authorization: 'Bearer flag' } });
  });

  it('exits 2 without a head or token', async () => {
    const { run, err } = setup({}, {});
    expect(await run('describe')).toBe(2);
    expect(err[0]).toMatch(/PBCP_HEAD_URL/);
    expect(await run('describe', '--head', 'https://h.test')).toBe(2);
    expect(err[1]).toMatch(/PBCP_TOKEN/);
  });
});

describe('pbcp submit', () => {
  it('submits a JSON file and a front-matter file, printing status and card', async () => {
    const { run, out } = setup({ 'c.json': toJSON(sample()), 'c.md': toFrontMatter(sample()) });
    expect(await run('submit', 'c.json')).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ status: 201, card: { id: 'mail:acct:m1', state: 'open', change_seq: 1 } });
    expect(await run('submit', 'c.md')).toBe(0);
    expect(JSON.parse(out[1]!)).toMatchObject({ status: 200, card: { change_seq: 1 } });
  });

  it('prints a 409 and exits 0', async () => {
    const { run, out, stub } = setup({ 'a.json': toJSON(sample()), 'b.json': toJSON(sample('Changed')) });
    await run('submit', 'a.json');
    stub.decideHere('mail:acct:m1', { decision: 'approve' });
    expect(await run('submit', 'b.json')).toBe(0);
    expect(JSON.parse(out[1]!)).toMatchObject({ status: 409, card: { state: 'decided', decision: 'approve', title: 'Hi' } });
  });

  it('refuses an invalid card locally with its RFC code, sending nothing', async () => {
    const { run, err, stub } = setup({ 'bad.json': JSON.stringify({ ...sample(), state: 'open' }) });
    expect(await run('submit', 'bad.json')).toBe(1);
    expect(err[0]).toBe('pbcp: 400 head_owned_field: head-owned fields are not accepted: state');
    expect(stub.requests).toHaveLength(0);
  });

  it('reports a head refusal and exits 1', async () => {
    const { run, err, stub } = setup({ 'c.json': toJSON(sample()) });
    stub.script(403, { error: 'outside_root', message: 'mail is not your root' });
    expect(await run('submit', 'c.json')).toBe(1);
    expect(err[0]).toBe('pbcp: 403 outside_root: mail is not your root');
    stub.script(500, 'boom');
    expect(await run('submit', 'c.json')).toBe(1);
    expect(err[1]).toBe('pbcp: head responded 500\nboom');
  });

  it('exits 1 on a missing file and 2 on a missing argument', async () => {
    const { run } = setup();
    expect(await run('submit', 'nope.json')).toBe(1);
    expect(await run('submit')).toBe(2);
  });
});

describe('pbcp sync', () => {
  const seed = async (n: number, run: (...a: string[]) => Promise<number>, files: Record<string, string>) => {
    for (let i = 1; i <= n; i++) {
      files[`${i}.json`] = toJSON(card({ producer: 'mail', namespace: 'acct', upstream: `m${i}`, kind: 'signal', to_person: 'morten', title: `t${i}`, body: '' }));
      await run('submit', `${i}.json`);
    }
  };

  it('prints every change as a JSON line across pages, then the cursor on stderr', async () => {
    const files: Record<string, string> = {};
    const { run, out, err } = setup(files);
    await seed(3, run, files);
    out.length = 0;
    expect(await run('sync')).toBe(0);
    expect(out.map((l) => JSON.parse(l).seq)).toEqual([1, 2, 3]);
    expect(JSON.parse(out[0]!).card.id).toBe('mail:acct:m1');
    expect(err).toEqual(['next: 3']);
  });

  it('starts after --after', async () => {
    const files: Record<string, string> = {};
    const { run, out } = setup(files);
    await seed(3, run, files);
    out.length = 0;
    await run('sync', '--after', '2');
    expect(out.map((l) => JSON.parse(l).seq)).toEqual([3]);
    expect(await run('sync', '--after', 'x')).toBe(2);
  });

  it('--follow polls on the interval until stopped', async () => {
    const files: Record<string, string> = {};
    const { run, out, io, stub } = setup(files);
    const ac = new AbortController();
    const waits: number[] = [];
    io.signal = ac.signal;
    io.sleep = async (ms) => {
      waits.push(ms);
      if (waits.length === 1) await seed(1, run, files);
      else ac.abort();
    };
    expect(await run('sync', '--follow', '--interval', '3')).toBe(0);
    expect(waits).toEqual([3000, 3000]);
    expect(out.filter((l) => l.startsWith('{"seq"')).map((l) => JSON.parse(l).seq)).toEqual([1]);
    expect(stub.requests.filter((r) => r.method === 'GET').map((r) => r.url)).toEqual([
      'https://head.test/changes?after=0',
      'https://head.test/changes?after=0',
      'https://head.test/changes?after=1',
    ]);
  });
});

describe('pbcp decide', () => {
  it('posts the decision with an edited proposal and comment', async () => {
    const { run, out, stub } = setup({ 'c.json': toJSON(sample()), 'p.md': 'New text\n' });
    await run('submit', 'c.json');
    expect(await run('decide', 'mail:acct:m1', 'edited', '--proposal', 'p.md', '--comment', 'tweak')).toBe(0);
    expect(stub.requests.at(-1)).toMatchObject({
      method: 'POST',
      url: 'https://head.test/cards/mail%3Aacct%3Am1/decision',
      body: { decision: 'edited', edited_proposal: 'New text\n', comment: 'tweak' },
    });
    expect(JSON.parse(out[1]!)).toMatchObject({ status: 200, card: { state: 'decided', decision: 'edited' } });
  });

  it('prints a 409 for an already decided card and exits 0; 404 exits 1', async () => {
    const { run, out, err } = setup({ 'c.json': toJSON(sample()) });
    await run('submit', 'c.json');
    await run('decide', 'mail:acct:m1', 'reject');
    expect(await run('decide', 'mail:acct:m1', 'approve')).toBe(0);
    expect(JSON.parse(out[2]!)).toMatchObject({ status: 409, card: { decision: 'reject' } });
    expect(await run('decide', 'mail:acct:nope', 'approve')).toBe(1);
    expect(err[0]).toMatch(/^pbcp: 404 not_found/);
  });
});

describe('usage', () => {
  it('prints usage for help, and exits 2 for nothing, an unknown command or option', async () => {
    const { run, out, err } = setup();
    expect(await run('--help')).toBe(0);
    expect(out[0]).toMatch(/^usage: pbcp/);
    expect(await run()).toBe(2);
    expect(await run('frobnicate')).toBe(2);
    expect(err.at(-1)).toMatch(/unknown command: frobnicate/);
    expect(await run('describe', '--nope')).toBe(2);
  });
});
