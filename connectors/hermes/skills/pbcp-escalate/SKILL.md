---
name: pbcp-escalate
description: Before sending, spending, deleting, or committing to anyone outside the user, stop and ask the user through their PBCP head with a decision card; continue only on their answer. Also covers reporting finished work as a log or brief card.
---

# Escalate to the person (PBCP)

You have two tools from the `pbcp` MCP server: `submit_card` and `poll_changes`. The head shows cards to one person, the owner, and records their decisions. You never decide a card yourself.

## When to stop and ask

Before any action that leaves the user's own space — sending a message or email, paying or spending, deleting or overwriting something that is not a scratch file, accepting or declining on the user's behalf, or promising anything to anyone — do not act. Submit a decision card instead, then stop working on that thread until the person answers.

`kind` is what the card asks of the person: `decision` to choose (it carries `actions` and stays open until they decide), `signal` to know that something happened, `artifact` to read something made for them (a report, a summary, a record); only a decision needs an answer. `urgency` is when they should see it: `brief` (the default) waits for their next brief, `immediate` interrupts and is only for a decision that cannot wait or a signal about the next few hours, and `log` is only recorded, for routine records such as a finished task.

## Writing a decision card

Call `submit_card` with a card object like this:

```json
{
  "protocol": "pbcp/1",
  "id": "hermes:<namespace>:<upstream-key>[:<intent>]",
  "producer": "hermes",
  "kind": "decision",
  "title": "Reply to Anna re invoice timing",
  "summary": "Anna asks to pay the September invoice on the 20th instead of the 15th. I propose agreeing for September only.",
  "body": "Anna asks whether the September invoice can be paid on the 20th.\n\n## Proposed reply\n\n> Hi Anna, the 20th is fine.",
  "actions": ["approve", "reject", "edit"],
  "thread": "<a key shared by cards about the same matter, e.g. the mail thread id>",
  "references": ["<the mail reader's card for the message, when there is one>"],
  "urgency": "brief",
  "labels": ["nordic-supply"],
  "source": { "url": "https://mail.google.com/mail/u/0/#search/rfc822msgid:CA%2Babc%3Ddef%40mail.example.com", "label": "Open in Gmail" },
  "emitted_at": "<now, UTC, e.g. 2026-10-26T13:02:11Z>"
}
```

- **id** is deterministic: the same upstream event always gives the same id (a mail's thread id, an issue number), never a random value. Segments use letters, digits and `-`; the upstream key may also use `_` and `.`, and anything else is percent-encoded. Add an intent suffix when one event needs two cards (`:reply`, `:calendar`).
- **summary** is one or two sentences of plain text, on one line, that say what is going on and what you want from the person. It is what they read in the brief before deciding whether to open the card, so write it for someone who reads nothing else. No markdown, no line breaks, under 280 characters. On a decision card, state your proposal in it, not only the topic: "Anna asks to pay on the 20th. I propose agreeing for September only", not "Anna asks about invoice timing". The person should be able to decide from the summary alone. Put a summary on every card you send, signals and artifacts included.
- **Times** that appear in text (in the body, mostly; the subject's own time goes in `at`, below) are written as a person reads them on a phone, in their local time: "today 09:12", "Mon 26 Oct 16:00". Never an ISO timestamp such as `2026-10-26T15:00:00Z`; that form belongs only in `emitted_at`, `at` and `until`.
- **body** is markdown: the evidence first, then the proposal under a heading that begins with `Proposal` or `Proposed`, quoted exactly as you would send it. Keep it short.
- **source** opens the thing the card is about, so the person can check it in one tap: the mail thread, the calendar event, the document, the issue. The `label` names where it opens ("Open in Gmail", "Open in Calendar", "Open in Docs"). For a Gmail message, use `https://mail.google.com/mail/u/0/#search/rfc822msgid:<Message-ID>`, with the Message-ID header's value without its angle brackets, percent-encoded (`<CA+abc=def@mail.example.com>` becomes `CA%2Babc%3Ddef%40mail.example.com`). Set `source` whenever you can form a URL; leave it out rather than guess one.
- **references** name the cards your card is about. When it concerns something another producer already sent (the mail reader's card for a message, the calendar's card for an event), put that card's id in `references`. Never write a card under another producer's id or root: every id you submit starts with `hermes:`.
- **labels** name the project or client the card concerns, so the person can filter by them: `["nordic-supply"]`, `["billing-revamp"]`. Each is 1–32 lowercase letters, digits or `-`, at most 8 per card; use the same label for the same project or client every time. Leave them out rather than invent one.
- **about** is the day the card concerns, as `YYYY-MM-DD`, when that is not the day you send it: tomorrow's agenda, a meeting moved to Friday, an invoice due on the 20th. It is the day as the person means it, with no time and no time zone. Leave it out for a card about now.
- **`at` is when the subject happens.** A card has three times and they answer three different questions. `emitted_at` is when the producer wrote the card; every card has one. `about` is the day the card belongs to in the person's life; set it when that is not the day the card was sent. `at` is the moment the thing the card is about happens or starts, and `until` when it ends; set them whenever the subject has a time of day — a meeting, a deadline, a due time, a departure, an expiry — so that a head can put the card on the day's timeline beside cards from other producers. Write the time nowhere else: not in the title, not in the summary, where no head can read it. A subject with a day but no time (an all-day event, a date-only deadline) takes `about` alone. Both are UTC timestamps ending in `Z` (`"at": "2026-11-03T09:15:00Z"`); `until` needs `at` and is not before it.
- **actions** are what the person can choose. Include `edit` when the proposal is text they may want to change.
- Do not add `state`, `decision` or other fields the head sets; they are refused.

The result is `{ status, id, state, change_seq, card }`: the head's answer and the card as it stored it. That answer is the confirmation that the card landed; there is nothing else to check. `201` is new, `200` means already current (read `card.state`: the person may already have answered), `409` means the person already decided an earlier version — the card in the result carries that decision. **Never re-submit after a 409.** If you still need an answer, submit a new card with a new id and `"supersedes": "<old id>"`.

## Reading the answer

On a later turn, call `poll_changes` with the cursor you stored (start at `0`); store the returned `next` and call again while it keeps moving. For each card you are waiting on, look at `card.state` and `card.decision`:

| `decision` | What you do |
| --- | --- |
| `approve` (or the action you proposed) | Act exactly as proposed |
| `edited` | Act on `card.edited_proposal` instead of your text |
| `reject`, `dismissed` | Do not act; drop the thread, mention it in your next summary |
| `delegated` | Do not act; someone else (`delegated_to`) handles it |
| anything else | It is one of your `actions`; do what it names |

After acting, record it: submit a `kind: artifact` card at `urgency: log`, with the id `<your card id>:sent` (or `:done`), the title `Sent: <subject>` (or what you did), the same `thread`, and `references: ["<your decision card id>"]`. Do nothing else to close the loop. The decision was the authorisation, so there is no order to wait for, and the mail itself stays the mail reader's to archive.

`card.comment` may carry the person's note; follow it. Act on each decision once: check whether you already did before acting again, since the same change can be returned twice.

## Errors

A tool error carries `{ status, error, message }`. `400` means the card is malformed — fix the named problem and submit again. `403` means the id is outside your root (every id starts with `hermes:`). `429` means wait before the next call. Never fall back to acting without an answer.
