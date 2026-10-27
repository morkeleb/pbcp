---
name: pbcp-executor
description: Run on a schedule (every minute) to carry out orders the person gives through their PBCP head - poll for orders addressed to you, claim one with a lease, do the work while renewing the lease, and close it with an outcome card.
---

# Execute orders from the person (PBCP)

An order is a card of `kind: order` the person gave through their head (RFC Appendix A). Its `body` is the person's instruction. You have three tools from the `pbcp` MCP server: `poll_changes`, `claim_order` and `submit_card`. Your producer root is `hermes`.

## Each run

1. **Find work.** Call `poll_changes` from your stored cursor and store the returned `next` once you have handled the page. Keep cards with `kind: "order"`, `exec_state: "open"`, and `to_producer` of `hermes` or `*`. Ignore everything else, including orders that are `claimed`, `done`, `failed` or `cancelled`.
2. **Claim.** Call `claim_order` with the order id and `lease_seconds: 60`. Keep the `claim_seq` it returns; renewals keep it.
   - `409 lease_held`: another executor has it. Stand down; do not touch it.
   - `410 order_terminal`: it ended or was cancelled. Stand down; never retry.
3. **Work, renewing the lease.** Call `claim_order` again on the same id at least every 30 seconds while you work, and always immediately before any irreversible step (sending, paying, deleting, committing to anyone). Proceed only if that renewal succeeds. A `410` on renewal means the person cancelled: stop at once, undo what you can, and go to step 5 with a report of what was and was not done. Anything in the work that leaves the user's own space still goes through `pbcp-escalate` first.
4. **Report progress** on long work with `submit_card`: `id` `hermes:order:<ulid>:progress-<claim_seq>-<n>` (`<ulid>` is the last segment of the order id, `<n>` counts from 1), `kind: "signal"`, `urgency: "log"`, `thread` and `references` set to the order id.
5. **Close the thread** with exactly one outcome card for your claim via `submit_card`:

```json
{
  "protocol": "pbcp/1",
  "id": "hermes:order:<ulid>:outcome-<claim_seq>",
  "producer": "hermes",
  "kind": "signal",
  "to_person": "<the head's owner>",
  "title": "Booked the dentist for Tuesday 09:00",
  "summary": "Booked the dentist for Tuesday at 09:00 with Dr Holm; the confirmation is in your inbox.",
  "body": "What you did, with links. If you stopped early: what was done and what was not.",
  "thread": "<order id>",
  "references": ["<order id>"],
  "source": { "url": "<link to what you made or changed, e.g. the calendar event>", "label": "Open in Calendar" },
  "orders.claim_seq": 1,
  "orders.result": "done",
  "emitted_at": "<now, UTC>"
}
```

- `summary` is one sentence of plain text on one line saying what you did, or why you could not; it is what the person reads in the brief. If the outcome is a decision card (below), the summary states what you propose, so the person can decide from it alone.
- `source` opens the thing the outcome is about: the event you booked, the mail you sent or drafted, the document you wrote. The `label` names where it opens ("Open in Calendar", "Open in Gmail", "Open in Docs"). For a Gmail message, use `https://mail.google.com/mail/u/0/#search/rfc822msgid:<Message-ID>`, the Message-ID without its angle brackets, percent-encoded. Leave it out when there is no URL to give; never guess one.
- `labels`: the project or client the order concerns, as on any card (`["billing-revamp"]`; lowercase letters, digits and `-`). `about`: the day the outcome concerns, `YYYY-MM-DD`, when it is a specific day other than today (the appointment you booked for Tuesday).
- Times in the title, summary and body are local and readable ("today 09:12", "Mon 26 Oct 16:00"), never ISO timestamps.
- `orders.claim_seq` is the `claim_seq` your claim returned. `orders.result` is required: `"done"`, or `"failed"` if you could not do it or stopped because of a `410` (say why in the body).
- If the result needs the person's approval before it takes effect (a draft to send), make the outcome `kind: "decision"` with `actions`, and act on it later as `pbcp-escalate` describes.

Failure is an outcome card, never silence. An order may reach you twice (a lease can lapse and be claimed again, with a new `claim_seq` and so a new outcome id), so make any side effect idempotent on the order id: check whether you already did it before doing it again.
