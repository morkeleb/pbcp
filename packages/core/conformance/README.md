# Conformance suite

The fixtures in `fixtures/` are the protocol's executable definition. They are plain JSON so a head written in any language can run them; the vitest runner in this directory is one consumer of them, not the definition.

- `fixtures/core/Cnn-*.json` — protocol cases, run against a `HeadUnderTest`.
- `fixtures/render/Rnn-*.json` — rendering classification (RFC §3.1, §14), run against a `RenderUnderTest`.

## Conventions

- The head under test is owned by person id `morten` (the RFC's example owner). Every card is addressed `to_person: "morten"`.
- The head clock starts at an arbitrary time; fixtures that care set it with the `clock` op.
- Tokens are named by their namespace root. `"token": "goalpath"` means "a producer token bound to root `goalpath`"; the runner mints one per root on first use. `"ceiling": "brief"` beside it mints that producer's token with an urgency ceiling (§9); a fixture uses the same ceiling on every call for that root, since a head may hold ceilings per producer.
- `"credential": "none"` sends no credential at all (`HeadUnderTest` receives `null`); `"credential": "invalid"` sends a producer token the head never issued.
- Every fixture starts from an empty head (`reset()`).
- C01–C24 check error responses by status only. From C25 on, fixtures also check the error code, which §7.4 makes normative.
- A fixture with `"extension": "orders"` tests the orders extension (Appendix A) and runs only for a head that implements it (`conformanceSuite({ extensions: ['orders'] })`). Executor tokens are minted with `"executor": true` beside `"token"`; a fixture uses the same flag on every call for that root.
- A fixture with `"level": "SHOULD"` checks a recommendation, not a requirement. A head may fail it and still conform; runners report it separately (`conformanceSuite({ should: false })` skips them).
- A fixture with `"condition": "prerender"` (R07) applies only to heads that draw diagrams before serving them (RFC §3.1 "Determinism"); `conformanceSuite({ prerender: false })` skips it.
- `HeadUnderTest.clock.set()` may return a promise; the runner awaits it before the next step.
- `covers` lists the requirements a fixture exercises, each as `§<section>` and words from one MUST, MUST NOT, SHOULD or SHOULD NOT sentence of that section; every fixture has at least one. `untested.json` lists the sentences no fixture covers, with why. `scripts/conformance-map.ts` makes RFC §14's coverage table from both, and `coverage.test.ts` fails when a reference names no sentence, or the table is out of date.
- `"instance": "second"` beside `"token"` mints a further token under the same root, for fixtures that act as two installations of one producer (C35).

## Fixture shape

```json
{
  "name": "C01 identical re-PUT returns 200 with the same change_seq",
  "rfc": ["§5"],
  "covers": ["§3 but MUST accept JSON"],
  "level": "MUST",
  "steps": [
    { "op": "put", "args": { "token": "hermes", "card": { "...": "..." } },
      "expect": { "status": 201 }, "save": { "seq": "body.change_seq" } }
  ]
}
```

Each step runs its `op` with `args`, checks the result against `expect`, then evaluates `save` (name → path into the result) into fixture variables.

### Core ops (`HeadUnderTest`)

| op | args | result |
| --- | --- | --- |
| `describe` | `token` or `credential` | `{ status, body }` — `GET /` (§7.5) |
| `put` | `token` or `credential`, `ceiling`?, `card` (object = JSON; string = file form, `text/markdown`) | `{ status, body }` — body is the stored card on 200/201/409 |
| `changes` | `token` or `credential`, `after` (a number, or a string sent as given) | `{ status, body: { changes: [{ seq, card }], next } }`, one page |
| `syncAll` | `token`, `after` | runner composite: calls `changes` until `next` stops moving. `{ status, body: { changes, next, pages, ascending } }` where `changes` is every entry across pages in order and `ascending` is true iff seqs strictly increase |
| `decide` | `id`, `decision` (`{ decision, edited_proposal?, comment?, delegated_to? }`) | `{ status, body }` — as the owner; 404 for an unknown id |
| `order` | `to_producer`, `title`, `body` | `{ status, body }` — the owner gives an order; body is the minted order (orders extension) |
| `claim` | `token`, `executor`?, `instance`?, `id`, `lease` | `{ status, body }` — `POST /cards/{id}/claim` with `{ lease_seconds }`; the order on 200, `{ error, message, order }` on 409 `lease_held` and 410 `order_terminal`, an error body on 400 `invalid_lease` (orders extension) |
| `decideWithToken` | `token`, `id`, `decision` | `{ status, body }` — the same request with a producer token instead of the owner's credential |
| `seen` | `id` | `{ status, body }` — the head presents the card to its owner (sets `seen_at`) |
| `acknowledge` | `id` | `{ status, body }` — the owner explicitly acknowledges an artifact or signal |
| `snooze` | `id`, `until` (RFC 3339, or `null` to clear) | `{ status, body }` — the owner snoozes an open card (sets `snoozed_until`) or clears it |
| `clock` | `set` (RFC 3339) | sets the head clock |

### Render ops (`RenderUnderTest`)

| op | args | result |
| --- | --- | --- |
| `render` | `body` (markdown) | `{ status: 200, body: RenderResult }` |
| `draws` | — | `{ status: 200, body: { count } }` — diagrams actually drawn since `reset()` (cache misses) |
| `lead` | `card` (`{ summary?, body }`) | `{ status: 200, body: { text, source } }` — the card's lead (§3.1); `source` is `summary` or `body`. `leadOf` from `@pbcp/core` implements it |

```ts
interface RenderResult {
  text: string;                       // the visible prose, markup removed; excludes fence sources, may include captions
  stripped: string[];                 // what was removed: 'html', 'click', 'init', 'htmlLabels'
  fences: Array<{                     // mermaid fences only, in reading order
    type: string;                     // diagram type label, e.g. 'pie', 'futurechart-beta'
    class: 'render' | 'fallback' | 'collapsed';
    source: string;                   // fence source after sanitisation
    message?: string;                 // for 'fallback': 'diagram not supported' or the parser's message
    fallbackImage?: boolean;          // true when a `fallback` image is shown in place of the fallback block
  }>;
  images: Array<{
    alt: string; src: string;
    class: 'image' | 'link' | 'hidden'; // 'hidden': a fallback image whose fence rendered
    svg?: string;                     // for data:image/svg+xml: the sanitised SVG text
  }>;
}
```

### Values in `args`

`{ "$var": "name" }` anywhere in `args` is replaced by the saved variable. `{ "$repeat": ["x", 60000] }` is replaced by the text repeated that many times, so a fixture can send a large card without carrying it.

### Matching (`expect`)

- A primitive matches by strict equality.
- An object without `$` keys matches **partially**: every listed key must match; other keys are ignored.
- An array matches elementwise and must have the same length.
- An object with `$` keys is a matcher; several `$` keys in one object must all hold:

| matcher | holds when |
| --- | --- |
| `{ "$var": "n" }` | equal to saved variable `n` |
| `{ "$gt": v }`, `{ "$lt": v }` | numeric comparison; `v` may be `{ "$var": … }` |
| `{ "$adjacent": v }` | numeric and `abs(actual - v) == 1` |
| `{ "$absent": true }` | key missing or `undefined` (use as a value inside a partial object) |
| `{ "$present": true }` | key present and not `null` |
| `{ "$type": "string" \| "number" \| "boolean" \| "object" \| "array" }` | type check |
| `{ "$len": n }` | array or string length |
| `{ "$contains": [m, …] }` | array: every `m` matches at least one element |
| `{ "$none": m }` | array: no element matches `m` |
| `{ "$every": m }` | array: every element matches `m` |
| `{ "$oneOf": [m, …] }` | at least one `m` matches |
| `{ "$includes": "s" }`, `{ "$excludes": "s" }` | string contains / does not contain `s` |

### Paths (`save`)

Dot-separated: `body.change_seq`, `body.changes.0.seq`. A segment `[k=v]` selects the first array element whose (dotted) key `k` equals `v`: `body.changes.[card.id=goalpath:item:4421].seq`.

## Reference renderer

`@pbcp/core/conformance/render` exports `referenceRenderer()`, the `RenderUnderTest` the in-process run uses. It classifies without drawing, so a head can run the render fixtures against it before its own renderer exists. Its `lead` is core's `leadOf`; a head that uses `leadOf` passes R09–R11 by delegating to it.

## Cases

| # | Case | RFC |
| --- | --- | --- |
| C01 | Identical re-PUT → 200, same `change_seq` | §5 |
| C02 | Changed open PUT → 200, replaced, `seen_at` cleared, `change_seq` bumped | §5 |
| C03 | Decide, then identical PUT → 200 with decision in body; deciding, presenting or acknowledging an unknown id → 404 | §5, §7.3 |
| C04 | Decide, then changed PUT → 409 with decision in body | §5 |
| C05 | Supersede open card: both visible atomically, two consecutive `change_seq` | §8 |
| C06 | Supersede decided card: predecessor keeps its decision | §8 |
| C07 | Supersede an already-superseded id → 409; a missing target or the card itself → 400 | §8 |
| C08 | Cross-namespace supersede (`goalpath:item` → `goalpath:milestone`) → 403 | §6 |
| C09 | Sync returns only the caller's namespace; `next` is the global max | §7.2 |
| C10 | Sync pagination: `next` advances across pages, nothing skipped | §7.2 |
| C11 | Artifact acknowledgement sets `acknowledged_at`, state stays `open`; an artifact with `actions` → 400; a decision card is never acknowledged | §4.1, §4.2 |
| C12 | Front-matter PUT with YAML outside the subset → 400; choice objects as a sequence of one-level mappings → 201 | §3, §4.4 |
| C13 | Id outside token root → 403; `producer` ≠ id root → 400; a card for another person → 403 `wrong_person` | §5, §10, §12 |
| C14 | Head-owned field on PUT (core and orders-extension fields) → 400; unknown fields accepted | §3.1, §4.2, A.1 |
| C15 | `protocol: pbcp/2`, `pbcp/1.1`, or no `protocol` → 400 | §2 |
| C16 | Orders: a `*` order reaches executors only; a named order reaches the producer it names | A.1 |
| C17 | Orders: second claim during a live lease → 409; at expiry (`<=` now) another claim → 200, `claim_seq` 2 | A.2 |
| C18 | Orders: an outcome with a stale `orders.claim_seq` is stored, `exec_state` unchanged; one without `orders.result` → 400; the current claim's outcome → `done`; terminal never changes | A.3 |
| C19 | Orders: `dismissed` → `exec_state` cancelled, lease released; renewal and claim → 410; other decisions → 400 | A.1, A.5 |
| C20 | Orders: a `*` order minted before an executor was eligible is never returned to it, and its claim is 404 | A.1 |
| C21 | Choice list with two defaults, a duplicate id, or a protocol decision as an id → 400; `edit` is never a decision, `edited` always is | §4.4, §7.3 |
| C22 | Percent-encoded `upstream-id` round-trips unchanged and is not normalised; a malformed escape → 400 | §5 |
| C24 | Unknown producer fields are preserved through PUT and sync (SHOULD) | §3.1 |
| C25 | `GET /` describes the head: `protocol`, `owner`, `seq`, `extensions`, `render.mermaid` | §7.5 |
| C26 | Missing or invalid producer token → 401 `unauthorized` on PUT and sync | §7.1, §7.2, §7.4 |
| C27 | A 64 KiB card is accepted; one over 1 MiB → 413 `too_large` | §3.1, §7.1 |
| C28 | A ceiling clamps `delivery`; `urgency` is stored and returned unchanged; a producer with no ceiling set has the ceiling `brief` | §4.2, §9 |
| C29 | Malformed `after` → 400 `invalid_cursor` | §7.2, §7.4 |
| C30 | A producer token on decide → 401 `unauthorized`; the card stays open | §7.3 |
| C31 | `GET /` `seq` is the highest `change_seq`; syncing from it returns only later changes | §7.5, §7.2 |
| C32 | Orders: renewing a cancelled order → 410 `order_terminal` with the order (`exec_state: cancelled`) in the body | A.5 |
| C33 | Orders: `claim_seq` counts claims, not renewals (claim 1, renew 1, re-claim after expiry 2, renew 2) | A.1–A.3 |
| C34 | Orders: `lease_seconds` that is not a positive integer → 400 `invalid_lease`; nothing changes | A.2, §7.4 |
| C35 | Orders: a lease belongs to the root; a second token under it renews and posts the outcome | A.1–A.3 |
| C36 | Orders: outcome ids are per claim; a re-run's outcome is a new card and only the current claim's moves `exec_state` | A.3, A.4 |
| C37 | Snooze sets `snoozed_until` with a new `change_seq`; the card stays `open` and in sync; clearing it takes another | §4.2, §6 |
| C38 | `summary` round-trips and counts for equality: identical re-PUT is a no-op, a changed summary replaces an open card (200), and is 409 once decided | §4.1, §5 |
| C39 | A `summary` with CR or LF, or an empty one, is 400 `invalid_card` in both forms; nothing is stored | §4.1 |
| C40 | `summary` in the file form is stored and synced | §3, §4.1 |
| C41 | `labels` round-trip in both forms and compare as a set; a different set replaces an open card and is 409 once decided | §3, §4.1, §5 |
| C42 | At most eight labels and no duplicates → else 400 `invalid_card` | §4.1 |
| C43 | Each label is 1–32 lowercase letters, digits or `-` → else 400 `invalid_card` | §4.1, §5 |
| C44 | `about` round-trips and counts for equality; a date that does not exist, a timestamp or another format → 400 `invalid_card` | §2, §4.1, §5 |
| C45 | An empty `title` or one with a line break → 400 `invalid_card`; nothing is stored | §4.1 |
| C46 | A `kind` the head does not implement → 400 `unsupported_kind`; nothing is stored | §4.1, §7.4 |
| C47 | A front-matter header containing `body` → 400 `invalid_card`; nothing is stored | §3 |
| C48 | Syncing a card does not set `seen_at` or take a `change_seq` | §4.2, §7.2 |
| R01 | Each core-tier type renders; the text around it is intact | §3.1 |
| R02 | An unknown diagram type falls back with its label; text intact | §3.1 |
| R03 | A fence with a parse error falls back with a parser message (shown, its wording the renderer's); the other fences still render | §3.1 |
| R04 | `click`, URL-loading `init` directives (also spanning lines) and front-matter `config:` are stripped before rendering; `title:` is kept | §3.1, §12 |
| R05 | Raw HTML stripped; `http:` image shown as link; `https:` and `data:image/png` as images; inline SVG sanitised | §3.1 |
| R06 | Ninth fence is collapsed, not dropped | §3.1 |
| R07 | Identical fence in two cards yields one cached render (condition `prerender`) | §3.1 |
| R08 | Image with alt `fallback` after a rendered fence is hidden; after an unrenderable fence it replaces the fallback block | §3.1 |
| R09 | The lead is `summary` when present, whatever the body starts with | §3.1, §4.1 |
| R10 | Without `summary`, the lead is the first paragraph, after any leading heading | §3.1 |
| R11 | Without `summary`, a body that opens with a mermaid fence has the first paragraph after it as its lead | §3.1 |
| R12 | An extended-tier diagram (`classDiagram`) renders (SHOULD) | §3.1 |

C23 (a parked change advances the cursor and is reported, RFC §7.2) is a producer obligation, so it is a client test in `packages/client`, not a head fixture.
