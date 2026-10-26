# Open questions found during implementation

Add one entry per ambiguity, with the RFC section and the interpretation chosen.

Found while building milestone 1 (`@pbcp/core`, the conformance suite, `@pbcp/client`, `connectors/imap`) against draft 0.2. Each entry: the question, then **Chosen:** the interpretation now in code or fixtures. Contradictions in the text come first.

## Contradictions

1. **§11.1 vs §4.2 — artifacts with actions.** §11.1 (revised) says the mail reader sends `kind: artifact` "with `actions: [archive, keep]` for inbox messages", but §4.2 says artifact and signal cards "never carry a decision", and `actions` is defined "for `kind: decision`" (§4.1). **Chosen:** inbox messages are `kind: decision` with `actions: [archive, keep]`; everything else is `kind: artifact` without actions (as the kickoff prompt and skeleton say). §11.1 should be fixed to match.
2. **§3 vs §4.4 — choice objects in the file form.** The YAML subset allows "flow sequences of scalars", "block sequences" and "one level of nested mapping"; a §4.4 choice object (`{id, label, body, default}`) in `actions` needs a *sequence of mappings*, which is arguably two levels. **Chosen:** block sequences whose items are one-level mappings of scalars are allowed (`- id: x` / `  label: y`); nothing deeper. `default` is written `"true"`/`"false"` and converted after parsing.
3. **§7.3 vs §4.4 — is `edited` always available?** §7.3 says `decision` MUST be one of `actions` or a built-in (`dismissed`, `delegated`, `edited`), so `edited` is always valid; §4.4 says a producer "that wants a closed choice leaves [`edit`] out". **Chosen:** §7.3 as written — the decide operation accepts `edited` on any decision card; whether a head *offers* it when `edit` is absent is UI. The literal value `edit` is not a valid decision (it is recorded as `edited`).
4. **Skeleton vs RFC — C11 section.** The skeleton cites §4.3 for acknowledgement; it is defined in §4.2. Fixtures cite §4.2.

## Interpretations in `@pbcp/core`

5. **§5, §8 — `change_seq` order within a supersession.** Two consecutive values; which card gets the lower one is unspecified. **Chosen:** predecessor first, successor second (the successor is the newest change). Fixtures only assert adjacency.
6. **§7.2 — what `next` is.** "Highest global head sequence observed in the response." **Chosen:** the highest `change_seq` the head scanned while building the page (other producers' cards included); when a page is cut off by the cap, the seq of the last entry returned; `after` when nothing is newer.
7. **§7.2, §4.2 — owner-side changes bump `change_seq`.** Setting `seen_at` or `acknowledged_at` changes the card's current representation, so it takes a new `change_seq` (and producers see it on sync).
8. **§5 — which revisions clear `seen_at`.** §5 says body or `actions`; the §6 table says body. **Chosen:** body or `actions`, compared semantically. A title-only change keeps `seen_at`. `acknowledged_at` and `snoozed_until` are kept across a replacement (the RFC is silent).
9. **§5 — semantic equality, precisely.** **Chosen:** defaults are applied before comparing (absent `urgency` = `brief`, absent `references` = `[]`, absent `actions` on a decision = `[approve, reject]`); `"x"` = `{ "id": "x" }`; `default: false` = no default; trailing whitespace at the end of `body` is ignored; key order is irrelevant; list order is significant (including `references`). Unknown and extension fields participate. A `content_hash` (§14) would make this explicit.
10. **§2, §3 — body boundary in the file form.** **Chosen:** the body is everything after the closing `---` line, minus one blank separator line if present. `toFrontMatter` writes that blank line.
11. **§3 — constructs neither allowed nor named as forbidden.** Flow mappings, block scalars (`|`, `>`), directives (`%YAML`), document end (`...`), multi-line scalars, quoted/complex keys, tabs in indentation, duplicate keys. **Chosen:** all rejected with 400 under "anything outside this subset". Comments (`#`) are allowed, with YAML's rule that ` #` starts a comment in a plain scalar (so `title: Fix #12` must be quoted; the writer does).
12. **§3 — an empty value (`thread:`).** **Chosen:** the empty string, then validated (so `thread:` fails, as `thread` must be non-empty).
13. **§3 — non-string extension fields in the file form.** `orders.claim_seq: 2` in YAML is the string `"2"`; the RFC's "YAML → strings → validation → typed JSON" only types *named* fields. **Chosen:** unknown fields stay strings when read from a file; `toFrontMatter` writes numbers and booleans as strings and refuses nested objects. The two forms are therefore not lossless for typed extension fields until an extension declares its types.
14. **§3.1 — unknown fields.** "MUST ignore … SHOULD preserve". **Chosen:** preserved verbatim, and C14 requires it for an `x-` field (stricter than the RFC, as the case list asked).
15. **§4.1 — `title` is "one line".** **Chosen:** a title containing CR or LF is rejected with 400.
16. **§4.1 — `actions` on artifacts and signals.** **Chosen:** validated (grammar, duplicates, defaults) and stored, but meaningless: such cards cannot be decided.
17. **§4.1, A.1 — `kind: order` and `to_producer` from a producer.** **Chosen:** `kind: order` is refused (400, `unsupported_kind`) since the head mints orders and milestone 1 does not implement the extension; unknown kinds likewise. `to_producer`, `exec_state`, `claimed_by`, `claim_expires_at`, `claim_seq` are treated as head-owned on every card and refused.
18. **§2 — malformed `protocol`.** **Chosen:** any string other than `pbcp/1` (including `pbcp/1.1`) is 400 `unsupported_protocol`; a missing or non-string `protocol` is 400 `invalid_card`.
19. **§2 — UTC timestamps.** **Chosen:** `Z` or `±00:00` offsets only; other offsets are 400.
20. **§5, §4.4 — grammar of string actions.** §4.4 says an object's `id` follows the intent grammar. **Chosen:** bare string entries do too.
21. **§6, §8 — supersede a card that does not exist.** **Chosen:** 400 `supersede_target_missing`.
22. **§6, §8 — a card that supersedes itself.** **Chosen:** 400 `supersede_self`.
23. **§8 — re-PUT of a successor.** **Chosen:** supersession is applied when the card is new, or when an open card is re-PUT with a *different* `supersedes`. An identical or same-target re-PUT never re-marks the predecessor.
24. **§5 — body of a 409 that is not about a locked card.** The table's 409 carries "the stored card", but a 409 for superseding an already-superseded target (§8) has no obvious stored card when the successor is new. **Chosen:** that refusal returns an error body, not a card; fixtures do not assert it.
25. **§7.3 — refusals the RFC does not list.** **Chosen:** deciding an artifact/signal is 400 `not_decidable`; acknowledging a decision card is 400 `not_acknowledgeable`; a decision value not offered, `edited` without `edited_proposal`, `delegated` without `delegated_to`, or either field alongside another decision is 400 `invalid_decision`. Deciding or acknowledging an unknown id is 404 in the in-process adapter; 404 is not in §7.4.
26. **§7.3 — success status.** Unstated. **Chosen:** 200 for decide, and for the owner-side `seen` and `acknowledge` operations.
27. **§7.1 — order of refusals.** When a card is both outside the token root (403) and malformed (400), which status wins is unspecified. **Chosen:** parse first (400), then root and owner (403). C13 tests them separately.
28. **`errors.ts` before `yaml.ts`.** Not an RFC question: the kickoff order put `errors.ts` last, but `yaml.ts` and `card.ts` throw it, so it was committed second.

## Interpretations in the conformance suite

29. **`HeadUnderTest` needs owner actions.** The skeleton's interface has no way to set `seen_at` (C02) or `acknowledged_at` (C11). **Chosen:** two methods were added, `seen(id)` and `acknowledge(id)`, both performed "as the owner".
30. **Owner identity.** The interface has no owner parameter. **Chosen:** the head under test is owned by `morten`, the RFC's example person.
31. **§7.2 — page size.** Cannot be forced through `HeadUnderTest`. **Chosen:** `syncAll` is a runner-side composite that pages until `next` stops moving. C10 has 121 cards so a head capping pages at 100 still paginates. The in-process adapter defaults to a page size of 2.
32. **§5 — "no change" on an identical re-PUT.** **Chosen:** `received_at`, `change_seq` and `seen_at` are unchanged; the stored `emitted_at` is not asserted.
33. **§3.1 — "immediately after … with nothing between".** Whether a blank line between a fence and its `fallback` image breaks the binding is open. The fixtures put the image on the next line. **Chosen** (reference renderer): blank lines are allowed between; any other content breaks the binding.
34. **§3.1, §14 — the "stripped" classification.** §14 lists `render`, `fallback`, `stripped` as fence classes. **Chosen:** fences are `render`, `fallback` or `collapsed`; what was removed (HTML, `click`, `init`, `htmlLabels`) is reported in a separate `stripped` list. Only `init` directives that load from URLs or set `htmlLabels` are removed; benign `init` is kept.
35. **§3.1 — the ninth fence.** "MUST render up to 8 … MAY collapse the rest". **Chosen:** R06 requires the first eight to render and the ninth to be present as `render` or `collapsed`.
36. **§3.1 — R07 caching.** Only heads that pre-render must cache by content hash. The fixture assumes the head under test does; a client-side head would need to skip R07.
37. **§3, §12 — contents of stripped HTML.** Unspecified whether the text inside a stripped element survives. **Chosen** (reference renderer): `<script>`, `<style>` and `<iframe>` lose their contents; other tags are dropped and keep their text. Fixtures assert only that tags and script contents are gone.
38. **Reference renderer.** It is a classifier in `conformance/in-process`, not part of `@pbcp/core`'s API: rendering belongs to heads. Its parse check is shallow (diagram header, plus `pie` data lines), enough for R03. `graph`, the mermaid alias for `flowchart`, is treated as "other", since the RFC lists only `flowchart`.

## Interpretations in `@pbcp/client` and `connectors/imap`

39. **§5 — real-world ids vs the grammar.** Message-IDs (`<a+b@host>`) are not valid `upstream-id`s, and accounts (`me@example.com`) are not valid namespaces. **Chosen:** upstream is the first 24 hex chars of sha256(Message-ID); the namespace is the account lowercased, with each run of characters outside `[a-z0-9-]` turned into `-`. Two accounts that differ only in punctuation collide. Should the RFC recommend a mapping, or allow percent-encoding in `upstream-id`?
40. **§5 — mail with no Message-ID.** **Chosen:** the id hashes `mailbox/uid`, which is *not* stable across a move or a UIDVALIDITY change. The RFC requires deterministic ids, and this source cannot always provide one.
41. **§3.1 — producers that depend on their extension fields.** The IMAP connector locates the message on decision through `x-imap-*` fields that heads only SHOULD preserve. If a head drops them, archive/keep silently does nothing. Should preserving `x-` fields through sync be a MUST?
42. **§7.2 — a change that can never be processed.** The cursor must not advance past a failing `onDecision`, so one unprocessable card (say, a deleted mailbox) blocks every later change for that producer. The RFC says nothing about parking or skipping a poison card. **Chosen:** block and report through `onError`.
43. **§7.2 — `next` lower than `after`** (for example after a head is reset). **Chosen:** the client ends the pass without moving the cursor.
44. **§5, §7.1 — decided cards on the submit path.** A 200 or 409 that returns a non-open card is handed to `onDecision` at once, and the same change usually arrives again through sync. Duplicate delivery is expected and the §5 idempotency rule covers it.
45. **§5 — a decided id produced again with different content.** If the archive folder is also scanned, an archived message is re-produced as an artifact with a different mailbox and uid, giving a 409 on every pass. This is harmless (never retried) but noisy.
46. **§4.1, §10 — how a producer learns `to_person`.** A connector has to be configured with its head owner's person id (`PBCP_TO_PERSON`). `GET /` could advertise it.
47. **§7.4 — `Retry-After`.** The client raises `rate_limited` but does not yet honour `Retry-After`; the loop simply waits for its next interval.
48. **§7.4 — error codes on the wire.** The RFC fixes statuses, not error body strings. The client trusts a body's `error` only if it is a known code whose status matches, and otherwise falls back to a code chosen from the status. Should error codes be part of the protocol?
49. **§8 — thread keys across servers.** The same conversation gets `thr-<server id>` on servers that expose thread ids, and `ref-<hash>` on others. Thread keys are scoped to the producer, so this matters only if a producer changes servers.
