// RFC §11.1 "A task reader": each Todoist task due today or overdue becomes a `kind: task` card (§4.1). The person's
// decision is carried out in Todoist, once. An outcome that ends the task supersedes the card with a `log` artifact; a
// move keeps it a task: re-PUT under its id while open, superseded by a `moved-<n>` task once decided (§4.3, §8).
// Dismissed ends the card, not the subject: nothing is sent until Todoist ends or re-dates the task.

import { card, type KeyValue, type SubmitResponse } from '@pbcp/client';
import { decodeUpstream, encodeUpstream, type Card, type ProducerCard, type Urgency } from '@pbcp/core';
import { EXECUTOR_LABEL, type Task, type TodoistReader } from './source.js';

/** How a subject ended (§4.3): the person's decision carried out, or the task completed or deleted in Todoist. A move is
 *  not here: it keeps the subject open (§8); nor is a dismissal, which ends only the card (`dismissed` is on records
 *  written before that rule). */
export type Result = 'done' | 'already' | 'dismissed' | 'completed' | 'deleted';

/** The reader's state per subject (§5): a task, or one occurrence of a recurring task, keyed by its first card's id
 *  (`todoist:task:<id>`, or `todoist:task:<id>:<original due day>`). Records are kept, so a closed subject is not sent again
 *  and a `moved-<n>` number is never reused. */
export interface Rec {
  item: string;
  /** The occurrence's original due day, for a recurring task: its id's date segment, kept when it moves (§5). */
  orig?: string;
  /** The due day the current card carries. */
  date?: string;
  title: string; thread?: string; url?: string;
  state: 'open' | 'closed';
  /** The card standing for the subject now, after a decided move, and the card it supersedes (§4.3). Absent: the key. */
  current?: string; prev?: string;
  /** Successors minted so far: the next is `moved-<moves + 1>`. */
  moves?: number;
  /** When the subject's first card was accepted: a completion in Todoist's activity log after it ends the subject. */
  since?: string;
  /** The card the person dismissed, while it is the current card: "not now". The subject stays open and nothing is sent
   *  until Todoist ends the task or changes its due day, which supersedes this card with a `moved-<n>` task (§4.3). */
  dismissed?: string;
  /** Set before a call to Todoist for the decision on `card`, cleared or replaced by `result` after it. */
  acting?: { card: string; decision: 'done' | 'tomorrow' };
  result?: Result;
}

export interface ReaderConfig { toPerson: string; timeZone?: string }

const PREFIX = 'todoist:task:';
/** A task card's id: the task, then the occurrence's date, then `moved-<n>` after a decided move (§4.3, §5). */
const TASK_ID = /^todoist:task:([^:]+)(?::(\d{4}-\d{2}-\d{2})(?:-moved-(\d+))?|:moved-(\d+))?$/;
const plainOf = (item: string) => PREFIX + encodeUpstream(item);
/** The subject key a task card id belongs to, its occurrence date, and its move number. */
function parse(id: string): { key: string; item: string; orig?: string; n: number } | undefined {
  const m = TASK_ID.exec(id);
  if (!m) return undefined;
  const [, up, orig, n1, n2] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined];
  return { key: `${PREFIX}${up}${orig ? `:${orig}` : ''}`, item: decodeUpstream(up), ...(orig ? { orig } : {}), n: Number(n1 ?? n2 ?? 0) };
}
/** The n-th successor of a subject's first card: `<id>:moved-<n>`, or `<id>:<date>-moved-<n>` for an occurrence (§4.3). */
const successor = (key: string, r: Rec, n: number) => (r.orig ? `${key}-moved-${n}` : `${key}:moved-${n}`);

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
const CLOSING: Record<Result, [string, string]> = {
  dismissed: ['Dismissed', 'Dismissed here; left as it is in Todoist.'],
  done: ['Done in Todoist', 'Marked done here, and completed in Todoist.'],
  completed: ['Done in Todoist', 'Completed in Todoist.'],
  already: ['Already completed', 'Todoist already had it completed.'],
  deleted: ['Deleted in Todoist', 'The task was deleted in Todoist.'],
};

/** `produce`, `onSubmitted` and `onDecision` for runProducer. `kv` holds a `Rec` per subject. */
export function todoistReader(src: TodoistReader, kv: KeyValue<Rec>, cfg: ReaderConfig, clock = () => new Date()) {
  const zone = cfg.timeZone;
  const base = { producer: 'todoist', namespace: 'task', to_person: cfg.toPerson } as const;
  const ended = (r?: Rec) => !!r && (r.state === 'closed' || !!r.result);
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

  /** The task's open subject: its undated key, or one of its occurrences. At most one is open at a time. */
  async function openSubject(item: string): Promise<{ key: string; rec: Rec } | undefined> {
    const plain = plainOf(item);
    for (const key of [plain, ...(await kv.keys(`${plain}:`))]) {
      const rec = await kv.get(key);
      if (rec && rec.state === 'open') return { key, rec };
    }
  }

  /** Whether Todoist's activity log has the task completed since the subject's first card; undefined when it cannot say. */
  async function completed(r: Rec): Promise<boolean | undefined> {
    try {
      return await src.completedSince(r.item, r.since ?? '1970-01-01T00:00:00Z');
    } catch {
      return undefined;
    }
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

  async function taskCard(t: Task, id: string, supersedes: string | undefined, today: string, now: Date): Promise<ProducerCard> {
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
      thread: t.parentId ? plainOf(t.parentId) : t.projectId ? `todoist:project:${encodeUpstream(t.projectId)}` : undefined,
      labels: [...new Set([project ?? '', ...(t.labels ?? [])].map(labelOf).filter(Boolean))].slice(0, 8),
      about: day, at: at && iso(at), until: until && iso(until), supersedes,
      ...(t.url ? { source: { url: t.url, label: 'Todoist task' } } : {}),
      // `done` is implicit (§4.1). Rescheduling by due string would drop a recurring task's recurrence, so it has none.
      actions: t.due?.recurring ? undefined : ['tomorrow'],
      emitted_at: iso(clock()),
    });
  }

  /** The subject's current card from the task as it is now: the same id with the new day after a move in Todoist (§5,
   *  §8), or the successor after a decided move (§4.3). Recorded once the head has it open. */
  /** A dismissed subject whose due day changed in Todoist comes back: the next `moved-<n>` supersedes the dismissed card,
   *  numbered from the record and recorded only once the head has it, so a failed PUT mints the same id again. */
  const redated = (key: string, rec: Rec, t: Task, day: string, today: string, now: Date) => {
    const n = (rec.moves ?? 0) + 1;
    return revise(key, { ...rec, dismissed: undefined, moves: n, prev: rec.current ?? key, current: successor(key, rec, n), date: day }, t, today, now);
  };

  async function revise(key: string, rec: Rec, t: Task, today: string, now: Date): Promise<ProducerCard> {
    const id = rec.current ?? key, c = await taskCard(t, id, rec.prev, today, now);
    return after(c, async (r) => {
      if (r.card.state !== 'open') return; // decided: its decision arrives through onDecision
      const latest = await kv.get(key);
      if (ended(latest) || latest?.acting) return;
      await kv.set(key, { ...latest, ...rec, date: c.about, title: c.title, thread: c.thread, url: c.source?.url, state: 'open', current: id, since: latest?.since ?? rec.since ?? iso(now) });
    });
  }

  /** §4.3: an ended subject's closing card supersedes its current card; an occurrence's carries its date (§5, one intent). */
  function closing(key: string, r: Rec): ProducerCard {
    const upstream = key.slice(PREFIX.length).split(':')[0]!;
    const [title, body] = CLOSING[r.result!];
    return card({
      ...base, upstream, intent: r.orig ? `closed-${r.orig}` : 'closed', kind: r.result === 'deleted' ? 'signal' : 'artifact', urgency: 'log',
      title, summary: oneLine(r.title), body, thread: r.thread, supersedes: r.current ?? key,
      ...(r.url && r.result !== 'deleted' ? { source: { url: r.url, label: 'Todoist task' } } : {}),
      emitted_at: iso(clock()),
    });
  }

  return {
    async *produce(): AsyncGenerator<ProducerCard> {
      then.clear();
      const now = clock(), today = dayIn(now, zone), followed = new Set<string>();
      const end = async (key: string, rec: Rec, result: Result) => kv.set(key, { ...rec, result });
      // The executor's tasks for orders carry its label; they are already on the head as the order's cards.
      const tasks = (await src.due()).filter((t) => t.state === 'open' && !t.labels?.includes(EXECUTOR_LABEL));
      for (const id of parts.keys()) if (!tasks.some((t) => t.id === id)) parts.delete(id);
      for (const t of tasks) {
        const day = dueDay(t, zone), recurring = t.due?.recurring === true;
        const open = await openSubject(t.id);
        if (open) {
          followed.add(open.key);
          if (open.rec.acting || open.rec.result) continue; // a decision under way
          // A recurring task due on another day was completed (its next occurrence) or moved: only the activity log's yes ends it.
          if (!(recurring && day !== open.rec.date && (await completed(open.rec)) === true)) {
            if (!open.rec.dismissed) yield await revise(open.key, open.rec, t, today, now);
            else if (day && day !== open.rec.date) yield await redated(open.key, open.rec, t, day, today, now);
            continue; // dismissed and not re-dated: not now, nothing to send
          }
          await end(open.key, open.rec, 'completed');
        }
        // A new subject. A task or occurrence whose subject ended is not sent again (README, Decisions).
        const key = recurring ? (day ? `${plainOf(t.id)}:${day}` : undefined) : plainOf(t.id);
        if (!key || (await kv.get(key))) continue;
        followed.add(key);
        yield await revise(key, { item: t.id, ...(recurring ? { orig: day } : {}), title: t.content, state: 'open' }, t, today, now);
      }
      // §11.1 step 5: a card stays until it is closed or moved, due today or not. What became of a task no longer listed:
      for (const key of await kv.keys(PREFIX)) {
        const rec = (await kv.get(key))!;
        if (followed.has(key) || ended(rec) || rec.acting) continue;
        const t = await src.get(rec.item), day = dueDay(t, zone);
        if (t.state === 'deleted') await end(key, rec, (await completed(rec)) ? 'completed' : 'deleted');
        else if (t.state === 'done') await end(key, rec, 'completed');
        else if (t.due?.recurring && day !== rec.date && (await completed(rec)) === true) await end(key, rec, 'completed');
        else if (!rec.dismissed) yield await revise(key, rec, t, today, now); // moved in Todoist, or a successor waiting for its day
        else if (day && day !== rec.date) yield await redated(key, rec, t, day, today, now);
      }
      for (const key of await kv.keys(PREFIX)) {
        const rec = (await kv.get(key))!;
        if (rec.state === 'closed' || !rec.result) continue;
        yield after(closing(key, rec), async () => void (await kv.set(key, { ...rec, state: 'closed' })));
      }
    },

    async onSubmitted(c: ProducerCard, r: SubmitResponse) {
      const fn = then.get(c.id);
      then.delete(c.id);
      await fn?.(r);
    },

    /** §11.1 step 3: done completes the task, tomorrow moves it, dismissed leaves it; each once per card (§5). Done ends
     *  the subject, recorded by a closing card; tomorrow moves it to a successor task card; dismissed ends only the card,
     *  which stays the current one until Todoist ends or re-dates the task (§4.3). */
    async onDecision(c: Card) {
      const p = parse(c.id);
      // A superseded card has its successor or closing card already: only this reader supersedes its cards.
      if (!p || c.kind !== 'task' || !c.decision || c.state === 'superseded') return;
      const prev = await kv.get(p.key);
      // Acted on already, or an earlier card of a moved subject.
      if (prev?.result || prev?.dismissed === c.id || (prev && (prev.current ?? p.key) !== c.id)) return;
      const rec: Rec = prev ?? {
        item: p.item, ...(p.orig ? { orig: p.orig } : {}), ...(c.about ? { date: c.about } : {}), title: c.title, thread: c.thread, url: c.source?.url,
        state: 'open', current: c.id, moves: p.n, ...(c.supersedes ? { prev: c.supersedes } : {}),
      };
      const settle = (result: Result) => kv.set(p.key, { ...rec, acting: undefined, result });
      if (c.decision === 'dismissed') return kv.set(p.key, { ...rec, acting: undefined, dismissed: c.id });
      if (c.decision !== 'done' && c.decision !== 'tomorrow') return;
      const t = await src.get(rec.item);
      if (t.state === 'deleted') return settle('deleted');
      // A call made before a crash shows as its effect; for a recurring task, this occurrence is gone once its day moved.
      const ours = rec.acting?.card === c.id && rec.acting.decision === c.decision;
      const gone = t.state === 'done' || (t.due?.recurring === true && dueDay(t, zone) !== rec.date);
      if (c.decision === 'done') {
        if (gone) return settle(ours ? 'done' : 'already');
        await kv.set(p.key, { ...rec, acting: { card: c.id, decision: 'done' } });
        await src.close(rec.item);
        return settle('done');
      }
      if (gone) return settle('already');
      // §4.3 moving: the decided card is locked, so its successor `moved-<n>` carries the new day; produce sends it.
      const move = (day?: string) => {
        const n = (rec.moves ?? 0) + 1;
        return kv.set(p.key, { ...rec, acting: undefined, moves: n, prev: c.id, current: successor(p.key, rec, n), ...(day ? { date: day } : {}) });
      };
      const tomorrow = nextDay(dayIn(clock(), zone));
      if (ours && dueDay(t, zone) === tomorrow) return move(tomorrow);
      await kv.set(p.key, { ...rec, acting: { card: c.id, decision: 'tomorrow' } });
      return move(dueDay(await src.reschedule(rec.item, 'tomorrow'), zone) ?? tomorrow);
    },
  };
}
