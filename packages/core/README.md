# @pbcp/core

The Personal Brief Card Protocol (draft 0.5), as pure functions: no I/O, no clock, no storage. A head is mostly plumbing around these calls; a producer uses them to build and check cards before sending.

The specification is [`rfc/pbcp-draft-0.5.md`](https://github.com/morkeleb/pbcp/blob/main/rfc/pbcp-draft-0.5.md). Section numbers below refer to it.

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
| `checkSubmission`, `submit`, `decide`, `canSupersede`, `acknowledge`, `markSeen` | Lifecycle transitions (§5–§8). Each returns its effect, including `changed`: the cards to persist, in the order the head assigns them `change_seq`. Nothing here touches the counter. `submit(stored, incoming, now, target, ceiling?)` sets the head-owned `delivery` from the producer's urgency ceiling (§9), which the head passes in; a producer with none set has the ceiling `brief`, the default. |
| `mintOrder`, `visibleTo`, `claim`, `renew`, `expireIfDue`, `checkLease`, `checkOutcome`, `applyOutcome`, `ulid`, `ulidOf` | The orders extension (Appendix A), pure like the lifecycle: the head mints orders, keeps the wildcard eligibility snapshot per root, and applies leases and outcomes with its own clock. A lease belongs to a root; a renewal keeps `claim_seq`. A refused claim is a `ClaimRefusal` (`409 lease_held`, `410 order_terminal`, with the order); `checkOutcome` refuses an outcome without `orders.result`. `decide` takes `dismissed` on an order and cancels it. |
| `clampUrgency` | `urgency` (absent is `brief`) lowered to a ceiling (§9). |
| `PbcpError`, `ERROR_CODES` | Refusals with their status and normative code (§7.4). |
| `ProducerCardSchema`, `HeadFieldsSchema`, `DecisionSchema`, `HeadDescriptionSchema` | Zod schemas; types `ProducerCard`, `Card`, `Decision`, `HeadDescription`. |

## Conformance

`@pbcp/core/conformance` ships the protocol's fixtures (`conformance/fixtures/*.json`, language-neutral) and a framework-free runner (`loadFixtures`, `runFixture`, which throws on the first failing step). Implement `HeadUnderTest` for your head. With vitest:

```ts
import { conformanceSuite } from '@pbcp/core/conformance/vitest';
conformanceSuite({ head: () => myHeadAdapter(), render: () => myRenderer() });
```

The fixture format, ops and matchers are described in `conformance/README.md`. `vitest` is an optional peer dependency, needed only for `@pbcp/core/conformance/vitest`. `@pbcp/core/conformance/render` exports `referenceRenderer()`, the classifier the in-process run uses for R01–R08, so a head can run the render fixtures before it has a renderer of its own.

MIT licence.
