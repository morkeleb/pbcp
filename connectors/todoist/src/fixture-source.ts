import { readFileSync } from 'node:fs';
import { page, task, type TodoistSource } from './source.js';

type Raw = Record<string, unknown>;
export type FixtureSource = TodoistSource & { raw: Map<string, Raw>; created: string[]; complete(id: string): void; remove(id: string): void };

/** A source over a recorded `GET /tasks` page, kept in the raw API shape. `complete` and `remove` act as the person in Todoist. */
export function fixtureSource(path: string): FixtureSource {
  const raw = new Map((JSON.parse(readFileSync(path, 'utf8')) as { results: Raw[] }).results.map((t) => [String(t.id), { ...t }]));
  const created: string[] = [];
  const edit = (id: string, patch: Raw) => void raw.set(id, { ...raw.get(id), ...patch });
  return {
    raw, created,
    complete: (id) => edit(id, { checked: true, completed_at: '2026-10-27T08:00:00.000000Z' }),
    remove: (id) => edit(id, { is_deleted: true }),
    find: async (marker) => page({ results: [...raw.values()] }).tasks.find((t) => t.state === 'open' && t.description.includes(marker)),
    async create(t) {
      const id = `6Xfx${String(raw.size + 1).padStart(4, '0')}`;
      created.push(id);
      raw.set(id, { id, content: t.content, description: t.description, labels: ['pbcp'], checked: false, is_deleted: false, completed_at: null, due: t.due_string ? { string: t.due_string, date: null, is_recurring: false, lang: 'en' } : null });
      return task(raw.get(id));
    },
    get: async (id) => task(raw.get(id), id),
    delete: async (id) => void raw.delete(id),
  };
}
