Read `CLAUDE.md`, then `rfc/pbcp-draft-0.2.md` in full, then `docs/skeleton.md`. Do not write code until you have read all three.

Then set up milestone 1 of the `pbcp` repo:

1. Initialise a pnpm workspace with `packages/core`, `packages/client`, `connectors/imap`, and `rfc/`. TypeScript strict, ESM, Node 22, vitest. Commit the scaffold on its own.

2. In `packages/core`, implement in this order, each with its own commit:
   - `id.ts`: the id grammar from RFC §5 (`parseId`, `sameNamespace`, `inRoot`). Unit tests from the RFC's own examples.
   - `yaml.ts`: the restricted-YAML reader/writer from §3 — strings only, one level of nesting, flow and block sequences, reject anchors/aliases/tags/multi-doc. Do not pull in a general YAML parser's implicit typing.
   - `card.ts`: the Zod schema for `ProducerCard` and `HeadFields` from §4, `parseCard` (JSON or front matter; rejects head-owned fields and unknown major version), `toFrontMatter`, `toJSON`, `equal` (§5: all producer fields except `emitted_at`, semantic). Choice lists per §4.4 including the one-default rule.
   - `lifecycle.ts`: pure transitions `submit`, `decide`, `canSupersede` returning effects, not performing them (§5, §6, §8). Supersession rules: same producer+namespace segments, target must be open or decided, atomic effect returned as one object.
   - `errors.ts`: `PbcpError` with the status codes in §7.4 and stable codes.

3. In `packages/core/conformance`, write the fixtures for **C01–C15** (core) and **R01–R08** (rendering classification) as described in `docs/skeleton.md`, plus **C21** (two defaults in `actions` → 400). Write the vitest runner against the `HeadUnderTest` interface, and an in-process adapter that drives the pure functions with an in-memory map and a fake monotonic counter. All cases must pass before moving on.

4. In `packages/client`, implement `HeadClient` and `runProducer` with the durable-cursor loop from RFC §7.2 — advance the cursor only after processing succeeds. Test it against a tiny in-memory HTTP stub, not against a real head.

5. In `connectors/imap`, write the producer described in `docs/skeleton.md`: unseen messages → `kind: decision` cards with `thread` = mail thread id, `actions: [approve, reject, edit]`, and an `onDecision` that sends on `approve`/`edited`. Keep it under 100 lines; the point is to prove the client is enough.

Stop after step 5. Do not implement orders, claims, the executor loop, `@pbcp/mcp`, or any head. Report what passes, what you had to interpret, and any place the RFC was ambiguous — those go in `rfc/OPEN.md`, not into guesses in code.
