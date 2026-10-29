# RFC changelog

## 0.8 (unreleased)

Draft 0.8 adds two producer-owned fields, `at` and `until`: when the thing a card is about happens, and when it ends. 0.7 gave a card a day (`about`); 0.8 gives it a time, so a head can lay the day's cards out by producer-independent time rather than reading it from titles. There are no changes to the operations, the lifecycle, orders or delegation. In-process conformance: 59 → 62 cases (core C49–C51).

**§4.1 — `at`, `until`.**
- **Shape:** optional timestamps as §2 defines them. `at` is when the card's subject happens or begins; `until` when it ends.
- **Rules:** `until` requires `at` and is equal to or after it; anything else is `400 invalid_card`. Neither is `emitted_at` (when the card was sent) nor `about` (the day the producer files it under); a card may carry any of the three.
- **Equality:** both count (§5). New fixtures C49, C50, C51.

**§4.1a — three times.** `emitted_at` is when the producer wrote the card, `about` the day it belongs to, `at`/`until` when its subject happens. A seven-row example table. Advisory.

**§8 — a card's time.** A card with `at` and no `about` is placed on the day of `at` in the head's time zone. Within a day a head SHOULD order cards by `at`; it MAY offer a day view laid out by `at` and `until` across producers; a brief MAY list the day's timed cards as an agenda. `at` never changes `delivery`, never notifies, never decides or acknowledges a card. A moved subject supersedes a decided card and re-PUTs an open one.

**§11.1 — producer checklist** gains: sets `at`/`until` when the subject has a time of day, never only in `title` or `summary`. The mail reader sets them from an invitation or confirmation.

**§11.3 — head checklist** gains: validates the two fields, places and orders by `at`.

**§4.1 — field validation as one requirement.** "A head MUST reject with `400 invalid_card` a card whose field breaks the rule given in its row below." Fixtures C42, C44, C49 and C50 now cover it, so `labels`, `about`, `at` and `until` validation appear in the coverage table (§14) under one row instead of through the "MUST NOT alter them" sentence.

**§4.1a — times in text.** Corrected: a time in `title` or `summary` is for the person and is allowed; what a producer must not do is write it *only* there. The hermes skills say the same.

**§4.5, §8 — a marker is not a presentation.** A head MAY show an open decision card as a marker (a point on a day view, a count, a linking line) without its controls, provided the card is presented with them one step away. The brief presents the ask; the day view may mark its time.

**§4.1a — kind names.** Advisory: a head shows the person what a card wants (decide, acknowledge, read), not the kind name.

**Connectors.** caldav: a `log` artifact per timed occurrence with `at`/`until`, referenced from the day's agenda; signals carry the times. MCP, hermes skills and CLI describe and accept both.

## 0.7 (2026-10-27)

Draft 0.7 adds two producer-owned fields that producers were already putting in bodies and titles: `labels`, the producer's categories for a card, and `about`, the day a card concerns. It also says which day a card belongs to when it has no `about`, which 0.6 left unstated. There are no changes to the operations, the lifecycle, orders or delegation. In-process conformance: 50 → 54 cases (core C41–C44).

**§2 — dates.** A date is an ISO 8601 calendar date, `YYYY-MM-DD`, with no time and no offset. Used by `about`.

**§3 — the example card** carries `labels: [billing-revamp]` in both forms.

**§4.1 — `labels`.**
- **Shape:** an optional list of the producer's categories for the card (a project, a client, a mailbox), for a head to show and filter by.
- **Rules:** each entry follows the `intent` grammar of §5 in lowercase only, 1 to 32 characters; at most 8 per card, no duplicates. Anything else is `400 invalid_card`.
- **Head:** a head MUST show labels on the card, SHOULD let the owner filter the brief by label, and MAY apply ceilings per label (§9).
- **Owner's labels:** labels the owner gives cards are head-owned state and never written to the card.
- **Equality:** labels count for equality (§5). New fixtures C41, C42, C43.

**§4.1 — `about`.**
- **Meaning:** an optional date naming the local day the card concerns, when that differs from when it was sent: tomorrow's agenda, a meeting moved to Friday, prices for a day.
- **Rules:** a `YYYY-MM-DD` date that exists; anything else, a timestamp included, is `400 invalid_card`. It is not a timestamp and has no time zone: it is the day as the producer means it.
- **Equality:** it counts for equality. New fixture C44.

**§5 — equality.** An absent `labels` equals `[]`, as an absent `references` does. `labels` compare as a set: order is not significant, so `[a, b]` and `[b, a]` are the same card, and a head keeps the order the producer sent. It is the one list whose order does not count.

**§8 — a card's day.** A head places each card on one day in its timeline and briefs:
- **With `about`:** that day, taken as written and never converted between zones.
- **Without `about`:** the day of `received_at` in the head's time zone, which is the owner's and set however the head chooses; the protocol carries none.
- **Future days:** a card whose day is in the future appears on that day, and MAY also be shown earlier.

**§8 — labels in a brief.** Labels are shown, not grouped. A generated brief MAY group by label only when the owner asks; by default its order is unchanged by labels. The §8 opening now names `about` and `labels` beside `thread`, `supersedes` and `references`.

**§9 — ceilings per label.** A head MAY let the person set a ceiling per label, applied like the per-producer ceiling. A card under both takes the lower of the two.

**§11.3 — head checklist** gains: shows each card's labels, and places each card on its day.

**Connectors.**
- **goalpath:** labels every card with the project (from `GOALPATH_LABEL` or the project's name) and, where there is one, the milestone.
- **caldav:** sets `about` on agendas and moved events, and labels a card with its calendar.
- **imap:** labels a card with its mailbox, then `IMAP_LABELS`.
- **obsidian-daily:** sets `about` to the note's date.
- **hermes skills:** tell the model to set `labels` from the project or client and `about` for a specific day.
- **MCP and CLI:** `submit_card` describes both fields; the CLI accepts both.

**Corrections after merge** (from the reference head's implementation of 0.7)

- **§8 — views.** A filter or view the owner chooses (by label, by producer or otherwise) is the owner's own narrowing of the brief. It does not affect what a head MUST include in a brief it generates: §8's requirements apply to the generated brief, not to the view. How a view combines several labels is the head's choice. A view MAY count the snoozed open decisions it admits, and never lists them or their leads.
- **§7.5 — `api`.** The description MAY give `api`, the base URL under which the head serves §7.1–§7.3 (and claims, A.2). It is there so a producer configured with only the head's origin can find them; a relative one is resolved against the description's URL. Absent, the operations are relative to the URL the description was read from, as before. The example shows it. C25 accepts it, when present, as a string. `HeadClient` sends its operations under `api` once `describe()` has read one.
- **§8 — how far ahead, and "the previous day".** How far ahead a timeline reaches is the head's choice; a later-day card shows on its day once the timeline reaches it, and earlier only under the existing MAY. A brief's "previous day" is the cards whose day (§8) is the previous day. A card about an earlier day that arrives after a brief was generated need not be added to it.
- **§9 — label ceilings.** A label's ceiling applies to every card carrying the label, whichever producer sent it. A card under several ceilings, its producer's and its labels', takes the lowest.
- **OPEN.md 4.** Whether a card's day is fixed when it is stored or follows a later change of the head's time zone is left open, with the reference head's choice: fixed at storage.
- **OPEN.md 5.** A producer read of its own card (`GET /cards/{id}` under the token's root) is recorded as a candidate for 0.8, from the first producers to connect (issue #22). Until then a producer confirms a card from the answer to its PUT (`201` or `200` with the stored card) and through sync; `@pbcp/client`, `@pbcp/mcp` and the site now say so.
- **§3 — the example's `source`** (illustrative, not normative). The example card's `source.url`, in both forms, is now the Gmail message search the connectors and the hermes skills use, `https://mail.google.com/mail/u/0/#search/rfc822msgid:<Message-ID>`, instead of an `#inbox/<thread>` link, and the wire form gives it in full. `exampleCard` in `@pbcp/core`, and the snippets made from it, follow.
- **§4.1a — choosing a kind and an urgency (new, advisory).** `kind` is what a card asks of the person: `decision` to choose (actions; open until decided), `signal` to know (an event; acknowledged), `artifact` to read (something made for them; acknowledged). `urgency` is when: `immediate` interrupts, `brief` waits for the next brief, `log` is recorded and never surfaced on its own (§9). The two are independent. Defaults: a decision is `brief` unless it cannot wait; a signal is `brief`, `immediate` when it concerns the next few hours; an artifact is `brief` when read daily (a report, an agenda, a digest) and `log` when a routine record (a commit, a completed task, a producer connecting). A six-row example table. §11.1 gains the gist for producer authors, as does the site's `/producers` page; the hermes skills and `@pbcp/mcp`'s `submit_card` description state it. No requirement changes and no fixture.
- **Connectors, against §4.1a.** todoist's Done outcome is now a `log` artifact (a completed task is a routine record), for which `@pbcp/client`'s executor accepts an `artifact` outcome and an `urgency` on any outcome.
- **Status.** Both implementations, the in-process reference and `pbcp-head`, pass the Draft 0.7 suite: all 54 cases (C01–C44 without C23, R01–R11). The status line said 0.5.
- **§14 — a coverage table.** Every MUST, MUST NOT, SHOULD and SHOULD NOT sentence in §3–§11 and Appendix A (111 sentences) is listed with the fixtures that exercise it, or why none does: client-side behaviour, interface behaviour a fixture cannot observe, or transport. Each fixture now has a `covers` list naming the sentences it exercises; the uncovered ones are in `packages/core/conformance/untested.json`. `scripts/conformance-map.ts` writes the table, and a test fails when a fixture names no sentence, a reference does not resolve, or the table is out of date.
- **New fixtures** for requirements a head can show but no fixture checked: C45 (an empty `title`, or one with a line break, is `400`, §4.1), C46 (a `kind` the head does not implement is `400 unsupported_kind`, §4.1), C47 (a front-matter header with `body` is `400`, §3), C48 (syncing does not set `seen_at`, §4.2) and R12 (an extended-tier diagram renders, SHOULD, §3.1). The in-process reference passes them; each has a sabotage test.
- **Status, 59 cases.** `pbcp-head` now passes C45–C48 and R12 as well, so both implementations pass all 59 cases of the Draft 0.7 suite (C01–C48 without C23, R01–R12). The status line no longer says the new cases are passed by the in-process reference only.
- **§11.1 — the reply loop, end to end** (documentation). A second worked example, "An agent that proposes replies", walks the decision loop that §1.2 only sketched, so that approving a drafted reply is not read as needing orders:
  - the agent reads the mailbox and submits a decision card under its own root that `references` the mail card;
  - the person decides;
  - the agent acts on `approve` or `edited` (sending `edited_proposal`), and does nothing on `reject` or `dismissed`;
  - it posts a `log` artifact `Sent: <subject>` referencing the decision card, and the reader's `archive` default retires the mail.

  A two-sentence variant offers a choice list (`task-and-archive`, `reply`, `keep`) with the same loop. §1.2's day table gains the `Sent` row, the record that its 08:11 row had called a signal.
- **§4.3, §11.1, A.1 — a decision is the authorisation.** The producer that asked acts on a decision, and an order originates with the person, never with a decision. Two new sentences, one in §4.3 and one in §11.1, say that a head MUST NOT mint an order as a consequence of a decision. They state what the design already meant; nothing else is normative here. The §14 table lists both as untested: a fixture could check the absence, and is left for a later draft.
- **§8 — pairing by reference.** A brief MAY pair a decided card with the later cards that reference it ("you approved; it was sent"), mechanically, from `references` alone.
- **Site and skills.** `/producers` gains "A reply loop, end to end", with the sequence and the two cards in the file form. The hermes escalate skill's example carries `references`, and the skill says how to record the action after acting.
- **OPEN.md 5** gains its first concrete customer: an agent confirming the decision it is about to act on without replaying sync. It stays open for 0.8.
- **OPEN.md 6, §14 — content hash.** Answered: no hash is needed. §5's semantic equality already tells a retry from a change, and the `200` and `409` answers carry the stored card. §14's item is marked answered; retention and the last-visit cursor stay open.

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
- **§8 — snoozed decisions stay out of the brief.** §8 required every open decision card in a generated brief, while §4.2 hides a card with a future `snoozed_until` from the brief. Resolved in favour of §4.2: the brief includes every open decision card that is not snoozed; it MAY state how many are snoozed and MUST NOT list them or their leads until `snoozed_until` has passed. The same holds for the previous day's artifact and signal threads: a brief shows each thread's newest card that is not snoozed, and leaves out a thread whose cards are all snoozed. The §11.3 brief item says the same for decisions. No fixture covers brief contents, so none changes.
- **§11.1 — mail cards link to the message.** A mail reader SHOULD set `source` (§4.1) to a URL that opens the message in the person's mail client when it can form one.
- **§12 — every connection is outbound from the producer.** States a property the design already had: submission, sync, claims and lease renewal are all initiated by the producer or executor, and the head never connects to one. A conforming head MUST NOT require a producer or executor to accept inbound connections, an extension MUST preserve this, and notifications, when specified, go to the owner's devices, never to producers. A producer in a restricted network needs only outbound HTTPS; token scope per root bounds what either side reaches if the other is compromised.

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
