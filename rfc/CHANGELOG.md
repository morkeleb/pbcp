# RFC changelog

## 0.3 (2026-10-26)

Draft 0.3 writes down what implementing 0.2 (core library, conformance suite, client, IMAP producer) had to decide. Numbers in brackets refer to the 0.2-era entries of `rfc/OPEN.md` (see its git history).

**Contradictions fixed**

- §11.1: a mail reader sends inbox messages as `kind: decision` with `actions: [archive, keep]` and every other message as `kind: artifact` without `actions`; it drafts and sends nothing. §1.2 calls the replying producer a mail *agent*. [#1]
- §3: block sequences of one-level mappings are in the restricted YAML subset, so §4.4 choice objects have a file form; booleans in them are written `"true"`/`"false"`. [#2]
- §4.3, §4.4, §7.3: `edited` is a valid decision on every decision card; the `edit` entry only controls whether a head offers free text, and `edit` is never recorded as a decision. [#3]

**Identity (§5)**

- `upstream-id` admits percent-encoded octets (`pct-encoded = "%" HEXDIG HEXDIG`); ids are compared as exact strings and never normalised; producers SHOULD use uppercase hex. [#39]
- A producer MAY hash an unbounded or unrepresentable upstream key and SHOULD document the hash; a source with no stable key cannot meet the determinism rule, and such a card MUST say so in its body. [#40]
- Equality is defined precisely: defaults applied (`urgency`, `references`, decision `actions`), string action = `{ id }`, `default: false` = no default, trailing body whitespace ignored, member order ignored, list order significant, unknown fields compared. [#9]
- An identical re-PUT changes nothing: `change_seq`, `received_at`, `seen_at` and the stored `emitted_at` are kept. [#32]
- A revision clears `seen_at` when the body or `actions` change (the §6 table now agrees) and keeps `acknowledged_at` and `snoozed_until`. [#8]

**Card format (§2, §3, §3.1, §4)**

- §2: timestamps use offset `Z` or `±00:00`, anything else is `400` [#19]; `protocol` must be exactly `pbcp/<major>`, so `pbcp/1.1` and a missing `protocol` are `400` [#18].
- §3: the subset is listed in full, with everything outside it named and rejected with `400` (flow mappings, block scalars, directives, document markers, multi-line scalars, quoted/complex keys, tabs, duplicate keys); comments are allowed with YAML's ` #` rule [#11]; an empty value is the empty string [#12]; the file form's header/body boundary and blank separator line are defined [#10]; fields not defined by the protocol or an implemented extension are strings in the file form [#13].
- §3.1: unknown fields SHOULD be preserved verbatim (unchanged level), and a producer keeps the state it needs to act on decisions itself [#14, #41]; stripped HTML loses `script`/`style`/`iframe` contents and keeps other text [#37]; a fallback image may follow its fence after blank lines [#33]; only URL-loading or `htmlLabels` `init` directives are stripped [#34]; a fence beyond the eighth is rendered or collapsed, never dropped [#35]; diagram types match exactly, so `graph` is Other tier [#38].
- §4.1: `title` is non-empty and one line (no CR/LF) [#15]; `actions` only on `kind: decision`, and an artifact or signal carrying it is `400` [#16, changed from "validated and ignored"]; bare string actions follow the intent grammar [#20]; a kind the head does not implement is `400` [#17].
- §4.2: owner-side changes (`seen_at`, `acknowledged_at`, `snoozed_until`) take a new `change_seq` [#7]; `acknowledged_at` is never set on a decision card [#25]; the orders extension's head-owned fields are refused on every card, extension or not [#17]; `edited_proposal` and `delegated_to` appear with their decision only [#25].

**Operations (§6, §7, §8)**

- §6, §8: superseding a card the head does not hold, or the card itself, is `400` [#21, #22]; a PUT supersedes only when it creates a card naming `supersedes` or changes an open card's `supersedes`; re-PUTs and PUTs to locked ids never supersede again [#23].
- §7.1: the URL id must equal the card id (`400`); refusals are evaluated in a fixed order (401, 400, 403, supersede checks, the §5 table) [#27]; refusals other than the locked-card `409` carry an error body, not a card [#24].
- §7.2: in a supersession the predecessor takes the lower `change_seq` [#5]; `next` is the highest sequence the head examined, the last returned `seq` when the page is capped, never lower than `after`, and a lower `next` is a producer-side error [#6, #43]; sequence values survive a storage restore; producers expect duplicate delivery [#44].
- §7.2: **parking** — a producer MAY park a change that keeps failing, advance past it, and MUST report it, at least by logging. [#42]
- §7.3: decide responds `200` with the card, `400` for a value not allowed or a non-decision card, `404` for an unknown id, `409` with the card when locked. [#25, #26]
- §7.4: `404 Not Found` added; error bodies `{ error, message }` with a normative table of codes per status; `Retry-After` is in seconds and a producer SHOULD wait it out. [#47, #48]
- §7.5 (new): `GET /` describes the head: `protocol`, `owner`, `extensions`, `render.mermaid`; §3.1 and §10 refer to it. [#46]
- §11.1, §11.3: checklists add parking, `Retry-After` and describe; stray markup fixed.
- §14: the conformance suite is described (owner actions, owner `morten`, paging, SHOULD-level fixtures, render classes `render`/`fallback`/`collapsed` plus a stripped list). [#29, #30, #31, #34, #36]
- Appendix A.1: a submitted `kind: order` is `400`. [#17]

**From review of this draft against the implementation**

- §2: a timestamp must name a date and time that exist (a leap second is allowed).
- §3: keys are written `key: value` with one space and start with a letter, digit or `_`; a plain scalar does not start with a YAML indicator (`,`, `]`, `}` included).
- §4.4: `dismissed`, `edited` and `delegated` are reserved and cannot be action ids (`400`).
- §7.1: the response list names every status (oversize is `413`, not `400`); `429` and `413` are placed in the refusal order; which `400` code is reported when several apply is not specified.
- §7.4: extension statuses (`410` in Appendix A) are the extension's to define.
- §7.5: `render.mermaid` values are `core`, `extended`, `other`; clients ignore unknown values.
- Editorial: §1.2 the risk card is a decision (a signal cannot be delegated) and the delegation row points at Appendix B; §7.3, §10 and §14 cross-references fixed (delegation is Appendix B, not A); the §6 lifecycle placeholder is now a diagram; escaped markup repaired.

## 0.2 (2026-10-26)

JSON canonical on the wire; server `change_seq` cursor; `to_person`/`to_producer`; `protocol: pbcp/1`; Orders as Appendix A with leases; delegation deferred to Appendix B; §3.1 rendering profile; §4.4 choice lists.

## 0.1 (2026-10-07)

First draft.
