# n8n-nodes-pbcp

n8n community nodes for PBCP: a polling trigger on sync (RFC §7.2) and a submit action (§7.1), both thin wrappers on `@pbcp/client`.

## Install

**Not on npm yet.** Both ways below install `n8n-nodes-pbcp` from npm and work once it is published. Until then, submit cards with the HTTP Request node in [Setup](#setup), which needs no package.

- In n8n: **Settings → Community Nodes → Install**, package name `n8n-nodes-pbcp`.
- Or by hand: `npm i n8n-nodes-pbcp` in `~/.n8n/custom` (or your `N8N_CUSTOM_EXTENSIONS` directory), then restart n8n.
- Requires **Node.js 22.12 or later** under n8n (see [Module format](#module-format)).

**Status:** these nodes have only been unit-tested against an in-memory stub head, with a hand-made stand-in for n8n's node context and its request helper. They have not been run inside a real n8n instance.

## Setup

<!-- setup: generated from src/connect.ts by scripts/readme-setup.ts; edit the template there, not this section -->

**With these nodes.** Once the community package `n8n-nodes-pbcp` is on npm, install it, then create a **PBCP Head** credential:

- Head URL: `<head url>`
- Token: `<token>`

Cards are addressed to the owner `<owner>`; PBCP Submit reads it from the head when its **To Person** field is empty. Until the package is published, use the HTTP Request node below: it needs no package.

**Without them.** One HTTP Request node submits a card. First create a **Header Auth** credential named `PBCP token`: Name `Authorization`, Value `Bearer <token>`. The node authenticates with it (Authentication: Generic Credential Type, Header Auth), so the token stays in n8n's encrypted credentials and never in the workflow, which people export and commit. Do not use an environment variable instead: n8n 2.x blocks `$env` in expressions by default (`N8N_BLOCK_ENV_ACCESS_IN_NODE`), and lifting the block exposes every variable to every workflow. The head URL and the owner are not secrets; they are written in the node.

Then copy this and paste it into a workflow; if n8n does not pick the credential, choose `PBCP token` in the node. The token must be bound to the root `n8n` (RFC §12), since the card id starts with `n8n:`.

```json
{
  "nodes": [
    {
      "parameters": {
        "method": "PUT",
        "url": "<head url>/cards/n8n%3Aworkflow%3Afirst-card",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"protocol\": \"pbcp/1\",\n  \"id\": \"n8n:workflow:first-card\",\n  \"producer\": \"n8n\",\n  \"kind\": \"decision\",\n  \"to_person\": \"<owner>\",\n  \"title\": \"Approve the first card from n8n?\",\n  \"summary\": \"A first card from an n8n workflow. Approve it to see the decision come back through PBCP Trigger.\",\n  \"body\": \"Sent by an HTTP Request node.\\n\\n## Proposal\\n\\nApprove it.\",\n  \"actions\": [\n    \"approve\",\n    \"reject\"\n  ],\n  \"emitted_at\": \"{{ $now.toUTC().toISO() }}\"\n}"
      },
      "name": "Submit a card to PBCP",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        0,
        0
      ],
      "credentials": {
        "httpHeaderAuth": {
          "name": "PBCP token"
        }
      }
    }
  ],
  "connections": {}
}
```

<!-- /setup -->

## Credentials: PBCP Head

| Field | Meaning |
| --- | --- |
| Head URL | The head's base URL, e.g. `https://head.example` |
| Token | A producer token. It is bound to one producer root (§5); every card you submit with it has that root as its first id segment. |

The credential test calls `GET /` (describe, §7.5) with the token as a bearer header.

## PBCP Trigger

A polling trigger: on n8n's poll schedule it calls `sync(after)` and emits one item per changed card.

Each item is the sync entry as the head sent it: `{ "seq": 103, "card": { ...the card, head-owned fields included } }`. Use `{{ $json.card.decision }}`, `{{ $json.card.id }}` and so on downstream.

| Option | Effect |
| --- | --- |
| Only Decisions | Emit only cards with `kind: decision` and `state: decided`. |
| Only Cards in These States | Emit only cards in the selected states (`open`, `decided`, `superseded`); none selected emits all. |
| Start From | `Now` (default) or `Beginning`: where the cursor starts on the first poll after activation. |

Both filters apply together. A change that is filtered out still moves the cursor past it.

**Cursor.** The cursor (`after`) lives in the node's workflow static data, so it survives restarts and reactivation.

- *First poll.* With `Start From: Now`, the first poll reads the head's current position, `seq` from `GET /` (describe, §7.5), stores it as the cursor, and emits nothing, so activating a workflow does not replay history; it does not read the change feed. This needs a head that implements draft 0.4 or later: a head whose describe has no `seq` makes the first poll fail. With `Beginning`, the first poll emits everything.
- *Each poll* pages until `next` stops moving and stores the last `next` reached.
- *A page that fails* is never skipped. If an earlier page in the same poll succeeded, the poll returns those items, stores only their `next`, and logs a warning; the failed page is fetched again on the next poll. If the first page fails, the poll throws and the cursor is untouched.
- *`next` lower than `after`* is an error (§7.2); the cursor is not moved.
- *Nothing changed* returns no items.
- *Manual runs* ("Test step" / "Fetch test event") page through the whole feed from 0 and return the latest matching change only, without reading or moving the stored cursor.

The cursor moves when the poll returns, not when the workflow that handles the items finishes. That is n8n's trigger model, unlike `runProducer`, which advances only after processing: if a downstream step fails, the change is not delivered again. Use n8n's error workflow for that case, and keep processing idempotent (§5): the same change can arrive twice.

## PBCP Submit

Builds one card per input item with `card()` from `@pbcp/client` and PUTs it.

| Parameter | Meaning |
| --- | --- |
| Producer | Required. The token's producer root. n8n cannot learn it from the token, so it is entered here; a value that does not match the token is refused by the head with `403 outside_root`. |
| Namespace | Required. Letters, digits and dashes (§5). |
| Upstream ID | Required. The upstream system's own key, as is. Every byte outside `A–Z a–z 0–9 - _ .` is percent-encoded with uppercase hex (§5), `%` included, so `<19a4@mail.example>` becomes `%3C19a4%40mail.example%3E`. Do not pre-encode it. |
| Intent | Optional id suffix (§5). |
| Kind | `decision`, `artifact` or `signal`. |
| To Person | Optional. Empty means the head's `owner`, read with describe once per execution. |
| Title, Body | One-line title; markdown body. |
| Additional Fields | `Thread`, `Urgency`, `Actions`, `References`, `Supersedes`, `Source URL`, `Source Label`. |

- **Actions** (decision cards only): either comma-separated ids (`approve, reject`) or a JSON array of ids and §4.4 objects (`[{"id":"ship-friday","label":"Ship Friday","default":true},"hold","edit"]`). A value starting with `[` is read as JSON.
- **References**: comma-separated card ids.
- Every parameter may be an expression; n8n resolves it before the node reads it.

**Output**, per item, linked to its input item: `{ "status": 201 | 200 | 409, "card": { ...the stored card } }`. A `409` is an output, not an error: the card was already decided and `card` carries the decision, so a workflow can branch on `{{ $json.status }}` or `{{ $json.card.decision }}`.

**Errors.** A card that does not conform is refused before any request, as a `NodeOperationError` whose message starts with the RFC code (`invalid_id: ...`). A refusal from the head is a `NodeApiError` with the HTTP status and the RFC code (§7.4). With *Continue On Fail* (Settings → On Error → Continue), the item is output as `{ "error": { "status": 400, "code": "invalid_id", "message": "..." } }` instead; `status` and `code` are absent when the failure has none (a network error, say).

## Workflows

- **Producer.** Any workflow that ends in PBCP Submit is a connector: a monitoring workflow submits `kind: decision` with a proposed action in `actions`; a second workflow on PBCP Trigger with *Only Decisions* acts on the answer.
- **Executor.** Trigger (orders) → Claim → the work → Submit (outcome). This needs a PBCP Claim node and the orders extension (Appendix A); neither is in this package yet.

## Module format

n8n loads community nodes with `require()`. `@pbcp/client` and `@pbcp/core` are ESM-only, so the compiled nodes are CommonJS that `require()` an ES module, which Node.js supports from 22.12 on. On older Node.js, loading the nodes fails with `ERR_REQUIRE_ESM`.

The sources are ESM like the rest of the repository (`src/package.json` says `"type": "module"`, and it is not published); `tsconfig.build.json` compiles them to CommonJS in `dist/`, where the package's own `package.json` (no `"type"`) makes Node.js read them as CommonJS.

## Requests

Both nodes send every request through n8n's own request helper (`this.helpers.httpRequest`), so n8n's proxy settings and request logging apply. The client builds the request (URL, `Authorization: Bearer <token>` from the credential, JSON body as text); the helper is called with `returnFullResponse: true`, `ignoreHttpStatusErrors: true`, `json: false` and `encoding: 'text'`, and the client reads the status, headers and body itself, so a head's refusal (§7.4) reaches the node as the RFC code, not as n8n's generic HTTP error. The credential's `authenticate` block is used only by the credential test.

## Build

```sh
pnpm --filter @pbcp/core --filter @pbcp/client build   # dist of the dependencies
pnpm --filter n8n-nodes-pbcp build
```
