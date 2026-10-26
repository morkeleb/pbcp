# connectors/hermes

A Hermes Agent plugin in the Agent Plugins 1.0 layout: `@pbcp/mcp` as the MCP server, plus two skills. There is no code here.

```sh
export PBCP_HEAD_URL=https://head.example PBCP_TOKEN=<token bound to the root hermes>
hermes plugins install ./connectors/hermes
hermes plugins enable pbcp
```

- `mcp.json` starts `npx -y @pbcp/mcp` over stdio and passes `PBCP_HEAD_URL` and `PBCP_TOKEN` through from the environment. The server exposes `submit_card`, `poll_changes` and `claim_order` (see `packages/mcp`).
- `skills/pbcp-escalate` — before sending, spending, deleting or committing to anyone outside the user, submit a `kind: decision` card and stop; continue on a later turn only on the person's answer. Informational output goes out as `signal` or `artifact` at `log` or `brief`.
- `skills/pbcp-executor` — the order loop of RFC Appendix A, run on a Hermes cron every minute: poll for orders to `hermes` or `*`, `claim_order` with a 60-second lease, renew at least every 30 seconds and before every irreversible step, stop on `410`, and close each order with one outcome card carrying `orders.claim_seq`. Orders to `*` reach Hermes only if the head lists it as an executor.

The token's root is `hermes`, so every id Hermes submits is `hermes:<namespace>:…`. The skills do not keep the `poll_changes` cursor for Hermes; store `next` wherever Hermes keeps state between turns.
