# pbcp

The Personal Brief Card Protocol: the RFC (`rfc/`), the packages that implement it, the conformance suite, and example connectors.

| Path | Package | What |
| --- | --- | --- |
| `packages/core` | `@pbcp/core` | Card schema, id grammar, restricted YAML, lifecycle transitions. Pure functions, no I/O. Conformance fixtures and runner under `conformance/`. |
| `packages/client` | `@pbcp/client` | `HeadClient` and `runProducer`, the durable-cursor loop. |
| `connectors/imap` | — | Example producer: unseen mail to cards. |

```sh
corepack pnpm install
corepack pnpm test        # unit tests + conformance (in-process)
corepack pnpm typecheck
corepack pnpm build
```

Node 22+. MIT licence.
