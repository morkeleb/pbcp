# pbcp

The Personal Brief Card Protocol: the RFC (`rfc/`), the packages that implement it, the conformance suite, and example connectors.

| Path | Package | What |
| --- | --- | --- |
| `packages/core` | `@pbcp/core` | Card schema, id grammar, restricted YAML, lifecycle transitions. Pure functions, no I/O. Conformance fixtures and runner under `conformance/`. |
| `packages/client` | `@pbcp/client` | `HeadClient` and `runProducer`, the durable-cursor loop. |
| `packages/cli` | `@pbcp/cli` | `pbcp describe`, `submit`, `sync`, `decide` from a shell. |
| `packages/mcp` | `@pbcp/mcp` | MCP server over stdio: `submit_card`, `poll_changes`. |
| `connectors/imap` | — | Example producer: unseen mail to cards. |
| `connectors/obsidian-daily` | — | Example producer: daily notes to log artifacts. |
| `connectors/caldav` | — | Example producer: the day's agenda, and signals for meetings moved to start soon. |
| `connectors/hermes` | — | Hermes Agent plugin: `@pbcp/mcp` plus two skills. |
| `connectors/n8n` | `n8n-nodes-pbcp` | n8n community nodes: a polling trigger on sync, and a submit action. |
| `connectors/goalpath` | — | Example producer: milestone risk, approvals, red builds and a nightly digest from GoalPath. |

```sh
corepack pnpm install
corepack pnpm test        # unit tests + conformance (in-process)
corepack pnpm typecheck
corepack pnpm build
```

Node 22+. MIT licence.
