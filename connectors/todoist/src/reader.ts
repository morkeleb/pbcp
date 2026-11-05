// RFC §11.1 "A task reader": each Todoist task due today or overdue becomes a `kind: task` card (§4.1). The person's
// decision is carried out in Todoist, once, and the card is superseded with a `log` artifact that records it (§4.3).

import { card, type KeyValue, type SubmitResponse } from '@pbcp/client';
import { decodeUpstream, encodeUpstream, type Card, type ProducerCard, type Urgency } from '@pbcp/core';
import { EXECUTOR_LABEL, type Task, type TodoistReader } from './source.js';

/** What became of a task card: the person's decision carried out, or a change made in Todoist meanwhile. */
export type Result = 'done' | 'rescheduled' | 'already' | 'dismissed' | 'completed' | 'changed' | 'deleted';

/** The reader's state per task card id (§5 idempotency). `date` is the due day the card is for. `acting` is set before a
 *  call to Todoist and `result` after it; `state` is `closed` once the head has the closing card. */
export interface Rec {
  item: string; date?: string; title: string; thread?: string; url?: string; state: 'open' | 'closed';
  acting?: 'done' | 'tomorrow'; result?: Result; next?: string; recurring?: boolean;
}

export interface ReaderConfig { toPerson: string; timeZone?: string }

const PREFIX = 'todoist:task:';
const ID = /^todoist:task:([^:]+)(?::(\d{4}-\d{2}-\d{2}))?$/;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const iso = (d: Date) => d.toISOString().replace(/\.000Z$/, 'Z');
export const dayIn = (d: Date, zone = 'UTC') => d.toLocaleDateString('en-CA', { timeZone: zone });
export const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

/** A Todoist due time as an instant: `…Z` as it is, a floating local time read in `zone`. */
export function instant(time: string, zone = 'UTC'): Date {
  if (/(Z|[+-]\d\d:\d\d)$/i.test(time)) return new Date(time);
  const local = Date.parse(`${time}Z`);
  const offset = (t: number) => Date.parse(`${new Date(t).toLocaleString('sv-SE', { timeZone: zone }).replace(' ', 'T')}Z`) - t;
  return new Date(local - offset(local - offset(local)));
}

/** The local day a task is due, in `zone` when Todoist gives an instant. */
export const dueDay = (t: Task, zone?: string) => (t.due?.time && /Z$/i.test(t.due.time) ? dayIn(new Date(t.due.time), zone) : t.due?.date);

/** How close a due time must be for a p1 task to interrupt (§4.1a, "within the next few hours"). */
export const IMMEDIATE_MS = 3 * 36e5;

/** §4.1a: a task due on the day (today or overdue) is `brief`, one due later or undated `log`. Priority maps to urgency
 *  only at the top: p1 (the API counts upside down, 4 is p1) is `immediate` when its due time is today and at most
 *  `IMMEDIATE_MS` away, or already passed today. Every task listed is open. */
export const urgencyOf = (priority: number | undefined, day: string | undefined, today: string, at?: Date, now?: Date): Urgency =>
  !day || day > today ? 'log'
    : priority === 4 && day === today && at && now && +at - +now <= IMMEDIATE_MS ? 'immediate'
      : 'brief';

/** §4.1 label grammar: lowercase `a`–`z`, digits and `-`, 1 to 32 characters; empty when nothing is left. */
export const labelOf = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32).replace(/^-+|-+$/g, '');

/** The closing card's title and body, by result (§4.3, §11.1 step 4). */
const CLOSING: Record<Result, (r: Rec) => [string, string]> = {
  dismissed: () => ['Dismissed', 'Dismissed here; left as it is in Todoist.'],
  done: () => ['Done in Todoist', 'Marked done here, and completed in Todoist.'],
  completed: () => ['Done in Todoist', 'Completed in Todoist.'],
  already: () => ['Already completed', 'Todoist already had it completed.'],
  rescheduled: (r) => ['Rescheduled', `Moved to ${r.next} in Todoist.`],
  changed: (r) => ['Changed in Todoist', r.recurring ? `This occurrence is no longer due in Todoist: it was completed or moved there. The next is due ${r.next}.` : r.next ? `Moved to ${r.next} in Todoist.` : 'Its due date was removed in Todoist.'],
  deleted: () => ['Deleted in Todoist', 'The task was deleted in Todoist.'],
};

/** `produce`, `onSubmitted` and `onDecision` for runProducer. `kv` holds a `Rec` per task card id. */
export function todoistReader(src: TodoistReader, kv: KeyValue<Rec>, cfg: ReaderConfig, clock = () => new Date()) {
  const zone = cfg.timeZone;
  const base = { producer: 'todoist', namespace: 'task', to_person: cfg.toPerson } as const;
  const spent = (r?: Rec) => !!r && (r.state === 'closed' || !!r.result);
  /** The subtask and comment parts of a task's body, by task id, with the signature of the listing they were fetched
   *  for: fetched again only when the listing changes (README, Rate). Project names are kept across passes. */
  const parts = new Map<string, { sig: string; subtasks: string[]; comments: string[] }>();
  const projects = new Map<string, Promise<string | undefined>>();
  const named = (p: string) => {
    if (!projects.has(p)) projects.set(p, src.project(p).catch((e: unknown) => { projects.delete(p); throw e; }));
    return projects.get(p)!;
  };
  /** What to record once the head answered a card, by card id; filled by produce, run by onSubmitted. */
  const then = new Map<string, (r: SubmitResponse) => Promise<void>>();
  const after = (c: ProducerCard, fn: (r: SubmitResponse) => Promise<void>) => (then.set(c.id, fn), c);

  /** §11.1 step 5: a recurring task is a card per occurrence, `todoist:task:<id>:<due day>`. Another task is
   *  `todoist:task:<id>`, and once that card is closed, a later due day of the same task takes the dated form too. */
  async function idFor(t: Task, day: string | undefined): Promise<string | undefined> {
    const plain = PREFIX + encodeUpstream(t.id), dated = day && `${plain}:${day}`;
    if (t.due?.recurring) return dated && !spent(await kv.get(dated)) ? dated : undefined;
    const r = await kv.get(plain);
    if (!spent(r)) return plain;
    return dated && r!.date !== day && !spent(await kv.get(dated)) ? dated : undefined;
  }

  /** Subtasks and comments, from the previous pass when the task's listing is unchanged. */
  async function partsOf(t: Task) {
    const sig = JSON.stringify([t.content, t.description, t.due, t.priority, t.labels, t.projectId, t.parentId, t.duration, t.updatedAt]);
    const known = parts.get(t.id);
    if (known?.sig === sig) return known;
    const [subtasks, comments] = await Promise.all([src.subtasks(t.id), src.comments(t.id)]);
    const fresh = { sig, subtasks: subtasks.map((s) => oneLine(s.content)), comments };
    parts.set(t.id, fresh);
    return fresh;
  }

  async function taskCard(t: Task, id: string, today: string, now: Date): Promise<ProducerCard> {
    const [{ subtasks, comments }, project] = await Promise.all([partsOf(t), t.projectId ? named(t.projectId) : undefined]);
    const day = dueDay(t, zone);
    // §4.1a: `at` and `until` only when the task has a time of day; `about` is its due day.
    const at = t.due?.time ? instant(t.due.time, zone) : undefined;
    const until = at && t.duration ? new Date(+at + t.duration.amount * (t.duration.unit === 'day' ? 864e5 : 6e4)) : undefined;
    const [upstream, intent] = id.slice(PREFIX.length).split(':') as [string, string | undefined];
    const body = [
      t.description.trim(),
      subtasks.length ? `## Subtasks\n\n${subtasks.map((s) => `- [ ] ${s}`).join('\n')}` : '',
      comments.length ? `## Comments\n\n${comments.map((c) => c.trim()).join('\n\n')}` : '',
    ].filter(Boolean).join('\n\n');
    return card({
      ...base, upstream, intent, kind: 'task', title: oneLine(t.content) || 'Todoist task', body, urgency: urgencyOf(t.priority, day, today, at, now),
      // §4.1 tasks: grouped under the project, or under the parent task for a subtask.
      thread: t.parentId ? PREFIX + encodeUpstream(t.parentId) : t.projectId ? `todoist:project:${encodeUpstream(t.projectId)}` : undefined,
      labels: [...new Set([project ?? '', ...(t.labels ?? [])].map(labelOf).filter(Boolean))].slice(0, 8),
      about: day, at: at && iso(at), until: until && iso(until),
      ...(t.url ? { source: { url: t.url, label: 'Todoist task' } } : {}),
      // `done` is implicit (§4.1). Rescheduling by due string would drop a recurring task's recurrence, so it has none.
      actions: t.due?.recurring ? undefined : ['tomorrow'],
      emitted_at: iso(clock()),
    });
  }

  /** §4.3: supersedes the task card, in its namespace; a dated card's closing card carries the date (§5, one intent). */
  function closing(id: string, r: Rec): ProducerCard {
    const [upstream, day] = id.slice(PREFIX.length).split(':') as [string, string | undefined];
    const [title, body] = CLOSING[r.result!](r);
    return card({
      ...base, upstream, intent: day ? `closed-${day}` : 'closed', kind: r.result === 'deleted' ? 'signal' : 'artifact', urgency: 'log',
      title, summary: oneLine(r.title), body, thread: r.thread, supersedes: id,
      ...(r.url && r.result !== 'deleted' ? { source: { url: r.url, label: 'Todoist task' } } : {}),
      emitted_at: iso(clock()),
    });
  }

  return {
    async *produce(): AsyncGenerator<ProducerCard> {
      then.clear();
      const now = clock(), today = dayIn(now, zone), listed = new Set<string>();
      // The executor's tasks for orders carry its label; they are already on the head as the order's cards.
      const tasks = (await src.due()).filter((t) => !t.labels?.includes(EXECUTOR_LABEL));
      for (const id of parts.keys()) if (!tasks.some((t) => t.id === id)) parts.delete(id);
      for (const t of tasks) {
        const day = dueDay(t, zone), id = t.state === 'open' ? await idFor(t, day) : undefined;
        if (!id) continue;
        listed.add(id);
        const c = await taskCard(t, id, today, now);
        const rec: Rec = { item: t.id, date: day, title: c.title, thread: c.thread, url: c.source?.url, state: 'open' };
        yield after(c, async (r) => { const prev = await kv.get(id); if (!spent(prev)) await kv.set(id, { ...prev, ...rec, state: r.card.state === 'superseded' ? 'closed' : 'open' }); });
      }
      // §4.3: a task completed, moved or deleted in Todoist while its card is open is superseded the same way, without a decision.
      for (const id of await kv.keys(PREFIX)) {
        const r = (await kv.get(id))!;
        if (spent(r) || r.acting || listed.has(id)) continue;
        const t = await src.get(r.item), day = dueDay(t, zone);
        const result = t.state === 'deleted' ? 'deleted' : t.state === 'done' ? 'completed' : day !== r.date ? 'changed' : undefined;
        if (result) await kv.set(id, { ...r, result, ...(day ? { next: day } : {}), recurring: t.due?.recurring === true });
      }
      for (const id of await kv.keys(PREFIX)) {
        const r = (await kv.get(id))!;
        if (r.state === 'closed' || !r.result) continue;
        yield after(closing(id, r), async () => void (await kv.set(id, { ...r, state: 'closed' })));
      }
    },

    async onSubmitted(c: ProducerCard, r: SubmitResponse) {
      const fn = then.get(c.id);
      then.delete(c.id);
      await fn?.(r);
    },

    /** §11.1 step 3: done completes the task, tomorrow moves it, dismissed leaves it; each once per card id (§5). Each is
     *  then recorded by a closing card (§4.3), dismissed included. */
    async onDecision(c: Card) {
      const m = ID.exec(c.id);
      // A superseded card has its closing card already: only this reader supersedes its cards.
      if (!m || c.kind !== 'task' || !c.decision || c.state === 'superseded') return;
      const prev = await kv.get(c.id);
      if (prev?.result) return;
      const date = m[2] ?? prev?.date ?? c.about;
      const rec: Rec = prev ?? { item: decodeUpstream(m[1]!), ...(date ? { date } : {}), title: c.title, thread: c.thread, url: c.source?.url, state: 'open' };
      const settle = (result: Result, next?: string) => kv.set(c.id, { ...rec, result, ...(next ? { next } : {}) });
      if (c.decision === 'dismissed') return settle('dismissed');
      if (c.decision !== 'done' && c.decision !== 'tomorrow') return;
      const t = await src.get(rec.item);
      if (t.state === 'deleted') return settle('deleted');
      // A call made before a crash shows as its effect; for a recurring task, this occurrence is gone once its day moved.
      const ours = rec.acting === c.decision;
      const gone = t.state === 'done' || (t.due?.recurring === true && dueDay(t, zone) !== rec.date);
      if (c.decision === 'done') {
        if (gone) return settle(ours ? 'done' : 'already');
        await kv.set(c.id, { ...rec, acting: 'done' });
        await src.close(rec.item);
        return settle('done');
      }
      if (gone) return settle('already');
      const tomorrow = nextDay(dayIn(clock(), zone));
      if (ours && dueDay(t, zone) === tomorrow) return settle('rescheduled', tomorrow);
      await kv.set(c.id, { ...rec, acting: 'tomorrow' });
      return settle('rescheduled', dueDay(await src.reschedule(rec.item, 'tomorrow'), zone) ?? tomorrow);
    },
  };
}
