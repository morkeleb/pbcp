---
name: pbcp-executor
description: Run on a schedule to carry out orders the person gives through their PBCP head. Not yet available - order claiming is not exposed by the pbcp MCP server in this version.
---

# Execute orders from the person (PBCP)

**Not yet available.** Orders are the PBCP orders extension (RFC Appendix A). Carrying one out safely needs `claim_order`, which takes a lease on the order so that two executors never run it twice. The `pbcp` MCP server in this version exposes only `submit_card` and `poll_changes`, so there is no way to claim an order. Until `claim_order` exists, do not act on an order card: a card from `poll_changes` with `kind: order` is ignored.

When it is available, the loop will be, run every minute:

1. `poll_changes` from the stored cursor; keep orders addressed to `hermes` or to `*` whose `exec_state` is `open`.
2. `claim_order` with a 60-second lease. A refusal means another executor has it or it was cancelled; skip it.
3. Do the work. Before each irreversible step, call `claim_order` again to renew; if the order was cancelled, stop and report what was and was not done.
4. Finish with `submit_card`: an outcome card that `references` the order, with `orders.claim_seq` from the claim. A failure is an outcome card too, never silence.

Anything in the work that leaves the user's own space still goes through `pbcp-escalate` first.
