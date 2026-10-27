# RFC changelog

## 0.6 (2026-10-27)

Draft 0.6 is driven by the first real brief rendered by a head. It adds one producer-owned field and makes presentation normative where it decides whether a person can act on a card. There are no changes to orders, delegation or the operations. In-process conformance: 44 → 50 cases (core C38–C40, render R09–R11).

**Fields**

- **§4.1 — `summary`.** An optional producer-owned string: one or two sentences of plain text saying what is going on and what the card wants. It MUST NOT be empty or contain CR or LF (`400 invalid_card`), SHOULD be under 280 characters, and a head MAY truncate it beyond that with an ellipsis. It is not markdown: a head MUST show it as text. It counts for equality (§5) like every producer-owned field except `emitted_at`, so a changed `summary` replaces an open card (`200`) and is a `409` on a decided one. New fixtures C38, C39 and C40.
- **§3 — the example card** carries `summary` in both forms.

**Rendering and presentation**

- **§3.1 — the lead.** A card's lead is its `summary`, or else the body's first paragraph, found by a line-based rule that skips headings, thematic breaks and fenced code blocks. In a list, a folded brief or a thread summary, a head MUST show at least each card's lead and MAY stop there; on the card a head MUST NOT hide it behind a gesture. Producers without `summary` write bodies lead-first. New fixtures R09, R10 and R11.
- **§4.5 — presenting a decision (new).**
  - The card's `actions` are its controls. A head MUST show them without a prior gesture and in order, with the default or else the first as the primary control, and never behind one intermediate control.
  - `dismissed` is always available as a secondary control; free text (`edited`) only when `edit` is listed; `delegated` only with Appendix B.
  - The lead and any `Proposal`/`Proposed` section are visible. Deciding never requires opening the card.
  - `comment` is never required, and SHOULD sit behind a disclosure.
  - A recorded decision or acknowledgement MUST be confirmed distinguishably from an unavailable control, and SHOULD show the new state in place.
- **§8 — what a brief contains.** A generated brief MUST include every open decision card's title and lead, SHOULD include the newest card's title and lead for each of the previous day's artifact and signal threads, and MUST link each entry to its card. Counts and charts are optional additions, never the brief.

**Corrections after merge**

- **§4.5 — no default, no primary.** Only the option marked `default` is the primary control. With no default, a head MUST give the options equal weight and MUST NOT style or place one as primary, consistent with §4.4's rule that there is no bare approve without a default. The merged text made the first entry primary, which contradicted §4.4. The render adapter cannot express how a control is weighted, so there is no fixture; the rule is in the §11.3 head checklist.
- **§4.5 — the proposal heading is matched case-insensitively**: `Proposal`, `Proposed`, `PROPOSED REPLY`. No core helper matches it.
- **§4.1 — `summary` on a decision card SHOULD state the proposal**, not only the topic, so that a brief's decision line can be decided on its own. The §3 example's `summary` already does. The hermes skills and the goalpath connector follow it.
- **§11.1 — one decision per mail thread** (after first use on a phone). A new message in a thread that has an open mail card supersedes that card (§8), so the thread is decided once, on its latest message, and the decision applies to the messages it superseded. A predecessor decided before the successor reached the head keeps its decision, as §8 already requires, and the reader acts on it for that message.
- **§11.1 — archive is the default** (after first use on a phone). Inbox cards are `actions: [{ "id": "archive", "default": true }, "keep"]`, so a bare approve gesture (§4.4) archives the message.
- **§8 — snoozed decisions stay out of the brief.** §8 required every open decision card in a generated brief, while §4.2 hides a card with a future `snoozed_until` from the brief. Resolved in favour of §4.2: the brief includes every open decision card that is not snoozed; it MAY state how many are snoozed and MUST NOT list them or their leads until `snoozed_until` has passed. The §11.3 brief item says the same. No fixture covers brief contents, so none changes.

**Conformance**

- **§11.1** — the mail reader fills `summary` from the message's first lines, whitespace collapsed.
- **§11.3** — the head checklist gains `summary` as text, the lead, §4.5 and §8.
- **§14** — lead fixtures run against the render adapter, from a card's `summary` and `body`. §4.5 and §8 are interface obligations and have no fixtures.

## 0.5 (2026-10-26)

Draft 0.5 writes the second implementation's findings into the text. The evidence is `rfc/OPEN.md` as of 0.4 plus orders (items 1–21, cited as OPEN #n), `morkeleb/pbcp-head` PR #2 (its fifteen §3.1 decisions, cited as H2-#n) and PR #3 (its Appendix A table and readings H-1 to H-6). Nothing new was added beyond what those findings required. In-process conformance: 40 → 43 cases.

**Status.** Two independent implementations pass the full suite and agree on every fixture; open questions are in `rfc/OPEN.md`, and none affects interoperability.

**Orders (Appendix A)**

- **A.1, A.2, A.3, A.5 — a renewal keeps `claim_seq`.** It increments on a new claim only (the first, or one after a lease lapsed). Under 0.4 every renewal incremented it, so an outcome built while a renewal was in flight arrived stale and the head filed a correct result as late (OPEN #14; pbcp-head PR #3, row 14). C33 changes accordingly. A.5's "stale after cancel" becomes "ignored because the order is terminal" (OPEN #13).
- **A.1, A.3 — `orders.result`.** A producer-owned field, `done` or `failed`, required on every outcome; an outcome lacking it, or `orders.claim_seq`, or an order in `references`, is `400 invalid_card`. It replaces 0.4's unstated success/failure (OPEN #11; head agrees, row 11). C18 gains the `400` step.
- **A.2, A.5, §7.4 — claim refusals have codes.** `409 lease_held` and `410 order_terminal` are §7.4 error bodies that also carry the order, `{ error, message, order }`; a missing or non-positive-integer `lease_seconds` is `400 invalid_lease`. All three are in the §7.4 table, and `410` in the status table (OPEN #8, #10; head rows 8 and 10, which used `invalid_card` for want of a code). New fixture C34; C17, C32 and C33 check the new bodies.
- **A.2 — claiming what you cannot read** is `404 not_found` (OPEN #9; head agrees).
- **A.1, A.2, A.3 — a lease and wildcard eligibility belong to a root.** `claimed_by` is the holding root; any token under it may renew the lease and post its outcome. The eligibility snapshot lists roots (pbcp-head H-1, H-2; OPEN #12 and #19 restated per root). New fixture C35.
- **A.2, A.3 — expiry and late results produce no cards.** A head SHOULD surface an expired lease or a late or duplicate outcome to the person in its own interface, and MUST NOT mint a card for it, since a head-minted card would move every producer's cursor. 0.4's "SHOULD emit a `signal` card" is withdrawn (pbcp-head H-3, H-4; OPEN #15).
- **A.2 — expiry is lazy and normative.** The head applies it when it next reads or writes the order, and the order takes a new `change_seq` then (OPEN #15; head row 15).
- **A.3 — what "the current lease" means.** After expiry is applied: the order is `claimed`, the outcome's root is `claimed_by`, and `orders.claim_seq` is the order's `claim_seq`. An applied outcome takes the lower `change_seq`, the order the higher (OPEN #12, #20; head rows 12 and 20).
- **A.3, A.4 — outcome and progress ids are per claim.** `<root>:order:<ulid>:outcome-<claim_seq>` and `progress-<claim_seq>-<n>`, so a re-run after a lapsed lease writes beside the first run rather than replacing it (OPEN #18; head row 18). New fixture C36. The reference executor sketch is rewritten to match, failure included (`orders.result: failed`, no longer a decision card).
- **A.1 — giving an order is the owner's action**, like decide: outside the producer protocol, exposed however the head likes (pbcp-head H-6).
- **A.1 — the rest of the order card.** A named `to_producer` reaches that root whether or not it is an executor (OPEN #21); `producer: head`, `delivery` from `urgency` without a ceiling, no `thread` (OPEN #17; head row 17); a `done` or `failed` order can be dismissed and keeps its `exec_state`, and any other decision on an order is `400 invalid_decision` (OPEN #16); the eligibility set is head-private (OPEN #19); a `*` order minted with no eligible root reaches no one and a head SHOULD say so (pbcp-head H-5).

**Core**

- **§9, §4.2 — a producer with no ceiling set has the ceiling `brief`.** 0.4's SHOULD default left the in-process reference (no ceiling, no clamp) and pbcp-head (default `brief`) disagreeing on C28 step 6 (pbcp-head PR #3, part A). `delivery` changes only when the content is stored again; a head's interface may present a card differently (OPEN #7). C28 changes accordingly.
- **§7.2 — parked changes.** Reporting is the producer's; it MAY tell the person with a card of its own; no head endpoint is defined (OPEN #1).
- **§3 — typed extension fields in the file form.** An extension defines its fields' types, and a reader that implements it types them; the orders fields are listed (OPEN #2).
- **§7.4 — owner-side codes.** The code table covers the owner's operations as well as the producer's; `not_acknowledgeable` stays (OPEN #4).
- **§7.3 — owner actions** name giving an order (A.1) beside cancelling one.
- **§14 — the conformance suite.** Fixtures may be marked with an extension or a condition (`prerender` for R07), declared by the adapter (OPEN #3); the adapter's clock may be set asynchronously (OPEN #6); `id_mismatch`, a transport check, is left to each head's tests, while `wrong_person` and `404` on presenting and acknowledging are now covered by C13 and C03 (OPEN #5).

**Rendering (§3.1)**

- **`config:` in a fence's front matter** is stripped like a URL-loading `%%{init}%%`; `title:` is kept (H2-#1). R04 gains a step.
- **A `%%{ … }%%` directive spanning lines** is one directive (H2-#2). R04 gains a step.
- **Fences after the eighth** are collapsed and drawn only when the person expands them (H2-#4).
- **The fallback image** is the first thing in the paragraph after the fence; text after it stays; a fallback image that cannot be shown leaves the fallback block in place (H2-#5).
- **Links and unsafe schemes.** Only `http:`, `https:` and `mailto:` are linked; `javascript:`, `data:` and any other scheme are shown as text. A `data:` image other than PNG or SVG is not shown (H2-#6).
- **Parser messages** are the renderer's own and not part of the profile; R03 asserts that a message is shown, not its wording (H2-#7).
- **The source behind the disclosure** is the sanitised source (H2-#10).
- **Choice-option bodies** (§4.4) are rendered under the same profile (H2-#11).
- Left to each head as presentation or deployment detail, not protocol: drawing Other-tier types (H2-#3, already MAY), the 16 KiB fallback text (H2-#8), captions without a title (H2-#9), whether a fallback block counts as a visual (H2-#12), image proxy limits (H2-#13), serving diagrams without a session (H2-#14). How `RenderResult.text` treats fence sources and captions (H2-#15) is defined in the conformance README, not here.

## 0.4 (2026-10-26)

Draft 0.4 resolves what the first head over HTTP (`morkeleb/pbcp-head` PR #1, "Probable RFC bugs" and "Conformance suite and packaging issues") and the first tooling (`morkeleb/pbcp` PRs #2 and #3) found. Nothing else changed.

- **§4.1, §4.2, §9 — urgency is never altered; the clamp lands in `delivery`.** §4.1 forbade altering producer-owned fields while §9 required clamping `urgency` (head PR #1, bug 1). A new head-owned field `delivery` (`immediate | brief | log`) is set whenever the head stores a card's content, to `urgency` (absent is `brief`) lowered to the producer's ceiling. `urgency` is stored and returned as sent, so equality (§5) is unaffected; sync returns both. Changing a ceiling does not revisit stored cards. §9's table, §11.3 and §12 are restated in terms of `delivery`; §1.2 notes that every card there lands as it asked.
- **§7, §7.3 — decide is the owner's operation.** `HeadClient.decide` sent a producer token to the decide endpoint, which the head could only refuse (head PR #1, bug 2). §7 now names submit and sync as the producer's operations and decide as the owner's, performed with the owner's credential, which the protocol does not define; a head exposes it however it likes. A producer token on decide MUST be refused with `401`, before anything else. §11.3 says so.
- **§7.2, §7.4 — `invalid_cursor`.** A missing or malformed `after` (`-1`, `1.5`, `abc`) is `400` with the new code `invalid_cursor`; no listed code fitted (head PR #1, bug 3).
- **§7.4 — `unauthorized`** covers every missing or invalid credential, producer or owner; the `401` row says so (head PR #1, bug 4).
- **§7 — paths are relative to the base URL.** A head MAY mount the paths under a prefix; `GET /` is the base URL (head PR #1, bug 5: the head mounts the API under `/api`).
- **§7 — the MCP adapter** offers `submit_card`, `poll_changes` and, with the `orders` extension, `claim_order`. `decide_card` is removed: an adapter acts with a producer token, which decide refuses (follows from the decide change; tooling PR #2 had left it out already).
- **§7.5 — `seq` in the description.** `GET /` carries `seq`, the highest `change_seq` assigned (`0` before the first). A producer that wants only what happens from now passes it as its first `after` instead of reading the whole change feed (tooling PR #3: the n8n trigger's "Start from: now").
- **§3.1 — a card over 1 MiB MUST be refused with `413`.** The size rule only said a head MAY refuse above 64 KiB, so a `413` could not be tested (head PR #1: no fixture covers `413`). A head still chooses its limit between 64 KiB and 1 MiB.
- **§14** — the conformance description covers describe, the owner's decide and the credential refusals; the "Field name" question is closed by `delivery`.

Conformance: C25 (`GET /` shape), C26 (missing or invalid producer token → `401` on PUT and sync), C27 (64 KiB accepted, over 1 MiB → `413`), C28 (ceiling clamps `delivery`, `urgency` unchanged), C29 (`invalid_cursor`), C30 (producer token on decide → `401`), C31 (`seq`). From C25 on, fixtures also check the error code.

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
