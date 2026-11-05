import { readFileSync } from 'node:fs';
import { nextDay } from './reader.js';
import { EXECUTOR_LABEL, page, task, type TodoistReader, type TodoistSource } from './source.js';

type Raw = Record<string, unknown>;
export type FixtureSource = TodoistSource & TodoistReader & {
  raw: Map<string, Raw>; created: string[]; closed: string[]; rescheduled: string[]; complete(id: string): void; remove(id: string): void;
};

/** A source over a recorded `GET /tasks` page (tasks.json), or recorded tasks, projects and comments pages (due.json), kept
 *  in the raw API shape. `complete` and `remove` act as the person in Todoist; completing a recurring task moves it to the
 *  next day, as `every day` would. `today` is the account's day, for `due()`. */
export function fixtureSource(path: string, opts: { today?: string } = {}): FixtureSource {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { results?: Raw[]; tasks?: { results: Raw[] }; projects?: { results: Raw[] }; comments?: { results: Raw[] } };
  const raw = new Map((doc.tasks?.results ?? doc.results ?? []).map((t) => [String(t.id), { ...t }]));
  const [created, closed, rescheduled]: [string[], string[], string[]] = [[], [], []];
  const edit = (id: string, patch: Raw) => void raw.set(id, { ...raw.get(id), ...patch });
  const complete = (id: string) => {
    const due = raw.get(id)?.due as Raw | null;
    if (due?.is_recurring) edit(id, { due: { ...due, date: nextDay(String(due.date).slice(0, 10)) } });
    else edit(id, { checked: true, completed_at: '2026-10-27T08:00:00.000000Z' });
  };
  const open = () => page({ results: [...raw.values()] }).tasks.filter((t) => t.state === 'open');
  return {
    raw, created, closed, rescheduled, complete,
    remove: (id) => edit(id, { is_deleted: true }),
    find: async (marker) => open().find((t) => t.description.includes(marker)),
    async create(t) {
      const id = `6Xfx${String(raw.size + 1).padStart(4, '0')}`;
      created.push(id);
      raw.set(id, { id, content: t.content, description: t.description, labels: [EXECUTOR_LABEL], checked: false, is_deleted: false, completed_at: null, due: t.due_string ? { string: t.due_string, date: null, is_recurring: false, lang: 'en' } : null });
      return task(raw.get(id));
    },
    get: async (id) => task(raw.get(id), id),
    delete: async (id) => void raw.delete(id),
    due: async () => open().filter((t) => t.due && t.due.date <= (opts.today ?? '')),
    subtasks: async (id) => open().filter((t) => t.parentId === id),
    comments: async (id) => (doc.comments?.results ?? []).filter((c) => c.item_id === id && !c.is_deleted).map((c) => String(c.content)),
    project: async (id) => (doc.projects?.results ?? []).find((p) => p.id === id)?.name as string | undefined,
    close: async (id) => void (closed.push(id), complete(id)),
    async reschedule(id, dueString) {
      if (dueString !== 'tomorrow') throw new Error(`the fixture only reschedules to tomorrow, not ${dueString}`);
      rescheduled.push(id);
      edit(id, { due: { date: nextDay(opts.today ?? ''), string: 'tomorrow', lang: 'en', is_recurring: false, timezone: null } });
      return task(raw.get(id), id);
    },
  };
}
