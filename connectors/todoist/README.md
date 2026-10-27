# connectors/todoist

```sh
pnpm --filter @pbcp/connector-todoist build
export TODOIST_TOKEN=… PBCP_HEAD_URL=https://head.example PBCP_TOKEN=…
node connectors/todoist/dist/src/index.js
```

An example executor on `runExecutor` from `@pbcp/client` (RFC Appendix A.4, "To-do tools are executors"). An order addressed to `todoist` becomes a Todoist task; when the person completes the task in Todoist, the connector posts the outcome card that closes the order. Orders to `*` are also taken if the head lists `todoist` as an executor; that is head policy.

**Status.** Tested against the synthetic fixtures in `fixtures/` and a fake `fetch` only, never against a live Todoist. It uses the unified API v1 (`https://api.todoist.com/api/v1`); the endpoints and fields it relies on are listed under [API](#api) and are unverified.

## Configuration

| Variable | Default | |
|---|---|---|
| `TODOIST_TOKEN` | – | personal API token, sent as `Authorization: Bearer` |
| `TODOIST_PROJECT` | the Inbox | project id for new tasks |
| `TODOIST_POLL_S` | `60` | seconds between checks of a waiting task |
| `PBCP_HEAD_URL`, `PBCP_TOKEN` | – | the head and this executor's token (root `todoist`) |
| `PBCP_STORE` | `pbcp-todoist.json` | the sync cursor and, per running order, the id of its task (`fileStore`) |
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
| Completed | `signal` with `orders.result: done`, `Done: <task content as it is now>`, body `Completed in Todoist, <time>.`, the time in UTC with the zone named, since the connector has no time zone setting: `today 08:12 UTC`, or `Mon 26 Oct 15:00 UTC` on another day | `done` |
| Deleted | `signal` with `orders.result: failed`, `Not done: <order title>`, saying the task was deleted without being completed | `failed` |
| (the person dismisses the order) | `signal` with `orders.result: failed`, `Stopped: <order title>`, saying the task was deleted | stays `cancelled` (the outcome is stale by design, A.5) |

Every outcome carries `references: [<order id>]`, `thread: <order id>`, `orders.result` and the `orders.claim_seq` of the claim it reports on (A.3). Ids are per claim, so a re-claim after a lapsed lease (`claim_seq` 2) writes `outcome-2` beside any earlier run's cards; `runExecutor` builds the ids and fields.

**Cancellation.** When renewal answers `410`, the task is deleted rather than completed, so it neither stays on the list nor shows in the person's completed history; that is the roll-back of A.5. If the delete fails, the executor's own `Stopped` outcome is posted instead, listing `Added to Todoist` as done. On shutdown (`SIGINT`, `SIGTERM`) or a lease lost to another executor the task is left alone: the next claim finds it through the order state (or its marker). Waits between checks use `ctx.sleep`, which a cancel, a lost lease or shutdown interrupts at once.

## API

Calls made, all unverified without credentials:

- `GET /api/v1/tasks?label=pbcp&limit=200[&cursor=…]`: open tasks, `{ results, next_cursor }`.
- `POST /api/v1/tasks` with `content`, `description`, `due_string`, `labels`, `project_id`.
- `GET /api/v1/tasks/{id}`: assumed to return completed tasks too, with `checked: true` and `completed_at`; `404` or `is_deleted: true` is read as deleted. If it returns `404` for completed tasks (as REST v2 did), completion would be misread as deletion.
- `DELETE /api/v1/tasks/{id}`.

The normaliser in `src/source.ts` also accepts REST v2's `is_completed` and bare-array pages.
