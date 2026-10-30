# connectors/hermes

A Hermes Agent plugin in the Agent Plugins 1.0 layout: `@pbcp/mcp` as the MCP server, plus two skills. The only code is `src/connect.ts`, the setup text below.

- `mcp.json` starts `npx -y @pbcp/mcp` over stdio and passes `PBCP_HEAD_URL` and `PBCP_TOKEN` through from the environment. The server exposes `submit_card`, `poll_changes`, `claim_order`, `report_progress` and `complete_order` (see `packages/mcp`).
- `skills/pbcp-escalate` — before sending, spending, deleting or committing to anyone outside the user, submit a `kind: decision` card and stop; continue on a later turn only on the person's answer. Informational output goes out as `signal` or `artifact` at `log` or `brief`.
- `skills/pbcp-executor` — the order loop of RFC Appendix A, run on a Hermes cron every minute: poll for orders to `hermes` or `*`, `claim_order` with a 60-second lease, renew at least every 30 seconds and before every irreversible step, report progress with `report_progress` (on starting, after each step that changes something outside the head, while waiting, and before each irreversible step), stop on `410`, and close each order with one `complete_order`. The server mints the progress and outcome ids from the claim it holds. Orders to `*` reach Hermes only if the head lists it as an executor.

## Rules

Both skills hold Hermes to three rules about the cards it writes:

1. **References, not borrowed ids.** A card about another producer's item, such as a mail the reader already carded or a calendar event, names that card in `references` and is written under Hermes's own id (`hermes:…`). It never writes the other producer's id or root.
2. **The summary states the proposal.** On a decision card, `summary` says what Hermes proposes, not only the topic ("Anna asks to pay on the 20th. I propose agreeing for September only"), so the person can decide from the brief (RFC §4.1).
3. **The source is real.** `source` is the thing the card is about (the mail thread, the event, the document), with a label naming where it opens. Hermes leaves it out rather than guess a URL. A Gmail message uses `https://mail.google.com/mail/u/0/#search/rfc822msgid:<Message-ID>`.

The token's root is `hermes`, so every id Hermes submits is `hermes:<namespace>:…`. The skills do not keep the `poll_changes` cursor for Hermes; store `next` wherever Hermes keeps state between turns.

## Setup

<!-- setup: generated from src/connect.ts by scripts/readme-setup.ts; edit the template there, not this section -->

The token is bound to the root `hermes` (RFC §12): the skills submit every card under `hermes:`. A card the model sends without `to_person` is addressed to the head's owner (`<owner>`), which `@pbcp/mcp` reads from the head; set `PBCP_TO_PERSON` to name it instead.

**Until the packages are on npm**, the `npm` and `npx` commands here do not work yet. Use a checkout of the repository at a release tag, built:

```sh
git clone --branch v0.8.0 --depth 1 https://github.com/morkeleb/pbcp && cd pbcp
corepack pnpm install --frozen-lockfile && corepack pnpm build
```

Then, in the checkout:

```sh
export PBCP_HEAD_URL='<head url>' PBCP_TOKEN='<token>'
hermes plugins install ./connectors/hermes
hermes plugins enable pbcp
```

`mcp.json` starts the server with `npx -y @pbcp/mcp`, which works once the package is on npm. Until then, configure the server by hand to run it from the checkout (its path in place of `/path/to/pbcp`):

```json
{
  "mcpServers": {
    "pbcp": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/path/to/pbcp/packages/mcp/dist/src/bin.js"
      ],
      "env": {
        "PBCP_HEAD_URL": "<head url>",
        "PBCP_TOKEN": "<token>"
      }
    }
  }
}
```

Once it is published, the same with `npx`:

```json
{
  "mcpServers": {
    "pbcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@pbcp/mcp"
      ],
      "env": {
        "PBCP_HEAD_URL": "<head url>",
        "PBCP_TOKEN": "<token>"
      }
    }
  }
}
```

The skills are `skills/pbcp-escalate/SKILL.md` (ask before acting outside the user) and `skills/pbcp-executor/SKILL.md` (carry out orders, Appendix A). An executor needs a token the head lets claim orders.

<!-- /setup -->
