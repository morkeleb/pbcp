# @pbcp/mcp

An MCP server over stdio that wraps `@pbcp/client`: five tools, nothing else. It is an adapter over the HTTP protocol (RFC §7), not a second definition of it.

```sh
export PBCP_HEAD_URL=https://head.example/api PBCP_TOKEN=<producer token>
npx -y @pbcp/mcp                     # once @pbcp/mcp is on npm; speaks MCP on stdin/stdout
# MCP client config: { "command": "npx", "args": ["-y", "@pbcp/mcp"], "env": { "PBCP_HEAD_URL": "…", "PBCP_TOKEN": "…" } }
```

**Until it is on npm**, run it from a checkout of the repository at a release tag:

```sh
git clone --branch v0.8.0 --depth 1 https://github.com/morkeleb/pbcp && cd pbcp
corepack pnpm install --frozen-lockfile && corepack pnpm build
node packages/mcp/dist/src/bin.js    # the same server; in an MCP client config: { "command": "node", "args": ["/path/to/pbcp/packages/mcp/dist/src/bin.js"], "env": { … } }
```

| Tool | Input | Result |
| --- | --- | --- |
| `submit_card` | `card`: a JSON object, JSON text, or front-matter text (§3); `to_person` may be left out | `{ status, id, state, change_seq, card }` — `201` or `200` with the stored card, or `409` with the decided card (§7.1) |
| `poll_changes` | `after`: the cursor, `0` the first time | `{ changes: [{ seq, card }], next }` — one page (§7.2); call again with `next` until it stops moving. An executor also receives orders addressed to it (A.1) |
| `claim_order` | `id`, `lease_seconds` (default 60) | `{ order }` with `exec_state: claimed` and `claim_seq` — a claim, or a renewal of a lease the caller holds (A.2). `409 lease_held` and `410 order_terminal` are tool errors carrying the order (A.5) |
| `report_progress` | `order_id`, `note` | `{ status, id, state, change_seq, card }` for a progress card `<root>:order:<ulid>:progress-<claim_seq>-<n>`: `kind: signal`, `urgency: log`, `thread` and `references` the order, title the note's first line, body the note (A.3) |
| `complete_order` | `order_id`, `result` (`done` or `failed`), `title`, `body`, `kind` (`artifact` by default, `signal`, or `decision` with `actions`); optionally `summary`, `source`, `labels`, `about`, `at`, `until`, `urgency` | `{ status, id, state, change_seq, card }` for the outcome card `<root>:order:<ulid>:outcome-<claim_seq>`, with `orders.claim_seq` and `orders.result` (A.3) |

The card is parsed and checked locally before it is sent, so a malformed card is refused without a request. A refusal is a tool error whose text is `{ status, error, message }` with the RFC code (§7.4), for example `{ "status": 400, "error": "head_owned_field", … }`; a failure without a protocol body has `error: "http"` and the response `body`. `--head URL`, `--token TOKEN` and `--to-person ID` override the environment.

**Addressee.** A card without `to_person` is addressed to `PBCP_TO_PERSON` when it is set, else to the head's owner, read once from its description (`GET /`, §7.5) when the first such card arrives. A card that names `to_person` is sent as it is.

**Confirmation.** The answer to `submit_card` is the confirmation that a card landed: `201` (new) or `200` (already current) with the card as the head stored it, head-owned fields included (`state`, `change_seq`, `received_at`, `delivery`), and `id`, `state` and `change_seq` repeated at the top so they are easy to read. Afterwards the card also appears in `poll_changes` with the same token. There is no producer read of a single card (`GET /cards/{id}` is not part of the protocol).

There is no `decide_card`: deciding is the owner's operation and refuses a producer token (§7.3), and this server holds a producer token. `claim_order` is the orders extension (Appendix A); against a head without it, the claim is refused (`404`). **Order cards.** The server remembers each claim `claim_order` makes: the root that holds it (`claimed_by`), its `claim_seq`, and how many progress cards it has written. `report_progress` and `complete_order` mint their ids from that, so the model never assembles one; a renewal keeps the count, a new claim starts it at 1. Either is refused with `{ error: "not_claimed" }`, before any request, for an order this server has not claimed, or whose lease another executor took (`409`). A `410` keeps the claim, so the executor can still report what it did (A.5). `complete_order` ends the claim. The claims live in memory: after a restart, claim again; if the lease still held, the renewal keeps `claim_seq` and the count starts again at 1, so the new progress cards replace the first ones of that claim. `submit_card` can still post an outcome by hand. The server keeps no cursor; the caller stores `next`. To start from now rather than from the beginning, read `seq` from the head's `GET /` (§7.5) and pass it as the first `after`.
