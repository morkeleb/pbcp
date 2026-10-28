# connectors/goalpath

An example producer on `@pbcp/client` for the GoalPath project tracker, read through its MCP server, one process per person. GoalPath stays the system of record; the connector carries only what needs this one person (RFC §10), and writes the answer to GoalPath's own approvals back. Individual tickets never become cards. There is no executor side yet (orders are milestone 2).

**Status.** This connector has been run against the recorded fixtures in `fixtures/` only, never against a live GoalPath. The shapes of the tool outputs are guesses; see [Guessed shapes](#guessed-shapes).

## Setup

<!-- setup: generated from src/connect.ts by scripts/readme-setup.ts; edit the template there, not this section -->

The token is bound to the root `goalpath` (RFC §12): every card id this connector mints starts with `goalpath:`.

It runs from a checkout of the repository at a release tag (the packages are not on npm yet):

```sh
git clone --branch v0.8.0 --depth 1 https://github.com/morkeleb/pbcp && cd pbcp
corepack pnpm install --frozen-lockfile && corepack pnpm build
export PBCP_HEAD_URL='<head url>' PBCP_TO_PERSON='<owner>' PBCP_TOKEN='<token>'
export GOALPATH_MCP_URL=https://… GOALPATH_TOKEN=… GOALPATH_PROJECT=…
node connectors/goalpath/dist/src/index.js
```

The label, milestones, digest time and the rest are under [Configuration](#configuration).

<!-- /setup -->

## Configuration

| Variable | Default | |
|---|---|---|
| `GOALPATH_MCP_URL`, `GOALPATH_TOKEN` | – | streamable-HTTP MCP endpoint; the token is sent as `Authorization: Bearer` |
| `GOALPATH_PROJECT` | – | project id |
| `GOALPATH_LABEL` | the project's name | the project's label on every card (§4.1); made into a label (lowercase letters, digits and `-`, at most 32) |
| `GOALPATH_FIXTURES` | – | a fixture file or directory to replay instead of the MCP; write-backs are then printed on exit, not sent |
| `GOALPATH_MILESTONES` | the milestones of your open items | comma-separated milestone ids you own |
| `GOALPATH_APPROVAL_STATUS` | `Finished` | the item status that means "waiting for your acceptance" |
| `GOALPATH_DIGEST_AT` | `20:00` | local time from which the day's digest is produced |
| `GOALPATH_TZ` | the process time zone | IANA name, for the digest date and time |
| `GOALPATH_INTERVAL_S` | `300` | seconds between passes |
| `PBCP_HEAD_URL`, `PBCP_TOKEN` | – | the head and this producer's token (root `goalpath`) |
| `PBCP_TO_PERSON` | the head's `owner` | read once from `GET /` at startup when unset |
| `PBCP_STORE` | `PBCP_CURSOR` if set, else `pbcp-goalpath.json` | one JSON file holding the sync cursor and the producer state (`fileStore` from `@pbcp/client`) |

## Cards

The producer root is `goalpath`. `<…-id>` is GoalPath's id, percent-encoded as in §5 (a UUID is unchanged). `<date>` is `YYYYMMDD` in ids and `YYYY-MM-DD` for the digest.

| Trigger | Id | Kind, urgency | Thread |
|---|---|---|---|
| Forecast of a milestone you own is past its deadline | `goalpath:milestone:<milestone-id>.<projected>:risk` | `signal`, `brief` | milestone id |
| … and then back on or before the deadline | `goalpath:milestone:<milestone-id>.<projected>:on-track` | `signal`, `brief` | milestone id |
| An item assigned to you is in `GOALPATH_APPROVAL_STATUS` | `goalpath:approval:<item-id>`, `goalpath:approval:<item-id>.<round>` from round 2 | `decision`, `brief` | item's milestone id |
| … and it left that status in GoalPath first | `<approval card id>:answered` | `signal`, `brief` | item's milestone id |
| A confirmed code link of one of your items in a milestone you own has a failing check | `goalpath:build:<run-id>` | `signal`, `immediate` (subject to the head's ceiling, §9) | item's milestone id |
| Once a day, from `GOALPATH_DIGEST_AT` | `goalpath:digest:<YYYY-MM-DD>` | `artifact`, `brief` | project id |

- **Risk.** Forecast, the deadline, by how many days, what moved (the forecast in the previous card of the chain, and the forecast's reasons), the milestones that depend on this one (from the dependency graph), and three options as text: cut scope, move the deadline, add capacity. It is a signal, so there are no actions.
- **Approval.** The item, its status, milestone and highlights as evidence, then a `## Proposal` section. `actions` are `accept` and `reject`, each with a `body` saying what it sets. `edit` is not offered (§4.4); an `edited` decision, which the decide operation accepts on any decision card, is written back as an accept with the text as a comment.
- **Build.** The check name and conclusion, the PR or commit, the item and milestone; `source` is the run URL. Only one card per run id, even when the run is linked to several items. Only checks on items in `Started`, `Finished` or `Delivered` are looked at, and only `confirmed` links: `suggested` ones are heuristic. A red run is re-submitted on every pass while it is reported; the content is the same, so the head changes nothing (§5).
- **Digest.** First a sentence with the day's counts (`1 item was accepted in the last 24 hours and 1 is blocked; 2 milestones are forecast past their deadline.`), then one `mermaid` `gantt` (core tier, §3.1) of up to 20 milestones not Done, from forecast start (else the milestone's start, else today) to projected end, late ones tagged `crit`; then your items accepted in the last 24 hours, your open items highlighted `Blocked`, and the unplanned share of completed work for the last week and the three before. Gantt task names drop `:` `#` `;` `%`, are cut to 40 characters, and a name starting with a gantt keyword is prefixed with `· `.

- **Labels.** Every card carries `labels` (§4.1): the project's label first, from `GOALPATH_LABEL`, else the project's name as GoalPath gives it (`get_project`), else the project id; then, on risk, back-on-track, approval, answered and build cards, the milestone's name as a label (`Billing revamp` → `billing-revamp`). A name becomes a label by dropping accents, lowercasing, turning every run of other characters into `-`, and cutting to 32 characters. The digest has the project's label only.

- **Links.** `source` (§4.1) opens the thing a card is about: the milestone on risk and back-on-track cards, the item on approval and answered cards, the run (else the PR or commit) on build cards, each when GoalPath gives a URL. The answered card uses the URL recorded with the approval round, so it links even after the item is no longer assigned to you. The digest covers the whole project and has none.

- **Summary.** Every card carries a one-line `summary` (§4.1); on risk, back-on-track, approval, answered and build cards it is built from the milestone's or item's name, status and dates. On the approval, a decision card, it also states the proposal (§4.1), so the brief's line can be decided on its own: `GP-12 Export invoices as CSV is Delivered in Billing revamp and waiting for your acceptance. Proposed: accept it, which sets it to Accepted in GoalPath.` The digest's summary is the counts its title ends with, as a sentence: `1 done, 1 blocked and 2 milestones late in GoalPath on 26 Oct.` Its body opens with a sentence too, so its lead (§3.1) reads as prose on a head that does not show `summary`.

"Own" is a guess: a milestone you own is one listed in `GOALPATH_MILESTONES`, or else one containing an open (not Accepted) item assigned to you. Risk and build cards are limited to those; the digest's gantt shows every milestone of the project that has a forecast.

## Supersession

All chains stay inside one namespace (§6) and always name the current card, which the store records, never one already superseded (§8).

- **Risk.** Each distinct projected date past the deadline is its own card. A later slip (a different projected date) supersedes the current card of that milestone. The same slip seen again yields the same id; since the state's current card already has it, nothing is sent. When the forecast comes back on or before the deadline, an `on-track` signal supersedes the risk card; staying on track sends nothing; a new slip supersedes the `on-track` card. A milestone that is Done, loses its forecast, or stops being owned leaves its last card as it is.
- **Approval answered in GoalPath.** When an approval card is open and its item is no longer in the approval status, an `:answered` signal supersedes it, saying what the status is now (or that it is no longer assigned to you). Not when the card was decided on the head: the write-back itself moves the item out of the queue.
- **New round.** When an item whose round was closed (decided on the head, or answered in GoalPath) has been seen out of the queue and then comes back into it (rejected, reworked, finished again), a new decision card `goalpath:approval:<item-id>.<n>` supersedes the previous round's card.

## Write-back

A decision on the current approval card is applied to GoalPath through the MCP when it arrives, by sync or as the body of a `200`/`409` on submit:

| Decision | GoalPath |
|---|---|
| `accept` | `set_item_status(Accepted)`, then `add_comment(comment)` if the person left one |
| `reject` | `set_item_status(Rejected)`, then the comment as above |
| `edited` | `set_item_status(Accepted)`, then `add_comment(edited_proposal + comment)`: §4.3 treats `edited` as approving the proposal ("Accept GP-N") with the person's text in its place |
| `delegated` | `add_comment("Delegated to <person>." + comment)`; no status change |
| `dismissed` | nothing |

The store marks the round decided once the write-back succeeded, so a decision seen again (§7.2) writes nothing. A write-back that fails is retried on the next pass and parked after five failures (`@pbcp/client`). If the process dies between `set_item_status` and saving the state, the next delivery sets the same status again, which is harmless, and repeats the comment. If the item was answered in GoalPath first (an `:answered` card was sent), a decision that still reaches the head is not written back: GoalPath is authoritative. A decision made on the head after GoalPath moved the item but before the next pass sees that is written back; GoalPath's last write wins.

## State and failures

The store file is `{ "after": <cursor>, "state": { "goalpath": { … } } }`, one entry per key: `risk:<milestone-id>` (the current card of that milestone's risk chain), `approval:<item-id>` (the item's current round: card id, round, whether it was submitted, decided, answered, and whether the item left the queue), and `digest` (the date of the last digest). An entry changes only once the head answered the card (`onSubmitted`): for a risk, `:answered` or digest card on `200` or `201`, for an approval on any answer, `409` included. A failed submit is recomputed and re-sent on the next pass. A card the head keeps refusing with a 4xx (other than 401, 408, 429) is parked by `@pbcp/client` after five attempts and reported (`console.error`); it is not sent again until the process restarts or its content changes. Approval rounds are never pruned.

Known gap: a risk chain that comes back to a projected date it already used (slip to 24 Nov, on track, slip to 24 Nov again) mints the id of a card the head holds as superseded. The head answers `409` with that stored card, which is a result, not a refusal (§5): it is not counted, parked or reported. The store keeps the `on-track` card as current. `@pbcp/client` does not send content the head answered `409` again while the loop runs (in memory, like parking), so the card is not re-sent on later passes; after a restart the `409` is seen once more, then suppressed again. The slip is not shown until the forecast moves to a date not used before, whose card supersedes the `on-track` card as usual.

### Upgrading from 0.3

0.3 kept the cursor (`PBCP_CURSOR`, default `pbcp-goalpath.cursor.json`) and the state (`PBCP_STATE`, default `pbcp-goalpath.state.json`) in two files; 0.4 keeps both in `PBCP_STORE`. If `PBCP_CURSOR` is set and `PBCP_STORE` is not, that file becomes the store and keeps its cursor, but the state still has to be moved in, or the connector starts from an empty state: risk chains restart without `supersedes`, and decisions on approval cards it no longer knows are not written back. Stop the process, then merge the two files (paths are the 0.3 defaults; the third is the new store):

```sh
node -e '
const fs = require("fs"), [cursor, state, out] = process.argv.slice(1);
const { after = 0 } = fs.existsSync(cursor) ? JSON.parse(fs.readFileSync(cursor, "utf8")) : {};
const { risks = {}, approvals = {}, digest } = JSON.parse(fs.readFileSync(state, "utf8")).state ?? {};
const kv = {};
for (const [id, r] of Object.entries(risks)) kv["risk:" + id] = r;
for (const [id, a] of Object.entries(approvals)) kv["approval:" + id] = a;
if (digest) kv.digest = digest;
fs.writeFileSync(out, JSON.stringify({ after, state: { goalpath: kv } }) + "\n");
' pbcp-goalpath.cursor.json pbcp-goalpath.state.json pbcp-goalpath.json
```

Then start 0.4 with `PBCP_STORE` pointing at the new file (unset `PBCP_CURSOR` and `PBCP_STATE`), and delete the two old files.

## Guessed shapes

Nothing below comes from GoalPath documentation of tool output; the tool names and inputs are the MCP's, everything about outputs is assumed. The normaliser in `src/source.ts` reads each field from the first of several plausible keys, so one wrong guess degrades one fact rather than the whole pass. `fixtures/` holds synthetic output in these shapes.

- **Tool results** are `structuredContent` if present, else the first `text` block parsed as JSON. `isError` throws. Lists may be bare arrays or under `items`, `data`, `results` or a tool-specific key.
- **`list_milestones({projectId})`**: `{ milestones: [{ id, name, status, startDate, deadline, url? }] }`; status `Done` is skipped. `title`, `dueDate`, `targetDate` are accepted as alternatives.
- **`get_milestone_forecast({milestoneId})`**: `{ projectedCompletionDate, startDate?, deadline?, confidence?, reasons?: string[] }`, possibly under `forecast`. Also read: `projectedDate`, `forecastDate`, `projectedEndDate`, `estimatedCompletionDate`; `drivers`, `risks`. A failing call leaves the milestone without a forecast. Dates are ISO dates or timestamps; the first ten characters are used.
- **`list_my_items({projectId, includeAccepted: true})`**: `{ items: [{ id, number, title, status, milestoneId | milestone: { id }, highlight? | highlights?: (string | { type })[], acceptedAt?, url? }] }`. A numeric `number` becomes `GP-<n>`. Accepted items are fetched so the digest can list what was done; this grows with the project's history.
- **`list_code_activity({itemId})`**: `{ confirmed: [link], suggested: [link] }`, link `{ type, number? | sha?, title | message, url?, checks | checkRuns: [{ runId | id, name, conclusion | status | state, url? }] }`. No tool exposes CI explicitly; that links carry checks with a run id is the largest guess here. A check counts as red when its conclusion, lowercased, is `failure`, `failed`, `error` or `timed_out`.
- **`get_unplanned_work_trend({projectId, weekCount: 4})`**: `{ weeks: [{ weekStart, plannedCount, unplannedCount, unplannedRatio }] }`, oldest first; counts win, else the ratio (0–1, or a percentage above 1). A failing call (the tool needs an add-on) shows "Not available."
- **`get_dependency_graph({projectId})`**: `{ nodes, edges: [{ prerequisiteId, enablesId }] }`.
- **`get_project({projectId})`**: `{ name }` or `{ project: { name } }` (`title` is accepted for `name`). Read once at startup, for the project's label; a failure falls back to the project id.
- **`set_item_status({itemId, status})`**, **`add_comment({itemId, content})`**: results ignored.
- **The approval queue** is a guess: GoalPath has no approval tool, so an item assigned to you in `Finished` (GoalPath: "code ready for review, may be awaiting stakeholder acceptance") is read as waiting for your acceptance; `GOALPATH_APPROVAL_STATUS=Delivered` switches that. "Answered in GoalPath" means the item left that status.
- **Card shapes** the skeleton leaves open: the risk id carries the projected date so a later slip can supersede (a fixed `goalpath:milestone:<id>:risk` could only be re-PUT); the `on-track`, `answered` and round ids; the digest's thread (the project id); the approval actions `accept`/`reject` without `edit`; options on the risk card as text.
