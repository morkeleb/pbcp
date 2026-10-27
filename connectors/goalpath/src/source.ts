// The GoalPath facts the producer needs, normalised from the MCP tools' JSON. Every raw shape read here is a guess (README).

export interface Milestone { id: string; name: string; start?: string; deadline?: string; projected?: string; confidence?: string; reasons: string[]; url?: string }
export interface Item { id: string; number: string; title: string; status: string; milestoneId?: string; highlights: string[]; acceptedAt?: string; url?: string }
export interface Check { runId: string; name: string; conclusion: string; url?: string }
export interface CodeLink { ref: string; title: string; url?: string; checks: Check[] }
export interface Week { week: string; ratio: number }
export interface Edge { from: string; to: string }

export interface GoalPathSource {
  /** Milestones not Done, each merged with its forecast. Dates are `YYYY-MM-DD`. */
  milestones(): Promise<Milestone[]>;
  /** Items assigned to the current user, Accepted included. */
  myItems(): Promise<Item[]>;
  /** Confirmed code links of an item; suggested ones are dropped. */
  codeActivity(itemId: string): Promise<CodeLink[]>;
  /** Unplanned share of completed work per week, oldest first; empty when unavailable. */
  unplannedTrend(weeks: number): Promise<Week[]>;
  /** Milestone dependencies, prerequisite → enabled. */
  dependencies(): Promise<Edge[]>;
  /** The project's name, for its label (§4.1); undefined when GoalPath does not say. */
  projectName(): Promise<string | undefined>;
  setItemStatus(itemId: string, status: 'Accepted' | 'Rejected'): Promise<void>;
  addComment(itemId: string, content: string): Promise<void>;
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
const line = (v: unknown) => str(v)?.replace(/\s+/g, ' ');
const pick = (o: Obj, ...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);
const date = (v: unknown) => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined; };
const num = (v: unknown) => (typeof v === 'number' ? v : Number(str(v) ?? NaN));
/** A list, bare or under one of `keys` or the usual wrappers. */
const list = (v: unknown, ...keys: string[]): Obj[] => { const a = Array.isArray(v) ? v : pick(obj(v), ...keys, 'items', 'data', 'results'); return Array.isArray(a) ? a.map(obj) : []; };
const strings = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => str(x) ?? str(obj(x).type) ?? str(obj(x).text)).filter((x): x is string => !!x);

export const parse = {
  milestones: (raw: unknown): Milestone[] => list(raw, 'milestones').flatMap((m) => {
    const [id, name] = [str(pick(m, 'id', 'milestoneId')), line(pick(m, 'name', 'title'))];
    if (!id || str(m.status) === 'Done') return [];
    return [{ id, name: name ?? id, start: date(pick(m, 'startDate', 'start')), deadline: date(pick(m, 'deadline', 'dueDate', 'targetDate')), reasons: [], url: str(m.url) }];
  }),
  forecast: (raw: unknown): Partial<Milestone> => {
    const f = obj(pick(obj(raw), 'forecast') ?? raw);
    return {
      projected: date(pick(f, 'projectedCompletionDate', 'projectedDate', 'forecastDate', 'projectedEndDate', 'estimatedCompletionDate')),
      start: date(pick(f, 'startDate', 'forecastStartDate')), deadline: date(pick(f, 'deadline', 'dueDate')),
      confidence: str(f.confidence), reasons: strings(pick(f, 'reasons', 'drivers', 'risks')),
    };
  },
  items: (raw: unknown): Item[] => list(raw).flatMap((i) => {
    const [id, n] = [str(pick(i, 'id', 'itemId')), str(pick(i, 'number', 'shortId', 'key'))];
    if (!id) return [];
    return [{
      id, number: n === undefined ? id : /^\d+$/.test(n) ? `GP-${n}` : n, title: line(pick(i, 'title', 'name')) ?? '(untitled)', status: str(i.status) ?? '',
      milestoneId: str(pick(i, 'milestoneId')) ?? str(obj(i.milestone).id), highlights: strings(pick(i, 'highlights', 'highlight')),
      acceptedAt: str(i.acceptedAt), url: str(i.url),
    }];
  }),
  codeActivity: (raw: unknown): CodeLink[] => list(obj(raw).confirmed).map((l) => {
    const n = str(pick(l, 'number', 'prNumber')), sha = str(pick(l, 'sha', 'commitSha'));
    const checks = list(pick(l, 'checks', 'checkRuns'), 'checks').flatMap((c) => {
      const runId = str(pick(c, 'runId', 'id'));
      return runId ? [{ runId, name: line(c.name) ?? 'build', conclusion: (str(pick(c, 'conclusion', 'status', 'state')) ?? '').toLowerCase(), url: str(c.url) }] : [];
    });
    return { ref: n ? `#${n}` : sha ? sha.slice(0, 7) : (str(l.id) ?? '?'), title: line(pick(l, 'title', 'message')) ?? '', url: str(l.url), checks };
  }),
  trend: (raw: unknown): Week[] => list(raw, 'weeks', 'trend').flatMap((w) => {
    const [p, u, r] = [num(pick(w, 'plannedCount', 'planned')), num(pick(w, 'unplannedCount', 'unplanned')), num(pick(w, 'unplannedRatio', 'ratio'))];
    const ratio = p + u > 0 ? u / (p + u) : r > 1 ? r / 100 : r;
    const week = date(pick(w, 'weekStart', 'week', 'startDate'));
    return week && Number.isFinite(ratio) ? [{ week, ratio }] : [];
  }),
  graph: (raw: unknown): Edge[] => list(raw, 'edges').flatMap((e) => {
    const [from, to] = [str(pick(e, 'prerequisiteId', 'from')), str(pick(e, 'enablesId', 'to'))];
    return from && to ? [{ from, to }] : [];
  }),
};

const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as Partial<T>;

/** A source over any tool caller: the MCP client or recorded fixtures. A milestone whose forecast fails is kept without one. */
export function toolSource(call: CallTool, projectId: string): GoalPathSource {
  return {
    async milestones() {
      const ms = parse.milestones(await call('list_milestones', { projectId }));
      return Promise.all(ms.map(async (m) => ({ ...m, ...defined(parse.forecast(await call('get_milestone_forecast', { milestoneId: m.id }).catch(() => ({})))) })));
    },
    myItems: async () => parse.items(await call('list_my_items', { projectId, includeAccepted: true })),
    codeActivity: async (itemId) => parse.codeActivity(await call('list_code_activity', { itemId })),
    unplannedTrend: (weekCount) => call('get_unplanned_work_trend', { projectId, weekCount }).then(parse.trend, () => []),
    dependencies: async () => parse.graph(await call('get_dependency_graph', { projectId })),
    projectName: () => call('get_project', { projectId }).then((raw) => line(pick(obj(raw), 'name', 'title') ?? pick(obj(obj(raw).project), 'name', 'title')), () => undefined),
    setItemStatus: async (itemId, status) => void (await call('set_item_status', { itemId, status })),
    addComment: async (itemId, content) => void (await call('add_comment', { itemId, content })),
  };
}
