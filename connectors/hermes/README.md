# connectors/hermes

A Hermes Agent plugin in the Agent Plugins 1.0 layout: `@pbcp/mcp` as the MCP server, plus two skills. There is no code here.

```sh
export PBCP_HEAD_URL=https://head.example PBCP_TOKEN=<token bound to the root hermes>
hermes plugins install ./connectors/hermes
hermes plugins enable pbcp
```

- `mcp.json` starts `npx -y @pbcp/mcp` over stdio and passes `PBCP_HEAD_URL` and `PBCP_TOKEN` through from the environment. The server exposes `submit_card` and `poll_changes` (see `packages/mcp`).
- `skills/pbcp-escalate` — before sending, spending, deleting or committing to anyone outside the user, submit a `kind: decision` card and stop; continue on a later turn only on the person's answer. Informational output goes out as `signal` or `artifact` at `log` or `brief`.
- `skills/pbcp-executor` — the order loop of RFC Appendix A. Not yet available: it needs `claim_order`, which `@pbcp/mcp` does not expose in this version, so the skill tells Hermes to ignore order cards.

The token's root is `hermes`, so every id Hermes submits is `hermes:<namespace>:…`. The skills do not keep the `poll_changes` cursor for Hermes; store `next` wherever Hermes keeps state between turns.
