# connectors/todoist

An example executor on `runExecutor` from `@pbcp/client` (RFC Appendix A.4, "To-do tools are executors"). An order addressed to `todoist` becomes a Todoist task; when the person completes the task in Todoist, the connector posts the outcome card that closes the order. Orders to `*` are also taken if the head lists `todoist` as an executor; that is head policy.

With `TODOIST_MODE=reader` it is instead a task reader (RFC §11.1, "A task reader"), a producer on `runProducer`: every task due today or overdue becomes a `kind: task` card, and the person's decision on it is carried out in Todoist. See [Reader](#reader).

**Status.** Tested against the synthetic fixtures in `fixtures/` and a fake `fetch` only, never against a live Todoist. It uses the unified API v1 (`https://api.todoist.com/api/v1`); the endpoints and fields it relies on are listed under [API](#api) and are unverified.

## Setup

<!-- setup: generated from src/connect.ts by scripts/readme-setup.ts; edit the template there, not this section -->

The token is bound to the root `todoist` (RFC §12) and is an executor's: the head must let it claim orders (Appendix A). On the reference head that is `pnpm mint-token <owner> todoist --executor`.

It runs from a checkout of the repository at a release tag (the packages are not on npm yet):

```sh
git clone --branch v0.10.0 --depth 1 https://github.com/morkeleb/pbcp && cd pbcp
corepack pnpm install --frozen-lockfile && corepack pnpm build
export PBCP_HEAD_URL='<head url>' PBCP_TO_PERSON='<owner>' PBCP_TOKEN='<token>'
export TODOIST_TOKEN=… TODOIST_TZ=Europe/Copenhagen
node connectors/todoist/dist/src/index.js
```

**Reader.** The same connector also reads Todoist into task cards (RFC §11.1, [Reader](#reader)). It runs as a second process under the same root, with a second token and its own store; it claims nothing, so the token is a producer's. On the reference head that is `pnpm mint-token <owner> todoist --instance reader`. Start it with that token and `TODOIST_MODE=reader`:

```sh
export PBCP_TOKEN='<reader token>' TODOIST_MODE=reader
node connectors/todoist/dist/src/index.js
```

The project, polling and lease settings are under [Configuration](#configuration).

<!-- /setup -->

## Configuration

| Variable | Default | |
|---|---|---|
| `TODOIST_TOKEN` | – | personal API token, sent as `Authorization: Bearer` |
| `TODOIST_PROJECT` | the Inbox | project id for new tasks |
| `TODOIST_MODE` | `executor` | `executor`, or `reader` for the task reader ([Reader](#reader)) |
| `TODOIST_POLL_S` | `60` | seconds between checks of a waiting task; for the reader, between passes |
| `TODOIST_TZ` | UTC | IANA zone for times in card text, e.g. `Europe/Copenhagen`; a name the runtime does not know stops the connector at startup. The reader also reads floating due times and finds today in it, so set it to the Todoist account's zone |
| `PBCP_HEAD_URL`, `PBCP_TOKEN` | – | the head and this process's token (root `todoist`); the reader has its own |
| `PBCP_TO_PERSON` | the head's `owner` | who outcome cards (and the reader's cards) are addressed to; read from `GET /` when unset |
| `PBCP_STORE` | `pbcp-todoist.json`; reader `pbcp-todoist-reader.json` | the sync cursor and, per running order, the id of its task; for the reader, its state per card id (`fileStore`). The two must not share a file |
| `PBCP_LEASE_S` | `60` | lease length in seconds, renewed every half lease and at every check (A.5) |
| `PBCP_CONCURRENCY` | `50` | orders waiting at once; orders wait days for the person, so one must not block the next |

## Order → task

| Task field | From |
|---|---|
| `content` | the order's `title` |
| `description` | the order's `body` without its due line, then a blank line and `pbcp: <order id>` |
| `due_string` | the due line, if any |
| `labels` | `["pbcp"]` |
| `project_id` | `TODOIST_PROJECT`, if set |

**Due line.** The first line of the body of the form `due: <when>` (any case, leading spaces allowed) is removed from the description and `<when>` is sent as `due_string`, which Todoist parses as natural language: `due: tomorrow 9am`, `Due: 2026-11-02`, `due: every friday`. Later `due:` lines stay in the description.

**Idempotency.** The key is the order id (A.4). Once a task is created, its id is kept in the executor's order state (`ctx.state`, in `PBCP_STORE` under `orders`, keyed by order id) until the order's outcome is accepted. An order claimed again after a crash reads the task from there and checks it, so a task completed (or deleted) while the executor was down is reported as such on the re-claim, not created again.

The order id is also written into the description as `pbcp: <order id>`. When there is no state for the order (a crash between creating the task and recording it, or a lost store file), the connector looks through the open tasks labelled `pbcp` for one whose description contains that line and uses it. That fallback sees open tasks only: a task completed in that narrow window, or after the store file was lost, gets a second task on re-claim. Removing the label or the line in Todoist defeats the fallback, not the state.

## Outcome

The connector checks the task every `TODOIST_POLL_S`, renewing the lease first (`ctx.checkpoint()`); the wait is interrupted by a cancel. A Todoist error during a check is logged and retried at the next one. When the task is created, a progress card `todoist:order:<ulid>:progress-<claim_seq>-1` says `Added to Todoist: <content>` (not repeated on a re-claim that finds the task).

| In Todoist | Outcome `todoist:order:<ulid>:outcome-<claim_seq>` | `exec_state` |
|---|---|---|
| Completed | `artifact` at `urgency: log` with `orders.result: done` (a completed task is a routine record, RFC §4.1a), `Done: <task content as it is now>`, body `Completed in Todoist, <time>.`, the time in `TODOIST_TZ`: `today 09:12`, or `Mon 26 Oct 16:00` on another day; with `TODOIST_TZ` unset, in UTC with the zone named: `today 08:12 UTC` | `done` |
| Deleted | `signal` with `orders.result: failed`, `Not done: <order title>`, saying the task was deleted without being completed | `failed` |
| (the person dismisses the order) | `signal` with `orders.result: failed`, `Stopped: <order title>`, saying the task was deleted | stays `cancelled` (the outcome is stale by design, A.5) |

Every outcome carries `references: [<order id>]`, `thread: <order id>`, `orders.result` and the `orders.claim_seq` of the claim it reports on (A.3). Ids are per claim, so a re-claim after a lapsed lease (`claim_seq` 2) writes `outcome-2` beside any earlier run's cards; `runExecutor` builds the ids and fields.

**Cancellation.** When renewal answers `410`, the task is deleted rather than completed, so it neither stays on the list nor shows in the person's completed history; that is the roll-back of A.5. If the delete fails, the executor's own `Stopped` outcome is posted instead, listing `Added to Todoist` as done. On shutdown (`SIGINT`, `SIGTERM`) or a lease lost to another executor the task is left alone: the next claim finds it through the order state (or its marker). Waits between checks use `ctx.sleep`, which a cancel, a lost lease or shutdown interrupts at once.

## Reader

`TODOIST_MODE=reader` runs a producer (RFC §11.1, "A task reader"). Every `TODOIST_POLL_S` it lists the tasks due today or overdue (Todoist's `today | overdue` filter) and submits a `kind: task` card for each. Tasks labelled `pbcp` are skipped: those are the executor's tasks for orders, already on the head as the order's cards.

| Card field | From |
|---|---|
| `id` | `todoist:task:<task id>`; for a recurring task, `todoist:task:<task id>:<due day>`, a new card per occurrence (§11.1 step 5) |
| `title` | the task's `content`, on one line |
| `about` | the due day (`YYYY-MM-DD`); for a due time Todoist gives as an instant, its day in `TODOIST_TZ` |
| `at`, `until` | only when the task has a due time: the time (floating times read in `TODOIST_TZ`), and the time plus the duration, if any |
| `thread` | `todoist:project:<project id>`; for a subtask, `todoist:task:<parent id>` |
| `labels` | the project's name and the task's labels, slugged to the §4.1 grammar (lowercase, `a`–`z`, digits and `-`, at most 32 characters), duplicates and empties dropped, at most 8 |
| `source` | the task link (see [API](#api)), labelled `Todoist task` |
| `body` | the description, then `## Subtasks` (open subtasks as `- [ ]` lines) and `## Comments`, each part only when it has content |
| `urgency` | by §4.1a: due today or overdue → `brief`, whatever the priority; p1 (API priority 4) → `immediate` only when it has a due time today at most 3 hours away, or already passed today; due later or undated → `log` |
| `actions` | `[tomorrow]`; none on a recurring task, since rescheduling by `due_string` would replace its recurrence. `done` is implicit (§4.1) |

An open card is sent again each pass, so a change to the task revises it (§5). Urgency counts for equality, so a p1 card is revised to `immediate` on the pass after its due time comes within 3 hours.

**Rate.** Todoist allows about 450 requests per 15 minutes. Each pass makes one listing call (one per 200 tasks); subtasks and comments are fetched only for a task new to the reader or whose listing changed (its content, description, due, duration, priority, labels, project, parent or `updated_at`), and the body built from them is reused otherwise. Project names are fetched once per project and kept while the process runs. The trade-off: a new comment or subtask alone does not change the task's listing, so it shows on the card at the task's next change, or after a restart; a renamed project likewise shows after a restart. The signatures and names are held in memory only.

**Decisions.** On `done` the task is completed in Todoist (`close`); on `tomorrow` it is rescheduled with `due_string: "tomorrow"`; on `dismissed` it is left as it is. The card is not sent again, and at the next pass it is superseded by a `log` artifact `todoist:task:<id>:closed` (§4.3), its `summary` the task's title:

| What happened | Title |
|---|---|
| `done`, completed now | `Done in Todoist` |
| `done` or `tomorrow` on a task Todoist already has completed (or, recurring, already moved past this occurrence) | `Already completed`, and no call |
| `tomorrow` | `Rescheduled`, saying the new due day |
| `dismissed` | `Dismissed`, saying it was left as it is in Todoist; no call |
| completed in Todoist while the card is open, no decision | `Done in Todoist` |
| moved to another day or its date removed in Todoist while open; for a recurring task, completed or moved there (the API does not tell the two apart) | `Changed in Todoist` |
| deleted in Todoist while open | `Deleted in Todoist`, a `signal` (§6, retracting a card) |

A recurring occurrence's card already uses the id's one `intent` segment for its date, so its closing card is `todoist:task:<id>:closed-<due day>` (§5 grammar). A task that is not recurring but comes due again after its card was closed (it was rescheduled) gets a dated card the same way, `todoist:task:<id>:<due day>`, since the undated id is locked (§4.3).

**Idempotency.** The store (`PBCP_STORE`, namespace `tasks`) keeps a record per task card id: the task, its due day, and what was done. A decision already recorded is not acted on again, whether it arrives again through sync, a re-sync or a repeated call, and the closing card is built from the record, so it is the same card each time. Before the call to Todoist the decision is marked in the record; a crash between the call and recording its result is recognised on the retry by its effect (the task completed, or due tomorrow), so it is neither repeated nor reported as `Already completed`. Without the record (a lost store) the decision is taken from the card itself, and an already-completed task is then reported as `Already completed`. Records are kept, so a closed card's id is never reused.

**Two processes, one root.** The reader and the executor both use the root `todoist` with separate tokens and stores; each ignores the other's cards in its sync.

## API

Calls made, all unverified without credentials:

- `GET /api/v1/tasks?label=pbcp&limit=200[&cursor=…]`: open tasks, `{ results, next_cursor }`.
- `POST /api/v1/tasks` with `content`, `description`, `due_string`, `labels`, `project_id`.
- `GET /api/v1/tasks/{id}`: assumed to return completed tasks too, with `checked: true` and `completed_at`; `404` or `is_deleted: true` is read as deleted. If it returns `404` for completed tasks (as REST v2 did), completion would be misread as deletion.
- `DELETE /api/v1/tasks/{id}`.

The reader adds, equally unverified:

- `GET /api/v1/tasks/filter?query=today%20%7C%20overdue&limit=200[&cursor=…]`: open tasks due today or overdue, by the account's day, `{ results, next_cursor }`. Each task's `due` is read as `{ date, is_recurring }`, with a due time in `due.date` as `YYYY-MM-DDTHH:MM:SS` (floating) or with `Z`; REST v2's `due.datetime` is accepted too. `duration` is `{ amount, unit: minute | day }`, `priority` 4 is p1.
- `GET /api/v1/tasks?parent_id={id}&limit=200`: the open subtasks.
- `GET /api/v1/comments?task_id={id}&limit=200`: the comments, `content` each.
- `GET /api/v1/projects/{id}`: the project's `name`, once per project while the process runs.
- `POST /api/v1/tasks/{id}/close`: completes the task; for a recurring one, the current occurrence.
- `POST /api/v1/tasks/{id}` with `{ "due_string": "tomorrow" }`: Todoist reads it in the account's zone and drops any due time.
- **Task link.** The Done outcome links to the task (`source`, RFC §4.1, labelled `Todoist task`). The task's `url` is used when the API returns one; otherwise the link is `https://app.todoist.com/app/task/<id>`, the web app's task address, which is assumed rather than documented by the API. Not-done and cancelled outcomes have no link, since the task is gone.

The normaliser in `src/source.ts` also accepts REST v2's `is_completed` and bare-array pages.
