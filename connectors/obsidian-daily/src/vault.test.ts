import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadClient, fileState, memoryCursor, producerPass } from '@pbcp/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubHead } from '../../../packages/client/test/stub.js';
import { dailyNotes } from './vault.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pbcp-obsidian-'));
  await mkdir(join(root, 'My Vault', 'Daily'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const note = (name: string, text: string) => writeFile(join(root, 'My Vault', 'Daily', name), text);

describe('dailyNotes against the stub head', () => {
  it('submits new notes, skips unchanged ones, and replaces changed ones', async () => {
    const stub = stubHead();
    const head = new HeadClient({ baseUrl: 'https://head.test', token: 't', fetch: stub.fetch });
    const state = fileState<string>(join(root, 'state.json'));
    const errors: unknown[] = [];
    const pass = () =>
      producerPass({
        ...dailyNotes({ vault: join(root, 'My Vault'), folder: 'Daily', toPerson: 'morten', head, state }),
        cursor: memoryCursor(),
        onError: (e) => errors.push(e),
      });
    const puts = () => stub.requests.filter((r) => r.method === 'PUT');

    await note('2026-10-26.md', 'Talked to [[Anna]].');
    await note('2027-01-01.md', 'New year.');
    await note('ideas.md', 'not a daily note');
    await pass();
    expect(errors).toEqual([]);
    expect([...stub.cards.keys()].sort()).toEqual(['obsidian:my-vault:2026-10-26', 'obsidian:my-vault:2027-01-01']);
    const first = stub.cards.get('obsidian:my-vault:2026-10-26')!;
    expect(first).toMatchObject({ state: 'open', body: 'Talked to Anna.', thread: '2026-W44', urgency: 'log' });
    expect(stub.cards.get('obsidian:my-vault:2027-01-01')!.thread).toBe('2026-W53');
    expect(puts()).toHaveLength(2);

    await pass();
    expect(puts()).toHaveLength(2);
    expect(stub.cards.get(first.id)!.change_seq).toBe(first.change_seq);

    await note('2026-10-26.md', 'Talked to [[Anna]]. Paid the invoice.');
    await pass();
    expect(puts()).toHaveLength(3);
    const changed = stub.cards.get(first.id)!;
    expect(changed.body).toBe('Talked to Anna. Paid the invoice.');
    expect(changed.change_seq).toBeGreaterThan(first.change_seq);
    expect(errors).toEqual([]);
  });

  it('re-sends after a failed submit, and an identical re-send changes nothing at the head', async () => {
    const stub = stubHead();
    const head = new HeadClient({ baseUrl: 'https://head.test', token: 't', fetch: stub.fetch });
    const opts = (state = fileState<string>(join(root, 'state.json'))) => ({
      ...dailyNotes({ vault: join(root, 'My Vault'), folder: 'Daily', toPerson: 'morten', head, state }),
      cursor: memoryCursor(),
      onError: () => {},
    });
    await note('2026-10-26.md', 'x');
    stub.script(500, { error: 'boom' });
    await producerPass(opts());
    expect(stub.cards.size).toBe(0);
    await producerPass(opts());
    const seq = stub.cards.get('obsidian:my-vault:2026-10-26')!.change_seq;
    await producerPass(opts(fileState<string>(join(root, 'fresh.json')))); // lost state: re-sent, head says 200
    expect(stub.requests.filter((r) => r.method === 'PUT')).toHaveLength(3);
    expect(stub.cards.get('obsidian:my-vault:2026-10-26')!.change_seq).toBe(seq);
  });
});
