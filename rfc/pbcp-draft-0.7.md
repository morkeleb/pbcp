# RFC: Personal Brief Card Protocol

Oct 27, 2026 · @Morten Nielsen · Draft 0.7

## Abstract

This document specifies a protocol for crossing the authority boundary between autonomous software and a person. An agent works on its own until it reaches a decision it is not authorised to make; it then submits a *card* to that person's *head*, the person decides, and the agent continues. Cards from every producer (agents, scripts, mail readers, calendars, project trackers) land in the same head, so the person has one place to review and one record of what they decided. A card is a JSON object with a markdown body, with an equivalent YAML-front-matter file form. It is submitted by HTTP PUT under a producer-minted identifier, which makes submission idempotent by identity. A decided card is immutable.

The core protocol is deliberately small: three operations, one document, one state machine in the core (extensions may add their own lifecycle). A conforming producer can be written in an afternoon with an HTTP client and a string template. It is the mailbox model (SMTP, IMAP) rather than the collaboration model (Google Wave): one writer per card and no concurrent editing. A card may be replaced by its producer while open; once decided it is locked, and change requires a new card. Giving work back to agents — orders, claims, delegation — is specified as an extension (Appendix A) on top of the same card primitive, so a head or producer that only needs the decision flow can ignore it.

**Status:** Draft 0.7, for discussion. Two independent implementations, the in-process reference in `@pbcp/core` and the `pbcp-head` service, pass the conformance suite of Draft 0.7: all 54 cases (core C01–C44 without C23, render R01–R11). Corrections after 0.7 add five small cases (C45–C48, R12), which the in-process reference passes; §14 maps every requirement to the cases that exercise it. Draft 0.6 added a producer-owned `summary` (§4.1), defined a card's *lead* (§3.1), and made how a head presents a decision card (§4.5) and what a generated brief contains (§8) normative. Draft 0.7 adds two producer-owned fields found in use: `labels`, the producer's categories for a card, and `about`, the day a card concerns (§4.1); §8 now says which day a card belongs to. The questions still open are listed in `rfc/OPEN.md`; none of them affects interoperability. `rfc/CHANGELOG.md` lists every change against 0.6.

## 1. Motivation

A person who runs several agents ends up with as many inboxes as agents: each tool reports in its own chat, its own dashboard, its own email. Nothing is triaged across them, nothing is remembered across them, and the person is the only integration point. The head exists to be that integration point instead.

The head is modelled on the brief a secretary gives an executive: a short account of what happened since you last looked, the decisions that need you, and a place to issue orders back. It is a review surface, not a conversation. The person reads, decides, and leaves; the agents continue. The brief is the reference head, not the only possible one — a CLI, a mobile app, a daily email or an Obsidian plugin can all be heads — but the protocol is designed so that the brief, the day view and the decision log are natural to build on it.

A shared contract matters more than any one head implementation. If every agent, mail reader and tracker speaks the same card format, a head is interchangeable and a connector is written once. The design goals, in priority order:

1. **Trivial to produce.** A connector needs an HTTP client and a string template. No SDK, no schema registry, no live connection.
2. **Safe to retry.** Networks fail and loops re-run. Submitting the same card twice must be harmless.
3. **Decisions are final.** Once a person has decided, the record of what they decided on must never change underneath them.
4. **Strictly personal.** A card belongs to one person. Team work belongs in team tools; this protocol only carries what reaches an individual.
5. **Readable without software.** A card is a text file a human can open in an editor.

### 1.1 Non-goals

This protocol does not provide, and should not be extended to provide:

- team collaboration, shared inboxes or multi-party consensus;
- live or concurrent editing of any document;
- task or project management as a system of record;
- general workflow orchestration or event streaming;
- guaranteed or exactly-once execution of external side effects;
- verification of the truth or authority of a card's content;
- agent-to-agent conversation.

The head is authoritative only for what reached the person, what they saw, what they decided and what they ordered. Every producer remains authoritative for its own domain.

### 1.2 A day, end to end

| Time | Producer | What it does | Card |
| --- | --- | --- | --- |
| 06:00 | mail agent | Sees a customer asking for a contract change; drafts a reply | `hermes:gmail:19a4…` decision, brief |
| 06:05 | project tracker | Notices a milestone at risk after overnight commits; asks who should review it | `goalpath:milestone:88:risk` decision, brief |
| 06:10 | calendar | A customer meeting now overlaps the roadmap review | `cal:event:7f3a:conflict` decision, brief |
| 06:30 | head | Writes the morning brief: 2 decisions, 1 warning, 11 log entries folded | `head:daily:2026-10-07` artifact |
| 08:10 | person | Reads the brief. Approves the reply, edits the meeting proposal, delegates the risk review to a colleague | three decisions, three cards locked |
| 08:11 | mail agent | Syncs, sees `approve`, sends the reply, posts a `sent` signal in the thread | `hermes:gmail:19a4…:sent` log |
| 08:11 | calendar | Syncs, sees `edited`, reschedules to the replacement time | — |
| 08:12 | colleague's head | Syncs the delegation, shows it to its owner as a decision card | (Appendix B, not yet specified) |
| 18:00 | head | Day view: every card, every decision, in order | — |

Each producer talked only to the head, only by PUT and sync, and never had to know what the brief looked like or that the other producers existed. The three decisions at 08:10 were made through the head's own interface with the owner's credential (§7.3); no producer token can decide. Every card here lands as it asked (its `delivery` equals its `urgency`) because no producer is above its ceiling (§9).

## 2. Terminology and conventions

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in RFC 2119.

| Term | Meaning |
| --- | --- |
| **Head** | The service that stores cards for one person, renders them, records decisions, and issues orders. |
| **Producer** | Anything that submits cards to a head: an agent, a script, a mail reader, a calendar connector, a project tracker. |
| **Executor** | A producer that also polls for orders and carries them out. Every executor is a producer; not every producer is an executor. |
| **Card** | One unit of content: a YAML header plus a markdown body. The only document in the protocol. |
| **Thread** | A producer-chosen grouping key. Cards sharing a thread are folded together by the head. |
| **Decision** | The person's recorded response to a card. Locks the card. |
| **Order** | A card minted by the head that asks a producer to do something. |
| **Namespace** | The prefix of a card id that a producer owns and may write under. |

Timestamps are RFC 3339 in UTC, written with the offset `Z`, `+00:00` or `-00:00`; a head MUST reject with `400` a card with any other offset, or with a date or time that does not exist (a leap second `:60` is allowed). A date (`about`, §4.1) is an ISO 8601 calendar date, `YYYY-MM-DD`, with no time and no offset. Identifiers are ASCII, case-sensitive, and compared as exact strings. The canonical wire encoding of a card is `application/json`; the file form is markdown with YAML front matter, and the two MUST be convertible field for field. Equality between cards is semantic, judged on the parsed fields, never on bytes (§5 defines it). Every card carries `protocol: pbcp/1`; the number is the major version, and backward-compatible additions arrive as extension fields without changing it. The value is exactly `pbcp/` followed by the major version: a head MUST reject with `400` a card whose major version it does not implement, a value of any other shape (`pbcp/1.1` included), and a card without `protocol`.

## 3. Card format

A card has two equivalent forms. On the wire it is a JSON object whose `body` member holds the markdown. As a file it is a UTF-8 text document: a YAML header between two `---` lines, followed by the markdown body — the front-matter convention used by Jekyll, Hugo and Obsidian, chosen because it is already familiar, readable in any editor, and can be written with a template. The file form is what a producer stores, logs and debugs; the wire form is what it sends. A head MAY accept the file form on PUT as `text/markdown`, but MUST accept JSON.

```markdown
---
protocol: pbcp/1
id: hermes:gmail:19a4f2e7c3b1
kind: decision
to_person: morten
producer: hermes
thread: gmail:19a4f2e7c3b1
labels: [billing-revamp]
urgency: brief
title: Reply to Anna re invoice timing
summary: Anna asks to pay the September invoice on the 20th instead of the 15th. The proposed reply agrees for September only.
actions: [approve, reject, edit]
references: []
emitted_at: "2026-10-07T13:02:11Z"
source:
  url: https://mail.google.com/mail/u/0/#search/rfc822msgid:CA%2Babc%3Ddef%40mail.example.com
  label: Gmail thread
---

Anna (Nordic Supply) asks whether the September invoice can be paid on the 20th instead of the 15th. Last three invoices were paid on time; no prior requests.

## Proposed reply

> Hi Anna — the 20th is fine for September. Let's keep the 15th from October on.
>
> Best, Morten
```

The same card on the wire:

```json
{
  "protocol": "pbcp/1",
  "id": "hermes:gmail:19a4f2e7c3b1",
  "kind": "decision",
  "to_person": "morten",
  "producer": "hermes",
  "thread": "gmail:19a4f2e7c3b1",
  "labels": ["billing-revamp"],
  "urgency": "brief",
  "title": "Reply to Anna re invoice timing",
  "summary": "Anna asks to pay the September invoice on the 20th instead of the 15th. The proposed reply agrees for September only.",
  "actions": ["approve", "reject", "edit"],
  "references": [],
  "emitted_at": "2026-10-07T13:02:11Z",
  "source": { "url": "https://mail.google.com/mail/u/0/#search/rfc822msgid:CA%2Babc%3Ddef%40mail.example.com", "label": "Gmail thread" },
  "body": "Anna (Nordic Supply) asks whether ..."
}
```

**Restricted YAML.** To keep parsers simple and avoid YAML's implicit-typing surprises, the header MUST use only this subset:

- `key: value` pairs at the top level, written as the key, a colon and one space; keys are unquoted, start with a letter, digit or `_`, continue with those and `.` or `-`, and appear at most once;
- scalars that are plain, `'single-quoted'` or `"double-quoted"` (with the JSON escape set), each on one line. A plain scalar does not start with a YAML indicator (`-`, `?`, `:` followed by a space; `,`, `[`, `]`, `{`, `}`, `#`, `&`, `*`, `!`, `|`, `>`, `'`, `"`, `%`, `@`, `` ` ``). Every scalar is parsed as a string, whatever it looks like; the protocol then validates named fields against their types (so YAML → strings → validation → typed JSON). An empty value (`thread:` with nothing after it) is the empty string. Producers SHOULD quote anything a YAML parser might otherwise coerce (`no`, `1.0`, dates) so the file reads the same in any editor;
- flow sequences of scalars (`[a, b]`) on one line, and block sequences (`- a`);
- one level of nested mapping (as in `source` above), whose values are scalars;
- block sequences whose items are one-level mappings of scalars, so that §4.4 choice objects have a file form (below). A boolean in such a mapping is written `"true"` or `"false"` and typed after parsing;
- full-line comments, and trailing comments introduced by a space and `#`. As in YAML, ` #` ends a plain scalar, so `title: Fix #12` reads as `Fix`; a value containing ` #` is quoted.

Nothing else is in the subset. In particular: anchors, aliases, tags, directives (`%YAML`), document markers (`---`, `...`) inside the header, block scalars (`|`, `>`), flow mappings (`{a: b}`), scalars that continue onto a second line, quoted or complex keys, tabs in indentation, duplicate keys, and nesting deeper than shown here. A header that uses anything outside this subset MUST be rejected with `400`.

```markdown
actions:
  - id: ship-friday
    label: Ship Friday
    default: "true"
  - id: hold
  - edit
```

**File form boundaries.** The header is the text between a first line `---` and the next line `---`. The body is everything after that second line, less one blank separator line if present; a writer emits that blank line. The header MUST NOT contain `body`.

**Typed fields in the file form.** Only the fields this document defines, and those of an extension the reader implements, are typed after parsing; an extension defines the types of its own fields (the orders extension: `orders.claim_seq` an integer, `orders.result` an enum, A.1). Any other field read from a file is a string. A field whose value is not a string, a list of strings, or a mapping as described above has no file form; a producer that uses such extension fields with a reader that does not implement the extension sends the wire form. Converting a card to the file form writes numbers and booleans as strings.

**Body.** The body is CommonMark plus GitHub-style tables and fenced code. Diagrams and charts are embedded as `mermaid` fences, which the head renders. No other embedding (HTML, iframes, remote widgets) is permitted in this version; a head MUST strip raw HTML. Richer content is linked through `source.url`.

### 3.1 Rendering profile

A producer that draws a chart needs to know it will be drawn, on every head, on every device. This profile is the contract: what a card body may contain, what a head MUST render, and what happens to the rest. It is normative for heads and advisory for producers.

**Markdown.** CommonMark plus GFM tables, task lists and fenced code. A head MUST render these. Raw HTML is stripped (§12): the tags are removed and their text kept, except that `<script>`, `<style>` and `<iframe>` elements are removed with their contents. This profile applies to a card's body and to the `body` of each choice option (§4.4), diagrams included.

**Links.** A link is followed only when its URL is `http:`, `https:` or `mailto:`. Any other scheme (`javascript:`, `data:`, `file:`, anything unknown) is shown as the link's text and not linked.

**Lead.** A card's *lead* is the part a person reads to decide whether to open it. When the card has a `summary` (§4.1), the lead is the `summary`, shown as text. Otherwise it is the body's first paragraph, rendered as inline markdown and found like this, line by line, so that every head picks the same one:

1. Skip blank lines, ATX headings (one to six `#` followed by a space or the end of the line), thematic breaks (three or more of the same `-`, `*` or `_`, and nothing else but spaces), and fenced code blocks, `mermaid` fences included: from an opening line of three or more `` ` `` or `~` to the next line of at least as many of the same character and nothing else but spaces, or to the end of the body if there is none.
2. The first line not skipped starts the lead. The lead runs to the line before the next blank line or the next line that starts a block, or to the end of the body. A line starts a block when it is an ATX heading, a thematic break or an opening fence, or begins with `>`, with `|`, or with a list marker (`-`, `*` or `+`, or one to nine digits and `.` or `)`) followed by a space. In steps 1 and 2 a marker may be indented by up to three spaces.
3. Each line of the lead is trimmed of leading and trailing whitespace. A body that has no such line has an empty lead.

In a list, a folded brief or a thread summary, a head MUST show at least the lead of each card, beside its title, and MAY stop there. On the card itself, a head MUST NOT hide the lead behind a gesture. A producer that does not send `summary` therefore writes its body lead-first: one opening paragraph that says what is going on and what the card wants, before any heading, table or diagram. The example in §3 does.

**Images.** `![alt](url)` is rendered when `url` is `https:` (subject to the head's image policy; a head SHOULD proxy or size-limit remote images and MUST NOT send cookies when fetching them) or an inline `data:image/png;base64,…` or `data:image/svg+xml;base64,…` URI. Inline images count toward the 64 KiB card limit, which is the only size control a producer needs. Inline SVG is sanitised before display: `<script>`, event attributes, `<foreignObject>`, external `href`s and `<use>` of remote documents are removed. A `data:` image of any other type, and an image with any other scheme, is not shown: its alt text appears in its place, linked only if the URL is one a link may have (`http:`, `https:`, `mailto:`).

**Image fallback for a diagram.** An image whose alt text is exactly `fallback`, placed immediately after a `mermaid` fence with nothing between but blank lines (so it is the first thing in the next paragraph; text after it in that paragraph stays), belongs to that fence: a head that rendered the fence MUST NOT show the image, and a head that could not (unsupported type, parse error, no renderer) MUST show the image in place of the fallback code block. If the fallback image itself cannot be shown (an `http:` URL, say), the fallback block stays and the image is treated as Images says. A producer that needs a chart to appear on every head pre-renders it and attaches it this way; the fence remains the source of truth and the image is never shown alongside it.

**Mermaid.** A fence tagged `mermaid` is a diagram. Support is in two tiers so producers can tell what is safe to send:

| Tier | Diagram types | Head obligation |
| --- | --- | --- |
| **Core** | `flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `gantt`, `timeline`, `pie`, `xychart-beta` (bar, line) | MUST render |
| **Extended** | `classDiagram`, `erDiagram`, `quadrantChart`, `sankey-beta`, `mindmap`, `gitGraph`, `journey` | SHOULD render; MAY fall back |
| **Other** | anything else, including future types | MAY render |

Type names are matched exactly as listed; an alias (mermaid's `graph` for `flowchart`) falls in the Other tier, so a producer writes the listed name. A producer that wants a chart to appear everywhere uses the core tier. The nightly brief, agendas and digests are expected to fit in `gantt`, `timeline`, `pie` and `xychart-beta`.

**Fallback.** A fence a head cannot render is shown as a code block with its type label and a one-line note ("diagram not supported"), never dropped and never shown as an error that hides the rest of the card. A fence that fails to parse is shown the same way with the parser's message; that message is the renderer's own, its wording differs between renderers and versions, and it is not part of this profile. In both cases the card's text, tables and other diagrams still render.

**Declarative only.** Rendering a mermaid fence MUST NOT cause network access, script execution, or navigation. `click` directives, `%%{init}%%` directives that reference a URL (`http:`, `https:`, `url(`, `@import`) or set `htmlLabels`, and `htmlLabels` itself are stripped before rendering; a directive that spans several lines, from `%%{` to `}%%`, is one directive. A `config:` key in the fence's own front matter (between `---` lines at its top) is a second way to set the same options and is stripped likewise; `title:` there is kept. Other `init` directives MAY be kept. A head MAY pre-render fences to SVG server-side and serve the SVG; a producer MUST NOT depend on client-side rendering.

**Presentation.** Every diagram and image is shown in two sizes, and producers design for the first. *In the card*, a head MUST show each visual as a thumbnail fitted to the card's width (assume 360 px on a phone, about 600 px on the web), in reading order, never cropped, with the fence's title or the image's alt text as a caption. *On tap or click*, the head MUST open the visual full-screen with zoom and pan, at its native size, and SHOULD offer the fence source behind a disclosure: the source as sanitised, which is what was drawn. A head MAY lazy-render thumbnails and MUST NOT require the full-screen view to read the card's text.

In a folded brief or a thread summary, a head MAY show only the first visual of a card, or none; it MUST NOT reflow a card's text to fit around visuals it has hidden. Producers therefore put the one chart that matters first.

What this means for a producer: a visual is legible at 360 px wide or it is not read. Put the point in the title, keep to roughly 20 nodes or 30 data points, label axes in the fence, and prefer two small diagrams to one large one. Anything denser belongs in a `source.url` the person can open.

**Limits.** A head MUST render up to 8 fences per card. A fence beyond the eighth is collapsed behind a disclosure and drawn only when the person expands it; it is never dropped. A single fence over 16 KiB MAY be treated as unsupported. Rendered diagrams are scaled to the viewport width; producers SHOULD keep diagrams under roughly 20 nodes or 30 data points, since the brief is read on a phone.

**Determinism.** Given the same fence, a head SHOULD produce the same diagram on every view; a head that pre-renders MUST cache by content hash of the fence so a re-PUT of an identical card does not redraw.

A head declares its tier support in `render.mermaid` of its description (`GET /`, §7.5), so a producer or a client can check before relying on a type.

**Size.** A head MUST accept a card whose JSON wire form is up to 64 KiB and MAY reject larger ones with `413`; it MUST reject one larger than 1 MiB with `413`. The limit is on the wire representation, so the two forms cannot disagree.

**Unknown fields.** A head MUST ignore producer-owned fields it does not recognise and SHOULD preserve them, verbatim, in what it returns and syncs, so a producer can round-trip its own extensions. Because preservation is only recommended, a producer that needs state to act on a decision (where the message is, which record to update) keeps that state itself, keyed on the card id, rather than in fields it expects the head to echo. A head MUST reject any field in the head-owned set (§4.2) on submission. Extensions (Appendix A) define their fields under a prefix (`x-` for private use, the extension's name otherwise) to keep them out of the core namespace.

## 4. Fields

### 4.1 Producer-owned fields

Set by the producer at submission. The head MUST NOT alter them.

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `protocol` | yes | string | `pbcp/1`. |
| `id` | yes | string | Deterministic identifier, see §5. |
| `kind` | yes | enum | `decision`, `artifact`, `signal`. Extensions MAY add kinds; a head MUST reject with `400` a kind it does not implement. |
| `to_person` | yes | string | The person this card is addressed to. Required for every core kind; the orders extension forbids it on kind: order (Appendix A). |
| `producer` | yes | string | Denormalised from the first segment of `id` for readability and filtering; the id namespace is authoritative, and a mismatch is `400`. See `id`. |
| `title` | yes | string | One line, shown in lists and the brief. MUST NOT be empty or contain CR or LF. |
| `summary` | no | string | One or two sentences of plain text that say what is going on and what the card wants, so that a person who reads only `title` and `summary` can tell whether to open the body. MUST NOT be empty or contain CR or LF, and SHOULD be under 280 characters; a head MAY truncate it beyond that with an ellipsis. It is not markdown: a head MUST show it as text, never render it. When present it is the card's lead (§3.1). On a decision card, `summary` SHOULD state the proposal, not only the topic ("The proposed reply agrees for September only"), so that a brief's line for the card can be decided on its own; the example in §3 does. |
| `body` | yes | string | Markdown, see §3. |
| `urgency` | no | enum | `immediate`, `brief` (default), `log`. The producer's request; the head never alters it. Where the card lands is the head-owned `delivery` (§4.2, §9). |
| `thread` | no | string | Grouping key within the producer. Not empty. |
| `labels` | no | list | The producer's categories for the card — a project, a client, a mailbox — for a head to show and filter by. Each entry follows the `intent` grammar of §5 in lowercase only (`a`–`z`, digits and `-`, so `billing-revamp`) and is 1 to 32 characters long; a card has at most 8 entries and no duplicates. A card that breaks any of these is rejected with `400 invalid_card`. Labels are a set: their order carries no meaning and does not count for equality (§5), and a head keeps them in the order the producer sent. A head MUST show a card's labels on the card and SHOULD let the owner filter the brief by label; it MAY apply ceilings per label (§9). Labels the owner gives cards, if a head offers that, are head-owned state and never written to the card. |
| `about` | no | date | The local day the card concerns, when that differs from when it was sent: tomorrow's agenda, a meeting moved to Friday, prices for a day. An ISO 8601 calendar date, `YYYY-MM-DD`, that exists; anything else is rejected with `400 invalid_card`. It is not a timestamp and carries no time zone: it is the day as the producer means it. A head uses it to place the card in its timeline and in briefs (§8). |
| `references` | no | list | Ids of related cards, any producer. |
| `supersedes` | no | string | Id of an earlier card this one replaces; same namespace only. |
| `actions` | no | list | Decision values offered, for `kind: decision` only; `artifact` and `signal` cards never carry it, and a head MUST reject one that does with `400`. Each entry is a string, or an object {id, label?, body?, default?} (§4.4). Default `[approve, reject]`. |
| `emitted_at` | yes | timestamp | When the producer created the card. Ignored for equality, see §5. |
| `source` | no | object | `url` (required, not empty) and `label` pointing at the thing the card is about. |

### 4.2 Head-owned fields

Set only by the head. A producer MUST NOT include them on submission; a head MUST reject a submission that does with `400`.

| Field | Type | Meaning |
| --- | --- | --- |
| `state` | enum | `open`, `decided`, `superseded`. |
| `change_seq` | integer | Monotonic sequence number, assigned anew on every head-side change to this card, including the owner-side fields below (`seen_at`, `acknowledged_at`, `snoozed_until`). The sync cursor, see §7.2. |
| `received_at` | timestamp | When the head accepted the card (head clock). |
| `delivery` | enum | `immediate`, `brief` or `log`: where the card lands. Set whenever the head stores the producer's content (`201`, or `200` with a replacement) to the card's `urgency` (default `brief`) clamped to the producer's ceiling (§9). It changes only when the content is stored again. |
| `changed_at` | timestamp | When any head-owned field last changed (head clock). |
| `seen_at` | timestamp | Implementation-defined evidence that the head presented the card to its owner. A head MUST NOT set it merely because the card was synced or folded into a generated brief. |
| `acknowledged_at` | timestamp | For `artifact` and `signal` cards: when the person acknowledged the card through whatever explicit acknowledgement the head's interface offers. Inclusion in a generated brief MUST NOT by itself set it, and a head MUST NOT set it on a `decision` card. The head's record that the person explicitly acknowledged the card; a producer observes it through sync. Acknowledging an acknowledged card changes nothing. |
| `snoozed_until` | timestamp | Hidden from the brief until then. Not a state. |
| `decision` | string | One of the ids in `actions` other than `edit`, or a protocol decision: `dismissed`, `edited`, `delegated`. Meaningful only for `kind: decision`. |
| `edited_proposal` | string | Replacement text when `decision` is `edited`; present then and only then. |
| `comment` | string | Free text from the person alongside the decision. |
| `decided_at` | timestamp | When the decision was recorded. |
| `delegated_to` | string | Person id when `decision` is `delegated`; present then and only then. |
| `to_producer`, `exec_state`, `claimed_by`, `claim_expires_at`, `claim_seq` | | Head-owned fields of the orders extension (A.1). They are head-owned on every card, whether or not the head implements the extension, and a submission carrying any of them is rejected with `400`. |

`kind: artifact` and `kind: signal` cards take no decision from the person. The head sets `acknowledged_at` when it considers the card received — through an explicit acknowledgement in its interface, never by folding the card into a brief — and the producer reads that as its delivery receipt. `decision` is the authority-boundary primitive and belongs to `kind: decision`; `artifact` and `signal` are attention primitives and never carry a decision. Acknowledgement is not a lifecycle transition: an artifact or signal card stays open after it is acknowledged and normally leaves open only by supersession.

### 4.3 What a decision means

A decision is any terminal response from the person, whether producer-defined (one of `actions`) or protocol-defined. The protocol-defined values are:

- `dismissed` — seen, no action; the producer SHOULD treat it as "do nothing".
- `edited` — the person accepts the intent of the card with the replacement text in `edited_proposal` in place of the card's proposal. The producer MUST act on the replacement as it would have on `approve` with the original. It is not a request to reinterpret. `edited` is a valid decision on every decision card, whether or not `actions` contains `edit` (§4.4).
- `delegated` — the person has handed the decision to `delegated_to`. A producer MUST treat it as terminal for its own card; whatever follows is federation, sketched in Appendix B and outside the core.

### 4.4 Choice lists

A producer that wants the person to pick between alternatives rather than approve or reject a single proposal lists them in `actions`. Each entry is either a bare string (the decision value, shown as its own label) or an object:

```json
"actions": [
  { "id": "ship-friday",   "label": "Ship Friday",   "body": "Needs Anna's sign-off by Thursday.", "default": true },
  { "id": "ship-next",     "label": "Ship next sprint", "body": "Slips M4 by one week." },
  { "id": "hold",          "label": "Hold" },
  "edit"
]
```

- `id` is the decision value the head records and the producer syncs; it follows the `intent` grammar in §5. So does a bare string entry. The protocol decisions `dismissed`, `edited` and `delegated` are reserved: a head MUST reject a card that uses one as an `id` with `400`.
- `label` is the short text shown on the control; absent, the head shows `id`.
- `body` is markdown shown beside the option — the consequence, the cost, the thing to know. It is the producer's argument for that option and lives on the option, not in the card body, so the head can lay out choices side by side.
- `default` marks at most one option. The head MUST pre-select it and MUST treat a bare approve gesture on the card (a swipe, a voice "yes", a keyboard shortcut) as choosing it. With no default, there is no bare approve and the person must pick.
- The built-in `edit` entry means "none of these — here is what I want": the person supplies text and the decision is recorded as `edited` with `edited_proposal`, exactly as in §4.3. `edit` is never itself recorded as a decision value. The entry controls only what the head *offers*: a producer that wants free text as an option includes `edit` in the list, and a head SHOULD NOT offer free text on a card that leaves it out. It does not restrict the decide operation, which accepts `edited` on any decision card (§7.3); a producer that receives `edited` on a closed choice acts on it as §4.3 requires.

One option is chosen; there is no multi-select in this version. A head MUST reject a card with two defaults or a duplicate `id` with `400`. A string entry and an object entry with the same `id` are the same option, so listing both is a duplicate. `default: false` is the same as no `default`.

A decision card SHOULD contain both the evidence (what happened) and the producer's proposal (what it suggests doing), as separate sections of the body, so the person decides on the proposal with the evidence in view. The person decides on the card *as it stood when decided*; the head MUST retain that version.

### 4.5 Presenting a decision

A decision card exists to be decided, so how a head presents one is part of the protocol, in outcomes rather than layout. These rules apply wherever a head presents an open decision card to its owner: in the brief, in a list, and on the card itself.

- **The actions are the controls.** A head MUST offer the card's `actions` (§4.4, the default `[approve, reject]` included) as controls on the card, available without a prior gesture, in the order the card gives them. The option marked `default` is the primary control. With no default there is no primary control: a head MUST give the options equal weight and MUST NOT style or place any one of them as primary, just as it offers no bare approve without a default (§4.4). A head MUST NOT gather the actions behind one intermediate control (a single "decide" control that reveals them).
- **The protocol decisions.** `dismissed` is always available, as a secondary control. Free text, recorded as `edited`, is offered as a control only when `actions` lists `edit` (§4.4). `delegated` is offered only by a head that implements Appendix B.
- **Enough to decide.** On the card as presented, the lead (§3.1) is visible, and so is the body's proposal: the section whose heading begins with `Proposal` or `Proposed`, matched without regard to case (`## Proposed reply`, `### PROPOSED REPLY`), from that heading to the next heading of the same or a higher level, if the body has one. The rest of the body MAY sit behind a single disclosure. A head MUST NOT require the person to open the card on its own to decide it.
- **The comment is optional.** A head MUST NOT require `comment` to record a decision. It SHOULD offer the comment behind a disclosure rather than as a field the person has to pass.
- **Confirmation.** When the head records a decision, or an acknowledgement (§4.2), it MUST confirm that in its interface in a way the person can tell apart from a control that is merely unavailable, and SHOULD show the card's new state in place: the decision recorded, or the time of acknowledgement.

## 5. Identity and idempotency

The producer mints the id; the head never does. An id is deterministic: the same upstream event MUST always yield the same id, so a retry or a re-run produces the same card rather than a duplicate. Random ids are not permitted.

**Grammar.**

```
id          = producer ":" namespace ":" upstream-id [ ":" intent ]
producer    = 1*(ALPHA / DIGIT / "-")
namespace   = 1*(ALPHA / DIGIT / "-")
upstream-id = 1*(ALPHA / DIGIT / "-" / "_" / "." / pct-encoded)
pct-encoded = "%" HEXDIG HEXDIG
intent      = 1*(ALPHA / DIGIT / "-")
```

Examples: `hermes:gmail:19a4f2e7c3b1`, `goalpath:item:4421:ship-approval`, `head:daily:2026-10-07`, `head:order:01J9Q3K7X2`, `mail:work:%3C19a4f2e7%40mail.example%3E`.

**Upstream keys.** `upstream-id` carries the upstream system's own key. A key that uses other characters is percent-encoded octet by octet over its UTF-8 bytes; a producer SHOULD use uppercase hex digits. Ids are compared as exact strings and a head MUST NOT normalise them, so `%3C` and `%3c` name different cards: a producer encodes the same key the same way every time. When an upstream key is unbounded in length or not representable even so, a producer MAY use a hash of it as `upstream-id`, and SHOULD say which hash (function, input, truncation) in its documentation so the mapping can be reproduced. A source that has no stable key for an event cannot satisfy the determinism rule above; a producer that submits a card for such an event anyway MUST say in the card's body that its id is not stable.

The `producer` segment is the producer's namespace root. A producer MUST only submit ids under its own root, and a head MUST reject any other with `403`. The `intent` suffix lets one upstream event yield several distinct cards (a reply proposal and a calendar proposal from the same email).

**Submission is a PUT, idempotent by identity.** The head compares the incoming card with the stored card on every producer-owned field except `emitted_at`; head-owned fields never participate. An id names a logical proposition; while the card is `open` its content may be revised by re-PUT, and the head MUST clear `seen_at` whenever the body or `actions` change (compared as below) so the person sees the revision as new. A revision keeps the other owner-side fields, `acknowledged_at` and `snoozed_until`. Once decided, the id is bound to the content that was decided on.

**Equality.** Two cards are identical when their producer-owned fields other than `emitted_at` are equal after these rules, and only then:

- an absent `urgency` equals `brief`, an absent `references` or `labels` equals `[]`, and an absent `actions` on a decision card equals `[approve, reject]`;
- in `actions`, a string entry equals an object with that `id` and nothing else, and `default: false` equals no `default`;
- trailing whitespace at the end of `body` is not significant;
- member order in objects is not significant; order in lists, `references` included, is, except in `labels`, which compare as a set: `[a, b]` equals `[b, a]`;
- every other field, unknown and extension fields included, compares by value.

| Stored card | Incoming card | Result |
| --- | --- | --- |
| none | any | `201 Created`; state `open` |
| `open`, identical | identical | `200 OK`; no change: `change_seq`, `received_at`, `seen_at` and the stored `emitted_at` stay as they were |
| `open`, different | different | `200 OK`; card replaced in place, `received_at` updated |
| `decided` or `superseded`, identical | identical | `200 OK`; body carries the stored card including its decision |
| `decided` or `superseded`, different | different | `409 Conflict`; body carries the stored card including its decision |

A `409` tells the producer that the person has already acted on an earlier version. The producer MUST NOT retry the same PUT; it MAY submit a new card with `supersedes` set to the locked id. A producer that receives `200` for a card it believed was new SHOULD read the returned decision, since it may already have an answer. Idempotent submission is not exactly-once processing: a producer that acts on a decision MUST make that action idempotent on its own side.

## 6. Lifecycle

A card has three states and moves through them in one direction only. Every kind shares this storage lifecycle; only kind: decision additionally takes part in the human-decision layer (§4.3), while artifact and signal cards pass through it with acknowledgement alone.

```mermaid
stateDiagram-v2
  [*] --> open: PUT (201)
  open --> open: PUT, different (200)
  open --> decided: decision
  open --> superseded: successor PUT
  decided --> superseded: successor PUT
```

An open card can be replaced by a re-PUT; once decided it is locked, and the only way past a locked card is a newer card that supersedes it.

| From | Event | To | Notes |
| --- | --- | --- | --- |
| — | PUT, no stored card | `open` | `201` |
| `open` | PUT, same id | `open` | Replaced in place; `seen_at` cleared if the body or `actions` changed (§5) |
| `open` | POST decision | `decided` | Locked. The decision fields and `decided_at` are set |
| `open` | PUT of a newer card with `supersedes` | `superseded` | New card is unseen; `seen_at` MUST NOT be carried forward |
| `decided` | PUT of a newer card with `supersedes` | `superseded` | Decision is retained on the old card |
| `decided` | PUT, different content | `decided` | `409`; no change |
| `superseded` | PUT, same id | `superseded` | As `decided`: identical is `200`, different is `409` (§5) |
| `superseded` | anything else | `superseded` | Terminal |

Snooze is not a state: `snoozed_until` hides an `open` card from the brief without changing its state, and a producer polling the card sees it as `open`.

`supersedes` MUST name a card in the same namespace, meaning the same producer and namespace segments of the id (`goalpath:item:4421` may be superseded by `goalpath:item:4421:revised`, never by `goalpath:milestone:88`). A head MUST reject a cross-namespace supersede with `403`, a `supersedes` that names a card the head does not hold with `400`, and a card that names itself with `400`. The token is bound to the producer root, so one producer may own several namespaces. A producer that wants to retract a card it has not yet had decided SHOULD supersede it with a `kind: signal` card titled accordingly; there is no delete.

## 7. Operations

There are three operations, and a description of the head (§7.5). Two are a producer's: submit (§7.1) and sync (§7.2), authenticated with its producer token. The third, decide (§7.3), is the owner's, authenticated with a credential the protocol does not define. A head MUST expose them over HTTPS with JSON bodies. The head never calls a producer; all traffic is producer-initiated, so a producer behind NAT or on a laptop needs no inbound port. HTTP is the protocol; an MCP server exposing `submit_card`, `poll_changes` and, when the head implements the `orders` extension, `claim_order` is an adapter over it, not a second definition, and a head SHOULD offer one. Decide is not offered over MCP: the adapter acts with a producer token, which decide refuses.

The paths in this document are relative to the head's base URL. A head MAY mount them under a prefix (`https://example.org/pbcp/cards/{id}`); `GET /` is the base URL itself. A head whose description is read at one URL and whose operations are served under another says where in its description (`api`, §7.5).

### 7.1 Submit

```
PUT /cards/{id}
Content-Type: application/json
Authorization: Bearer <producer token>

{ card }
```

Responses: `201`, `200`, `400` (the card does not conform), `401` (missing or invalid producer token), `403` (id outside the producer's namespace, a card for another person, or cross-namespace `supersedes`), `409` (locked card, different content; or a supersede target already superseded), `413` (card too large), `429` (rate-limited). A `201` and a `200` return the stored card in full, including head-owned fields; so does a `409` for a locked card. Every other refusal carries an error body (§7.4), including the `409` for superseding a card that is already superseded (§8).

`{id}` is the card's id, percent-encoded as a URL path segment; the decoded value MUST equal the card's `id`, or the head rejects the card with `400`. When several refusals apply, a head reports the first in this order, so a producer can tell what to fix:

1. `401`: no token, or one the head does not accept; then `429` if the producer is rate-limited, and `413` if the card is larger than the head accepts;
2. `400`: the card does not conform (encoding, YAML subset, head-owned fields, `protocol`, fields, id grammar, `producer` against the id, `actions`, the URL id). When several of these apply, which `400` code is reported is not specified;
3. `403`: the id is outside the token's root, or `to_person` is not the head's owner (§10);
4. when the PUT supersedes (§8), the checks of §6 and §8: `400` for a card that names itself, `403` for another namespace, `400` for a card the head does not hold, `409` for a card already superseded;
5. the submission table of §5.

### 7.2 Sync

```
GET /changes?after={change_seq}
Authorization: Bearer <producer token>

200 OK
{ "changes": [ { "seq": 103, "card": { ... } }, ... ], "next": 103 }
```

Sync returns current cards, not an event log. Each entry is a card in the producer's namespace whose latest `change_seq` is greater than `after`, carrying that card's current representation and its `seq`; intermediate representations between two polls are not returned. Entries are in ascending `seq`. The head MUST assign `change_seq` from one strictly increasing counter per head — gaps are allowed, and an atomic change to several cards takes several consecutive values; in a supersession the predecessor takes the lower and the successor the higher — so a producer that stores `next` and passes it back never misses a changed card and never sees a stale one, regardless of clocks. A card's `change_seq` MUST increase whenever its current representation changes, owner-side fields included (§4.2), and a sequence value once assigned MUST never be reused, also across a restore of the head's storage.

`after` is a non-negative integer in decimal notation: `0`, or a `next` the head returned. A missing or malformed `after` (`-1`, `1.5`, `abc`) is refused with `400` and the code `invalid_cursor`.

`next` is the highest *global* head sequence the head examined while building the response — not the highest belonging to this producer, since cards of other producers advance it too — or `after` when nothing is newer. A head MAY cap the page; when it does, `next` is the `seq` of the last entry returned, and the producer loops until `next` stops moving. `next` is never lower than `after`; a producer that receives a lower `next` treats the response as an error and leaves its cursor where it was. Timestamps are for display and filtering, never for synchronisation.

The durable-consumer pattern a producer MUST follow:

```
resp = sync(after=cursor)
for change in resp.changes:
    process(change.card)   # idempotent on the producer side
cursor = resp.next         # advance only after processing succeeded
```

A producer sees the same change more than once: a `200` or `409` on submit returns a card it will also receive through sync, and a pass that fails part-way is repeated. Processing is therefore idempotent, as §5 requires.

**Parking.** A change whose processing keeps failing (a mailbox that no longer exists, a record deleted upstream) would hold the cursor back for good. A producer MAY park such a change after repeated failed attempts: it records the change as parked, treats it as processed, and advances its cursor past it. A producer that parks MUST report every parked change, at least by logging the card id, its `seq` and the failure; it MUST NOT park a change it has not attempted to process. Reporting is the producer's: it MAY also tell the person with a card of its own (a `signal` in the parked card's thread), and the protocol defines no head endpoint for parked changes.

### 7.3 Decide

```
POST /cards/{id}/decision
Content-Type: application/json
Authorization: <the owner's credential>

{ "decision": "edited", "edited_proposal": "...", "comment": "..." }
```

The owner's operation: the head's own interface calls it on behalf of the person, never a producer. It is performed with the head owner's credential, which the protocol does not define (a session, a passkey assertion, a local socket); a head exposes it however it likes, at this path or another. A producer token MUST be refused with `401`, before the request is otherwise examined. (Appendix A uses decide for the person to cancel an order; giving an order is another owner action of the same kind, A.1; an executor's claim is a producer operation, A.2.) `decision` MUST be one of the card's `actions` other than `edit`, or one of the built-in values `dismissed`, `delegated` (with `delegated_to`), `edited` (with `edited_proposal`); `edited` is accepted on every decision card (§4.4). `edited_proposal` and `delegated_to` appear with their decision and with no other; `comment` may accompany any. The protocol defines no credentials for human interfaces: who may decide on behalf of the owner is entirely the head's responsibility.

Responses: `200` with the decided card; `401` for a missing or invalid owner credential, a producer token included; `400` for a value not allowed above, or for a card that is not `kind: decision`; `404` for an id the head does not hold; `409` with the stored card when the card is already `decided` or `superseded`.

### 7.4 Status codes

| Code | Meaning |
| --- | --- |
| `200` | Accepted, nothing new, or already decided — read the body |
| `201` | New card stored |
| `400` | Card or request does not conform |
| `401` | Missing or invalid credential: a producer token on submit or sync, the owner's credential on decide |
| `403` | Id or supersede target outside the producer's namespace, or a card for another person |
| `404` | No card with this id |
| `409` | Card is locked and the content differs, or a supersede target is already superseded, or (orders) another root holds the lease |
| `410` | (orders) The order is done, failed or cancelled |
| `413` | Card too large |
| `429` | Producer rate-limited; `Retry-After` set |

**Error bodies.** Every refusal that does not return a card (§7.1, §7.3, A.2) carries `{ "error": "<code>", "message": "<text>" }`; a refused claim adds the order as it stands, `"order": { … }` (A.2, A.5). `code` is one of the values below for its status, and a client MAY rely on it; `message` is for people and says nothing a client should parse. A head MUST NOT send a code under a status other than its own.

| Status | `error` codes |
| --- | --- |
| `400` | `malformed_json`, `malformed_front_matter`, `yaml_outside_subset`, `invalid_card`, `invalid_id`, `producer_mismatch`, `head_owned_field`, `unsupported_protocol`, `unsupported_kind`, `duplicate_action`, `multiple_defaults`, `id_mismatch`, `supersede_self`, `supersede_target_missing`, `invalid_cursor`, `invalid_lease`, `invalid_decision`, `not_decidable`, `not_acknowledgeable` |
| `401` | `unauthorized` |
| `403` | `outside_root`, `wrong_person`, `cross_namespace_supersede` |
| `404` | `not_found` |
| `409` | `already_superseded`, `lease_held` |
| `410` | `order_terminal` |
| `413` | `too_large` |
| `429` | `rate_limited` |

`unauthorized` covers every missing or invalid credential, producer or owner. `invalid_cursor` is a missing or malformed `after` on sync (§7.2). The table covers the owner's operations as well as the producer's: `not_acknowledgeable` is for the owner's acknowledgement, which a head exposes through its own interface (§4.2), and a head that exposes owner operations over HTTP uses these codes for them. `invalid_lease`, `lease_held` and `order_terminal` belong to the orders extension (A.2, A.5). A `429` carries `Retry-After` in seconds; a producer SHOULD NOT send another request to that head before it has elapsed.

### 7.5 Describe

```
GET /

200 OK
{ "protocol": "pbcp/1", "owner": "morten", "api": "https://head.example/api", "seq": 1042, "extensions": [], "render": { "mermaid": ["core", "extended"] } }
```

A head MUST answer `GET /` with its description: `protocol`, the version it implements; `owner`, the person id it stores cards for, which a producer uses as `to_person` (§10); `seq`, the highest `change_seq` the head has assigned (`0` before the first), which a producer that wants only what happens from now on passes as its first `after` (§7.2) instead of reading the whole change feed; `extensions`, the names of the extensions it implements (`orders` for Appendix A), empty for the core alone; and `render.mermaid`, the mermaid tiers it renders (§3.1): `core`, `extended`, and `other` for a head that renders types outside both. It MAY also give `api`, the base URL under which it serves the operations of §7.1–§7.3 (and claims, A.2), so that a producer configured with only the head's origin can find them; a relative `api` is resolved against the URL the description was read from. Absent, the operations are relative to that URL, as §7 says: at the origin, for a description read from the origin. A client that reads `api` sends its operations there. A client ignores values it does not know. A head MAY require a producer token for `GET /`, and MAY add members; a client ignores members it does not know.

## 8. Threads, supersession and folding

Producers emit flat cards; the head does the arranging, from fields the producer sets: `thread`, `supersedes` and `references` relate cards, and `about` and `labels` place and mark them.

**`thread`** groups cards from one producer. A head MUST show cards sharing a thread together, newest last, and MAY collapse all but the newest. The producer chooses the key; a mail reader would use the mail thread id, an executor the order id.

**`supersedes`** establishes a successor card in the same producer namespace. A successor MAY supersede an `open` card, to replace an unresolved proposal, or a `decided` card, to ask a new question that builds on the previous one. It MUST NOT supersede a `superseded` card; naming one is rejected with `409`, so chains stay linear because only the current card can be superseded. Supersession never changes or invalidates the decision recorded on the predecessor: the head shows the successor, keeps the predecessor reachable in the thread with its decision intact, and marks it `superseded`. A superseding PUT MUST atomically store the successor and mark the predecessor; neither change is visible without the other. A PUT supersedes when it stores a new card that names `supersedes`, or replaces an open card with one that names a different `supersedes` than before; re-PUTting a successor with the same `supersedes` does not supersede again, and a PUT to a decided or superseded id never supersedes (§5 applies). To withdraw a proposal, a producer supersedes it with a `kind: signal` card whose body says so.

**`references`** links cards across producers without grouping them. The head renders these as links and MAY show a referenced card's title inline.

**A card's day.** A head places each card on one day in its timeline and in briefs: the card's `about` (§4.1) when it has one, else the day of its `received_at` (§4.2) in the head's time zone, which is the owner's and is set however the head chooses; the protocol carries none. `about` is taken as written, never converted between zones. A card whose day is in the future appears on that day, and a head MAY also show it earlier. How far ahead a head's timeline reaches is the head's choice: a card about a later day is shown on its day once the timeline reaches that day, and before then only under that MAY. In a brief, the previous day's cards are those whose day, so defined, is the previous day. A brief is generated from the cards the head holds when it generates it; a card about an earlier day that arrives afterwards is placed on its day in the timeline, and need not be added to a brief already generated.

**`labels`** are shown, not grouped. A head shows a card's labels on the card (§4.1). A generated brief MAY group its entries by label only when the owner asks for that; by default its order is unchanged by labels.

**Views.** A filter or view the owner chooses, by label, by producer or otherwise, is the owner's own narrowing of the brief. It does not affect what a head MUST include in a brief it generates: the requirements of this section apply to the generated brief, not to the view, and a view never changes the generated brief. How a view combines several labels is the head's choice. A view MAY count the snoozed open decisions it admits, and, like a brief, MUST NOT list them or their leads (§4.2).

Folding is the head's job: turning a day of cards into one readable brief, collapsing a thread of progress cards into a single line, rendering `mermaid`. A head MAY use a language model to write the brief. It MUST NOT alter card bodies or decisions while doing so, and MUST keep every card reachable in its original form.

**What a brief contains.** A brief the head generates (a `head:` card such as `head:daily:<date>`, or a view the head assembles) MUST include, for every open decision card that is not snoozed (§4.2), its title and its lead (§3.1), and SHOULD include, for each of the previous day's artifact and signal threads, the title and lead of the thread's newest card that is not snoozed (§4.2); a thread whose cards are all snoozed is left out. Each entry MUST link to its card. A brief MAY state how many open decision cards are snoozed, and MUST NOT list them or their leads until their `snoozed_until` has passed. Counts, charts and other aggregates MAY be added; they are never the brief on their own. Titles and leads are what make a brief readable without a language model, and a brief folded mechanically from them is complete.

## 9. Urgency and producer trust

`urgency` is a delivery preference: it says where the producer asks a card to land, not how important it is. Where it actually lands is the head-owned `delivery` (§4.2), which the head sets from `urgency` and the producer's ceiling. Neither changes the card's lifecycle.

| `delivery` | Where it lands | Typical use |
| --- | --- | --- |
| `immediate` | Shown at once; MAY notify | A meeting moved to ten minutes from now; a production alert |
| `brief` (default) | Woven into the next brief | A reply to approve; today's agenda; an overnight summary |
| `log` | Stored, shown only in the day view | A commit; a progress update; a routine signal |

A `kind: decision` card remains open until decided, whatever its `delivery`. How a head keeps it in view (pinned, badged, listed) is the head's choice; that it stays reachable is the protocol's.

**Ceilings.** Urgency is a producer's request, not a right. A head MUST let the person set a per-producer ceiling. When it stores a card's content it sets `delivery` to the card's `urgency` (absent is `brief`), lowered to the ceiling if above it, in the order `log` < `brief` < `immediate`; it MUST NOT alter `urgency` itself, which stays as the producer sent it for equality (§5) and is returned unchanged. Sync returns both, so a producer can see that it was clamped. Changing a ceiling does not revisit cards already stored. A producer whose ceiling the person has not set has the ceiling `brief`. A head's interface may present a card however it likes, but `delivery` as stored and synced changes only when the card's content is stored. A head MAY also let the person set a ceiling per label (§4.1), applied the same way. A label's ceiling applies to every card that carries the label, whichever producer sent it; a card under several ceilings, its producer's and those of any of its labels, takes the lowest. This is the only defence against a noisy producer short of revoking its token.

## 10. Addressee

Every card carries `to_person`, naming one person. A head stores only cards addressed to its owner and MUST reject others with `403`. A producer learns the owner's person id from the head's description (§7.5). There is no team mode, no shared inbox and no assignment: work that belongs to a team lives in the team's own tool, which is itself a producer. A producer that serves several people posts to several heads. The one-owner rule is what makes `approve`, `reject` and `delegate` unambiguous; the protocol deliberately keeps multi-party consensus out of scope.

In the core protocol, `delegated` is simply a decision value with `delegated_to` set: the card locks, and the producer learns from sync that it is now waiting on someone else. How the delegate comes to see the card is federation, sketched in Appendix B and not yet specified.

## 11. Connector conformance

The bar is deliberately low. The checklists below are the whole of what each role must do for the core protocol; the `orders` extension adds its own in Appendix A.

### 11.1 A producer

- [ ] Mints deterministic ids under one namespace root it owns
- [ ] Sends cards as JSON with `protocol: pbcp/1`; MAY keep them as front-matter files
- [ ] Submits with PUT; treats `201` as newly accepted, `200` as already current, and `409` as terminal — reconcile, never retry
- [ ] On `409`, never re-PUTs the same content; supersedes instead if it still needs an answer
- [ ] Syncs with `after=<change_seq>` and advances its cursor only after processing, or parking and reporting (§7.2)
- [ ] Honours `Retry-After` on `429`
- [ ] Acts on decisions idempotently on its own side
- [ ] Never includes head-owned fields on submission

A mail reader is the canonical minimal producer: IMAP message id → `id` (percent-encoded or hashed, §5), thread id → `thread`, subject → `title`, the first lines of the message with whitespace collapsed → `summary`, headers and first lines → body. A message in the inbox is a `kind: decision` card with `actions: [{ "id": "archive", "default": true }, "keep"]`, so a bare approve gesture (§4.4) archives it; every other message is a `kind: artifact` card with no `actions`. A new message in a thread that has an open mail card supersedes that card (§8), so a thread is decided once, on its latest message, and the decision applies to the messages it superseded. A predecessor decided before the successor reached the head keeps its decision (§8), and the reader acts on that decision for that card's own message. A mail reader SHOULD set `source` (§4.1) to a URL that opens the message in the person's mail client when it can form one. It drafts nothing and sends nothing; a producer that proposes a reply is a separate agent that `references` the mail card.

### 11.2 An executor (orders extension)

Everything in 11.1, plus:

- [ ] Syncs for `kind: order` cards addressed to it (or `*`)
- [ ] Claims with a lease before starting; renews at least every half lease and before each irreversible step; stands down on `409`; stops on `410` and never retries it
- [ ] Makes external side effects idempotent on the order id
- [ ] Reports progress and outcome as new cards in the order's thread, with ids per claim (`<root>:order:<ulid>:outcome-<claim_seq>`)
- [ ] Reports failure as an outcome card with `orders.result: failed`, never silently

### 11.3 A head

- [ ] Stores cards for exactly one person and rejects others
- [ ] Implements submit, sync and describe for producers, and decide for its owner only, with the status codes and error codes in §7
- [ ] Assigns `change_seq` from one monotonic counter
- [ ] Enforces namespace ownership and the lock on decided cards
- [ ] Retains the decided version of every card and every decision, reachable in original form (the decision log)
- [ ] Ignores unknown producer fields; rejects head-owned fields on PUT
- [ ] Renders markdown; strips raw HTML
- [ ] Shows `summary` as text, never as markdown; shows each card's lead (§3.1) in lists and briefs and does not hide it on the card
- [ ] Shows each card's `labels` on the card, and places each card on its day: its `about`, else the day of `received_at` in the head's time zone (§4.1, §8)
- [ ] Presents decision cards as §4.5 requires: the actions as controls in order, the `default` as primary and, with no default, no option styled or placed as primary, `dismissed` always available, the lead and the proposal visible, no required comment, and a confirmation once recorded
- [ ] Puts every open decision card's title and lead, linked to the card, in any brief it generates, except snoozed cards, which it does not list (nor their leads) until `snoozed_until` has passed and MAY only count (§4.2, §8)
- [ ] Lets the person set per-producer urgency ceilings, and records the clamped value as `delivery` without altering `urgency`
- [ ] For the `orders` extension: mints orders, implements claim leases and lease expiry

A head is a role, not a particular service: a cloud service, a local daemon, an MCP server or a plugin inside another product can each be one. A head MAY add a brief writer, `mermaid` rendering, search, dictation or any other interface. None of that is part of the protocol.

## 12. Security considerations

**Authentication is identity, not authority.** Each producer holds a bearer token issued by the head and bound to exactly one namespace root; a producer that needs several roots holds several tokens. The head MUST check that every id and `supersedes` target falls under that root. A valid token establishes *who* submitted a card; it says nothing about whether the card's claims are true or whether the producer had any standing to make them. A head MUST NOT present producer identity to the person as if it vouched for content. The human-readable `producer` name and the authenticated principal are distinct: two installations of the same connector SHOULD hold different tokens, and a head MAY bind a token to a producer *instance* as well as a name. Revoking the token is the way to silence a producer.

**Every connection is outbound from the producer.** Every connection in the protocol is initiated by a producer or executor: submission (§7.1), sync (§7.2) and, in the orders extension, claims and lease renewal (A.2). The head never connects to a producer. A conforming head MUST NOT require a producer or executor to accept inbound connections, and an extension MUST preserve this property. Notifications, when an extension specifies them, go to the owner's devices, never to producers. Two consequences follow. A producer inside a restricted network needs only outbound HTTPS to its head. And token scope (§7, one token per namespace root) bounds what either side can reach if the other is compromised: a compromised producer's token reaches only its own root, and a compromised head can only answer the requests a producer chooses to make.

**Content is untrusted.** A card body is written by a machine from material the person has not seen — an email from a stranger, a web page, a commit message. A head that uses a language model to fold or draft MUST treat card bodies as data, never as instructions, and SHOULD show the person the raw card on request. The same applies to an executor reading an order: the order's body is the person's words, but material quoted inside it may not be.

**Decisions are the sensitive record.** The decision log says what the person approved, rejected and delegated, with timestamps. A head MUST protect it at least as carefully as the cards themselves and MUST NOT expose it to producers beyond their own namespace.

**Urgency as a vector.** A compromised or misbehaving producer can flood `immediate`. Ceilings (§9), which clamp `delivery`, and rate limits (`429`) are the mitigations; a head SHOULD alert the person when a producer's volume changes sharply.

**No raw HTML.** Stripping HTML from bodies closes the obvious injection path into the head's interface. Mermaid fences are declarative content: rendering one MUST NOT cause network access or code execution. Links in markdown and source.url are permitted; a head SHOULD show the destination hostname beside any link, MUST NOT auto-open them, and MUST treat source.label as untrusted display text that says nothing about where the link goes.

## 13. Prior art

| Source | Borrowed | Rejected |
| --- | --- | --- |
| **Email (SMTP, IMAP)** | Sender-minted message ids as the idempotency key; threads by reference; one addressee per message; the client reads, the server never pushes | Mutable flags set by any client; no notion of a decision; free-form headers |
| **Google Wave** | Globally unique ids made of a domain plus an id string; wavelets hosted by their creator's provider and mirrored to participants; robots as first-class participants; private reply wavelets (the model for delegation); open-request subscription by id prefix (the model for poll by namespace) | Operational transformation and live concurrent editing — the concurrency model imposed substantial implementation cost on every participant. Cards are immutable; change is a new card |
| **Jekyll / Hugo / Obsidian front matter** | The card file format itself | Full YAML: restricted to a plain subset (§3) |
| **Webhooks** | Bearer tokens per integration; retries assume idempotency | Push from server to client: producers poll instead, so a producer behind NAT or on a laptop works without exposure |
| **MCP** | Tool-shaped exposure of the three operations for agents that speak it | — |
| **Task queues (Celery, SQS, Sidekiq)** | Leased claims with expiry; at-least-once delivery with idempotent consumers | System-to-worker dispatch as the primary model. An order is a person's instruction to software they are authorised over, carried in a human-readable card and recorded in a decision ledger; execution is optional and exactly-once side effects are out of scope |

The design position is the mailbox, not the document: Wave showed what a shared, live, structured conversation could be, and also that the cost of that liveness is borne by every implementer. A protocol meant to be implemented in an afternoon by a mail-reading script cannot carry that cost. Single-writer cards, replaceable while open and locked on decision, give most of Wave's traceability at none of its concurrency complexity.

Sources: [Wave Federation Protocol](https://en.wikipedia.org/wiki/Google_Wave_Federation_Protocol), [Wave federation spec](https://svn.apache.org/repos/asf/incubator/wave/whitepapers/federation/wavespec.html), [Wave client-server protocol](https://svn.apache.org/repos/asf/incubator/wave/whitepapers/client-server-protocol/client-server-protocol.html), [Wave conversation model](https://svn.apache.org/repos/asf/incubator/wave/whitepapers/conversation/convspec.html), [InfoQ on Wave](https://www.infoq.com/news/2009/06/wave/).

## 14. Open questions

**Conformance suite.** Conformance is tested with fixtures: language-neutral JSON files, published with the reference implementation, that a head runs through an adapter. Protocol fixtures drive a head through describe, submit and sync, through decide with the owner's credential, and through two more actions its owner would take (presenting a card, which sets `seen_at`, and acknowledging one); they also check that a missing or invalid producer token and a producer token on decide are refused; the head under test is owned by `morten`, and paging is exercised by syncing until `next` stops moving, whatever page size the head chooses. A fixture marked `SHOULD` checks a recommendation and may fail without breaking conformance. A fixture marked with an extension (`orders`) runs only for a head that implements it, and one marked with a condition runs only for a head the condition describes (`prerender`: R07, for a head that draws diagrams before serving them); the head's adapter declares both. The adapter's test clock may be set asynchronously. A refusal that exists only in a transport (the URL id against the card id, `id_mismatch`) is left to each head's own tests. Rendering conformance (§3.1) is tested from card bodies rather than over HTTP: each fixture gives a body and the expected classification of every fence (`render`, `fallback`, `collapsed`), what was stripped (raw HTML, `click`, URL-loading `init` or front-matter `config`, `htmlLabels`), and how each image is shown; for `fallback`, that a parser message is shown (not its wording) and that the surrounding text still appears. A head passes by rendering the fixture and matching the classification; pixel output is not compared. The lead (§3.1) is tested the same way, from a card's `summary` and `body`: the fixture expects the lead's text and whether it came from `summary` or the body. The presentation rules of §4.5 and the brief contents of §8 are obligations on a head's interface and are not tested by fixtures. Producer obligations (cursor handling, parking) are tested in the client library, not against a head.

**Coverage.** The table maps each requirement sentence in §3–§11 and Appendix A (every one with MUST, MUST NOT, SHOULD or SHOULD NOT; one row per sentence, quoted briefly) to the fixtures that exercise it, or says why none does. A fixture listed against a sentence exercises it, not necessarily every clause of it. The table is generated by `scripts/conformance-map.ts` from each fixture's `covers` list and `packages/core/conformance/untested.json`, and a test fails when it no longer matches the fixtures or this text.

<!-- coverage: generated from the fixtures by scripts/conformance-map.ts; edit their `covers` or packages/core/conformance/untested.json, not this table -->

111 requirements: 56 exercised by a fixture, 55 untested.

| § | Requirement | Fixtures |
| --- | --- | --- |
| 3 | A head MAY accept the file form on PUT as `text/markdown`, but MUST accept JSON. | C01, C15 |
| 3 | **Restricted YAML.** To keep parsers simple and avoid YAML's implicit-typing surprises, the header MUST use only this subset: | C12 |
| 3 | Producers SHOULD quote anything a YAML parser might otherwise coerce (`no`, `1.0`, dates) so the file reads the same in any editor; | untested: client-side behaviour (a producer's) |
| 3 | A header that uses anything outside this subset MUST be rejected with `400`. | C12 |
| 3 | The header MUST NOT contain `body`. | C47 |
| 3 | No other embedding (HTML, iframes, remote widgets) is permitted in this version; a head MUST strip raw HTML. | R05 |
| 3.1 | This profile is the contract: what a card body may contain, what a head MUST render, and what happens to the rest. | R01, R02, R03 |
| 3.1 | A head MUST render these. | untested: interface behaviour: the render adapter reports text and fences, not markdown structure |
| 3.1 | In a list, a folded brief or a thread summary, a head MUST show at least the lead of each card, beside its title, and MAY stop there. | R09, R10, R11 |
| 3.1 | On the card itself, a head MUST NOT hide the lead behind a gesture. | untested: interface behaviour a fixture cannot observe |
| 3.1 | **Images.** `![alt](url)` is rendered when `url` is `https:` (subject to the head's image policy; a head SHOULD proxy or size-limit remote images and MUST NOT … | R05 |
| 3.1 | **Image fallback for a diagram.** An image whose alt text is exactly `fallback`, placed immediately after a `mermaid` fence with nothing between but blank … | R08 |
| 3.1 | **Core** \| `flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `gantt`, `timeline`, `pie`, `xychart-beta` (bar, line) \| MUST render | R01 |
| 3.1 | **Extended** \| `classDiagram`, `erDiagram`, `quadrantChart`, `sankey-beta`, `mindmap`, `gitGraph`, `journey` \| SHOULD render; MAY fall back | R12 |
| 3.1 | **Declarative only.** Rendering a mermaid fence MUST NOT cause network access, script execution, or navigation. | R04 |
| 3.1 | A head MAY pre-render fences to SVG server-side and serve the SVG; a producer MUST NOT depend on client-side rendering. | untested: client-side behaviour (a producer's) |
| 3.1 | *In the card*, a head MUST show each visual as a thumbnail fitted to the card's width (assume 360 px on a phone, about 600 px on the web), in reading order … | untested: interface behaviour a fixture cannot observe |
| 3.1 | *On tap or click*, the head MUST open the visual full-screen with zoom and pan, at its native size, and SHOULD offer the fence source behind a disclosure: the … | untested: interface behaviour a fixture cannot observe |
| 3.1 | A head MAY lazy-render thumbnails and MUST NOT require the full-screen view to read the card's text. | untested: interface behaviour a fixture cannot observe |
| 3.1 | In a folded brief or a thread summary, a head MAY show only the first visual of a card, or none; it MUST NOT reflow a card's text to fit around visuals it has … | untested: interface behaviour a fixture cannot observe |
| 3.1 | **Limits.** A head MUST render up to 8 fences per card. | R06 |
| 3.1 | Rendered diagrams are scaled to the viewport width; producers SHOULD keep diagrams under roughly 20 nodes or 30 data points, since the brief is read on a phone. | untested: client-side behaviour (a producer's) |
| 3.1 | **Determinism.** Given the same fence, a head SHOULD produce the same diagram on every view; a head that pre-renders MUST cache by content hash of the fence so … | R07 |
| 3.1 | **Size.** A head MUST accept a card whose JSON wire form is up to 64 KiB and MAY reject larger ones with `413`; it MUST reject one larger than 1 MiB with `413`. | C27 |
| 3.1 | **Unknown fields.** A head MUST ignore producer-owned fields it does not recognise and SHOULD preserve them, verbatim, in what it returns and syncs, so a … | C14, C24 |
| 3.1 | A head MUST reject any field in the head-owned set (§4.2) on submission. | C14 |
| 4.1 | The head MUST NOT alter them. | C01, C40, C41, C44 |
| 4.1 | `kind`: Extensions MAY add kinds; a head MUST reject with `400` a kind it does not implement. | C46 |
| 4.1 | `title`: MUST NOT be empty or contain CR or LF. | C45 |
| 4.1 | `summary`: MUST NOT be empty or contain CR or LF, and SHOULD be under 280 characters; a head MAY truncate it beyond that with an ellipsis. | C39 |
| 4.1 | `summary`: It is not markdown: a head MUST show it as text, never render it. | R09 |
| 4.1 | `summary`: On a decision card, `summary` SHOULD state the proposal, not only the topic ("The proposed reply agrees for September only"), so that a brief's line … | untested: client-side behaviour (a producer's) |
| 4.1 | `labels`: A head MUST show a card's labels on the card and SHOULD let the owner filter the brief by label; it MAY apply ceilings per label (§9). | untested: interface behaviour a fixture cannot observe |
| 4.1 | `actions` \| no \| list \| Decision values offered, for `kind: decision` only; `artifact` and `signal` cards never carry it, and a head MUST reject one that … | C11 |
| 4.2 | A producer MUST NOT include them on submission; a head MUST reject a submission that does with `400`. | C14 |
| 4.2 | `seen_at`: A head MUST NOT set it merely because the card was synced or folded into a generated brief. | C48 |
| 4.2 | `acknowledged_at`: Inclusion in a generated brief MUST NOT by itself set it, and a head MUST NOT set it on a `decision` card. | C11 |
| 4.3 | - `dismissed` — seen, no action; the producer SHOULD treat it as "do nothing". | untested: client-side behaviour (a producer's) |
| 4.3 | The producer MUST act on the replacement as it would have on `approve` with the original. | untested: client-side behaviour (a producer's) |
| 4.3 | A producer MUST treat it as terminal for its own card; whatever follows is federation, sketched in Appendix B and outside the core. | untested: client-side behaviour (a producer's) |
| 4.4 | The protocol decisions `dismissed`, `edited` and `delegated` are reserved: a head MUST reject a card that uses one as an `id` with `400`. | C21 |
| 4.4 | The head MUST pre-select it and MUST treat a bare approve gesture on the card (a swipe, a voice "yes", a keyboard shortcut) as choosing it. | untested: interface behaviour a fixture cannot observe |
| 4.4 | The entry controls only what the head *offers*: a producer that wants free text as an option includes `edit` in the list, and a head SHOULD NOT offer free text … | untested: interface behaviour a fixture cannot observe |
| 4.4 | A head MUST reject a card with two defaults or a duplicate `id` with `400`. | C21 |
| 4.4 | A decision card SHOULD contain both the evidence (what happened) and the producer's proposal (what it suggests doing), as separate sections of the body, so the … | untested: client-side behaviour (a producer's) |
| 4.4 | The person decides on the card *as it stood when decided*; the head MUST retain that version. | C03, C04, C06, C38 |
| 4.5 | - **The actions are the controls.** A head MUST offer the card's `actions` (§4.4, the default `[approve, reject]` included) as controls on the card, available … | untested: interface behaviour a fixture cannot observe |
| 4.5 | With no default there is no primary control: a head MUST give the options equal weight and MUST NOT style or place any one of them as primary, just as it … | untested: interface behaviour a fixture cannot observe |
| 4.5 | A head MUST NOT gather the actions behind one intermediate control (a single "decide" control that reveals them). | untested: interface behaviour a fixture cannot observe |
| 4.5 | A head MUST NOT require the person to open the card on its own to decide it. | untested: interface behaviour a fixture cannot observe |
| 4.5 | - **The comment is optional.** A head MUST NOT require `comment` to record a decision. | untested: interface behaviour a fixture cannot observe |
| 4.5 | It SHOULD offer the comment behind a disclosure rather than as a field the person has to pass. | untested: interface behaviour a fixture cannot observe |
| 4.5 | - **Confirmation.** When the head records a decision, or an acknowledgement (§4.2), it MUST confirm that in its interface in a way the person can tell apart … | untested: interface behaviour a fixture cannot observe |
| 5 | An id is deterministic: the same upstream event MUST always yield the same id, so a retry or a re-run produces the same card rather than a duplicate. | untested: client-side behaviour (a producer's) |
| 5 | A key that uses other characters is percent-encoded octet by octet over its UTF-8 bytes; a producer SHOULD use uppercase hex digits. | untested: client-side behaviour (a producer's) |
| 5 | Ids are compared as exact strings and a head MUST NOT normalise them, so `%3C` and `%3c` name different cards: a producer encodes the same key the same way … | C22 |
| 5 | When an upstream key is unbounded in length or not representable even so, a producer MAY use a hash of it as `upstream-id`, and SHOULD say which hash … | untested: a producer's documentation, not its behaviour |
| 5 | A source that has no stable key for an event cannot satisfy the determinism rule above; a producer that submits a card for such an event anyway MUST say in the … | untested: client-side behaviour (a producer's) |
| 5 | A producer MUST only submit ids under its own root, and a head MUST reject any other with `403`. | C13 |
| 5 | An id names a logical proposition; while the card is `open` its content may be revised by re-PUT, and the head MUST clear `seen_at` whenever the body or … | C02 |
| 5 | The producer MUST NOT retry the same PUT; it MAY submit a new card with `supersedes` set to the locked id. | untested: client-side behaviour (a producer's) |
| 5 | A producer that receives `200` for a card it believed was new SHOULD read the returned decision, since it may already have an answer. | untested: client-side behaviour (a producer's) |
| 5 | Idempotent submission is not exactly-once processing: a producer that acts on a decision MUST make that action idempotent on its own side. | untested: client-side behaviour (a producer's) |
| 6 | `open` \| PUT of a newer card with `supersedes` \| `superseded` \| New card is unseen; `seen_at` MUST NOT be carried forward | C05 |
| 6 | `supersedes` MUST name a card in the same namespace, meaning the same producer and namespace segments of the id (`goalpath:item:4421` may be superseded by … | C08 |
| 6 | A head MUST reject a cross-namespace supersede with `403`, a `supersedes` that names a card the head does not hold with `400`, and a card that names itself … | C07, C08 |
| 6 | A producer that wants to retract a card it has not yet had decided SHOULD supersede it with a `kind: signal` card titled accordingly; there is no delete. | untested: client-side behaviour (a producer's) |
| 7 | A head MUST expose them over HTTPS with JSON bodies. | untested: transport, which the adapter hides |
| 7 | HTTP is the protocol; an MCP server exposing `submit_card`, `poll_changes` and, when the head implements the `orders` extension, `claim_order` is an adapter … | untested: outside the HTTP operations the fixtures drive |
| 7.1 | `{id}` is the card's id, percent-encoded as a URL path segment; the decoded value MUST equal the card's `id`, or the head rejects the card with `400`. | untested: transport (the URL id), left to each head's own tests (§14) |
| 7.2 | The head MUST assign `change_seq` from one strictly increasing counter per head — gaps are allowed, and an atomic change to several cards takes several … | C05, C09, C10 |
| 7.2 | A card's `change_seq` MUST increase whenever its current representation changes, owner-side fields included (§4.2), and a sequence value once assigned MUST … | C02, C11, C37, C38, C41 |
| 7.2 | The durable-consumer pattern a producer MUST follow: | untested: client-side behaviour (a producer's) |
| 7.2 | A producer that parks MUST report every parked change, at least by logging the card id, its `seq` and the failure; it MUST NOT park a change it has not … | untested: client-side behaviour (a producer's) |
| 7.3 | A producer token MUST be refused with `401`, before the request is otherwise examined. | C30 |
| 7.3 | (Appendix A uses decide for the person to cancel an order; giving an order is another owner action of the same kind, A.1; an executor's claim is a producer … | C19, C21 |
| 7.4 | A head MUST NOT send a code under a status other than its own. | C15, C26, C27, C29, C34, C42, C43, C44 |
| 7.4 | A `429` carries `Retry-After` in seconds; a producer SHOULD NOT send another request to that head before it has elapsed. | untested: client-side behaviour (a producer's) |
| 7.5 | A head MUST answer `GET /` with its description: `protocol`, the version it implements; `owner`, the person id it stores cards for, which a producer uses as … | C25, C31 |
| 8 | A head MUST show cards sharing a thread together, newest last, and MAY collapse all but the newest. | untested: interface behaviour a fixture cannot observe |
| 8 | It MUST NOT supersede a `superseded` card; naming one is rejected with `409`, so chains stay linear because only the current card can be superseded. | C07 |
| 8 | A superseding PUT MUST atomically store the successor and mark the predecessor; neither change is visible without the other. | C05, C06 |
| 8 | It does not affect what a head MUST include in a brief it generates: the requirements of this section apply to the generated brief, not to the view, and a view … | untested: interface behaviour a fixture cannot observe |
| 8 | A view MAY count the snoozed open decisions it admits, and, like a brief, MUST NOT list them or their leads (§4.2). | untested: interface behaviour a fixture cannot observe |
| 8 | It MUST NOT alter card bodies or decisions while doing so, and MUST keep every card reachable in its original form. | untested: interface behaviour a fixture cannot observe |
| 8 | **What a brief contains.** A brief the head generates (a `head:` card such as `head:daily:<date>`, or a view the head assembles) MUST include, for every open … | untested: interface behaviour a fixture cannot observe |
| 8 | Each entry MUST link to its card. | untested: interface behaviour a fixture cannot observe |
| 8 | A brief MAY state how many open decision cards are snoozed, and MUST NOT list them or their leads until their `snoozed_until` has passed. | untested: interface behaviour a fixture cannot observe |
| 9 | A head MUST let the person set a per-producer ceiling. | C28 |
| 9 | When it stores a card's content it sets `delivery` to the card's `urgency` (absent is `brief`), lowered to the ceiling if above it, in the order `log` < … | C28 |
| 10 | A head stores only cards addressed to its owner and MUST reject others with `403`. | C13 |
| 11.1 | A mail reader SHOULD set `source` (§4.1) to a URL that opens the message in the person's mail client when it can form one. | untested: client-side behaviour (a producer's) |
| A.1 | This extension changes three core rules, and only for `kind: order`: it adds `order` to the `kind` enum; `to_person` MUST be absent and `to_producer` MUST be … | C16, C20 |
| A.1 | A `*` order minted when no root is eligible reaches no one; a head SHOULD say so to the person when it is given. | untested: interface behaviour a fixture cannot observe |
| A.1 | **Order fields.** The extension adds head-owned fields to the order card, which a producer MUST NOT submit, and two producer-owned fields to the outcome card … | C14 |
| A.1 | The one coupling runs the other way: a human decision of `dismissed` on an order (the only decision an order accepts; any other is `400 invalid_decision`) MUST … | C19 |
| A.1 | That is how a person cancels an order — through the core decision operation, not a fourth operation — and a cancelled order MUST NOT be claimed again. | C19 |
| A.2 | A claim while another root's lease holds is refused with `409 lease_held`, and that executor MUST stand down. | untested: client-side behaviour (an executor's) |
| A.2 | A claim or renewal MUST evaluate expiry atomically with the claim itself, and a lease whose `claim_expires_at` is at or before the head's current time is … | C17 |
| A.2 | A head SHOULD surface an expired lease to the person, since it usually means a worker died, in its own interface: it MUST NOT mint a card for it, because a … | untested: interface behaviour; a head-minted card is outside every producer's sync |
| A.3 | An executor MUST NOT re-PUT the order. | untested: client-side behaviour (an executor's) |
| A.3 | A card that carries `orders.claim_seq` or `orders.result` is an outcome: it MUST carry both, with `orders.claim_seq` a positive integer and `orders.result` … | C18 |
| A.3 | `claimed` \| lease expires, no outcome \| `open` (the head SHOULD surface it to the person, A.2) | untested: interface behaviour a fixture cannot observe |
| A.3 | Any other outcome — the lease lapsed, another root claimed since, or the order is already terminal — is still stored in the thread as information but MUST NOT … | C18, C36 |
| A.3 | A head SHOULD surface such a late or duplicate result to the person in its own interface, and MUST NOT mint a card for it. | untested: interface behaviour; a head-minted card is outside every producer's sync |
| A.3 | Cancellation prevents further execution where observed; it does not undo a side effect the executor has already begun, so an executor MUST check `exec_state` … | untested: client-side behaviour (an executor's) |
| A.4 | An executor that performs an external side effect (sending mail, charging a card, pushing a commit) MUST make that effect idempotent on its own side, keyed on … | untested: client-side behaviour (an executor's) |
| A.5 | - A renewal on an order whose `exec_state` is `cancelled` (or any terminal state) MUST be refused with `410 order_terminal`, and the body MUST carry the order … | C19, C32 |
| A.5 | - A claim on a cancelled order MUST likewise be refused with `410 order_terminal`. | C19 |
| A.5 | - A successful claim or renewal response MUST be the order with its current `exec_state`, so the executor never has to make a separate read. | C17, C33, C35 |
| A.5 | The renewal is the check; the executor MUST NOT rely on a cached `exec_state` older than its last renewal. | untested: client-side behaviour (an executor's) |

<!-- /coverage -->

- [ ] **Last-visit cursor.** The brief is defined by one global "since last visit" cursor. Per-producer cursors would let a person catch up on one producer without clearing the rest. Global is simpler; undecided.
- [ ] **Withdraw.** There is no delete. Superseding with a signal is the workaround; is a first-class withdraw worth an operation?
- [ ] **Delegation rules.** Standing rules ("always approve replies to Anna") live in the head, outside the protocol. Should a producer be able to ask whether a rule exists before submitting?
- [ ] **Retention.** How long a head keeps `log` cards, and whether retention is per producer.
- [ ] **Head-to-head trust.** Appendix B has a delegate's head polling the delegator's head as a producer. Who issues that token, and how does the delegator's head learn the delegate's endpoint?
- [x] **Content hash.** A `content_hash` on the wire would separate identity, content version and decision cleanly and make `409` diagnosis trivial. Answered: not needed, since §5's semantic equality already tells a retry (`200`, nothing changed) from a change (`200` replacing an open card, `409` on a decided one), and both answers carry the stored card (`rfc/OPEN.md` 6).

## Appendix A. Extension: Orders

The core protocol carries work *to* a person. This extension carries work *from* the person back to producers, using the same card primitive and the same three operations. A head or producer MAY implement the core without it. Everything in this appendix is normative only for implementations that claim the `orders` extension.

### A.1 The order card

An order is a card of `kind: order`, minted by the head under `head:order:<ulid>`. Its body is the person's instruction, immutable from the moment it is minted.

**Giving an order is the owner's action.** Like decide (§7.3), it is outside the producer protocol: the person gives an order through the head's own interface, with the owner's credential, and the head exposes that however it likes. No producer operation creates an order.

**Schema overrides.** A producer never submits a `kind: order` card; the head mints them, and rejects a submitted one with `400`. This extension changes three core rules, and only for `kind: order`: it adds `order` to the `kind` enum; `to_person` MUST be absent and `to_producer` MUST be present; and the sync operation (§7.2) returns, in addition to the caller's own namespace, every order whose `to_producer` names the caller's root, or is `*` and lists that root as eligible (below). That last rule is recipient authorisation — what a producer may *read* — alongside the core's namespace authorisation — what it may *write*. A named `to_producer` reaches that root whether or not the head counts it as an executor; only `*` depends on executor status. The head acts as the producer of order cards and owns the `head:` namespace root; no token is issued for it. For every other kind the core rules stand unchanged.

**The order card's other fields.** `producer` is `head`; `title` and `body` are the person's; `urgency` is optional, and `delivery` is set from it as for any card but without a ceiling, since the owner is the author. An order has no `thread`: the executor's cards set `thread` to the order id (A.3).

**Wildcard eligibility is fixed at creation, per root.** When the head mints an order with `to_producer: *`, it records the set of producer roots eligible at that moment, and only those roots receive it on sync, through any of their tokens. A root that becomes eligible later does not receive earlier wildcard orders. This keeps the sync cursor sound: a sequence a producer has advanced past can never later contain a card it was entitled to see. The set is head policy: the head keeps it where no producer can read it, and it is not discoverable through the protocol. A `*` order minted when no root is eligible reaches no one; a head SHOULD say so to the person when it is given.

**Addressing.** `to_producer` is one producer root, or `*` for any executor the head trusts.

**Order fields.** The extension adds head-owned fields to the order card, which a producer MUST NOT submit, and two producer-owned fields to the outcome card (A.3).

| Field | On | Owner | Required | Type | Meaning |
| --- | --- | --- | --- | --- | --- |
| `to_producer` | order | head | yes | string | Recipient producer root, or `*`. Replaces `to_person`. |
| `exec_state` | order | head | yes | enum | `open`, `claimed`, `done`, `failed`, `cancelled`. Independent of core `state`. |
| `claimed_by` | order | head | no | string | The producer root holding the current lease. Any token under that root may renew it and post its outcome. Cleared when the lease ends. |
| `claim_expires_at` | order | head | no | timestamp | When the lease lapses unless renewed. |
| `claim_seq` | order | head | no | integer | Starts at 1 on the first claim and increments by one on every later claim. A renewal keeps it. Returned in the claim response. |
| `orders.claim_seq` | outcome | producer | yes | integer | The `claim_seq` of the claim the outcome reports on. |
| `orders.result` | outcome | producer | yes | enum | `done` or `failed`: whether the order was carried out. |

The two lifecycles are orthogonal. `state` describes the order as a card; `exec_state` describes execution of the instruction. Execution reaching `done`, `failed` or `cancelled` never creates a core decision and never changes `state`; the outcome is a separate card. The one coupling runs the other way: a human decision of `dismissed` on an order (the only decision an order accepts; any other is `400 invalid_decision`) MUST atomically set `exec_state` to `cancelled` if it is `open` or `claimed`, releasing any lease, and moves `state` to `decided` as for any card. A `done` or `failed` order can be dismissed too; its `exec_state` stays as it was. That is how a person cancels an order — through the core decision operation, not a fourth operation — and a cancelled order MUST NOT be claimed again. `decision` is otherwise meaningful only for cards that require human resolution.

### A.2 Claims are leases, not decisions

An executor claims an order with `POST /cards/{id}/claim`, carrying `{ "lease_seconds": N }`, where N is a positive integer; anything else is refused with `400 invalid_lease`, and a head MAY cap N. This is the one producer-side write to a card it did not mint, and it is deliberately *not* a decision: a human decision is permanent, an execution claim is temporary. A claim on an order the caller's root cannot read (A.1), or on a card that is not an order, is `404 not_found`.

A lease belongs to a root. The head records `claimed_by`, `claim_expires_at` and sets the order's execution state to `claimed`, and answers `200` with the order. A claim while another root's lease holds is refused with `409 lease_held`, and that executor MUST stand down. A claim by the holding root before expiry renews the lease: it moves `claim_expires_at` and keeps `claim_seq`. Both refusals of this extension carry the error body of §7.4 with the order as it stands, `{ "error": "lease_held", "message": "…", "order": { … } }`.

The head owns the lease clock. A claim or renewal MUST evaluate expiry atomically with the claim itself, and a lease whose `claim_expires_at` is at or before the head's current time is expired. If the lease expires with no outcome, the order returns to `open` and any eligible root may claim it, which increments `claim_seq`. Expiry is lazy: the head applies it when it next reads or writes the order (a sync, a claim, an outcome), and the order takes a new `change_seq` then. A head SHOULD surface an expired lease to the person, since it usually means a worker died, in its own interface: it MUST NOT mint a card for it, because a head-minted card would take a `change_seq` and move every producer's cursor. Orders therefore have at-least-once delivery; exactly-once execution of any side effect is the executor's problem (A.4).

### A.3 Thread shape

An order is a thread with a known shape. The executor writes under its own namespace with `thread` set to the order id:

1. the order card, whose content is immutable and whose execution claim is leased;
2. zero or more progress cards, `kind: signal`, `urgency: log`;
3. one outcome card per claim, with `references` naming the order, `orders.claim_seq` and `orders.result`. The outcome is often itself a `kind: decision` card ("here is the draft, approve?"), with `orders.result: done`.

Progress and outcome are always new cards. An executor MUST NOT re-PUT the order. A card that carries `orders.claim_seq` or `orders.result` is an outcome: it MUST carry both, with `orders.claim_seq` a positive integer and `orders.result` `done` or `failed`, and MUST name an order in `references`; a head refuses anything else with `400 invalid_card`. The execution lifecycle:

| From | Event | To |
| --- | --- | --- |
| `open` | claim | `claimed` (`claim_seq` + 1) |
| `claimed` | renew before expiry | `claimed` (`claim_seq` unchanged) |
| `claimed` | outcome from the current lease, `orders.result: done` | `done` |
| `claimed` | outcome from the current lease, `orders.result: failed` | `failed` |
| `claimed` | lease expires, no outcome | `open` (the head SHOULD surface it to the person, A.2) |
| `open` or `claimed` | person cancels | `cancelled` (lease released) |
| `done`, `failed`, `cancelled` | anything | unchanged — terminal |

Only the current lease can move execution state. An outcome comes from it when, after expiry has been applied, the order is `claimed`, the outcome's producer root is `claimed_by`, and its `orders.claim_seq` is the order's `claim_seq`. Any other outcome — the lease lapsed, another root claimed since, or the order is already terminal — is still stored in the thread as information but MUST NOT change `exec_state`: a terminal order never becomes non-terminal. A head SHOULD surface such a late or duplicate result to the person in its own interface, and MUST NOT mint a card for it. When an outcome does move `exec_state`, the outcome card takes the lower `change_seq` and the order the higher. Cancellation prevents further execution where observed; it does not undo a side effect the executor has already begun, so an executor MUST check `exec_state` before each irreversible step.

### A.4 Executors

**Side effects.** The protocol delivers an order at least once. An executor that performs an external side effect (sending mail, charging a card, pushing a commit) MUST make that effect idempotent on its own side, keyed on the order id, so a crash between acting and reporting does not act twice on re-claim. It keeps what it needs for that — the task it created, the message it sent — itself, as §3.1 says of any producer state.

**To-do tools are executors.** A connector to a task manager (Todoist, Things, Reminders) treats an order addressed to it as a task to create, and posts the outcome card when the person completes the task there. The head's list of open orders is thereby a to-do list without the head implementing to-dos: an order to a person and an order to an agent look identical.

**Reference executor.** A conforming executor is a loop:

```
loop every N seconds:
  resp = sync(after=cursor)
  for ch in resp.changes:
    o = ch.card
    if o.kind != 'order' or o.exec_state != 'open': continue
    lease = claim(o, lease_seconds=600)          # returns the order with claim_seq, or 409 / 410
    if lease:
      k = ulid_of(o.id)                          # the ulid segment: valid as upstream-id
      s = lease.claim_seq
      run o in a sub-process or sub-agent, renewing the lease while it runs
      on progress: PUT me:order:<k>:progress-<s>-<n>   (signal, log, thread=o.id)
      on finish:   PUT me:order:<k>:outcome-<s>        (references o, orders.claim_seq=s, orders.result=done)
      on failure:  PUT me:order:<k>:outcome-<s>        (references o, orders.claim_seq=s, orders.result=failed)
  cursor = resp.next                             # only after the loop body succeeded
```

`ulid_of` is an implementation helper, not a protocol operation: k is the ULID segment of the order id. The executor's card ids use that ULID as `upstream-id`, never the order's full id, which contains colons and would not conform to the grammar in §5. The outcome and progress ids carry the claim's `claim_seq`, so a re-run after a lapsed lease writes new cards beside the first run's rather than replacing them.

### A.5 Handling cancellation

The head never calls an executor, so cancellation reaches it the same way everything else does: by the executor asking. The channel is lease renewal, which an executor is already obliged to perform, so no new mechanism is needed and the lease length becomes the cancellation latency.

**Head rules.**

- A renewal on an order whose `exec_state` is `cancelled` (or any terminal state) MUST be refused with `410 order_terminal`, and the body MUST carry the order with its current `exec_state`.
- A claim on a cancelled order MUST likewise be refused with `410 order_terminal`.
- A successful claim or renewal response MUST be the order with its current `exec_state`, so the executor never has to make a separate read.

**Executor rules.**

- Choose a lease short enough that the person's cancel takes effect in acceptable time, and renew at no more than half the lease length. A lease of 60 seconds renewed every 30 means a cancel is honoured within 30 seconds.
- Treat `410` on renewal as a stop signal: cease work, roll back what can be rolled back, and post an outcome card (`orders.result: failed`) that says what was and was not done. The head stores it as information and ignores it for `exec_state`, because the order is terminal (A.3); the person reads it as the executor's final report.
- Before any irreversible step (sending, charging, pushing, deleting), renew first and proceed only on success. The renewal is the check; the executor MUST NOT rely on a cached `exec_state` older than its last renewal.
- Never retry a `410`.

**What cancellation cannot do.** It cannot interrupt a step already in flight between one renewal and the next, and it cannot undo a side effect already performed. Those are bounded by the renewal interval and the executor's rollback, respectively, and the person sees both in the final outcome card. An executor that wants tighter bounds shortens its lease; the protocol does not offer push and does not need to.

The loop is the orchestrator: it owns the claim and the reporting, so a worker that goes wrong still produces a readable thread. A coding agent run in a loop on a personal subscription is a complete executor with no further infrastructure.

## Appendix B. Extension: Delegation (not yet specified)

The core records `delegated` with `delegated_to` and stops there. Carrying the card to the delegate is federation: the delegator's head must mint something the delegate's head can read, and the delegate's head must hold a credential on the delegator's head that authorises reading cards addressed to its person — a recipient authorisation keyed on a person, which the core's namespace tokens and Appendix A's producer-keyed orders do not provide. The intended shape is an order addressed to a person, claimed and executed by the delegate's head, with the outcome returning to the original thread. This appendix is a placeholder for that design and is not normative. Implementations claiming only the core and `orders` extensions treat `delegated` as a terminal decision and nothing more.
