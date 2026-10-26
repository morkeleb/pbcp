# connectors/imap

An example producer on `@pbcp/client`: it turns unseen IMAP mail into cards (RFC §11.1). It is a reader only. It does not draft replies, send mail or run a model.

- Unseen messages in `INBOX` become `decision` cards with the actions `archive` and `keep`.
- Unseen messages in any other listed mailbox become `artifact` cards.
- The card body is the sender, the date and the first lines of the plain text, quoted.
- On a decision, `archive` moves the message to the archive folder and `keep` marks it `\Seen`. A message that is already gone is not an error. Nothing else is done to the mailbox.

## Configuration

| Variable | Default | |
|---|---|---|
| `IMAP_HOST`, `IMAP_PORT` | –, `993` | TLS only |
| `IMAP_USER`, `IMAP_PASSWORD` | – | |
| `IMAP_MAILBOXES` | `INBOX` | comma-separated |
| `IMAP_ARCHIVE` | `Archive` | target of `archive` |
| `PBCP_HEAD_URL`, `PBCP_TOKEN` | – | the head and this producer's token |
| `PBCP_TO_PERSON` | the head's `owner` | read once from `GET /` at startup when unset |
| `PBCP_MAIL_ACCOUNT` | `IMAP_USER` | source of the id namespace |
| `PBCP_CURSOR` | `pbcp-imap.cursor.json` | sync cursor |
| `PBCP_STATE` | the cursor path with `.cursor.json` replaced by `.state.json`, else `<cursor>.state.json` | producer state |

## Ids

A card id is `mail:<namespace>:<upstream>` (§5).

- **upstream** is the first 24 lowercase hex characters of the SHA-256 of the `Message-ID` header value as received, encoded as UTF-8: the msg-id including its angle brackets, with surrounding whitespace removed (`<CA+abc=def@mail.example.com>`). The same message gets the same id in every mailbox and on every pass.
- **namespace** is `PBCP_MAIL_ACCOUNT` (default `IMAP_USER`) lowercased, with each run of characters outside `[a-z0-9-]` replaced by `-` and leading and trailing `-` removed. Accounts that differ only in punctuation (`a.b@x.com`, `a-b@x.com`) collide; set `PBCP_MAIL_ACCOUNT` to tell them apart.
- **No Message-ID.** Such a message has no stable key. The upstream hashes `<mailbox>/<uid>` instead, so the id changes when the message moves or the mailbox's UIDVALIDITY changes. The card body says so.

## Threads

A card's `thread` is `thr-<id>` when the server exposes a thread id (Gmail's `X-GM-THRID`, or `OBJECTID`), else `ref-<hash>` of the first `References` entry (or `In-Reply-To`, or the message's own Message-ID). Thread keys are scoped to the producer, but moving the same account to a server with different thread support changes every thread key.

## State file

The connector does not rely on the head echoing extension fields. When it produces a decision card, before submitting it, it records the card id → `{ mailbox, uid, messageId }` in the state file. On a decision it looks the message up by uid and Message-ID in that mailbox, then by Message-ID alone, and removes the entry once it has acted. Losing the state file means decisions on cards produced before the loss are ignored. Entries for cards that are never decided (superseded, or the message read elsewhere) are not pruned; the file grows with them, and deleting it while no decision is pending is safe.

## Re-produced decided messages

Do not list the archive folder in `IMAP_MAILBOXES`. An archived message that is still unseen would be produced again with the same id but as an artifact, which the head refuses with 409 on every pass. This is harmless but noisy.

## Gmail

Archiving in Gmail means removing the Inbox label, which over IMAP is a move to `[Gmail]/All Mail`. Set `IMAP_ARCHIVE='[Gmail]/All Mail'`.
