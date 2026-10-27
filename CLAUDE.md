# pbcp — Personal Brief Card Protocol

This repo is the **protocol**: the RFC, the npm packages that implement it, the conformance suite, and example connectors. There is no head (server) and no UI here; those live in the separate `head` repo and depend on this one from npm.

## Read first

- `rfc/pbcp-draft-0.6.md` — the specification. It is normative. When code and RFC disagree, the RFC wins; if the RFC is wrong, change the RFC first and note it in `rfc/CHANGELOG.md`.
- `docs/skeleton.md` — the package layout, public interfaces, and build order. Follow it; do not invent additional packages or layers.

## What is being built, in order

Milestone 1 only. Do not start milestone 2 or 3 work (brief folding, orders, executor) until milestone 1 is green.

1. `packages/core` — pure functions, no I/O: card schema (Zod), parse/serialize (JSON ⇄ YAML front matter), id grammar, semantic equality, the core lifecycle transitions (`submit`, `decide`, `canSupersede`). Conformance cases **C01–C15** and **R01–R08** must pass in-process.
2. `packages/core/conformance` — JSON fixtures + a vitest runner that takes a `HeadUnderTest` adapter. The fixtures are the protocol's real definition; write them from the RFC, not from the implementation.
3. `packages/client` — `HeadClient` + `runProducer` (durable cursor loop). No executor yet.
4. `connectors/imap` — a producer on `@pbcp/client`, under 100 lines, that turns unseen mail into cards: inbox messages are `kind: decision` with `actions: [archive, keep]`, everything else is `kind: artifact` with no actions (RFC §11.1). It is a reader: no model, no SMTP, no reply drafting.

## Rules

- **Zero I/O in core.** No fetch, no fs, no database handles. If a function needs a clock, take `now: string` as a parameter.
- **Head-owned fields are never accepted on input.** `parseCard` rejects them with a 400-class error.
- **Restricted YAML.** Every scalar parses as a string; typed validation happens after. Do not use a full YAML library's implicit typing.
- **Equality** compares every producer-owned field except `emitted_at`, semantically, never byte-for-byte.
- **Errors** are `PbcpError` with the RFC status code and a stable `code`; never throw strings.
- **No marketing, no product names** in code, comments, or docs beyond what the RFC's examples already use.
- Tests before features: a conformance case that fails is the spec for the next change.
- TypeScript strict, ESM, Node 22+, pnpm workspaces, vitest. Zod for schemas. No other runtime dependencies in `core`.

## Other languages

The conformance fixtures in `packages/core/conformance` are the protocol's definition and are language-neutral. A second-language implementation (Python first; Rust, Swift, Kotlin later if a need appears) lives in its own repo, depends on the fixtures published from here, and claims conformance by passing them. Do not add non-TypeScript code to this repo.

## Licence

MIT, whole repo. The head app is licensed separately in its own repo.

## When unsure

Quote the RFC section number in the commit message or PR description. If a question cannot be answered from the RFC, it is an open question: add it to `rfc/OPEN.md` and pick the simplest interpretation that keeps the conformance suite small.
