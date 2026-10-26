# @pbcp/mcp

An MCP server over stdio that wraps `@pbcp/client`: two tools, nothing else. It is an adapter over the HTTP protocol (RFC §7), not a second definition of it.

```sh
export PBCP_HEAD_URL=https://head.example PBCP_TOKEN=<producer token>
npx -y @pbcp/mcp                     # speaks MCP on stdin/stdout
# MCP client config: { "command": "npx", "args": ["-y", "@pbcp/mcp"], "env": { "PBCP_HEAD_URL": "…", "PBCP_TOKEN": "…" } }
```

| Tool | Input | Result |
| --- | --- | --- |
| `submit_card` | `card`: a JSON object, JSON text, or front-matter text (§3) | `{ status, card }` — `201`, `200`, or `409` with the decided card (§7.1) |
| `poll_changes` | `after`: the cursor, `0` the first time | `{ changes: [{ seq, card }], next }` — one page (§7.2); call again with `next` until it stops moving |

The card is parsed and checked locally before it is sent, so a malformed card is refused without a request. A refusal is a tool error whose text is `{ status, error, message }` with the RFC code (§7.4), for example `{ "status": 400, "error": "head_owned_field", … }`; a failure without a protocol body has `error: "http"` and the response `body`. `--head URL` and `--token TOKEN` override the environment.

There is no `decide_card`: deciding is the owner's operation and refuses a producer token (§7.3), and this server holds a producer token. `claim_order` (Appendix A) comes with the orders extension. The server keeps no cursor; the caller stores `next`. To start from now rather than from the beginning, read `seq` from the head's `GET /` (§7.5) and pass it as the first `after`.
