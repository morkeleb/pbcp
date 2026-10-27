# PBCP Reference Implementation — Repo Skeleton

Oct 26, 2026 · @Morten Nielsen · Companion to RFC Draft 0.5

## Layout

Two repos, split on the licence line. `pbcp` (MIT) holds the RFC, the packages, the conformance suite and the connectors — everything you want forked and contributed to, with no head in it. `head` (Sustainable Use) holds the Next.js app and the iOS app, which share one API contract and change in lockstep. The head pins `@pbcp/core` from npm and runs its conformance suite in CI, so the protocol never knows the app exists and the app cannot drift from the spec. Not three repos: the phone and its server belong together, and the connectors belong with the protocol. Work starts in `pbcp`, with `@pbcp/core` and the conformance suite, before any HTTP exists.

## Repo 1 — `pbcp` (MIT)

The protocol and everything that speaks it. No head, no UI, nothing to deploy. Publishes three npm packages under one version.

```
pbcp/
├── rfc/                       the RFC as markdown, versioned with the packages
├── packages/
│   ├── core/                  @pbcp/core — the protocol, no I/O
│   │   ├── src/
│   │   │   ├── card.ts        Card type, parse/serialize (JSON ⇄ front matter), equality
│   │   │   ├── id.ts          id grammar, namespace checks
│   │   │   ├── yaml.ts        restricted-YAML reader/writer (strings only)
│   │   │   ├── lifecycle.ts   core state machine: submit/decide/supersede as pure transitions
│   │   │   ├── orders.ts      extension: exec_state machine, lease evaluation
│   │   │   ├── errors.ts      typed refusals mapped to the RFC status codes
│   │   │   └── index.ts
│   │   └── conformance/       fixtures + a vitest runner any head can run
│   ├── client/                @pbcp/client — what a connector installs
│   │   └── src/
│   │       ├── head.ts        HeadClient: submit, sync, claim, renew, decide
│   │       ├── producer.ts    durable-cursor loop, cursor store interface
│   │       ├── executor.ts    order loop: claim → run → renew → outcome, A.5 built in
│   │       └── index.ts
│   ├── cli/                   @pbcp/cli — `pbcp` command over HeadClient: describe, submit, sync, decide
│   └── mcp/                   @pbcp/mcp — MCP server adapter over HeadClient
└── connectors/                examples, each < 100 lines on @pbcp/client
    ├── imap/                  mailbox → decision cards
    ├── caldav/                day agenda → artifact card
    ├── obsidian-daily/        yesterday's note → log card
    ├── n8n/                   n8n-nodes-pbcp: trigger + two action nodes
    ├── hermes/                Hermes Agent plugin: mcp.json + two skills
    └── goalpath/              project tracker → head: risk signals, approvals; orders → reprioritise
```

Publishing: `@pbcp/core` and `@pbcp/client` to npm under one version; the head is deployed from `apps/head` to Vercel and runnable locally with `docker compose up` (Postgres only). `@pbcp/mcp` is optional and tiny; it exists so Hermes, Claude Code and friends get the three operations as tools without each writing an HTTP wrapper.

### @pbcp/core

Pure functions over plain objects. Every RFC MUST that can be checked without a database lives here, so a head is mostly plumbing around these calls. Zod for the schema so the types and the runtime validation are one definition.

```ts
// card.ts
export type Kind = 'decision' | 'artifact' | 'signal' | 'order';
export type Urgency = 'immediate' | 'brief' | 'log';
export type State = 'open' | 'decided' | 'superseded';

export interface ProducerCard {          // §4.1 — what a producer sends
  protocol: 'pbcp/1';
  id: string; kind: Kind; producer: string; title: string; body: string;
  to_person?: string; to_producer?: string;   // exactly one, by kind
  urgency?: Urgency; thread?: string; references?: string[];
  supersedes?: string; actions?: string[]; emitted_at: string;
  source?: { url: string; label?: string };
  [ext: `${string}.${string}`]: unknown;      // extension fields, e.g. 'orders.claim_seq'
}

export interface HeadFields {            // §4.2 + A.1 — head-owned
  state: State; change_seq: number; received_at: string; changed_at: string;
  seen_at?: string; acknowledged_at?: string; snoozed_until?: string;
  decision?: string; edited_proposal?: string; comment?: string;
  decided_at?: string; delegated_to?: string;
  exec_state?: ExecState; claimed_by?: string; claim_expires_at?: string; claim_seq?: number;
}
export type Card = ProducerCard & HeadFields;

export const parseCard: (input: unknown | string) => Result<ProducerCard, PbcpError>;
  // JSON object or front-matter text; rejects head-owned fields, bad ids, YAML outside the subset
export const toFrontMatter: (c: ProducerCard) => string;
export const toJSON: (c: ProducerCard) => string;
export const equal: (a: ProducerCard, b: ProducerCard) => boolean;   // §5: all producer fields except emitted_at

// id.ts
export const parseId: (id: string) => { producer: string; namespace: string; upstream: string; intent?: string } | null;
export const sameNamespace: (a: string, b: string) => boolean;         // producer + namespace segments
export const inRoot: (id: string, root: string) => boolean;

// lifecycle.ts — pure transitions; the head applies the returned effect in one transaction
export const submit: (stored: Card | null, incoming: ProducerCard, now: string) =>
  | { status: 201 | 200; card: Card; superseded?: string }
  | { status: 409; card: Card };
export const decide: (stored: Card, d: Decision, now: string) =>
  | { status: 200; card: Card; cancelOrder?: true }
  | { status: 409; card: Card };
export const canSupersede: (target: Card | null, incoming: ProducerCard) => PbcpError | null;

// orders.ts (extension) — every transition also returns `changed`, as lifecycle.ts does
export type ExecState = 'open' | 'claimed' | 'done' | 'failed' | 'cancelled';
export type OrderCard = HeadFields & { kind: 'order'; producer: 'head'; to_producer: string; exec_state: ExecState; ... };
export const mintOrder: (input: { to_producer; title; body }, ctx: { ulid; now; executors }) =>
  { order: OrderCard; eligible: readonly string[] | null };             // A.1: wildcard snapshot, head-private
export const visibleTo: (order: OrderCard, root: string, eligible?) => boolean;   // A.1 recipient rule, for sync
export const claim: (order: OrderCard, by: string, leaseSeconds: number, now: string) =>
  | { status: 200; card: OrderCard }      // a new claim increments claim_seq (from 1); the holding root's claim renews and keeps it
  | { status: 409 | 410; code: 'lease_held' | 'order_terminal'; card: OrderCard };  // the head answers ClaimRefusal { error, message, order }
export const renew = claim;
export const expireIfDue: (order: OrderCard, now: string) => { card: OrderCard };   // lazy expiry, A.2: `<=` now is expired
export const applyOutcome: (order: OrderCard, outcome: ProducerCard, now: string) =>
  { card: OrderCard; stale: boolean };    // holder + orders.claim_seq check; terminal never reopens, A.3
// lifecycle.decide: `dismissed` on an order → exec_state cancelled, lease released (A.1)

// errors.ts
export class PbcpError extends Error { status: 400|401|403|409|410|413|429; code: string; }
```

Two rules the package enforces by construction: `HeadFields` is never accepted by `parseCard`, and no function here takes a database handle. `change_seq` assignment is deliberately *not* here — it is the one piece of state the head owns, and it has to be a transactional counter.

### @pbcp/client

The "producer in an afternoon" promise lives here. A connector author never sees HTTP, cursors or leases; they implement two callbacks.

```ts
// head.ts — thin, typed HTTP
export class HeadClient {
  constructor(opts: { baseUrl: string; token: string; fetch?: typeof fetch });
  submit(card: ProducerCard): Promise<{ status: 200|201|409; card: Card }>;   // 409 is returned, never thrown
  sync(after: number): Promise<{ changes: { seq: number; card: Card }[]; next: number }>;
  claim(id: string, leaseSeconds: number): Promise<{ claim_seq: number; exec_state: ExecState }>; // throws 409/410
  describe(): Promise<HeadDescription>;                       // GET /, RFC §7.5: protocol, owner, seq, extensions, render
}
// constructor also takes `transport?: Transport` instead of fetch: (req) => Promise<{ status, headers, body }>

// owner.ts — the owner's side (RFC §7.3); the credential is whatever the head's own interface issues
export class OwnerClient {
  constructor(opts: { baseUrl: string; credential: string; fetch?: typeof fetch; transport?: Transport; paths?: {...} });
  decide(id: string, d: Decision): Promise<{ status: 200|409; card: Card }>;  // a producer token here is a 401
  seen(id: string): Promise<Card>;
  ack(id: string): Promise<Card>;
}

// store.ts — the cursor plus connector state
export interface CursorStore { get(): Promise<number>; set(n: number): Promise<void>; }
export interface KeyValue<T> { get(k): Promise<T|undefined>; set(k, v: T): Promise<void>; delete(k): Promise<void>; keys(prefix?): Promise<string[]>; }
export interface StateStore extends CursorStore { kv<T>(namespace: string): KeyValue<T>; }
export const fileStore: (path: string) => StateStore;           // one JSON file next to the connector
export const memoryStore: () => StateStore;

// producer.ts — durable consumer loop, §7.2

export function runProducer(opts: {
  head: HeadClient;
  store: CursorStore;                                           // usually a StateStore
  produce?: () => AsyncIterable<ProducerCard>;                  // emit new cards (may be empty for pure listeners)
  onSubmitted?: (card: ProducerCard, res: SubmitResponse) => void | Promise<void>;  // per answered submit, before produce resumes
  onDecision: (card: Card) => Promise<void>;                    // after produce() finishes; once per changed card; idempotent
  intervalMs?: number;
  maxAttempts?: number;                                         // default 5; then the change is parked (RFC §7.2)
  onParked?: (p: { from: 'sync'; seq: number; card: Card } | { from: 'submit'; card: ProducerCard }, err: unknown) => void | Promise<void>;  // MUST report; default logs
}): { stop(): void };
// Loop: produce → submit each (answered → onSubmitted; refused 4xx → parked after maxAttempts) → onDecision for decided submit
// results → sync(after) → onDecision each → store.set(next)

// testing.ts (`@pbcp/client/testing`) — stubHead(): an in-memory head behind a fetch, on core's own transitions

// executor.ts — Appendix A, with A.5 cancellation handling built in
export function runExecutor(opts: {
  head: HeadClient; store: CursorStore; producer: string;
  leaseSeconds?: number;                                        // default 60; renewed at half
  run: (order: OrderCard, ctx: ExecCtx) => Promise<Outcome>;    // the worker; ctx.checkpoint() renews and throws Cancelled on 410
  onProgress?: (order: OrderCard, note: string) => void;
  concurrency?: number;                                         // orders run at once; default 1
}): { stop(): Promise<void> };
// HeadClient.claim(id, leaseSeconds) → OrderCard; 409/410 throw ClaimRefused { status, code, order }

export interface ExecCtx {
  checkpoint(): Promise<void>;         // call before each irreversible step: renews the lease, throws Cancelled on 410
  progress(note: string): Promise<void>;  // PUTs me:order:<ulid>:progress-<n>, urgency log, thread = order id
  signal: AbortSignal;                 // aborted on cancel or lease loss, for long awaits
}
export type Outcome =
  | { kind: 'signal'; title: string; body: string }                       // done, nothing to decide
  | { kind: 'decision'; title: string; body: string; actions?: string[] }  // done, needs approval
  | { kind: 'failed'; title: string; body: string };
// runExecutor mints me:order:<ulid>:outcome-<claim_seq> with references=[order.id], orders.claim_seq and orders.result;
// a Cancelled thrown from run() becomes a 'failed' outcome describing what was and was not done.

// Card construction helpers, so connectors never hand-write ids
export const card: (p: { producer: string; namespace: string; upstream: string; intent?: string } & Omit<ProducerCard,'id'|'protocol'|'producer'|'emitted_at'>) => ProducerCard;
```

An IMAP connector on this is: a `produce()` that lists unseen messages and yields `card({ producer:'mail', namespace: account, upstream: messageId, kind: inInbox ? 'decision' : 'artifact', thread: threadId, title: subject, body: from + date + first lines, actions: inInbox ? ['archive','keep'] : undefined })`, and an `onDecision` that sets IMAP flags. Nothing else: a reader has no model and no SMTP, so it never drafts or sends. Drafting a reply is a second producer (an agent) that `references` the mail card; the head folds the two by thread.

### Connectors

Each connector is a worked example of the client, kept deliberately small. IMAP, CalDAV and Obsidian are plain `runProducer` scripts; the three below are the integrations into tools that already run 24/7.

#### connectors/n8n

Published as `n8n-nodes-pbcp`, a community node package, so an n8n workflow becomes a producer or an executor with no code. Three nodes, all thin wrappers on `@pbcp/client`:

| Node | Type | Does |
| --- | --- | --- |
| **PBCP Trigger** | polling trigger | Calls `sync(after)` on the workflow's schedule, emits one item per changed card. The cursor lives in n8n's workflow static data, so it is durable for free. Options: *only decisions*, *only orders addressed to me*. |
| **PBCP Submit** | action | Builds a card from the item (`namespace`, `upstream` id, `kind`, `title`, `body` as expressions) and PUTs it. Outputs the stored card, including any existing decision on a 200/409, so a workflow can branch on it. |
| **PBCP Claim** | action | Claims an order with a lease and outputs `claim_seq`; a *renew* mode re-claims. Paired with a Submit node for the outcome card. |

Credentials: one n8n credential type holding base URL and producer token; the token's root is the workflow's namespace root.

Two workflows prove it. **Producer:** an existing monitoring workflow ends in PBCP Submit with `kind: decision` and a proposed action — a complete connector. **Executor:** PBCP Trigger (orders only) → PBCP Claim → the work → PBCP Submit (outcome, `orders.claim_seq` from the claim node). A.5 cancellation is handled by a Claim node in renew mode before any irreversible step; a 410 is an error branch.

#### connectors/hermes

Hermes Agent takes integrations as a portable plugin package — an `mcp.json` naming MCP servers plus a `skills/` folder — installed with `hermes plugins install`, and it has cron and webhook triggers built in. So the connector is not code: it is `@pbcp/mcp` wired in as the MCP server, and two skills that tell Hermes when and how to use it.

```
connectors/hermes/
├── plugin.json
├── mcp.json                 pbcp: npx -y @pbcp/mcp --head $PBCP_HEAD_URL --token $PBCP_TOKEN (stdio)
└── skills/
    ├── pbcp-escalate/       when to stop and submit a decision card instead of acting
    └── pbcp-executor/       the order loop, run on a Hermes cron
```

| Skill | What it teaches Hermes |
| --- | --- |
| **pbcp-escalate** | The authority boundary as a rule: before sending, spending, deleting, or committing to anyone outside the user, call `submit_card` with `kind: decision`, the evidence as context, the proposal as a section, and `actions`; then stop that thread. On a later turn, `poll_changes` and continue only on `approve` or `edited` (acting on the edited text). Anything informational goes out as `signal` or `artifact` at `urgency: log` or `brief`. Never re-submit on 409; read the decision in the body. |
| **pbcp-executor** | Installed as a cron skill (`hermes cron` every minute): `poll_changes` for orders addressed to `hermes` or `*`; `claim_order` with a 60-second lease; do the work, calling `claim_order` again in renew mode before each irreversible step and stopping on 410; finish with `submit_card` as the outcome, `references` the order, `orders.claim_seq` from the claim. Failure is an outcome card, never silence. |

Hermes's token is bound to the root `hermes`, so everything it submits is `hermes:<namespace>:…`, and Hermes is marked `executor: true` in `producer_tokens` so it receives wildcard orders. With this plus n8n, both of the 24/7 systems you already run become producers and executors without either learning HTTP.

#### connectors/goalpath

The one connector that shows a *team* tool escalating to a *personal* head — the boundary §10 of the RFC draws. GoalPath stays the system of record for the roadmap and its own approvals; the connector only carries what needs one person, and takes orders back. It runs on `@pbcp/client` against the GoalPath MCP, one process per person.

**Producer side** — what crosses to the head, and nothing else:

| Trigger in GoalPath | Card | Kind, urgency |
| --- | --- | --- |
| Milestone forecast slips past its deadline | `goalpath:milestone:<id>:risk` — forecast, what moved, options | `signal`, `brief` |
| An approval in GoalPath's own queue is assigned to this person | `goalpath:approval:<id>` — the item, proposed action, `actions` from the queue | `decision`, `brief` |
| Build goes red on a milestone this person owns | `goalpath:build:<run-id>` | `signal`, `immediate` (subject to ceiling) |
| Nightly | `goalpath:digest:<date>` — items done, blocked, unplanned-work trend, one `mermaid` gantt | `artifact`, `brief` |

`thread` is the milestone id, so a slip, its approvals and its green build fold into one line in the brief. Individual tickets never become cards.

**Executor side** — orders to `goalpath`:

| Order (person's words) | What the executor does | Outcome card |
| --- | --- | --- |
| "prioritise the billing bug" | `search_items` → `reorder_item` to the top of its milestone | `signal`: new position, what it displaced |
| "move the roadmap review to next milestone" | `move_item_to_milestone` | `signal` |
| "what's blocking M4?" | `get_dependency_graph` + `list_items` | `artifact`: the answer as markdown |
| anything it cannot map confidently | — | `decision`: "did you mean A or B?" |

**GoalPath's own approvals.** GoalPath keeps its queue; the connector mirrors each item assigned to this person as a decision card and writes the answer back through the GoalPath MCP when it syncs the decision. If the person answers in GoalPath first, the next producer pass supersedes the card with a `signal` saying so. That is the "outsource the approval queue" idea with GoalPath still authoritative.

No marketing copy anywhere in the repo or the RFC. The connector is the demonstration; a reader learns what GoalPath does by seeing which cards it sends.

### Conformance suite

The suite is the protocol's real definition. It ships inside `@pbcp/core/conformance` as JSON fixtures plus a vitest runner that takes a `HeadUnderTest` adapter, so it runs against the in-process core, against a local head over HTTP, and against anyone else's implementation in any language from the same fixtures.

```ts
export interface HeadUnderTest {
  reset(): Promise<void>;
  token(root: string, opts?: { executor?: boolean; ceiling?: Urgency }): Promise<string>;
  describe(token: string | null): Promise<{ status: number; body: unknown }>;        // GET /
  put(token: string | null, card: unknown): Promise<{ status: number; body: unknown }>;   // null: no credential
  changes(token: string | null, after: number | string): Promise<{ status: number; body: unknown }>;
  decide(cardId: string, d: Decision): Promise<{ status: number; body: unknown }>;   // as the owner
  decideWithToken(token: string, cardId: string, d: Decision): Promise<{ status: number; body: unknown }>;  // must be 401
  seen(cardId: string): Promise<{ status: number; body: unknown }>;                  // owner: present the card (seen_at)
  acknowledge(cardId: string): Promise<{ status: number; body: unknown }>;           // owner: acknowledge an artifact/signal
  claim(token: string, cardId: string, lease: number): Promise<{ status: number; body: unknown }>;
  clock: { set(iso: string): void };     // leases and expiry are tested against a controlled clock
}
```

Each fixture is `{ name, steps: [{ op, args, expect }] }`. The first release carries these cases, numbered so a failing implementation can be discussed by number:

| # | Case | RFC |
| --- | --- | --- |
| C01 | Identical re-PUT → 200, same `change_seq` | §5 |
| C02 | Changed open PUT → 200, replaced, `seen_at` cleared, `change_seq` bumped | §5 |
| C03 | Decide, then identical PUT → 200 with decision in body | §5 |
| C04 | Decide, then changed PUT → 409 with decision in body | §5 |
| C05 | Supersede open card: both visible atomically, two consecutive `change_seq` | §8 |
| C06 | Supersede decided card: predecessor keeps its decision | §8 |
| C07 | Supersede an already-superseded id → 409 | §8 |
| C08 | Cross-namespace supersede (`goalpath:item` → `goalpath:milestone`) → 403 | §6 |
| C09 | Sync returns only the caller's namespace; `next` is the global max | §7.2 |
| C10 | Sync pagination: `next` advances across pages, nothing skipped | §7.2 |
| C11 | Artifact acknowledgement sets `acknowledged_at`, state stays `open` | §4.2 |
| C12 | Front-matter PUT with YAML outside the subset → 400 | §3 |
| C13 | Id outside token root → 403; `producer` ≠ id root → 400 | §5, §12 |
| C14 | Head-owned field on PUT → 400; unknown `x-` field preserved | §4 |
| C15 | `protocol: pbcp/2` → 400 | §2 |
| C16 | Order: executor sees it via sync; non-executor does not | A.1 |
| C17 | Order: second claim during live lease → 409; after expiry → 200, `claim_seq` 2 | A.2 |
| C18 | Order: outcome with stale `orders.claim_seq` stored, `exec_state` unchanged | A.3 |
| C19 | Order: `dismissed` → `exec_state` cancelled; renewal → 410; claim → 410 | A.1, A.5 |
| C20 | Wildcard order minted before an executor is eligible is never returned to it | A.1 |
| C21 | Choice list with two defaults or a duplicate id → 400; `edit` is never a decision, `edited` always is | §4.4, §7.3 |
| C22 | Percent-encoded `upstream-id` round-trips unchanged, not normalised | §5 |
| C23 | A parked change: the cursor advances and `onParked` fires (client test, not a head fixture) | §7.2 |
| C24 | Unknown producer fields preserved through PUT and sync (SHOULD) | §3.1 |
| C25 | `GET /` shape: `protocol`, `owner`, `seq`, `extensions`, `render.mermaid` | §7.5 |
| C26 | Missing or invalid producer token → 401 on PUT and sync | §7.1, §7.2 |
| C27 | 64 KiB card accepted; over 1 MiB → 413 | §3.1 |
| C28 | Ceiling clamps `delivery`; `urgency` stored unchanged | §4.2, §9 |
| C29 | Malformed `after` → 400 `invalid_cursor` | §7.2, §7.4 |
| C30 | Producer token on decide → 401 | §7.3 |
| C31 | `GET /` `seq` is the highest `change_seq`; sync from it sees only later changes | §7.5 |
| C32 | Order: renewal on a cancelled order → 410 with the order's `exec_state` in the body | A.5 |
| C33 | Order: `claim_seq` counts claims, not renewals, across expiry | A.1–A.3 |
| C34 | Order: bad `lease_seconds` → 400 `invalid_lease` | A.2 |
| C35 | Order: a second token under the holding root renews and posts the outcome | A.1–A.3 |
| C36 | Order: outcome ids per claim; only the current claim's outcome moves `exec_state` | A.3, A.4 |

Rendering is tested from fixture bodies rather than over HTTP (RFC §3.1): the runner takes a `render(body) → classified fences + text` adapter and checks classification, not pixels.

| # | Case | RFC |
| --- | --- | --- |
| R01 | Each core-tier type renders; the text around it is intact | §3.1 |
| R02 | An unknown diagram type falls back with its label; text intact | §3.1 |
| R03 | A fence with a parse error falls back with the message; the other fences still render | §3.1 |
| R04 | `click` and URL-loading `init` directives are stripped before rendering | §3.1, §12 |
| R05 | Raw HTML in the body is stripped; `![](http://…)` is shown as a link, `https:` and data:image/png as images; inline SVG has script and foreignObject removed. R08: image with alt fallback after a renderable fence is hidden; after an unrenderable fence it replaces the fallback block | §3.1 |
| R06 | Ninth fence is collapsed, not dropped | §3.1 |
| R07 | Identical fence in two cards yields one cached render | §3.1 |

The suite is the CI gate for `apps/head` and the compatibility badge for third-party heads.

## Repo 2 — `head` (Sustainable Use)

The product: the reference head and its phone app, one API contract between them. Depends on `@pbcp/core` and `@pbcp/client` from npm, pinned, and runs the conformance suite in CI.

```
head/
├── apps/
│   ├── head/                  Next.js 15, App Router, Vercel
│   │   ├── app/api/cards/[id]/route.ts            PUT            (producer)
│   │   ├── app/api/cards/[id]/decision/route.ts   POST
│   │   ├── app/api/cards/[id]/claim/route.ts      POST           (orders ext.)
│   │   ├── app/api/changes/route.ts               GET            (producer)
│   │   ├── app/api/me/**                          human API      (session)  — see mobile PRD
│   │   ├── app/api/auth/{apple,passkey,refresh,logout}           — see mobile PRD
│   │   ├── app/api/cron/brief/route.ts            nightly summary card
│   │   ├── app/(ui)/brief, day/[date], card/[id]  the review surface, on /api/me
│   │   ├── db/schema.ts        Drizzle schema (Postgres)
│   │   └── lib/                auth (producer + session), counter, folding, push outbox
│   └── ios/                   SwiftUI; client generated from the head's OpenAPI
├── packages/
│   └── api-types/             OpenAPI from the Zod schemas, consumed by ios/
└── docker-compose.yml         Postgres for self-hosters
```

### Head app

Next.js App Router on Vercel, Postgres via Drizzle (Neon in hosted mode, any Postgres self-hosted). Four tables carry the whole protocol; the fifth is the one piece of state the RFC leaves to the head.

```sql
create table heads (
  id            text primary key,          -- person id, e.g. 'morten'
  created_at    timestamptz not null default now()
);

create table producer_tokens (
  token_hash    bytea primary key,
  head_id       text not null references heads(id),
  root          text not null,             -- namespace root this token may write; one root per token (§12)
  instance      text,                      -- optional principal suffix, two installs ≠ one producer
  urgency_ceiling text not null default 'brief',
  executor      boolean not null default false,   -- eligible for to_producer:'*' (head policy, A.1)
  revoked_at    timestamptz
);

create table cards (
  head_id       text not null references heads(id),
  id            text not null,
  producer      text not null,             -- denormalised from id, checked on write
  namespace     text not null,             -- second id segment, for supersedes checks
  producer_doc  jsonb not null,            -- the ProducerCard exactly as accepted (equality is computed on this)
  state         text not null,             -- open | decided | superseded
  change_seq    bigint not null,
  received_at   timestamptz not null, changed_at timestamptz not null,
  seen_at timestamptz, acknowledged_at timestamptz, snoozed_until timestamptz,
  decision text, edited_proposal text, comment text, decided_at timestamptz, delegated_to text,
  decided_doc   jsonb,                     -- frozen copy of producer_doc at decision time (§4.3)
  exec_state text, claimed_by text, claim_expires_at timestamptz, claim_seq int,
  wildcard_eligible text[],                -- executors snapshotted at mint time (A.1)
  primary key (head_id, id)
);
create index cards_sync on cards (head_id, change_seq);
create index cards_thread on cards (head_id, producer, (producer_doc->>'thread'));

create table change_counter (
  head_id text primary key references heads(id),
  seq     bigint not null default 0
);
-- every write: update change_counter set seq = seq + 1 where head_id = $1 returning seq  (same transaction)

create table decision_log (                -- append-only; the thing the hosted version is really keeping
  head_id text, card_id text, decision text, decided_at timestamptz, decided_doc jsonb, actor text
);
```

**Routes** are thin: parse → load → call `@pbcp/core` → apply the returned effect in one transaction → respond. The handler for `PUT /api/cards/[id]` is the only one with any logic of its own, and that logic is "begin; bump counter; if `supersedes`, also mark the predecessor; commit".

| Route | Core call | Transactional effect |
| --- | --- | --- |
| `PUT /api/cards/[id]` | `parseCard`, `inRoot`, `canSupersede`, `submit` | insert/replace card; mark predecessor; one or two `change_seq` |
| `GET /api/changes?after=` | — | `where change_seq > $after and (producer = $root or (kind='order' and (to_producer = $root or $root = any(wildcard_eligible)))) order by change_seq limit 200` |
| `POST /api/cards/[id]/decision` | `decide` | set decision fields, freeze `decided_doc`, append `decision_log`; for orders also `exec_state = cancelled` |
| `POST /api/cards/[id]/claim` | `expireIfDue`, `claim` | `select … for update`; expiry is evaluated inside the same row lock (A.2) |
| `GET /api/cron/brief` | — | Vercel Cron, 05:30 local; mints `head:daily:YYYY-MM-DD` through the same PUT path |

Auth: bearer token → sha256 → `producer_tokens` lookup, root attached to the request. Human sessions for the UI are a separate concern (NextAuth or similar) and never touch producer routes.

**No worker process.** Lease expiry is evaluated lazily on the next claim or sync that touches the order, which A.2 permits; the brief is the only scheduled job. That is what keeps the whole head deployable as a single Vercel project.

**MCP adapter** (`@pbcp/mcp`): three tools, `submit_card`, `poll_changes`, `claim_order`, each a one-line call into `HeadClient`. Shipped separately so the head app has no MCP dependency.

**Rendering pipeline** (RFC §3.1). Every card body is rendered once, on receipt, server-side, and the result is what both web and phone display. No producer text is ever executed in a browser or on a phone.

1. On PUT, after commit: markdown → HTML through a strict renderer (no raw HTML, GFM tables and tasks on), with `mermaid` fences lifted out.
2. Each fence is sanitised (`click`, URL-loading `%%{init}%%`, `htmlLabels` stripped), classified by type into core / extended / other, and rendered to SVG with the mermaid CLI in a Vercel function. Output is cached in blob storage under `sha256(fence)`; identical fences across cards and re-PUTs are drawn once.
3. A fence that fails or is unsupported is replaced by the fallback block from §3.1 — the type label, a one-line note, the source in a collapsed code block.
4. The rendered HTML, with `<img src="/api/me/svg/<hash>">` where the diagrams go, is stored beside the card. `/api/me/svg/<hash>` serves the cached SVG with a long cache lifetime; the iOS app shows it in a native image view, no WebView.
5. `GET /` reports `render.mermaid: ["core", "extended"]` so producers can check what this head draws.

This is also why the "dashboard" needs no feature of its own: the Brief renders artifact cards, and a card with a `gantt`, a `pie` and an `xychart-beta` is a dashboard. Pinning favourite cards to the top is a head preference, not a protocol concern.

## Build order and the open-source / hosted split

Open source with a hosted alternative is the right shape for this, and the layout is already cut along that line. The protocol and the connectors have to be open or nobody trusts the authority boundary; the hosted product earns its keep on the parts that are a chore to run yourself. The split follows n8n: the line is drawn between building on the protocol (always allowed, actively promoted) and reselling the app (not allowed), never between features.

| Layer | Licence | Why |
| --- | --- | --- |
| `@pbcp/core`, `@pbcp/client`, `@pbcp/mcp`, `rfc/`, `connectors/` | MIT | A protocol with a proprietary client is not a protocol. Anyone may build another head, another client, another connector — that is adoption, and it is the goal. |
| `apps/head` | Sustainable Use Licence (n8n's model) | Free to self-host, read, modify and run for yourself or your company. Not free to offer *this app* as a hosted service to others. A competing head built from the RFC is allowed and welcome; a rehosted copy of this one is not. |
| Hosted head | Paid | Decision memory kept and backed up for years, the mobile app, push on `immediate`, the nightly brief writer, head-to-head delegation when Appendix B lands. None of it needs to be closed; it needs to be *run*. |

Self-hosted and hosted are one codebase with a `HOSTED=1` switch for billing and multi-head routing. The first paying customer is you, which keeps the hosted features honest.

**Milestone 1 — the core round-trips (one week of evenings).**

1. `@pbcp/core`: types, parser, equality, `submit`/`decide`/`canSupersede`. Conformance C01–C15 pass in-process.
2. `apps/head`: schema, the three core routes, token auth. C01–C15 pass over HTTP against local Postgres.
3. `@pbcp/client`: `HeadClient` + `runProducer`. A CLI `pbcp submit card.md` / `pbcp sync` on top of it.
4. `connectors/imap`: your real mailbox → decision cards → approve → reply sent. The first day you read mail in the head and not in the mail client is the milestone.

**Milestone 2 — the brief.** Day view, global last-visit cursor, the nightly `head:daily` card, urgency ceilings. Still no LLM; folding is mechanical.

**Milestone 3 — orders.** `orders.ts`, the claim route, `runExecutor`, C16–C20. A Claude Code loop as the first executor. Todoist as the second, which is where the "orders are the to-do list" claim gets tested.

**Deliberately after that:** the LLM brief writer, the mobile app, delegation, and any second head implementation. Each is a reason to revisit the RFC with evidence rather than opinion.
