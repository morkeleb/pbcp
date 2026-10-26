import { card, type HeadClient, type StateStore } from '@pbcp/client';
import { encodeUpstream as enc, type Card, type ProducerCard } from '@pbcp/core';
import type { Check, CodeLink, Edge, GoalPathSource, Item, Milestone, Week } from './source.js';

export interface Config { toPerson: string; projectId: string; tz: string; digestAt?: string; approvalStatus?: string; milestones?: string[]; trendWeeks?: number }
/** One mirrored approval round. `card` is its id; `left` is set once the item was seen out of the queue after the round closed. */
export interface Approval { card: string; round: number; label: string; thread: string; prev?: string; submitted?: boolean; decided?: boolean; answered?: boolean; left?: boolean }
/** The current card of a milestone's risk chain. */
export interface Risk { card: string; projected: string; slipping: boolean }
export interface State { approvals: Record<string, Approval>; risks: Record<string, Risk>; digest?: string }

const ACTIVE = new Set(['Started', 'Finished', 'Delivered']);
const FAILED = new Set(['failure', 'failed', 'error', 'timed_out']);
const KEYWORD = /^(title|section|dateformat|axisformat|tickinterval|excludes|includes|todaymarker|weekday|weekend|inclusiveenddates|topaxis|click|call|href|acc\w*)\b/i;

/** A gantt task name: no `:` `#` `;` `%`, no leading keyword, at most 40 characters. */
export const ganttTitle = (s: string) => (s.replace(/[:#;%]/g, ' ').replace(/\s+/g, ' ').trim() || '(untitled)').replace(KEYWORD, '· $1').slice(0, 40);
const local = (d: Date, tz: string) => d.toLocaleString('sv-SE', { timeZone: tz }); // "YYYY-MM-DD HH:MM:SS"
const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const pct = (w: Week) => `${Math.round(w.ratio * 100)}%`;
const late = (m: Milestone) => !!(m.projected && m.deadline && m.projected > m.deadline);
const label = (i: Item) => `${i.number} ${i.title}`;
const base = (cfg: Config, now: Date) => ({ producer: 'goalpath', to_person: cfg.toPerson, emitted_at: now.toISOString() });
const source = (url: string | undefined, label: string) => (url ? { source: { url, label } } : {});

/** A risk signal when the forecast is past the deadline and differs from the chain's current card; back on track when it recovers. */
export function riskCard(m: Milestone, prev: Risk | undefined, all: Milestone[], edges: Edge[], cfg: Config, now: Date): ProducerCard | undefined {
  if (!m.projected || !m.deadline) return undefined;
  const common = { ...base(cfg, now), namespace: 'milestone', upstream: `${enc(m.id)}.${m.projected.replace(/-/g, '')}`, kind: 'signal' as const, urgency: 'brief' as const, thread: m.id, supersedes: prev?.card, ...source(m.url, 'GoalPath milestone') };
  if (!late(m)) {
    if (!prev?.slipping) return undefined;
    return card({ ...common, intent: 'on-track', title: `${m.name}: back on track, forecast ${short(m.projected)} (deadline ${short(m.deadline)})`, body: `The forecast is now ${m.projected}, on or before the deadline ${m.deadline}. It was ${prev.projected}.` });
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
  return card({ ...common, intent: 'risk', title: `${m.name}: forecast ${short(m.projected)}, ${days(by)} past ${short(m.deadline)}`, body });
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
    title: `Accept ${label(i)}?`, body, ...source(i.url, 'GoalPath item'),
    actions: [{ id: 'accept', label: 'Accept', body: `Sets ${i.number} to Accepted.` }, { id: 'reject', label: 'Reject', body: `Sets ${i.number} to Rejected.` }],
  });
}

export function answeredCard(a: Approval, item: Item | undefined, cfg: Config, now: Date): ProducerCard {
  const where = item ? `it is now ${item.status}` : 'it is no longer assigned to you';
  return card({
    ...base(cfg, now), namespace: 'approval', upstream: a.card.slice('goalpath:approval:'.length), intent: 'answered', kind: 'signal', urgency: 'brief', thread: a.thread, supersedes: a.card,
    title: `${a.label}: answered in GoalPath`, body: `**${a.label}** left the acceptance queue in GoalPath; ${where}. Nothing to decide here.`,
  });
}

export function buildCard(i: Item, l: CodeLink, ch: Check, m: Milestone | undefined, cfg: Config, now: Date): ProducerCard {
  const ref = l.url ? `[${l.ref}](${l.url})` : l.ref;
  return card({
    ...base(cfg, now), namespace: 'build', upstream: enc(ch.runId), kind: 'signal', urgency: 'immediate', thread: i.milestoneId ?? cfg.projectId,
    title: `Build failed: ${ch.name} on ${l.ref} (${i.number})`,
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
  const body = [
    ...(bars.length ? ['```mermaid', 'gantt', '  title Milestone forecasts', '  dateFormat YYYY-MM-DD', '  axisFormat %d %b', ...bars.map(({ m, start }) => `  ${ganttTitle(m.name)} :${late(m) ? 'crit, ' : ''}${start}, ${m.projected}`), '```', ''] : []),
    '**Done** (accepted in the last 24 hours)', ...list(done), '', '**Blocked**', ...list(blocked), '',
    `**Unplanned work.** ${last ? `${pct(last)} of completed work in the week of ${short(last.week)}${before.length ? `; the weeks before, newest first: ${before.map(pct).join(', ')}` : ''}.` : 'Not available.'}`,
  ].join('\n');
  const lateCount = ms.filter(late).length;
  return card({
    ...base(cfg, now), namespace: 'digest', upstream: date, kind: 'artifact', urgency: 'brief', thread: cfg.projectId,
    title: `GoalPath ${short(date)}: ${done.length} done, ${blocked.length} blocked, ${lateCount} milestone${lateCount === 1 ? '' : 's'} late`, body,
  });
}

/** `head`, `produce` and `onDecision` for runProducer. State changes only after the head accepted the card, so a failed submit is retried. */
export function goalpathProducer(head: Pick<HeadClient, 'submit' | 'sync'>, gp: GoalPathSource, store: StateStore<State>, cfg: Config, clock = () => new Date()) {
  const status = new Map<string, number>();
  const ok = (id: string) => status.get(id) === 200 || status.get(id) === 201;
  const load = async (): Promise<State> => ({ approvals: {}, risks: {}, ...(await store.get('state')) });
  const mutate = async (fn: (s: State) => void) => { const s = await load(); fn(s); await store.set('state', s); };
  const closed = (a: Approval) => !!(a.decided || a.answered);
  return {
    head: { sync: (after: number) => head.sync(after), submit: async (c: ProducerCard) => { status.delete(c.id); const r = await head.submit(c); status.set(c.id, r.status); return r; } },

    async *produce(): AsyncGenerator<ProducerCard> {
      const now = clock();
      const [ms, items, edges] = await Promise.all([gp.milestones(), gp.myItems(), gp.dependencies()]);
      const open = items.filter((i) => i.status !== 'Accepted');
      const owned = new Set(cfg.milestones ?? open.flatMap((i) => (i.milestoneId ? [i.milestoneId] : [])));
      const byId = new Map(ms.map((m) => [m.id, m]));

      for (const m of ms.filter((m) => owned.has(m.id))) {
        const c = riskCard(m, (await load()).risks[m.id], ms, edges, cfg, now);
        if (!c) continue;
        yield c;
        if (ok(c.id)) await mutate((s) => { s.risks[m.id] = { card: c.id, projected: m.projected!, slipping: late(m) }; });
      }

      const queue = new Map(open.filter((i) => i.status === (cfg.approvalStatus ?? 'Finished')).map((i) => [i.id, i]));
      for (const i of queue.values()) {
        let a = (await load()).approvals[i.id];
        if (a && closed(a) && !a.left) continue;
        if (!a || closed(a)) {
          const round = (a?.round ?? 0) + 1;
          const fresh: Approval = { card: approvalId(i.id, round), round, label: label(i), thread: i.milestoneId ?? cfg.projectId, prev: a?.card };
          await mutate((s) => { s.approvals[i.id] = fresh; });
          a = fresh;
        }
        if (a.submitted) continue;
        const c = approvalCard(i, byId.get(i.milestoneId ?? ''), a, cfg, now);
        yield c;
        if (status.has(c.id)) await mutate((s) => { s.approvals[i.id]!.submitted = true; });
      }
      for (const [id, a] of Object.entries((await load()).approvals)) {
        if (queue.has(id) || !a.submitted || a.left) continue;
        if (closed(a)) { await mutate((s) => { s.approvals[id]!.left = true; }); continue; }
        const c = answeredCard(a, items.find((i) => i.id === id), cfg, now);
        yield c;
        if (ok(c.id)) await mutate((s) => { Object.assign(s.approvals[id]!, { answered: true, left: true }); });
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
      if ((await load()).digest !== date && time.slice(0, 5) >= (cfg.digestAt ?? '20:00')) {
        const c = digestCard(date, items, ms, await gp.unplannedTrend(cfg.trendWeeks ?? 4), cfg, now);
        yield c;
        if (ok(c.id)) await mutate((s) => { s.digest = date; });
      }
    },

    /** Writes a head decision on the current approval card back to GoalPath, once. GoalPath wins when it answered first. */
    async onDecision(c: Card) {
      if (c.kind !== 'decision' || c.decision === undefined) return;
      const [itemId, a] = Object.entries((await load()).approvals).find(([, a]) => a.card === c.id) ?? [];
      if (!itemId || !a || a.decided || a.answered) return;
      const note = async (...parts: (string | undefined)[]) => { const text = parts.filter(Boolean).join('\n\n'); if (text) await gp.addComment(itemId, text); };
      // §4.3: `edited` accepts the proposal ("Accept GP-N") with the person's text in place of it.
      if (c.decision === 'accept' || c.decision === 'reject' || c.decision === 'edited') {
        await gp.setItemStatus(itemId, c.decision === 'reject' ? 'Rejected' : 'Accepted');
        await note(c.edited_proposal, c.comment);
      } else if (c.decision === 'delegated') await note(`Delegated to ${c.delegated_to}.`, c.comment);
      await mutate((s) => { s.approvals[itemId]!.decided = true; });
    },
  };
}
