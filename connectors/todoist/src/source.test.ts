import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { restSource, task } from './source.js';

const recorded = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/tasks.json', import.meta.url)), 'utf8')) as { results: Record<string, unknown>[] };

describe('restSource', () => {
  it('links a task: the url from the API when given, else the web app task address, and none once deleted', () => {
    expect(task({ id: '6Xfx0001', content: 'x', url: 'https://todoist.example/t/1' }).url).toBe('https://todoist.example/t/1');
    expect(task({ id: '6Xfx0001', content: 'x' }).url).toBe('https://app.todoist.com/app/task/6Xfx0001');
    expect(task({ id: '6Xfx0001', is_deleted: true }).url).toBeUndefined();
    expect(task(undefined, 'gone').url).toBeUndefined();
  });

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

  it('reads due, recurring and timed tasks, subtasks, comments and project names, and closes and reschedules (reader)', async () => {
    const due = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/due.json', import.meta.url)), 'utf8')) as Record<string, { results: Record<string, unknown>[] }>;
    const calls: string[] = [];
    const fake: typeof fetch = async (url, init) => {
      const u = new URL(String(url));
      calls.push(`${init?.method ?? 'GET'} ${u.pathname}${u.search}${init?.body ? ` ${String(init.body)}` : ''}`);
      if (u.pathname === '/api/v1/tasks/filter') return Response.json({ results: due.tasks!.results.slice(0, 3), next_cursor: null });
      if (u.pathname === '/api/v1/tasks') return Response.json({ results: [due.tasks!.results[3]], next_cursor: null });
      if (u.pathname === '/api/v1/comments') return Response.json(due.comments);
      if (u.pathname === '/api/v1/projects/6Xfp0002') return Response.json(due.projects!.results[1]);
      if (u.pathname.endsWith('/close')) return new Response(null, { status: 204 });
      return Response.json({ ...due.tasks!.results[2], due: { date: '2026-11-06', string: 'tomorrow', is_recurring: false } });
    };
    const src = restSource('tok', { fetch: fake });
    const [bank, plants, passport] = await src.due();
    expect(bank).toMatchObject({ id: '6Xfx0101', priority: 4, projectId: '6Xfp0002', labels: ['Errands', 'phone'], due: { date: '2026-11-05', time: '2026-11-05T17:00:00', recurring: false }, duration: { amount: 30, unit: 'minute' } });
    expect(plants!.due).toEqual({ date: '2026-11-04', recurring: true });
    expect(passport!.due).toEqual({ date: '2026-11-05', recurring: false });
    expect((await src.subtasks('6Xfx0101')).map((t) => t.parentId)).toEqual(['6Xfx0101']);
    expect(await src.comments('6Xfx0101')).toEqual(['Their number is on the back of the card.']);
    expect(await src.project('6Xfp0002')).toBe('Home & Garden');
    await src.close('6Xfx0101');
    expect((await src.reschedule('6Xfx0103', 'tomorrow')).due).toEqual({ date: '2026-11-06', recurring: false });
    expect(calls).toEqual([
      'GET /api/v1/tasks/filter?query=today%20%7C%20overdue&limit=200',
      'GET /api/v1/tasks?parent_id=6Xfx0101&limit=200',
      'GET /api/v1/comments?task_id=6Xfx0101&limit=200',
      'GET /api/v1/projects/6Xfp0002',
      'POST /api/v1/tasks/6Xfx0101/close',
      'POST /api/v1/tasks/6Xfx0103 {"due_string":"tomorrow"}',
    ]);
  });
});
