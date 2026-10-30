---
name: pbcp-executor
description: Run on a schedule (every minute) to carry out orders the person gives through their PBCP head - poll for orders addressed to you, claim one with a lease, do the work while renewing the lease and reporting progress, and close it with complete_order.
---

# Execute orders from the person (PBCP)

An order is a card of `kind: order` the person gave through their head (RFC Appendix A). Its `body` is the person's instruction. You have five tools from the `pbcp` MCP server: `poll_changes`, `claim_order`, `report_progress`, `complete_order` and `submit_card`. Your producer root is `hermes`. Never write an order card's id yourself: `report_progress` and `complete_order` mint it from the claim the server holds.

## Each run

1. **Find work.** Call `poll_changes` from your stored cursor and store the returned `next` once you have handled the page. Keep cards with `kind: "order"`, `exec_state: "open"`, and `to_producer` of `hermes` or `*`. Ignore everything else, including orders that are `claimed`, `done`, `failed` or `cancelled`.
2. **Claim.** Call `claim_order` with the order id and `lease_seconds: 60`.
   - `409 lease_held`: another executor has it. Stand down; do not touch it.
   - `410 order_terminal`: it ended or was cancelled. Stand down; never retry.
3. **Work, renewing the lease.** Call `claim_order` again on the same id at least every 30 seconds while you work, and always immediately before any irreversible step (sending, paying, deleting, committing to anyone). Proceed only if that renewal succeeds and the order it returns is still `exec_state: "claimed"` (A.5): the renewal is the check, never an older answer. A `410` on renewal means the person cancelled: stop at once, undo what you can, and go to step 5 with a report of what was and was not done. Anything in the work that leaves the user's own space still goes through `pbcp-escalate` first.
4. **Report progress** with `report_progress`, passing the order id and a note of one or two sentences. The person reads these notes in their brief, in the order's thread; they are how the person sees that the work is moving and what it has touched. Report:
   - on claiming: `"Started: <what you will do>."`;
   - after each step that changes something outside the head: `"Sent the reply to Lars."`, `"Booked Tue 3 Nov 09:00 with Dr Holm."`;
   - when you are waiting on something external: `"Waiting for the clinic to confirm; checking again at 14:00."`;
   - before any irreversible step, after the renewal in step 3 succeeded: `"About to pay invoice 4411 (2 400 kr)."`.
5. **Close the order** with exactly one `complete_order` for your claim: the order id, `result`, `title` and `body`, and the optional fields below. The server sets the id, `thread`, `references`, `orders.claim_seq` and `to_person`.

```json
{
  "order_id": "<order id>",
  "result": "done",
  "title": "Booked the dentist for Tue 3 Nov 09:00",
  "summary": "Booked the dentist for Tuesday at 09:00 with Dr Holm; the confirmation is in your inbox.",
  "body": "What you did, with links. If you stopped early: what was done and what was not.",
  "source": { "url": "<link to what you made or changed, e.g. the calendar event>", "label": "Open in Calendar" },
  "at": "2026-11-03T08:00:00Z",
  "until": "2026-11-03T08:15:00Z"
}
```

- `summary` is one sentence of plain text on one line saying what you did, or why you could not; it is what the person reads in the brief. If the outcome is a decision card (below), the summary states what you propose, so the person can decide from it alone.
- `source` opens the thing the outcome is about: the event you booked, the mail you sent or drafted, the document you wrote. The `label` names where it opens ("Open in Calendar", "Open in Gmail", "Open in Docs"). For a Gmail message, use `https://mail.google.com/mail/u/0/#search/rfc822msgid:<Message-ID>`, the Message-ID without its angle brackets, percent-encoded. Leave it out when there is no URL to give; never guess one.
- Never write a card under another producer's id or root. A card about another producer's card (the mail you answered) goes through `submit_card` with its id in `references`; your ids start with `hermes:`.
- `labels`: the project or client the order concerns, as on any card (`["billing-revamp"]`; lowercase letters, digits and `-`). `about`: the day the outcome concerns, `YYYY-MM-DD`, when it is a specific day other than today (the appointment you booked for Tuesday).
- **`at` is when the subject happens.** A card has three times and they answer three different questions. `emitted_at` is when the producer wrote the card; every card has one. `about` is the day the card belongs to in the person's life; set it when that is not the day the card was sent. `at` is the moment the thing the card is about happens or starts, and `until` when it ends; set them whenever the subject has a time of day — a meeting, a deadline, a due time, a departure, an expiry — so that a head can put the card on the day's timeline beside cards from other producers. Do not write the time only there: a time in the title or summary is for the person, who reads the brief's line; `at` is for the head, which reads nothing else. A subject with a day but no time (an all-day event, a date-only deadline) takes `about` alone. Both are UTC timestamps ending in `Z` (`"at": "2026-11-03T09:15:00Z"`); `until` needs `at` and is not before it. An outcome about an appointment you booked carries its `at` and `until`.
- Times in the title, summary and body are local and readable ("today 09:12", "Mon 26 Oct 16:00"), for the person; never ISO timestamps there, since that form belongs only in `emitted_at`, `at` and `until`. A time you write in text goes on the card as `at` (and `until`) too, above: the head reads only those.
- `result` is `"done"`, or `"failed"` if you could not do it or stopped because of a `410` (say why in the body).
- If the result needs the person's approval before it takes effect (a draft to send), pass `kind: "decision"` with `actions` to `complete_order`, and act on it later as `pbcp-escalate` describes.
- `kind` is what the outcome asks of the person: `artifact` (the default) to read something you made (a report, a record of what you did), `signal` to know that something happened (a booking made, a failure), `decision` to choose. `urgency` is when they should see it: `brief` (the default) waits for their next brief, `immediate` interrupts and is only for what cannot wait or concerns the next few hours, and `log` is only recorded, for a routine record such as a completed task.

Failure is an outcome card, never silence. An order may reach you twice (a lease can lapse and be claimed again, with a new `claim_seq`), so make any side effect idempotent on the order id: check whether you already did it before doing it again.
