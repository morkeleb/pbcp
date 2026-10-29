// An MCP adapter over HeadClient (RFC §7): submit_card, poll_changes and, for the orders extension, claim_order.
// Not a second definition of the protocol.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HeadClient, HeadHttpError } from '@pbcp/client';
import { ClaimRefusal, PbcpError, parseCardOrThrow, yamlScalar, type ProducerCard } from '@pbcp/core';
import { z } from 'zod';

export const VERSION = '0.8.0';

export interface Config {
  baseUrl: string;
  token: string;
  /** Who cards are addressed to when a card leaves `to_person` out; unset, the head's owner from its description (§7.5, §10). */
  toPerson?: string;
}

/** `--head URL`, `--token TOKEN` and `--to-person ID` override `PBCP_HEAD_URL`, `PBCP_TOKEN` and `PBCP_TO_PERSON`. */
export function configFrom(argv: string[], env: Record<string, string | undefined>): Config {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const baseUrl = flag('head') ?? env.PBCP_HEAD_URL;
  const token = flag('token') ?? env.PBCP_TOKEN;
  if (!baseUrl) throw new Error('no head: pass --head or set PBCP_HEAD_URL');
  if (!token) throw new Error('no token: pass --token or set PBCP_TOKEN');
  const toPerson = flag('to-person') || env.PBCP_TO_PERSON || undefined;
  return { baseUrl, token, ...(toPerson ? { toPerson } : {}) };
}

const result = (value: object): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

/** Refusals come back as tool errors carrying the RFC status and code (§7.4), so the caller can fix the card. */
function refusal(e: unknown): CallToolResult {
  const error =
    e instanceof ClaimRefusal ? { status: e.status, error: e.code, message: e.message, order: e.order }
    : e instanceof PbcpError ? { status: e.status, error: e.code, message: e.message }
    : e instanceof HeadHttpError ? { status: e.status, error: 'http', message: e.message, body: e.body }
    : { error: 'failed', message: e instanceof Error ? e.message : String(e) };
  return { content: [{ type: 'text', text: JSON.stringify(error, null, 2) }], isError: true };
}

const SUBMIT = `Submit a card to the person's head (PBCP §7.1). Pass the card as a JSON object, JSON text, or front-matter text (a YAML header between --- lines, then the markdown body).

Give every card a "summary" (§4.1): one or two sentences of plain text on one line, under 280 characters, saying what is going on and what you want from the person. It is what they read in the brief. No markdown and no line breaks; a summary with a line break, or an empty one, is refused with 400 invalid_card.

Set "labels" (§4.1) to the project, client or mailbox the card concerns, so the person can filter by them: a list of up to 8, each 1–32 lowercase letters, digits or "-" (["billing-revamp"]). Set "about" to the day the card is about, as YYYY-MM-DD, when that is not today: tomorrow's agenda, a meeting moved to Friday. Either one broken is refused with 400 invalid_card.

**\`at\` is when the subject happens.** A card has three times and they answer three different questions. \`emitted_at\` is when the producer wrote the card; every card has one. \`about\` is the day the card belongs to in the person's life; set it when that is not the day the card was sent. \`at\` is the moment the thing the card is about happens or starts, and \`until\` when it ends; set them whenever the subject has a time of day — a meeting, a deadline, a due time, a departure, an expiry — so that a head can put the card on the day's timeline beside cards from other producers. Write the time nowhere else: not in the title, not in the summary, where no head can read it. A subject with a day but no time (an all-day event, a date-only deadline) takes \`about\` alone. Both are timestamps in UTC ending in Z ("2026-11-03T09:15:00Z"); "until" needs "at" and is not before it, or the card is refused with 400 invalid_card.

Set "kind" by what the card asks of the person: "decision" to choose (with "actions"; open until they decide), "signal" to know that something happened, "artifact" to read something made for them (a report, a record). Set "urgency" by when they should see it: "brief" (the default) waits for their next brief, "immediate" interrupts and is only for a decision that cannot wait or a signal about the next few hours, and "log" is only recorded, for routine records such as a completed task.

Leave out "to_person": the server addresses the card to the person the head is for.

Returns { status, id, state, change_seq, card }: the head's answer, with the card as it stored it. That answer is the confirmation that the card landed. 201: new card stored. 200: already current; read card.state and card.decision, since the person may already have answered. 409: the person already decided an earlier version; card carries that decision. Never re-submit the same id after a 409; submit a new card with "supersedes" set to the old id if you still need an answer.`;

const POLL = `Read what changed on your cards since a cursor (PBCP §7.2). Pass after = 0 the first time, then the "next" from the previous call.

Returns { changes: [{ seq, card }], next }. A decided card has state "decided" and a "decision" (one of its actions, or edited with edited_proposal, dismissed, delegated). When next equals after there is nothing newer; otherwise call again with next. If you are an executor, orders addressed to you (or to *) arrive here too: kind "order", with to_producer and exec_state.`;

const CLAIM = `Claim an order, or renew a lease you hold (PBCP Appendix A.2). Pass the order id and lease_seconds (default 60). Renew at least every half lease while you work, and always just before an irreversible step (sending, paying, deleting): only proceed if the renewal succeeds.

Returns the order with exec_state "claimed" and claim_seq. A renewal keeps claim_seq; a new claim (after a lease lapsed) gets a new one. When done, submit_card one outcome card for your claim, in your own namespace: id <you>:order:<ulid>:outcome-<claim_seq> (ulid is the last segment of the order id), references: [order id], thread: order id, "orders.claim_seq": your claim_seq, and "orders.result": "done" or "failed" (both are required).

Errors: 409 lease_held — another executor has it; stand down. 410 order_terminal — the order is done, failed or cancelled; stop, never retry, and report what you did and did not do in the outcome card. 400 invalid_lease — lease_seconds must be a positive integer.`;

/**
 * The card as given, with `to_person` set to `owner` when it has none (§10): the model need not know who the head is for.
 * Front-matter text gets a `to_person` line after the opening `---`; JSON text and objects get the field.
 */
export function addressed(card: string | Record<string, unknown>, owner: string): string | Record<string, unknown> {
  if (typeof card !== 'string') return 'to_person' in card ? card : { ...card, to_person: owner };
  const text = card.replace(/^\uFEFF/, '');
  if (/^---\r?\n/.test(text)) {
    const header = text.slice(0, text.search(/\n---\r?(\n|$)/) + 1);
    return /^to_person:/m.test(header) ? card : text.replace(/^---\r?\n/, `---\nto_person: ${yamlScalar(owner)}\n`);
  }
  try {
    const obj = JSON.parse(text) as unknown;
    return typeof obj === 'object' && obj !== null && !Array.isArray(obj) && !('to_person' in obj) ? { ...obj, to_person: owner } : card;
  } catch {
    return card; // parseCardOrThrow reports it
  }
}

/** What submit_card answers: the head's answer, and the stored card's id, state and change_seq up front, so the model sees it landed. */
const landed = ({ status, card }: { status: number; card: ProducerCard & { state?: string; change_seq?: number } }) =>
  ({ status, id: card.id, state: card.state, change_seq: card.change_seq, card });

export function createServer(head: Pick<HeadClient, 'submit' | 'sync' | 'claim' | 'describe'>, opts: { toPerson?: string } = {}): McpServer {
  const server = new McpServer({ name: 'pbcp', version: VERSION });
  // Without a configured addressee, the head's description says who it is for (§7.5), read once, when the first card
  // without to_person arrives. A card that has one needs no request before it is checked.
  let owner: Promise<string> | undefined = opts.toPerson === undefined ? undefined : Promise.resolve(opts.toPerson);
  const ready = () => (owner ??= head.describe().then((d) => d.owner, (e: unknown) => { owner = undefined; throw e; }));

  server.registerTool(
    'submit_card',
    {
      description: SUBMIT,
      inputSchema: { card: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('The card: JSON object, JSON text, or front-matter text') },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ card }) => {
      try {
        const given = card as string | Record<string, unknown>;
        const filled = addressed(given, '') === given ? given : addressed(given, await ready());
        return result(landed(await head.submit(parseCardOrThrow(filled))));
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    'poll_changes',
    {
      description: POLL,
      inputSchema: { after: z.number().int().min(0).describe('The cursor: 0, or the "next" of the previous call') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ after }) => {
      try {
        return result(await head.sync(after));
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    'claim_order',
    {
      description: CLAIM,
      inputSchema: {
        id: z.string().describe('The order id, head:order:<ulid>'),
        lease_seconds: z.number().int().min(1).default(60).describe('Lease length in seconds'),
      },
      annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ id, lease_seconds }) => {
      try {
        return result({ order: await head.claim(id, lease_seconds) });
      } catch (e) {
        return refusal(e);
      }
    },
  );

  return server;
}
