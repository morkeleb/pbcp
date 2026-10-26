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
| `PBCP_STORE` | `PBCP_CURSOR` if set, else `pbcp-imap.store.json` | one file: the sync cursor and the producer state |

## Ids

A card id is `mail:<namespace>:<upstream>` (§5).

- **upstream** is the first 24 lowercase hex characters of the SHA-256 of the `Message-ID` header value as received, encoded as UTF-8: the msg-id including its angle brackets, with surrounding whitespace removed (`<CA+abc=def@mail.example.com>`). The same message gets the same id in every mailbox and on every pass.
- **namespace** is `PBCP_MAIL_ACCOUNT` (default `IMAP_USER`) lowercased, with each run of characters outside `[a-z0-9-]` replaced by `-` and leading and trailing `-` removed. Accounts that differ only in punctuation (`a.b@x.com`, `a-b@x.com`) collide; set `PBCP_MAIL_ACCOUNT` to tell them apart.
- **No Message-ID.** Such a message has no stable key. The upstream hashes `<mailbox>/<uid>` instead, so the id changes when the message moves or the mailbox's UIDVALIDITY changes. The card body says so.

## Threads

A card's `thread` is `thr-<id>` when the server exposes a thread id (Gmail's `X-GM-THRID`, or `OBJECTID`), else `ref-<hash>` of the first `References` entry (or `In-Reply-To`, or the message's own Message-ID). Thread keys are scoped to the producer, but moving the same account to a server with different thread support changes every thread key.

## Store file

The connector does not rely on the head echoing extension fields. Once the head has answered a decision card (`201`, `200` or `409`), it records the card id → `{ mailbox, uid, messageId }` in the store file, under `state.mail`, next to the sync cursor; a submit that fails records nothing. On a decision it looks the message up by uid and Message-ID in that mailbox, then by Message-ID alone, and removes the entry once it has acted. Losing the store file means decisions on cards produced before the loss are ignored, and the cursor starts again from 0. Entries for cards that are never decided (superseded, or the message read elsewhere) are not pruned; the file grows with them.

## Upgrading from 0.3

0.3 kept the cursor in `pbcp-imap.cursor.json` and the message refs in a separate `.state.json`. 0.4 keeps both in one store file and no longer reads `PBCP_STATE` or the old state file.

- If you set `PBCP_CURSOR`, nothing to do: it is used as the store path, and a 0.3 cursor file is read as is. Otherwise rename `pbcp-imap.cursor.json` to `pbcp-imap.store.json`, or set `PBCP_STORE` to the old cursor file. Without either, the cursor starts at 0 and every change at the head is replayed once; that is harmless, since a decision without a recorded ref is ignored.
- The refs in the old state file are not carried over. A message that is still unseen in its mailbox recovers on the first pass: it is produced again with the same id, the head answers `200` (or `409` if it was decided meanwhile, which is then acted on), and its ref is recorded. A decision on a card whose message was read elsewhere before the upgrade is ignored. Delete the old `.state.json` afterwards.

## Re-produced decided messages

Do not list the archive folder in `IMAP_MAILBOXES`. An archived message that is still unseen would be produced again with the same id but as an artifact, which the head refuses with 409 on every pass. This is harmless but noisy.

## Gmail

Archiving in Gmail means removing the Inbox label, which over IMAP is a move to `[Gmail]/All Mail`. Set `IMAP_ARCHIVE='[Gmail]/All Mail'`.
