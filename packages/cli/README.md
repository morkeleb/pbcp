# @pbcp/cli

`pbcp`: the operations of a PBCP head (RFC §7) from a shell, on `@pbcp/client`.

```sh
npm i -g @pbcp/cli
export PBCP_HEAD_URL=https://head.example PBCP_TOKEN=<producer token>
pbcp describe
```

| Command | Does |
| --- | --- |
| `pbcp describe` | `GET /` (§7.5); prints the head description |
| `pbcp submit <file.md\|file.json>` | Parses the card (JSON or front-matter file, §3), checks it locally, `PUT /cards/{id}` (§7.1); prints `{ status, card }`. `409` is printed like `200` and `201`, with exit 0: it is a result, the decided card |
| `pbcp sync [--after N] [--follow] [--interval S]` | `GET /changes` (§7.2) page by page; prints each change `{ seq, card }` as one JSON line, then `next: N` on stderr. `--follow` keeps polling every `S` seconds (default 10) until interrupted |
| `pbcp decide <id> <decision> [--proposal FILE] [--comment TEXT]` | `POST /cards/{id}/decision` (§7.3) as the owner, with `--owner-credential`; `--proposal` sends the file as `edited_proposal`. Prints `{ status, card }`; `409` (already decided) exits 0 |

`--head URL`, `--token TOKEN` and `--owner-credential VALUE` override `PBCP_HEAD_URL`, `PBCP_TOKEN` and `PBCP_OWNER_CREDENTIAL`.

**`decide` is head-dependent.** Deciding is the owner's operation, performed with the owner's credential, which the protocol does not define (§7.3); a head MUST refuse a producer token there with `401`. `pbcp decide` sends `--owner-credential` (or `PBCP_OWNER_CREDENTIAL`) verbatim as the `Authorization` header — for example `Session <id>` from the head's own sign-in — to the RFC path `POST /cards/{id}/decision`. It works against a head that accepts its owner session that way at that path; how to obtain such a credential, if at all, is up to the head. It uses `OwnerClient` from `@pbcp/client`.

Exit codes: `0` done (including a printed `409`), `1` refused or failed (the error code and message go to stderr, e.g. `pbcp: 400 head_owned_field: …`), `2` usage.
