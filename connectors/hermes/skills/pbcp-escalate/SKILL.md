---
name: pbcp-escalate
description: Before sending, spending, deleting, or committing to anyone outside the user, stop and ask the user through their PBCP head with a decision card; continue only on their answer. Also covers reporting finished work as a log or brief card.
---

# Escalate to the person (PBCP)

You have two tools from the `pbcp` MCP server: `submit_card` and `poll_changes`. The head shows cards to one person, the owner, and records their decisions. You never decide a card yourself.

## When to stop and ask

Before any action that leaves the user's own space — sending a message or email, paying or spending, deleting or overwriting something that is not a scratch file, accepting or declining on the user's behalf, or promising anything to anyone — do not act. Submit a decision card instead, then stop working on that thread until the person answers.

Anything that only informs (a summary, a finished report, a heads-up) needs no answer: send it as `kind: signal` or `kind: artifact` with `urgency: log` (read later) or `brief` (today's brief). Use `immediate` only for something the person must see within minutes.

## Writing a decision card

Call `submit_card` with a card object like this:

```json
{
  "protocol": "pbcp/1",
  "id": "hermes:<namespace>:<upstream-key>[:<intent>]",
  "producer": "hermes",
  "kind": "decision",
  "to_person": "<the head's owner>",
  "title": "Reply to Anna re invoice timing",
  "summary": "Anna asks to pay the September invoice on the 20th instead of the 15th. I propose agreeing for September only.",
  "body": "Anna asks whether the September invoice can be paid on the 20th.\n\n## Proposed reply\n\n> Hi Anna, the 20th is fine.",
  "actions": ["approve", "reject", "edit"],
  "thread": "<a key shared by cards about the same matter>",
  "urgency": "brief",
  "labels": ["nordic-supply"],
  "source": { "url": "https://mail.google.com/mail/u/0/#search/rfc822msgid:CA%2Babc%3Ddef%40mail.example.com", "label": "Open in Gmail" },
  "emitted_at": "<now, UTC, e.g. 2026-10-26T13:02:11Z>"
}
```

- **id** is deterministic: the same upstream event always gives the same id (a mail's thread id, an issue number), never a random value. Segments use letters, digits and `-`; the upstream key may also use `_` and `.`, and anything else is percent-encoded. Add an intent suffix when one event needs two cards (`:reply`, `:calendar`).
- **summary** is one or two sentences of plain text, on one line, that say what is going on and what you want from the person. It is what they read in the brief before deciding whether to open the card, so write it for someone who reads nothing else. No markdown, no line breaks, under 280 characters. On a decision card, state your proposal in it, not only the topic: "Anna asks to pay on the 20th. I propose agreeing for September only", not "Anna asks about invoice timing". The person should be able to decide from the summary alone. Put a summary on every card you send, signals and artifacts included.
- **Times** in the title, summary and body are written as a person reads them on a phone, in their local time: "today 09:12", "Mon 26 Oct 16:00". Never an ISO timestamp such as `2026-10-26T15:00:00Z`; that form belongs only in `emitted_at`.
- **body** is markdown: the evidence first, then the proposal under a heading that begins with `Proposal` or `Proposed`, quoted exactly as you would send it. Keep it short.
- **source** opens the thing the card is about, so the person can check it in one tap: the mail thread, the calendar event, the document, the issue. The `label` names where it opens ("Open in Gmail", "Open in Calendar", "Open in Docs"). For a Gmail message, use `https://mail.google.com/mail/u/0/#search/rfc822msgid:<Message-ID>`, with the Message-ID header's value without its angle brackets, percent-encoded (`<CA+abc=def@mail.example.com>` becomes `CA%2Babc%3Ddef%40mail.example.com`). Set `source` whenever you can form a URL; leave it out rather than guess one.
- **labels** name the project or client the card concerns, so the person can filter by them: `["nordic-supply"]`, `["billing-revamp"]`. Each is 1–32 lowercase letters, digits or `-`, at most 8 per card; use the same label for the same project or client every time. Leave them out rather than invent one.
- **about** is the day the card concerns, as `YYYY-MM-DD`, when that is not the day you send it: tomorrow's agenda, a meeting moved to Friday, an invoice due on the 20th. It is the day as the person means it, with no time and no time zone. Leave it out for a card about now.
- **actions** are what the person can choose. Include `edit` when the proposal is text they may want to change.
- Do not add `state`, `decision` or other fields the head sets; they are refused.

The result is `{ status, card }`. `201` is new, `200` means already current (read `card.state`: the person may already have answered), `409` means the person already decided an earlier version — the card in the result carries that decision. **Never re-submit after a 409.** If you still need an answer, submit a new card with a new id and `"supersedes": "<old id>"`.

## Reading the answer

On a later turn, call `poll_changes` with the cursor you stored (start at `0`); store the returned `next` and call again while it keeps moving. For each card you are waiting on, look at `card.state` and `card.decision`:

| `decision` | What you do |
| --- | --- |
| `approve` (or the action you proposed) | Act exactly as proposed |
| `edited` | Act on `card.edited_proposal` instead of your text |
| `reject`, `dismissed` | Do not act; drop the thread, mention it in your next summary |
| `delegated` | Do not act; someone else (`delegated_to`) handles it |
| anything else | It is one of your `actions`; do what it names |

`card.comment` may carry the person's note; follow it. Act on each decision once: check whether you already did before acting again, since the same change can be returned twice.

## Errors

A tool error carries `{ status, error, message }`. `400` means the card is malformed — fix the named problem and submit again. `403` means the id is outside your root or `to_person` is wrong. `429` means wait before the next call. Never fall back to acting without an answer.
