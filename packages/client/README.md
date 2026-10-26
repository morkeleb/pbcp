# @pbcp/client

A PBCP client for producers: `HeadClient` speaks the HTTP surface of a head (RFC §7), and `runProducer` is the durable-cursor loop a connector runs on (§7.2). No executor, no orders.

## HeadClient

```ts
const head = new HeadClient({ baseUrl: 'https://head.example', token });
await head.describe();          // GET / → { protocol, owner, extensions, render } (§7.5)
await head.submit(card);        // PUT /cards/{id} → { status: 200 | 201 | 409, card }
await head.sync(after);         // GET /changes?after=n → { changes: [{ seq, card }], next }
```

A 409 that returns a card is a result, not an error: the card was already decided and the body is the stored card. Any other refusal whose body is `{ "error": "<code>", "message": "..." }` with a known code bound to the response status throws `PbcpError` with that code (§7.4). A 429 carries `retryAfter` (seconds) when the head sent `Retry-After` in delta-seconds form. Everything else (5xx, unknown codes, bodies that are not what the call expects) throws `HeadHttpError` with the status and body.

## runProducer

```ts
const run = runProducer({ head, cursor: fileCursor('cursor.json'), produce, onDecision });
await run.stop(); // waits for the pass in flight
```

Each pass submits the cards `produce()` yields, then syncs until `next` stops moving, calling `onDecision` for every change and for any non-open card a submit returns. `onDecision` must be idempotent: the same decision can arrive twice. The cursor advances only after every change on a page has been processed. Passes run `intervalMs` apart (default 60 s) and never overlap. Failures go to `onError`; a pass never throws.

- **Parking (§7.2).** A sync change whose `onDecision` fails is retried on later passes. After `maxAttempts` (default 5) failures it is parked: `onParked(change, error)` is called (default: `console.error` with the card id and seq) and the cursor moves past it. If `onParked` throws, the change is not parked and the cursor stays. Attempt counts live in memory for the life of one `runProducer`. Failures of `onDecision` on the submit path are reported but not counted, because the same change also arrives through sync.
- **Retry-After (§7.4).** A 429 with `Retry-After` from submit or sync ends the pass, and the next pass waits for the longer of `intervalMs` and the requested delay.
- **`next` lower than `after`** is reported through `onError`; the pass ends and the cursor does not move.

`producerPass(opts, signal?, attempts?)` runs a single pass and returns `{ retryAfterMs? }`. Pass the same `attempts` map to each call if you drive passes yourself.

## card()

`card({ producer, namespace, upstream, intent?, kind, to_person, title, body, ... })` builds the id `producer:namespace:upstream[:intent]` (§5), fills `protocol` and `emitted_at`, and validates the result, so connectors never assemble ids or protocol fields by hand.

## Stores

- `fileCursor(path)` keeps the cursor as `{ "after": n }`; a missing file is cursor 0. `memoryCursor()` is for tests.
- `fileState<T>(path)` is a small JSON key/value file (`get`, `set`, `delete`) for producer-local state such as where a card's source lives. A missing file is empty.

Both write through a temp file and rename.
