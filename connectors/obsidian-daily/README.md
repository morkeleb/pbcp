# connectors/obsidian-daily

```sh
export OBSIDIAN_VAULT=~/Notes PBCP_HEAD_URL=https://head.example PBCP_TOKEN=…
pnpm --filter @pbcp/connector-obsidian-daily build
node connectors/obsidian-daily/dist/src/index.js
```

An example producer on `@pbcp/client`: each daily note in an Obsidian vault becomes a card (RFC §11.1). It is a reader only. It never writes to the vault and runs no model.

- Every file named `YYYY-MM-DD.md` (a real calendar date) directly in the daily-notes folder becomes one `kind: artifact` card with `urgency: log`, no `actions`, and the title `Daily note YYYY-MM-DD`. Its `about` (§4.1) is the note's date, so a head files a note sent the next morning under its own day. Its `summary` (§4.1) is the note's first line of text: the first line of its lead (§3.1, so headings and fences are skipped), without list, task or quote markers, cut to 280 characters. A note with no such line has no `summary`. Subfolders and other files are ignored.
- A new note is submitted; a changed note replaces its card. Artifacts are never decided, so decisions are ignored.

## Configuration

| Variable | Default | |
|---|---|---|
| `OBSIDIAN_VAULT` | – | path to the vault; its folder name is the id namespace |
| `OBSIDIAN_DAILY_FOLDER` | `Daily` | relative to the vault |
| `PBCP_HEAD_URL`, `PBCP_TOKEN` | – | the head and this producer's token |
| `PBCP_TO_PERSON` | the head's `owner` | read once from `GET /` at startup when unset |
| `PBCP_STORE` | `PBCP_CURSOR` if set, else `pbcp-obsidian-daily.store.json` | one file: the sync cursor and the digests of the cards last sent |
| `PBCP_INTERVAL_S` | `60` | seconds between passes |

## Ids and threads

A card id is `obsidian:<namespace>:<YYYY-MM-DD>` (§5). The namespace is the vault's folder name lowercased, with each run of characters outside `[a-z0-9-]` replaced by `-` and leading and trailing `-` removed (`vault` if nothing is left). Renaming the vault folder changes every id; two vaults whose names differ only in punctuation collide.

A card's `thread` is the note's ISO-8601 week, `YYYY-Www`, where the year is the ISO week-year: `2027-01-01` is in `2026-W53`, `2021-01-03` in `2020-W53`.

## Body

The body is the note's markdown with three changes:

- A leading YAML front-matter block (Obsidian properties) is removed. Properties are metadata for the vault, not text for the person.
- Wiki-links and embeds become plain text: `[[Page]]` → `Page`, `[[Page|alias]]` → `alias`, `[[Page#Heading]]` → `Page > Heading`, `[[Page#A#B]]` → `Page > A > B`, `[[#Heading]]` → `Heading`, `[[Page#^block]]` → `Page`. `![[x]]` is treated the same as `[[x]]`, so an embedded image becomes its file name. Links inside code blocks are converted too.
- Leading and trailing whitespace is trimmed.

A card whose JSON wire form would exceed 64 KiB (§3) has its body cut to fit and ends with `_Truncated: the note is longer than a card allows. The full text is in the vault._`, so the head never sees an oversized card and the connector never loops on `413`.

## Unchanged notes

Every pass reads every daily note, builds its card, and compares a SHA-256 digest of the card (all fields except `emitted_at`) with the one in the store file (under `state.notes`). Only cards whose digest differs are submitted. The digest is recorded once the head answers (`201`, `200` or `409`), so a submit that fails is retried next pass. Losing the store file is safe: every note is sent once more and the head answers `200` without a change, because its equality ignores `emitted_at` (§5).

Editing a note changes its card in place. Deleting a note leaves its card at the head.

## Upgrading from 0.3

0.3 kept the cursor in `pbcp-obsidian-daily.cursor.json` and the digests in a separate `.state.json`. 0.4 keeps both in one store file and no longer reads `PBCP_STATE` or the old state file.

- If you set `PBCP_CURSOR`, it is used as the store path and the 0.3 cursor file is read as is. Otherwise rename `pbcp-obsidian-daily.cursor.json` to `pbcp-obsidian-daily.store.json`, or set `PBCP_STORE`; without either, the cursor starts at 0, which costs one replay of the changes and nothing else, since decisions are ignored.
- The digests are not carried over, so on the first pass every daily note is sent once more. The head answers `200` and changes nothing, because its equality ignores `emitted_at` (§5). Delete the old `.state.json` afterwards.
