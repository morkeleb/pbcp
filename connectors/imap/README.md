# connectors/imap

An example producer on `@pbcp/client`: it turns unseen IMAP mail into cards (RFC §11.1). It is a reader only. It does not draft replies, send mail or run a model.

- Unseen messages in `INBOX` become `decision` cards with the actions `archive` (the default, so a bare approve archives) and `keep` (RFC §11.1).
- A new message in a thread whose card is still open supersedes that card (§8): a thread is decided once, on its latest message, and the decision applies to every message the card covers.
- Unseen messages in any other listed mailbox become `artifact` cards.
- The card body is the sender, the date in `IMAP_TZ` (`Mon 26 Oct 16:00`), or in UTC with the zone named when it is unset (`Mon 26 Oct 15:00 UTC`), and the first lines of the plain text, quoted. The date never says `today`: an open card is produced again on later days, and its content must not change.
- `labels` (RFC §4.1): the mailbox the message was read from, as a label (`INBOX` → `inbox`, `[Gmail]/All Mail` → `gmail-all-mail`: lowercased, each run of other characters made `-`, cut to 32), then the `IMAP_LABELS`, without repeats and at most 8.
- `summary` (RFC §4.1) is the opening plain text with quoted lines (`>`) left out and whitespace collapsed, cut at a word to at most 200 characters, ending in `…` when cut. A message with no text has no `summary`.
- On a decision, `archive` moves the card's messages to the archive folder and `keep` marks them `\Seen`. A message that is already gone is not an error. Nothing else is done to the mailbox.

## Configuration

| Variable | Default | |
|---|---|---|
| `IMAP_HOST`, `IMAP_PORT` | –, `993` | TLS only |
| `IMAP_USER`, `IMAP_PASSWORD` | – | |
| `IMAP_MAILBOXES` | `INBOX` | comma-separated |
| `IMAP_ARCHIVE` | `Archive` | target of `archive` |
| `IMAP_LABELS` | – | comma-separated labels added to every card after the mailbox's (§4.1), e.g. `work,nordic-supply`; each is made into a label as below |
| `IMAP_SOURCE_URL` | – | template for a link to the message, with `{message_id}` and `{uid}`; when set, every card gets `source` (see below) |
| `IMAP_SOURCE_LABEL` | `Open in mail` | the link's label |
| `IMAP_TZ` | UTC | IANA zone for times in card text, e.g. `Europe/Copenhagen`; a name the runtime does not know stops the connector at startup |
| `PBCP_HEAD_URL`, `PBCP_TOKEN` | – | the head and this producer's token |
| `PBCP_TO_PERSON` | the head's `owner` | read once from `GET /` at startup when unset |
| `PBCP_MAIL_ACCOUNT` | `IMAP_USER` | source of the id namespace |
| `PBCP_STORE` | `PBCP_CURSOR` if set, else `pbcp-imap.store.json` | one file: the sync cursor and the producer state |

## Link to the message

With `IMAP_SOURCE_URL` set, every card (inbox decisions and artifacts alike) carries `source: { url, label }` (RFC §4.1, §11.1), so the head can open the message in the person's mail client. In the template:

- `{message_id}` is the `Message-ID` without its angle brackets, percent-encoded (`<CA+abc=def@mail.example.com>` → `CA%2Babc%3Ddef%40mail.example.com`).
- `{uid}` is the message's IMAP uid in the mailbox it was read from.

A message with no Message-ID gets no `source` when the template uses `{message_id}`. The link counts for card equality like any field, so changing the template re-sends open cards with the new link and is refused (`409`) on decided ones; that is harmless.

For Gmail:

```
IMAP_SOURCE_URL='https://mail.google.com/mail/u/0/#search/rfc822msgid:{message_id}'
```

`u/0` is the first signed-in Google account in the browser; use `u/1` and so on for another.

## Ids

A card id is `mail:<namespace>:<upstream>` (§5).

- **upstream** is the first 24 lowercase hex characters of the SHA-256 of the `Message-ID` header value as received, encoded as UTF-8: the msg-id including its angle brackets, with surrounding whitespace removed (`<CA+abc=def@mail.example.com>`). The same message gets the same id in every mailbox and on every pass.
- **namespace** is `PBCP_MAIL_ACCOUNT` (default `IMAP_USER`) lowercased, with each run of characters outside `[a-z0-9-]` replaced by `-` and leading and trailing `-` removed. Accounts that differ only in punctuation (`a.b@x.com`, `a-b@x.com`) collide; set `PBCP_MAIL_ACCOUNT` to tell them apart.
- **No Message-ID.** Such a message has no stable key. The upstream hashes `<mailbox>/<uid>` instead, so the id changes when the message moves or the mailbox's UIDVALIDITY changes. The card body says so.

## Threads

A card's `thread` is `thr-<id>` when the server exposes a thread id (Gmail's `X-GM-THRID`, or `OBJECTID`), else `ref-<hash>` of the first `References` entry (or `In-Reply-To`, or the message's own Message-ID). Thread keys are scoped to the producer, but moving the same account to a server with different thread support changes every thread key.

## Threads and supersession

The connector keeps, per thread, the card it believes is open and the messages that card covers. For an inbox message:

- No open card in its thread: the message's card is sent as is and becomes the thread's open card.
- The open card is this message's card: it is sent again unchanged, with the same `supersedes` as before (re-sending is idempotent, §5).
- The open card already covers this message (it was superseded): the message is not sent again.
- Otherwise the message is newer: its card names the open card in `supersedes` and becomes the open card, covering the earlier messages too.

A decision on the open card applies to all its messages and closes the thread; the next message starts a new card that supersedes nothing. A predecessor the person decided before its successor reached the head keeps its decision (§8); the connector acts on it for that card's own message, and the successor's decision applies afterwards to all of them. Messages outside `INBOX` are artifacts and do not take part.

## Store file

The connector does not rely on the head echoing extension fields. Once the head has answered a decision card (`201`, `200` or `409`), it records the thread's open card in the store file, under `state.thread`, keyed by thread: `{ id, supersedes?, refs: [{ card, mailbox, uid, messageId }] }`, next to the sync cursor; a submit that fails records nothing. On a decision it looks each message up by uid and Message-ID in its mailbox, then by Message-ID alone, and removes the thread's entry once the open card is decided (with any decision; only `archive` and `keep` touch the mailbox). Losing the store file means decisions on cards produced before the loss are ignored, and the cursor starts again from 0.

## Upgrading from 0.7.0

0.7.0 kept one entry per card under `state.mail`. Those entries are no longer read. A message that is still unseen in the inbox recovers on the next pass, as below for 0.3: it is produced again with the same id and recorded as its thread's open card. Delete `state.mail` from the store file afterwards.

## Upgrading from 0.3

0.3 kept the cursor in `pbcp-imap.cursor.json` and the message refs in a separate `.state.json`. 0.4 keeps both in one store file and no longer reads `PBCP_STATE` or the old state file.

- If you set `PBCP_CURSOR`, nothing to do: it is used as the store path, and a 0.3 cursor file is read as is. Otherwise rename `pbcp-imap.cursor.json` to `pbcp-imap.store.json`, or set `PBCP_STORE` to the old cursor file. Without either, the cursor starts at 0 and every change at the head is replayed once; that is harmless, since a decision without a recorded ref is ignored.
- The refs in the old state file are not carried over. A message that is still unseen in its mailbox recovers on the first pass: it is produced again with the same id, the head answers `200` (or `409` if it was decided meanwhile, which is then acted on), and its ref is recorded. A decision on a card whose message was read elsewhere before the upgrade is ignored. Delete the old `.state.json` afterwards.

## Re-produced decided messages

Do not list the archive folder in `IMAP_MAILBOXES`. An archived message that is still unseen would be produced again with the same id but as an artifact, which the head refuses with 409 on every pass. This is harmless but noisy.

## Gmail

Archiving in Gmail means removing the Inbox label, which over IMAP is a move to `[Gmail]/All Mail`. Set `IMAP_ARCHIVE='[Gmail]/All Mail'`.
