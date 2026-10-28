# @pbcp/core

The Personal Brief Card Protocol (draft 0.7), as pure functions: no I/O, no clock, no storage. A head is mostly plumbing around these calls; a producer uses them to build and check cards before sending.

The specification is [`rfc/pbcp-draft-0.7.md`](https://github.com/morkeleb/pbcp/blob/main/rfc/pbcp-draft-0.7.md). Section numbers below refer to it.

```ts
import { parseCard, toFrontMatter, toJSON, equal, submit, decide, checkSubmission } from '@pbcp/core';
```

| Export | What |
| --- | --- |
| `parseCard(input)` | JSON object, JSON text or front-matter text → `{ ok, value }` or `{ ok: false, error }`. Rejects head-owned fields, other major versions, YAML outside the subset (§2–§4). `parseCardOrThrow` throws instead. |
| `toJSON(card)`, `toFrontMatter(card)` | The wire and file forms (§3). |
| `equal(a, b)` | Semantic equality (§5). |
| `parseId`, `sameNamespace`, `inRoot`, `encodeUpstream`, `decodeUpstream` | The id grammar, including percent-encoded upstream ids (§5). |
| `parseYaml`, `stringifyYaml` | The restricted YAML subset (§3). |
| `checkSubmission`, `submit`, `decide`, `canSupersede`, `acknowledge`, `markSeen`, `snooze`, `unsnooze` | Lifecycle transitions (§5–§8). Each returns its effect, including `changed`: the cards to persist, in the order the head assigns them `change_seq`. Nothing here touches the counter. `submit(stored, incoming, now, target, ceiling?)` sets the head-owned `delivery` from the producer's urgency ceiling (§9), which the head passes in; a producer with none set has the ceiling `brief`, the default. `snooze(stored, until, now)` and `unsnooze(stored, now)` set and clear the owner-side `snoozed_until` (§4.2) on an `open` card, which takes a new `change_seq` and stays `open` (§6); a card that is not open is a 409 result carrying it, and an `until` not later than `now` is `400 invalid_snooze`. |
| `mintOrder`, `visibleTo`, `claim`, `renew`, `expireIfDue`, `checkLease`, `checkOutcome`, `applyOutcome`, `ulid`, `ulidOf` | The orders extension (Appendix A), pure like the lifecycle: the head mints orders, keeps the wildcard eligibility snapshot per root, and applies leases and outcomes with its own clock. A lease belongs to a root; a renewal keeps `claim_seq`. A refused claim is a `ClaimRefusal` (`409 lease_held`, `410 order_terminal`, with the order); `checkOutcome` refuses an outcome without `orders.result`. `decide` takes `dismissed` on an order and cancels it. |
| `isLabel`, `LABELS_MAX`, `isLocalDate` | The §4.1 rules for `labels` (lowercase intent grammar, 1–32 characters, at most 8, no repeats) and `about` (a `YYYY-MM-DD` date that exists), which `parseCard` applies; exported for producers that build labels or dates. |
| `exampleCard` | The §3 example card as a typed constant; a test parses the RFC's own §3 fence and checks they are equal. |
| `clampUrgency` | `urgency` (absent is `brief`) lowered to a ceiling (§9). |
| `leadOf` | A card's lead (§3.1): `{ text, source: 'summary' }` when the card has a `summary`, else the body's first paragraph by the RFC's line rule, `{ text, source: 'body' }` (empty text when there is none). It splits; it renders nothing. Heads use it so every head shows the same lead. |
| `PbcpError`, `ERROR_CODES` | Refusals with their status and normative code (§7.4). |
| `ProducerCardSchema`, `HeadFieldsSchema`, `DecisionSchema`, `HeadDescriptionSchema` | Zod schemas; types `ProducerCard`, `Card`, `Decision`, `HeadDescription`. |

## Conformance

`@pbcp/core/conformance` ships the protocol's fixtures (`conformance/fixtures/*.json`, language-neutral) and a framework-free runner (`loadFixtures`, `runFixture`, which throws on the first failing step). Implement `HeadUnderTest` for your head. With vitest:

```ts
import { conformanceSuite } from '@pbcp/core/conformance/vitest';
conformanceSuite({ head: () => myHeadAdapter(), render: () => myRenderer() });
```

The fixture format, ops and matchers are described in `conformance/README.md`. `vitest` is an optional peer dependency, needed only for `@pbcp/core/conformance/vitest`. `@pbcp/core/conformance/render` exports `referenceRenderer()`, the classifier the in-process run uses for R01–R11, so a head can run the render fixtures before it has a renderer of its own.

MIT licence.
