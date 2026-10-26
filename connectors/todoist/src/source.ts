// The Todoist facts the executor needs, normalised from the API's task JSON (unified API v1; README, Status).

export interface Task { id: string; content: string; description: string; state: 'open' | 'done' | 'deleted'; completedAt?: string }
export interface NewTask { content: string; description: string; due_string?: string }

export interface TodoistSource {
  /** The open task whose description contains `marker`, if any. */
  find(marker: string): Promise<Task | undefined>;
  create(task: NewTask): Promise<Task>;
  /** The task now; `state: 'deleted'` when Todoist no longer has it. */
  get(id: string): Promise<Task>;
  delete(id: string): Promise<void>;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** One raw task. v1 says `checked` and `is_deleted`; REST v2 said `is_completed`. */
export function task(raw: unknown, id = ''): Task {
  const t = (raw ?? { id, is_deleted: true }) as Obj;
  const state = t.is_deleted === true ? 'deleted' : t.checked === true || t.is_completed === true ? 'done' : 'open';
  return { id: str(t.id), content: str(t.content), description: str(t.description), state, ...(t.completed_at ? { completedAt: str(t.completed_at) } : {}) };
}

/** A page of tasks: v1 wraps them in `{ results, next_cursor }`; v2 returned a bare array. */
export const page = (raw: unknown): { tasks: Task[]; next?: string } =>
  Array.isArray(raw) ? { tasks: raw.map((r) => task(r)) } : { tasks: ((raw as Obj).results as unknown[]).map((r) => task(r)), next: str((raw as Obj).next_cursor) || undefined };

const API = 'https://api.todoist.com/api/v1';

/** Tasks it creates carry `label`, and `find` looks only at open tasks with that label. */
export function restSource(token: string, opts: { project?: string; label?: string; fetch?: typeof fetch } = {}): TodoistSource {
  const label = opts.label ?? 'pbcp';
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await (opts.fetch ?? fetch)(API + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Todoist ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? undefined : res.json();
  };
  return {
    async find(marker) {
      for (let cursor: string | undefined = ''; cursor !== undefined; ) {
        const p = page(await call('GET', `/tasks?label=${encodeURIComponent(label)}&limit=200${cursor && `&cursor=${encodeURIComponent(cursor)}`}`));
        const hit = p.tasks.find((t) => t.state === 'open' && t.description.includes(marker));
        if (hit) return hit;
        cursor = p.next;
      }
    },
    create: async (t) => task(await call('POST', '/tasks', { ...t, labels: [label], ...(opts.project ? { project_id: opts.project } : {}) })),
    get: async (id) => task(await call('GET', `/tasks/${encodeURIComponent(id)}`), id),
    delete: async (id) => void (await call('DELETE', `/tasks/${encodeURIComponent(id)}`)),
  };
}
