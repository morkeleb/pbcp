# @pbcp/client

A PBCP client: `HeadClient` speaks a producer's side of a head (RFC §7), `runProducer` is the durable-cursor loop a connector runs on (§7.2), `runExecutor` carries out orders (Appendix A), and `OwnerClient` speaks the owner's side for tools and tests.

## HeadClient

```ts
const head = new HeadClient({ baseUrl: 'https://head.example', token });
await head.describe();          // GET / → { protocol, owner, seq, extensions, render } (§7.5)
await head.submit(card);        // PUT /cards/{id} → { status: 200 | 201 | 409, card }
await head.sync(after);         // GET /changes?after=n → { changes: [{ seq, card }], next }
```

A 409 that returns a card is a result, not an error: the card was already decided and the body is the stored card. Any other refusal whose body is `{ "error": "<code>", "message": "..." }` with a known code bound to the response status throws `PbcpError` with that code (§7.4). A 429 carries `retryAfter` (seconds) when the head sent `Retry-After` in delta-seconds form. Everything else (5xx, unknown codes, bodies that are not what the call expects) throws `HeadHttpError` with the status and body.

Paths are relative to `baseUrl`, so a head mounted under a prefix is `baseUrl: 'https://example.org/pbcp'` (§7). To start a cursor from now rather than from the beginning, pass `(await head.describe()).seq` as the first `after`.

**Transport.** Requests go through the global `fetch` by default, or through `fetch: myFetch`. A host with its own request layer (proxies, logging, as in n8n) passes `transport` instead: `(req: { method, url, headers, body? }) => Promise<{ status, headers, body }>`, with lower-case header names and every status returned as a response rather than thrown. `fetchTransport(f)` adapts a fetch function.

## runExecutor (orders extension)

```ts
const run = runExecutor({ head, store: fileStore('exec.json'), producer: 'todoist', concurrency: 50,
  run: async (order, ctx) => {
    await ctx.progress('Created the task');      // PUT todoist:order:<ulid>:progress-1 (signal, log)
    await ctx.checkpoint();                       // renews; throws Cancelled if the person cancelled (410)
    return { kind: 'signal', title: 'Done', body: '…' };
  } });
```

Each pass syncs and claims the orders addressed to `producer` or `*` that are `open`, up to `concurrency` at once, with a lease (default 60 s) renewed every half lease. A started run continues in the background; the cursor advances once every open order on a page has been claimed or refused. When `run` returns, the executor PUTs `<producer>:order:<ulid>:outcome` with `thread` and `references` naming the order and `orders.claim_seq` from the latest renewal (A.3). A `failed` outcome, a thrown error, or a `Cancelled` (410 on renewal, or the lease lost to another executor, 409) becomes an outcome with `orders.result: "failed"` that lists the progress notes as what was done (A.5). `stop()` aborts runs without an outcome, so their leases lapse and the orders are claimed again. `executor(opts)` gives the same loop without its timer (`pass()`, `idle()`).

`HeadClient.claim(id, leaseSeconds)` claims or renews and returns the order; a `409` or `410` throws `ClaimRefused` with `code` `lease_held` or `order_terminal` and the order. The test stub mints orders with `stub.order({ to_producer, title, body })`; `stubHead({ executors })` lists the roots that receive `*` orders.

## OwnerClient

```ts
const owner = new OwnerClient({ baseUrl, credential: 'Session …' });
await owner.decide(id, { decision: 'approve' });   // POST /cards/{id}/decision → { status: 200 | 409, card }
await owner.seen(id);                              // head-defined path; default /cards/{id}/seen
await owner.ack(id);                               // head-defined path; default /cards/{id}/acknowledge
```

Decide is the owner's operation, performed with the owner's credential, which the protocol does not define (§7.3). `credential` is sent verbatim as the `Authorization` header; a head refuses a producer token there with `401`. Where a head mounts these operations is its choice: pass `paths` to match it. Seen and acknowledge are not protocol operations at all (§4.2).

## runProducer

```ts
const store = fileStore('pbcp.json');
const run = runProducer({ head, store, produce, onSubmitted, onDecision });
await run.stop(); // waits for the pass in flight
```

Each pass runs in this order, so `onDecision` never runs while `produce()` is suspended:

1. `produce()` runs to completion. Each card it yields is submitted; when the head answers (201, 200 or 409), `onSubmitted(card, result)` is called before `produce()` resumes. Record local state there, not before the submit: a card whose submit failed is not reported and is produced again next pass.
2. `onDecision` is called for every non-open card a submit returned.
3. Sync runs until `next` stops moving, calling `onDecision` for every change. The cursor advances only after every change on a page has been processed.

`onDecision` must be idempotent: the same decision can arrive twice (from submit and from sync, or after a failed pass). Passes run `intervalMs` apart (default 60 s) and never overlap. Failures go to `onError`; a pass never throws.

- **Parking (§7.2).** A sync change whose `onDecision` fails is retried on later passes; after `maxAttempts` (default 5) failures it is parked: `onParked({ from: 'sync', seq, card }, error)` is called and the cursor moves past it. A card the head refuses with a 4xx that resending cannot fix (anything but 401, 408 and 429) is parked the same way, `onParked({ from: 'submit', card }, error)`, and not sent again while its content is unchanged. If `onParked` throws, nothing is parked. Attempt counts and parked submits live in memory for the life of one `runProducer`. Failures of `onDecision` for submit results are reported but not counted, because the same change also arrives through sync. The default `onParked` logs with `console.error`.
- **Retry-After (§7.4).** A 429 with `Retry-After` from submit or sync ends the pass, and the next pass waits for the longer of `intervalMs` and the requested delay.
- **`next` lower than `after`** is reported through `onError`; the pass ends and the cursor does not move.

`producerPass(opts, signal?, attempts?)` runs a single pass and returns `{ retryAfterMs? }`. Pass the same `attempts` map to each call if you drive passes yourself.

## card()

`card({ producer, namespace, upstream, intent?, kind, to_person, title, body, ... })` builds the id `producer:namespace:upstream[:intent]` (§5), fills `protocol` and `emitted_at`, and validates the result, so connectors never assemble ids or protocol fields by hand. `upstream` is used as given; encode an arbitrary key with `encodeUpstream` from `@pbcp/core`.

## Stores

`fileStore(path)` keeps the cursor and the connector's own state in one JSON file, `{ "after": n, "state": { namespace: { key: value } } }`; a missing file is cursor 0 and no state, and a 0.3 cursor file `{ "after": n }` reads as is. `memoryStore()` is the same in memory. Both are a `StateStore`:

```ts
await store.get(); await store.set(n);          // the cursor
const refs = store.kv<MailRef>('mail');         // a namespace of key/value state
await refs.set(id, ref); await refs.get(id); await refs.delete(id);
await refs.keys('approval:');                   // keys by prefix, sorted
```

Writes to one store are applied in the order they are made, through a temp file and rename.

## Testing

`@pbcp/client/testing` exports `stubHead()`, an in-memory head behind a `fetch` function, for testing producers and tools without a server. Its rules are `@pbcp/core`'s own transitions (submit, supersession, decide, acknowledge), so a connector sees the protocol's answers. Producer tokens are any `Bearer` value; the owner endpoints take `Session owner` (or `ownerCredential`). `stub.decideHere(id, decision)` decides as the owner without HTTP, `stub.script(status, body)` scripts the next response, and `stub.requests` records every request.

## Migrating from 0.3

- `HeadClient.decide` is gone: use `OwnerClient` with the owner's credential (§7.3).
- `runProducer({ cursor })` → `runProducer({ store })`. `cursor` still works in 0.4.
- `fileCursor`, `memoryCursor` → `fileStore`, `memoryStore`; `fileState(path)` → `fileStore(path).kv(namespace)`. The old names work in 0.4 and go in 0.5. The 0.3 key/value type `StateStore<T>` is now `KeyValue<T>`; `StateStore` is the cursor plus `kv()`.
- `onParked(change, err)` → `onParked(parked, err)`, where `parked.from` is `'sync'` (with `seq`) or `'submit'`.
- `onDecision` for a decided submit result now runs after `produce()` finishes, not between yields.
- Replace any wrapper around `head.submit` used to learn results with `onSubmitted`.
- `describe()` requires `seq` in the head's description (§7.5), and cards carry the head-owned `delivery` (§4.2).
- The test stub is `@pbcp/client/testing`.
