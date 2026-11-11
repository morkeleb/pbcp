// The Todoist facts the executor and the reader need, normalised from the API's task JSON (unified API v1; README, Status).

/** `date` is the due day as Todoist gives it; `time`, when the task has one, is `…Z` (an instant) or floating local time. */
export interface Due { date: string; time?: string; recurring: boolean }
export interface Task {
  id: string; content: string; description: string; state: 'open' | 'done' | 'deleted'; completedAt?: string; url?: string;
  /** Read by the reader only. `priority` is the API's: 4 is p1, 1 is p4. */
  due?: Due; priority?: number; projectId?: string; parentId?: string; labels?: string[]; duration?: { amount: number; unit: 'minute' | 'day' };
  /** The API's `updated_at`, when it gives one; part of the reader's change signature. */
  updatedAt?: string;
}
export interface NewTask { content: string; description: string; due_string?: string }

export interface TodoistSource {
  /** The open task whose description contains `marker`, if any. */
  find(marker: string): Promise<Task | undefined>;
  create(task: NewTask): Promise<Task>;
  /** The task now; `state: 'deleted'` when Todoist no longer has it. */
  get(id: string): Promise<Task>;
  delete(id: string): Promise<void>;
}

/** What the reader (src/reader.ts) needs beyond `get`. */
export interface TodoistReader extends Pick<TodoistSource, 'get'> {
  /** Open tasks due today or overdue, by the Todoist account's own day. */
  due(): Promise<Task[]>;
  /** The open subtasks of a task. */
  subtasks(id: string): Promise<Task[]>;
  /** The texts of a task's comments, oldest first. */
  comments(id: string): Promise<string[]>;
  /** A project's name. */
  project(id: string): Promise<string | undefined>;
  close(id: string): Promise<void>;
  /** Sets the due date from natural language, `tomorrow`; returns the task as it now is. */
  reschedule(id: string, dueString: string): Promise<Task>;
  /** Whether the activity log has the task completed at or after `since` (a timestamp). Tells a completion from a move,
   *  which the task alone does not for a recurring task, and a completion from a deletion when `get` cannot (README, API). */
  completedSince(id: string, since: string): Promise<boolean>;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** One raw task. v1 says `checked` and `is_deleted`; REST v2 said `is_completed`. `url` is the API's when it gives one, else the web
 *  app's task link formed from the id (README, API); a deleted task has none. */
export function task(raw: unknown, id = ''): Task {
  const t = (raw ?? { id, is_deleted: true }) as Obj;
  const state = t.is_deleted === true ? 'deleted' : t.checked === true || t.is_completed === true ? 'done' : 'open';
  const url = state === 'deleted' ? '' : str(t.url) || (str(t.id) && `https://app.todoist.com/app/task/${encodeURIComponent(str(t.id))}`);
  const due = t.due as Obj | null | undefined, dur = t.duration as Obj | null | undefined;
  // v1 puts a due time in `due.date` (`2026-11-05T17:00:00`); REST v2 had a separate `due.datetime`.
  const when = due ? str(due.datetime) || (str(due.date).length > 10 ? str(due.date) : '') : '';
  return {
    id: str(t.id), content: str(t.content), description: str(t.description), state, ...(t.completed_at ? { completedAt: str(t.completed_at) } : {}), ...(url ? { url } : {}),
    ...(due && str(due.date) ? { due: { date: str(due.date).slice(0, 10), ...(when ? { time: when } : {}), recurring: due.is_recurring === true } } : {}),
    ...(typeof t.priority === 'number' ? { priority: t.priority } : {}),
    ...(str(t.project_id) ? { projectId: str(t.project_id) } : {}), ...(str(t.parent_id) ? { parentId: str(t.parent_id) } : {}),
    ...(Array.isArray(t.labels) ? { labels: t.labels.map(str) } : {}),
    ...(str(t.updated_at) ? { updatedAt: str(t.updated_at) } : {}),
    ...(dur && typeof dur.amount === 'number' && (dur.unit === 'minute' || dur.unit === 'day') ? { duration: { amount: dur.amount, unit: dur.unit } } : {}),
  };
}

/** A page of tasks: v1 wraps them in `{ results, next_cursor }`; v2 returned a bare array. */
export const page = (raw: unknown): { tasks: Task[]; next?: string } =>
  Array.isArray(raw) ? { tasks: raw.map((r) => task(r)) } : { tasks: ((raw as Obj).results as unknown[]).map((r) => task(r)), next: str((raw as Obj).next_cursor) || undefined };

const API = 'https://api.todoist.com/api/v1';

/** The label the executor gives the tasks it creates for orders; the reader skips tasks carrying it. */
export const EXECUTOR_LABEL = 'pbcp';

/** Tasks it creates carry `label` (default `EXECUTOR_LABEL`), and `find` looks only at open tasks with that label. */
export function restSource(token: string, opts: { project?: string; label?: string; fetch?: typeof fetch } = {}): TodoistSource & TodoistReader {
  const label = opts.label ?? EXECUTOR_LABEL;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await (opts.fetch ?? fetch)(API + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Todoist ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? undefined : res.json();
  };
  /** Every page of a listing, `{ results, next_cursor }` or a bare array. */
  const all = async (path: string): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (let cursor = ''; ; ) {
      const raw = (await call('GET', `${path}&limit=200${cursor && `&cursor=${encodeURIComponent(cursor)}`}`)) ?? [];
      out.push(...(Array.isArray(raw) ? raw : ((raw as Obj).results as unknown[])));
      if (!(cursor = Array.isArray(raw) ? '' : str((raw as Obj).next_cursor))) return out;
    }
  };
  const e = encodeURIComponent;
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
    due: async () => (await all(`/tasks/filter?query=${e('today | overdue')}`)).map((r) => task(r)),
    subtasks: async (t) => (await all(`/tasks?parent_id=${e(t)}`)).map((r) => task(r)),
    comments: async (t) => (await all(`/comments?task_id=${e(t)}`)).map((c) => str((c as Obj).content)).filter(Boolean),
    project: async (p) => str(((await call('GET', `/projects/${e(p)}`)) as Obj | undefined)?.name) || undefined,
    close: async (t) => void (await call('POST', `/tasks/${e(t)}/close`)),
    reschedule: async (t, due_string) => task(await call('POST', `/tasks/${e(t)}`, { due_string }), t),
    async completedSince(t, since) {
      const events = await all(`/activities?object_type=item&object_id=${e(t)}&event_type=completed&date_from=${e(since)}`);
      return events.some((x) => {
        const ev = x as Obj;
        return ev.event_type === 'completed' && str(ev.object_id) === t && !(Date.parse(str(ev.event_date)) < Date.parse(since));
      });
    },
  };
}
