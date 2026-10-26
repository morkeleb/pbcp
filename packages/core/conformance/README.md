# Conformance suite

The fixtures in `fixtures/` are the protocol's executable definition. They are plain JSON so a head written in any language can run them; the vitest runner in this directory is one consumer of them, not the definition.

- `fixtures/core/Cnn-*.json` — protocol cases, run against a `HeadUnderTest`.
- `fixtures/render/Rnn-*.json` — rendering classification (RFC §3.1, §14), run against a `RenderUnderTest`.

## Conventions

- The head under test is owned by person id `morten` (the RFC's example owner). Every card is addressed `to_person: "morten"`.
- The head clock starts at an arbitrary time; fixtures that care set it with the `clock` op.
- Tokens are named by their namespace root. `"token": "goalpath"` means "a producer token bound to root `goalpath`"; the runner mints one per root on first use.
- Every fixture starts from an empty head (`reset()`).
- Error responses are checked by status only. A head's error body is its own business; this implementation returns `{ "error": "<stable code>", "message": "..." }`.

## Fixture shape

```json
{
  "name": "C01 identical re-PUT returns 200 with the same change_seq",
  "rfc": ["§5"],
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
| `put` | `token`, `card` (object = JSON; string = file form, `text/markdown`) | `{ status, body }` — body is the stored card on 200/201/409 |
| `changes` | `token`, `after` | `{ status, body: { changes: [{ seq, card }], next } }`, one page |
| `syncAll` | `token`, `after` | runner composite: calls `changes` until `next` stops moving. `{ status, body: { changes, next, pages, ascending } }` where `changes` is every entry across pages in order and `ascending` is true iff seqs strictly increase |
| `decide` | `id`, `decision` (`{ decision, edited_proposal?, comment?, delegated_to? }`) | `{ status, body }` — as the owner |
| `seen` | `id` | `{ status, body }` — the head presents the card to its owner (sets `seen_at`) |
| `acknowledge` | `id` | `{ status, body }` — the owner explicitly acknowledges an artifact or signal |
| `clock` | `set` (RFC 3339) | sets the head clock |

### Render ops (`RenderUnderTest`)

| op | args | result |
| --- | --- | --- |
| `render` | `body` (markdown) | `{ status: 200, body: RenderResult }` |
| `draws` | — | `{ status: 200, body: { count } }` — diagrams actually drawn since `reset()` (cache misses) |

```ts
interface RenderResult {
  text: string;                       // the visible prose, markup removed; used with $includes / $excludes
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

`{ "$var": "name" }` anywhere in `args` is replaced by the saved variable.

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

## Cases

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
| C14 | Head-owned field on PUT → 400; unknown `x-` field preserved | §3.1, §4.2 |
| C15 | `protocol: pbcp/2` → 400 | §2 |
| C21 | Choice list with two defaults, or a duplicate id → 400 | §4.4 |
| R01 | Each core-tier type renders; the text around it is intact | §3.1 |
| R02 | An unknown diagram type falls back with its label; text intact | §3.1 |
| R03 | A fence with a parse error falls back with the message; the other fences still render | §3.1 |
| R04 | `click` and URL-loading `init` directives are stripped before rendering | §3.1, §12 |
| R05 | Raw HTML stripped; `http:` image shown as link; `https:` and `data:image/png` as images; inline SVG sanitised | §3.1 |
| R06 | Ninth fence is collapsed, not dropped | §3.1 |
| R07 | Identical fence in two cards yields one cached render | §3.1 |
| R08 | Image with alt `fallback` after a rendered fence is hidden; after an unrenderable fence it replaces the fallback block | §3.1 |

C16–C20 (orders extension) are milestone 3.
