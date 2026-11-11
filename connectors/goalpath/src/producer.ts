import { card, type StateStore, type SubmitResponse } from '@pbcp/client';
import { encodeUpstream as enc, type Card, type ProducerCard } from '@pbcp/core';
import type { Check, CodeLink, Edge, GoalPathSource, Item, Milestone, Week } from './source.js';

export interface Config { toPerson: string; projectId: string; tz: string; /** The project's label (§4.1), from `labelOf`. */ label?: string; digestAt?: string; approvalStatus?: string; milestones?: string[]; trendWeeks?: number }
/** One mirrored approval round. `card` is its id; `left` is set once the item was seen out of the queue after the round closed; `url` is the
 *  item's, kept so the answered card can link to it after the item leaves your list. */
export interface Approval { card: string; round: number; label: string; thread: string; prev?: string; url?: string; submitted?: boolean; decided?: boolean; answered?: boolean; left?: boolean }
/** An item's task subject (§5): `card` is its current card, `goalpath:task:<item-id>` or `…:moved-<n>`; `date` and `at` the due day and time
 *  last sent; `moves` the last `<n>` used, so a number never repeats; `prev` the card the current one supersedes. `decision` is set once acted
 *  on; `closed` once the closing card was sent. Stored under `task:<item-id>`; `task:<item-id>:<date>` entries are older dated ones, and `item`
 *  is absent on entries older still. */
export interface Task { card: string; item?: string; date?: string; at?: string; label: string; thread: string; url?: string; submitted?: boolean; decision?: string; closed?: boolean; moves?: number; prev?: string }
/** Why a task ended (§4.3): decided here, or what GoalPath says. */
export type TaskEnd = 'done' | 'dismissed' | 'accepted' | 'rejected' | 'queue' | 'unassigned' | 'deleted';
/** The current card of a milestone's risk chain. */
export interface Risk { card: string; projected: string; slipping: boolean }

const ACTIVE = new Set(['Started', 'Finished', 'Delivered']);
const ENDED = new Set(['Accepted', 'Rejected']);
const FAILED = new Set(['failure', 'failed', 'error', 'timed_out']);
const KEYWORD = /^(title|section|dateformat|axisformat|tickinterval|excludes|includes|todaymarker|weekday|weekend|inclusiveenddates|topaxis|click|call|href|acc\w*)\b/i;

/** A gantt task name: no `:` `#` `;` `%`, no leading keyword, at most 40 characters. */
export const ganttTitle = (s: string) => (s.replace(/[:#;%]/g, ' ').replace(/\s+/g, ' ').trim() || '(untitled)').replace(KEYWORD, '· $1').slice(0, 40);
const local = (d: Date, tz: string) => d.toLocaleString('sv-SE', { timeZone: tz }); // "YYYY-MM-DD HH:MM:SS"
const day = (d: Date, tz: string) => local(d, tz).slice(0, 10);
const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const pct = (w: Week) => `${Math.round(w.ratio * 100)}%`;
const late = (m: Milestone) => !!(m.projected && m.deadline && m.projected > m.deadline);
const label = (i: Item) => `${i.number} ${i.title}`;
const base = (cfg: Config, now: Date) => ({ producer: 'goalpath', to_person: cfg.toPerson, emitted_at: now.toISOString() });
const source = (url: string | undefined, label: string) => (url ? { source: { url, label } } : {});
/** A §4.1 label from a name: lowercase letters, digits and `-`, at most 32 characters; undefined when nothing is left. */
export const labelOf = (name: string) =>
  name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || undefined;
/** `labels`: the project's, then the milestone's when there is one; none when neither gives a label. */
const labels = (cfg: Config, m?: Milestone) => ((ls) => (ls.length ? { labels: ls } : {}))([...new Set([cfg.label, m && labelOf(m.name)].filter((l): l is string => !!l))]);
/** §4.1 `summary`: one line of plain text, cut to 280 characters. */
const summary = (s: string) => ((t) => (t.length > 280 ? `${t.slice(0, 279)}…` : t))(s.replace(/\s+/g, ' ').trim());

/** A risk signal when the forecast is past the deadline and differs from the chain's current card; back on track when it recovers. */
export function riskCard(m: Milestone, prev: Risk | undefined, all: Milestone[], edges: Edge[], cfg: Config, now: Date): ProducerCard | undefined {
  if (!m.projected || !m.deadline) return undefined;
  const common = { ...base(cfg, now), namespace: 'milestone', upstream: `${enc(m.id)}.${m.projected.replace(/-/g, '')}`, kind: 'signal' as const, urgency: 'brief' as const, thread: m.id, supersedes: prev?.card, ...source(m.url, 'GoalPath milestone'), ...labels(cfg, m) };
  if (!late(m)) {
    if (!prev?.slipping) return undefined;
    return card({ ...common, intent: 'on-track', title: `${m.name}: back on track, forecast ${short(m.projected)} (deadline ${short(m.deadline)})`,
      summary: summary(`${m.name} is forecast for ${m.projected} again, on or before its deadline ${m.deadline}. Nothing to decide.`), body: `The forecast is now ${m.projected}, on or before the deadline ${m.deadline}. It was ${prev.projected}.` });
  }
  if (prev?.card === `goalpath:milestone:${common.upstream}:risk`) return undefined;
  const by = Math.round((Date.parse(m.projected) - Date.parse(m.deadline)) / 86_400_000);
  const names = new Map(all.map((x) => [x.id, x.name]));
  const next = edges.filter((e) => e.from === m.id).map((e) => names.get(e.to) ?? e.to);
  const body = [
    `Forecast **${m.projected}**${m.confidence ? ` (confidence: ${m.confidence})` : ''} against the deadline ${m.deadline}: ${days(by)} late.`, '',
    `**What moved.** ${prev && prev.projected !== m.projected ? `The forecast was ${prev.projected} when last reported.` : 'This is the first forecast past the deadline.'}`,
    ...m.reasons.map((r) => `- ${r}`),
    ...(next.length ? ['', `**Also affected.** ${next.join(', ')} depend${next.length === 1 ? 's' : ''} on this milestone.`] : []),
    '', '**Options**',
    `- Cut scope: move items out of ${m.name} until the forecast meets ${m.deadline}.`,
    `- Move the deadline to ${m.projected}${next.length ? ' and re-plan what depends on it' : ''}.`,
    '- Add capacity to the milestone.',
  ].join('\n');
  return card({
    ...common, intent: 'risk', title: `${m.name}: forecast ${short(m.projected)}, ${days(by)} past ${short(m.deadline)}`, body,
    summary: summary(`${m.name} is forecast for ${m.projected}, ${days(by)} past its deadline ${m.deadline}. Cut scope, move the deadline or add capacity.`),
  });
}

export const approvalId = (itemId: string, round: number) => `goalpath:approval:${enc(itemId)}${round > 1 ? `.${round}` : ''}`;

export function approvalCard(i: Item, m: Milestone | undefined, a: Approval, cfg: Config, now: Date): ProducerCard {
  const body = [
    `**${label(i)}** is ${i.status} and waiting for your acceptance.`, '',
    `- Milestone: ${m?.name ?? i.milestoneId ?? 'none'}`,
    ...(i.highlights.length ? [`- Highlights: ${i.highlights.join(', ')}`] : []),
    ...(a.round > 1 ? [`- Back in the queue: round ${a.round}.`] : []),
    '', '## Proposal', '', `Accept ${i.number}. Accepting or rejecting here sets its status in GoalPath.`,
  ].join('\n');
  return card({
    ...base(cfg, now), namespace: 'approval', upstream: a.card.slice('goalpath:approval:'.length), kind: 'decision', urgency: 'brief', thread: a.thread, supersedes: a.prev,
    title: `Accept ${label(i)}?`, body, ...source(i.url, 'GoalPath item'), ...labels(cfg, m),
    // §4.1: on a decision card the summary states the proposal, so the brief's line can be decided on its own.
    summary: summary(`${label(i)} is ${i.status}${m ? ` in ${m.name}` : ''} and waiting for your acceptance. Proposed: accept it, which sets it to Accepted in GoalPath.`),
    actions: [{ id: 'accept', label: 'Accept', body: `Sets ${i.number} to Accepted.` }, { id: 'reject', label: 'Reject', body: `Sets ${i.number} to Rejected.` }],
  });
}

export function answeredCard(a: Approval, item: Item | undefined, cfg: Config, now: Date, m?: Milestone): ProducerCard {
  const where = item ? `it is now ${item.status}` : 'it is no longer assigned to you';
  return card({
    ...base(cfg, now), namespace: 'approval', upstream: a.card.slice('goalpath:approval:'.length), intent: 'answered', kind: 'signal', urgency: 'brief', thread: a.thread, supersedes: a.card,
    title: `${a.label}: answered in GoalPath`, ...source(item?.url ?? a.url, 'GoalPath item'), ...labels(cfg, m), summary: summary(`${a.label} left the acceptance queue in GoalPath; ${where}.`), body: `**${a.label}** left the acceptance queue in GoalPath; ${where}. Nothing to decide here.`,
  });
}

/** `goalpath:task:<item-id>`: the id names the item, never its due day (§5). `date` only forms the ids of older dated entries. */
export const taskId = (itemId: string, date?: string) => `goalpath:task:${enc(itemId)}${date ? `:${date}` : ''}`;
/** A task card id: the item's upstream id, the date of an older dated card, and the move number. */
const TASK_ID = /^goalpath:task:([^:]+)(?::(?:(\d{4}-\d{2}-\d{2})(?:-moved-\d+)?|moved-\d+))?$/;
/** The successor of a decided task whose item was re-dated (§4.3): `…:moved-<n>`; an older dated card keeps its date, `…:<date>-moved-<n>`. */
export function movedId(card: string, n: number) {
  const [, upstream, date] = TASK_ID.exec(card) ?? [];
  return `goalpath:task:${upstream}:${date ? `${date}-` : ''}moved-${n}`;
}
/** The local day an item is due. */
const dueDay = (i: Item, tz: string) => (i.dueAt ? day(new Date(i.dueAt), tz) : i.due!);

/** §4.1 task: due on `about`, at `at` only when GoalPath gives a time; `brief` once due (today or overdue), `log` before (§4.1a). */
export function taskCard(i: Item, m: Milestone | undefined, cfg: Config, now: Date, id = taskId(i.id), supersedes?: string): ProducerCard {
  const about = dueDay(i, cfg.tz), prefix = `goalpath:task:${enc(i.id)}:`;
  const what = `${label(i)} is ${i.status}${m ? ` in ${m.name}` : ''}, due ${about}${i.dueAt ? ` at ${local(new Date(i.dueAt), cfg.tz).slice(11, 16)}` : ''}.`;
  return card({
    ...base(cfg, now), namespace: 'task', upstream: enc(i.id), intent: id.startsWith(prefix) ? id.slice(prefix.length) : undefined, supersedes, kind: 'task', urgency: about <= day(now, cfg.tz) ? 'brief' : 'log', about, ...(i.dueAt ? { at: i.dueAt } : {}),
    thread: i.milestoneId ?? cfg.projectId, title: label(i), summary: summary(what), body: i.description ?? what, ...source(i.url, 'GoalPath item'), ...labels(cfg, m),
  });
}

/** The card that ends a task (§4.3): a `log` artifact saying what happened, a `signal` when the item was deleted in GoalPath (§6). */
export function taskClosedCard(t: Task, item: Item | undefined, why: TaskEnd, cfg: Config, now: Date, m?: Milestone): ProducerCard {
  const [title, text] = {
    done: ['done in GoalPath', 'Marked done here; set to Accepted in GoalPath.'],
    dismissed: ['dismissed', `Dismissed here; left as it is in GoalPath${item ? ` (${item.status})` : ''}.`],
    accepted: ['done in GoalPath', 'Accepted in GoalPath.'],
    rejected: ['rejected in GoalPath', 'Rejected in GoalPath.'],
    queue: ['waiting for acceptance', `${item?.status} in GoalPath and waiting for your acceptance; the approval card asks for it.`],
    unassigned: ['closed in GoalPath', 'It is no longer assigned to you in GoalPath.'],
    deleted: ['deleted in GoalPath', 'Deleted in GoalPath.'],
  }[why];
  const [, upstream, date] = TASK_ID.exec(t.card) ?? [];
  return card({
    // §5: one intent segment, so an older dated task closes as `closed-<date>`.
    ...base(cfg, now), namespace: 'task', upstream: upstream!, intent: date ? `closed-${date}` : 'closed', kind: why === 'deleted' ? 'signal' : 'artifact', urgency: 'log', thread: t.thread, supersedes: t.card,
    title: `${t.label}: ${title}`, summary: summary(`${t.label}: ${text}`), body: `**${t.label}**: ${text}`, ...source(item?.url ?? t.url, 'GoalPath item'), ...labels(cfg, m),
  });
}

export function buildCard(i: Item, l: CodeLink, ch: Check, m: Milestone | undefined, cfg: Config, now: Date): ProducerCard {
  const ref = l.url ? `[${l.ref}](${l.url})` : l.ref;
  return card({
    ...base(cfg, now), namespace: 'build', upstream: enc(ch.runId), kind: 'signal', urgency: 'immediate', thread: i.milestoneId ?? cfg.projectId, ...labels(cfg, m),
    title: `Build failed: ${ch.name} on ${l.ref} (${i.number})`,
    summary: summary(`${ch.name} ended ${ch.conclusion} on ${l.ref}, linked to ${label(i)}${m ? ` in ${m.name}` : ''}.`),
    body: `**${ch.name}** ended \`${ch.conclusion}\` on ${ref}${l.title ? ` ${l.title}` : ''}, linked to **${label(i)}**${m ? ` in ${m.name}` : ''}.`,
    ...source(ch.url ?? l.url, 'Build run'),
  });
}

export function digestCard(date: string, items: Item[], ms: Milestone[], trend: Week[], cfg: Config, now: Date): ProducerCard {
  const since = +now - 86_400_000;
  const done = items.filter((i) => i.status === 'Accepted' && i.acceptedAt && Date.parse(i.acceptedAt) >= since);
  const blocked = items.filter((i) => i.status !== 'Accepted' && i.highlights.includes('Blocked'));
  const list = (xs: Item[]) => (xs.length ? xs.map((i) => `- ${label(i)}`) : ['- none']);
  const bars = ms.filter((m) => m.projected).slice(0, 20).map((m) => ({ m, start: [m.start ?? date, m.projected!].sort()[0]! })).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const [last, ...before] = [...trend].reverse();
  const lateCount = ms.filter(late).length;
  const counts = `${done.length} done, ${blocked.length} blocked, ${lateCount} milestone${lateCount === 1 ? '' : 's'} late`;
  const are = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const body = [
    // The body opens with a sentence, so the card reads on its own before the chart and the lists.
    `${are(done.length, 'item was', 'items were')} accepted in the last 24 hours and ${are(blocked.length, 'is', 'are')} blocked; ${are(lateCount, 'milestone is', 'milestones are')} forecast past ${lateCount === 1 ? 'its' : 'their'} deadline.`, '',
    ...(bars.length ? ['```mermaid', 'gantt', '  title Milestone forecasts', '  dateFormat YYYY-MM-DD', '  axisFormat %d %b', ...bars.map(({ m, start }) => `  ${ganttTitle(m.name)} :${late(m) ? 'crit, ' : ''}${start}, ${m.projected}`), '```', ''] : []),
    '**Done** (accepted in the last 24 hours)', ...list(done), '', '**Blocked**', ...list(blocked), '',
    `**Unplanned work.** ${last ? `${pct(last)} of completed work in the week of ${short(last.week)}${before.length ? `; the weeks before, newest first: ${before.map(pct).join(', ')}` : ''}.` : 'Not available.'}`,
  ].join('\n');
  return card({
    ...base(cfg, now), namespace: 'digest', upstream: date, kind: 'artifact', urgency: 'brief', thread: cfg.projectId, ...labels(cfg),
    title: `GoalPath ${short(date)}: ${counts}`, body,
    summary: summary(`${done.length} done, ${blocked.length} blocked and ${lateCount} milestone${lateCount === 1 ? '' : 's'} late in GoalPath on ${short(date)}.`),
  });
}

/** One state entry per key in the store's `goalpath` namespace: `risk:<milestone-id>`, `approval:<item-id>`, `task:<item-id>` (and older dated `task:<item-id>:<date>`), `digest`. */
export const NAMESPACE = 'goalpath';

/**
 * `produce`, `onSubmitted` and `onDecision` for runProducer. State changes only once the head answered the card
 * (onSubmitted), so a failed submit is recomputed and retried on the next pass.
 */
export function goalpathProducer(gp: GoalPathSource, store: StateStore, cfg: Config, clock = () => new Date()) {
  const kv = store.kv<Risk | Approval | Task | string>(NAMESPACE);
  const risk = async (id: string) => (await kv.get(`risk:${id}`)) as Risk | undefined;
  const approval = async (id: string) => (await kv.get(`approval:${id}`)) as Approval | undefined;
  const setApproval = (id: string, a: Approval) => kv.set(`approval:${id}`, a);
  const approvals = async () => Promise.all((await kv.keys('approval:')).map(async (k) => [k.slice('approval:'.length), (await kv.get(k)) as Approval] as const));
  const setTask = (key: string, t: Task) => kv.set(key, t);
  /** Every task entry by store key, with `item` filled in (an old entry's key is `task:<item-id>`). */
  const tasks = async () => Promise.all((await kv.keys('task:')).map(async (k) => ((t) => [k, { ...t, item: t.item ?? k.slice('task:'.length) }] as const)((await kv.get(k)) as Task)));
  const closed = (a: Approval) => !!(a.decided || a.answered);
  /** What to record once the head answered a card, by card id; filled by produce, run by onSubmitted. */
  const then = new Map<string, (r: SubmitResponse) => Promise<void>>();
  const after = (c: ProducerCard, fn: (r: SubmitResponse) => Promise<void>) => (then.set(c.id, fn), c);
  const ok = (r: SubmitResponse) => r.status !== 409;
  return {
    async *produce(): AsyncGenerator<ProducerCard> {
      then.clear();
      const now = clock();
      const [ms, items, edges] = await Promise.all([gp.milestones(), gp.myItems(), gp.dependencies()]);
      const open = items.filter((i) => i.status !== 'Accepted');
      const owned = new Set(cfg.milestones ?? open.flatMap((i) => (i.milestoneId ? [i.milestoneId] : [])));
      const byId = new Map(ms.map((m) => [m.id, m]));

      for (const m of ms.filter((m) => owned.has(m.id))) {
        const c = riskCard(m, await risk(m.id), ms, edges, cfg, now);
        if (c) yield after(c, async (r) => void (ok(r) && (await kv.set(`risk:${m.id}`, { card: c.id, projected: m.projected!, slipping: late(m) }))));
      }

      const queue = new Map(open.filter((i) => i.status === (cfg.approvalStatus ?? 'Finished')).map((i) => [i.id, i]));
      for (const i of queue.values()) {
        let a = await approval(i.id);
        if (a && closed(a) && !a.left) continue;
        if (!a || closed(a)) {
          const round = (a?.round ?? 0) + 1;
          a = { card: approvalId(i.id, round), round, label: label(i), thread: i.milestoneId ?? cfg.projectId, prev: a?.card, ...(i.url ? { url: i.url } : {}) };
          await setApproval(i.id, a);
        }
        if (a.submitted) continue;
        const fresh = a;
        yield after(approvalCard(i, byId.get(i.milestoneId ?? ''), a, cfg, now), () => setApproval(i.id, { ...fresh, submitted: true }));
      }
      for (const [id, a] of await approvals()) {
        if (queue.has(id) || !a.submitted || a.left) continue;
        if (closed(a)) { await setApproval(id, { ...a, left: true }); continue; }
        const item = items.find((i) => i.id === id);
        yield after(answeredCard(a, item, cfg, now, byId.get(item?.milestoneId ?? '')), async (r) => void (ok(r) && (await setApproval(id, { ...a, answered: true, left: true }))));
      }

      // Tasks (§4.3, §5, §8, §11.1): one subject per item, `goalpath:task:<item-id>`. A card sent is followed until it is closed or moved,
      // whether or not the item is still listed: re-PUT while open, so a moved due date or the due day arriving revises it; superseded by a
      // `moved-<n>` task when it was dismissed and the item is then re-dated; closed when the item ends. A closed subject is not sent again.
      const queued = cfg.approvalStatus ?? 'Finished';
      const mine = new Map(items.map((i) => [i.id, i]));
      const known = await tasks();
      for (const [key, t] of known) {
        if (!t.submitted || t.closed) continue;
        const listed = mine.get(t.item!);
        const item = listed ?? (await gp.item(t.item!)); // undefined: deleted in GoalPath
        const m = byId.get(item?.milestoneId ?? t.thread);
        const ended: TaskEnd | undefined = !item ? 'deleted' : !listed ? 'unassigned' : item.status === 'Accepted' ? 'accepted' : item.status === 'Rejected' ? 'rejected' : item.status === queued ? 'queue' : undefined;
        const d = item?.due ? dueDay(item, cfg.tz) : undefined;
        if (t.decision === 'dismissed' && !ended && d && d !== t.date) {
          // Moved after it was decided: the decided card is locked, so a task supersedes it (§4.3); a move closes nothing (§8).
          const n = (t.moves ?? 0) + 1, c = taskCard(item!, m, cfg, now, movedId(t.card, n), t.card);
          yield after(c, () => setTask(key, { card: c.id, item: t.item, date: d, ...(item!.dueAt ? { at: item!.dueAt } : {}), label: label(item!), thread: c.thread!, ...(item!.url ? { url: item!.url } : {}), submitted: true, moves: n, prev: t.card }));
        } else if (t.decision || ended) {
          const c = taskClosedCard(t, item, t.decision === 'done' ? 'done' : t.decision ? 'dismissed' : ended!, cfg, now, m);
          yield after(c, async (r) => void (ok(r) && (await setTask(key, { ...t, closed: true }))));
        } else {
          // Open: re-PUT under its id (§5). An item that lost its due date keeps the day last sent; the card stays until closed or moved.
          const shown = item!.due ? item! : { ...item!, due: t.date, dueAt: t.at };
          const c = taskCard(shown, m, cfg, now, t.card, t.prev);
          // A 409 means it was decided on the head: the decision arrives by sync, and the day it was decided on stays recorded.
          yield after(c, async (r) => void (ok(r) && (await setTask(key, { ...t, date: dueDay(shown, cfg.tz), at: shown.dueAt, label: label(shown), thread: c.thread!, ...(shown.url ? { url: shown.url } : {}) }))));
        }
      }
      // A new subject: an item assigned to you with a due date, not ended and not in the approval queue (its approval card asks for it).
      const followed = new Set(known.map(([, t]) => t.item));
      for (const i of items.filter((i) => i.due && !ENDED.has(i.status) && i.status !== queued && !followed.has(i.id))) {
        const c = taskCard(i, byId.get(i.milestoneId ?? ''), cfg, now);
        yield after(c, () => setTask(`task:${i.id}`, { card: c.id, item: i.id, date: dueDay(i, cfg.tz), ...(i.dueAt ? { at: i.dueAt } : {}), label: label(i), thread: c.thread!, ...(i.url ? { url: i.url } : {}), submitted: true }));
      }

      const runs = new Set<string>();
      for (const i of open.filter((i) => ACTIVE.has(i.status) && owned.has(i.milestoneId ?? '')).sort((a, b) => (a.id < b.id ? -1 : 1)))
        for (const l of await gp.codeActivity(i.id))
          for (const ch of l.checks) {
            if (!FAILED.has(ch.conclusion) || runs.has(ch.runId)) continue;
            runs.add(ch.runId);
            yield buildCard(i, l, ch, byId.get(i.milestoneId ?? ''), cfg, now);
          }

      const [date, time] = local(now, cfg.tz).split(' ') as [string, string];
      if ((await kv.get('digest')) !== date && time.slice(0, 5) >= (cfg.digestAt ?? '20:00')) {
        const c = digestCard(date, items, ms, await gp.unplannedTrend(cfg.trendWeeks ?? 4), cfg, now);
        yield after(c, async (r) => void (ok(r) && (await kv.set('digest', date))));
      }
    },

    async onSubmitted(c: ProducerCard, r: SubmitResponse) {
      const fn = then.get(c.id);
      then.delete(c.id);
      await fn?.(r);
    },

    /** Writes a head decision on the current approval card, or on a task, back to GoalPath, once. GoalPath wins when it answered first. */
    async onDecision(c: Card) {
      if (c.decision === undefined) return;
      if (c.kind === 'task') {
        const [key, t] = (await tasks()).find(([, t]) => t.card === c.id) ?? [];
        if (!key || !t || t.decision || t.closed) return;
        if (c.decision === 'done') {
          await gp.setItemStatus(t.item!, 'Accepted');
          if (c.comment) await gp.addComment(t.item!, c.comment);
        }
        return setTask(key, { ...t, decision: c.decision });
      }
      if (c.kind !== 'decision') return;
      const [itemId, a] = (await approvals()).find(([, a]) => a.card === c.id) ?? [];
      if (!itemId || !a || a.decided || a.answered) return;
      const note = async (...parts: (string | undefined)[]) => { const text = parts.filter(Boolean).join('\n\n'); if (text) await gp.addComment(itemId, text); };
      // §4.3: `edited` accepts the proposal ("Accept GP-N") with the person's text in place of it.
      if (c.decision === 'accept' || c.decision === 'reject' || c.decision === 'edited') {
        await gp.setItemStatus(itemId, c.decision === 'reject' ? 'Rejected' : 'Accepted');
        await note(c.edited_proposal, c.comment);
      } else if (c.decision === 'delegated') await note(`Delegated to ${c.delegated_to}.`, c.comment);
      await setApproval(itemId, { ...a, decided: true });
    },
  };
}
