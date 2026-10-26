---
name: pbcp-executor
description: Run on a schedule (every minute) to carry out orders the person gives through their PBCP head - poll for orders addressed to you, claim one with a lease, do the work while renewing the lease, and close it with an outcome card.
---

# Execute orders from the person (PBCP)

An order is a card of `kind: order` the person gave through their head (RFC Appendix A). Its `body` is the person's instruction. You have three tools from the `pbcp` MCP server: `poll_changes`, `claim_order` and `submit_card`. Your producer root is `hermes`.

## Each run

1. **Find work.** Call `poll_changes` from your stored cursor and store the returned `next` once you have handled the page. Keep cards with `kind: "order"`, `exec_state: "open"`, and `to_producer` of `hermes` or `*`. Ignore everything else, including orders that are `claimed`, `done`, `failed` or `cancelled`.
2. **Claim.** Call `claim_order` with the order id and `lease_seconds: 60`. Keep the `claim_seq` it returns.
   - `409 lease_held`: another executor has it. Stand down; do not touch it.
   - `410 order_terminal`: it ended or was cancelled. Stand down; never retry.
3. **Work, renewing the lease.** Call `claim_order` again on the same id at least every 30 seconds while you work, and always immediately before any irreversible step (sending, paying, deleting, committing to anyone). Proceed only if that renewal succeeds, and keep the new `claim_seq` each time. A `410` on renewal means the person cancelled: stop at once, undo what you can, and go to step 5 with a report of what was and was not done. Anything in the work that leaves the user's own space still goes through `pbcp-escalate` first.
4. **Report progress** on long work with `submit_card`: `id` `hermes:order:<ulid>:progress-<n>` (`<ulid>` is the last segment of the order id, `<n>` counts from 1), `kind: "signal"`, `urgency: "log"`, `thread` and `references` set to the order id.
5. **Close the thread** with exactly one outcome card via `submit_card`:

```json
{
  "protocol": "pbcp/1",
  "id": "hermes:order:<ulid>:outcome",
  "producer": "hermes",
  "kind": "signal",
  "to_person": "<the head's owner>",
  "title": "Booked the dentist for Tuesday 09:00",
  "body": "What you did, with links. If you stopped early: what was done and what was not.",
  "thread": "<order id>",
  "references": ["<order id>"],
  "orders.claim_seq": 3,
  "emitted_at": "<now, UTC>"
}
```

- `orders.claim_seq` is the `claim_seq` from your latest successful claim or renewal.
- If you could not do it, or stopped because of a `410`, add `"orders.result": "failed"` and say why.
- If the result needs the person's approval before it takes effect (a draft to send), make the outcome `kind: "decision"` with `actions`, and act on it later as `pbcp-escalate` describes.

Failure is an outcome card, never silence. An order may reach you twice (a lease can lapse and be claimed again), so make any side effect idempotent on the order id: check whether you already did it before doing it again.
