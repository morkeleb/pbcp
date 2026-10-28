# connectors/hermes

A Hermes Agent plugin in the Agent Plugins 1.0 layout: `@pbcp/mcp` as the MCP server, plus two skills. The only code is `src/connect.ts`, the setup text below.

- `mcp.json` starts `npx -y @pbcp/mcp` over stdio and passes `PBCP_HEAD_URL` and `PBCP_TOKEN` through from the environment. The server exposes `submit_card`, `poll_changes` and `claim_order` (see `packages/mcp`).
- `skills/pbcp-escalate` — before sending, spending, deleting or committing to anyone outside the user, submit a `kind: decision` card and stop; continue on a later turn only on the person's answer. Informational output goes out as `signal` or `artifact` at `log` or `brief`.
- `skills/pbcp-executor` — the order loop of RFC Appendix A, run on a Hermes cron every minute: poll for orders to `hermes` or `*`, `claim_order` with a 60-second lease, renew at least every 30 seconds and before every irreversible step, stop on `410`, and close each order with one outcome card carrying `orders.claim_seq`. Orders to `*` reach Hermes only if the head lists it as an executor.

The token's root is `hermes`, so every id Hermes submits is `hermes:<namespace>:…`. The skills do not keep the `poll_changes` cursor for Hermes; store `next` wherever Hermes keeps state between turns.

## Setup

<!-- setup: generated from src/connect.ts by scripts/readme-setup.ts; edit the template there, not this section -->

The token is bound to the root `hermes` (RFC §12): the skills submit every card under `hermes:`. Cards are addressed to the owner `<owner>`, which the skills read from the head.

```sh
export PBCP_HEAD_URL='<head url>' PBCP_TOKEN='<token>'
hermes plugins install ./connectors/hermes
hermes plugins enable pbcp
```

`mcp.json` passes the two variables to the server from the environment. To configure the server by hand instead:

```json
{
  "mcpServers": {
    "pbcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@pbcp/mcp"
      ],
      "env": {
        "PBCP_HEAD_URL": "<head url>",
        "PBCP_TOKEN": "<token>"
      }
    }
  }
}
```

The skills are `skills/pbcp-escalate/SKILL.md` (ask before acting outside the user) and `skills/pbcp-executor/SKILL.md` (carry out orders, Appendix A). An executor needs a token the head lets claim orders.

<!-- /setup -->
