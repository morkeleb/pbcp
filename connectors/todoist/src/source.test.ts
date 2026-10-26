import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { restSource } from './source.js';

const recorded = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/tasks.json', import.meta.url)), 'utf8')) as { results: Record<string, unknown>[] };

describe('restSource', () => {
  it('pages through labelled tasks, posts new ones with the label and project, and reads 404 as deleted', async () => {
    const calls: [string, string, unknown][] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push([init?.method ?? 'GET', String(url), init?.body ? JSON.parse(String(init.body)) : undefined]);
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/tasks' && init?.method === 'GET')
        return Response.json(u.searchParams.get('cursor') ? { results: [{ ...recorded.results[1], id: '6Xfx0009', checked: false, description: 'pbcp: head:order:X' }], next_cursor: null } : { ...recorded, next_cursor: 'c2' });
      if (init?.method === 'POST') return Response.json({ ...recorded.results[0], id: '6Xfx0010', content: 'Buy milk' });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    };
    const src = restSource('tok', { project: 'p1', fetch: fake });
    expect(await src.find('pbcp: head:order:X')).toMatchObject({ id: '6Xfx0009', state: 'open' });
    expect(await src.find('pbcp: head:order:01JBXZ0000000000000000000A')).toBeUndefined(); // completed: not open
    expect(await src.create({ content: 'Buy milk', description: 'd', due_string: 'friday' })).toMatchObject({ id: '6Xfx0010', state: 'open' });
    expect(await src.get('gone')).toEqual({ id: 'gone', content: '', description: '', state: 'deleted' });
    await src.delete('6Xfx0010');
    expect(calls.map(([m, u]) => `${m} ${u}`)).toEqual([
      'GET https://api.todoist.com/api/v1/tasks?label=pbcp&limit=200',
      'GET https://api.todoist.com/api/v1/tasks?label=pbcp&limit=200&cursor=c2',
      'GET https://api.todoist.com/api/v1/tasks?label=pbcp&limit=200',
      'GET https://api.todoist.com/api/v1/tasks?label=pbcp&limit=200&cursor=c2',
      'POST https://api.todoist.com/api/v1/tasks',
      'GET https://api.todoist.com/api/v1/tasks/gone',
      'DELETE https://api.todoist.com/api/v1/tasks/6Xfx0010',
    ]);
    expect(calls[4]![2]).toEqual({ content: 'Buy milk', description: 'd', due_string: 'friday', labels: ['pbcp'], project_id: 'p1' });
  });
});
