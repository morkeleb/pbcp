// An MCP adapter over HeadClient (RFC §7): submit_card, poll_changes and, for the orders extension, claim_order,
// report_progress and complete_order. Not a second definition of the protocol.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HeadClient, HeadHttpError, card as build } from '@pbcp/client';
import { ClaimRefusal, OUTCOME_CLAIM_SEQ, OUTCOME_RESULT, PbcpError, parseCardOrThrow, ulidOf, yamlScalar, type ProducerCard } from '@pbcp/core';
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

/** report_progress or complete_order on an order this server has not claimed: refused here, before any request. */
class NotClaimed extends Error {}

/** Refusals come back as tool errors carrying the RFC status and code (§7.4), so the caller can fix the card. */
function refusal(e: unknown): CallToolResult {
  const error =
    e instanceof ClaimRefusal ? { status: e.status, error: e.code, message: e.message, order: e.order }
    : e instanceof PbcpError ? { status: e.status, error: e.code, message: e.message }
    : e instanceof NotClaimed ? { error: 'not_claimed', message: e.message }
    : e instanceof HeadHttpError ? { status: e.status, error: 'http', message: e.message, body: e.body }
    : { error: 'failed', message: e instanceof Error ? e.message : String(e) };
  return { content: [{ type: 'text', text: JSON.stringify(error, null, 2) }], isError: true };
}

const SUBMIT = `Submit a card to the person's head (PBCP §7.1). Pass the card as a JSON object, JSON text, or front-matter text (a YAML header between --- lines, then the markdown body).

Give every card a "summary" (§4.1): one or two sentences of plain text on one line, under 280 characters, saying what is going on and what you want from the person. It is what they read in the brief. No markdown and no line breaks; a summary with a line break, or an empty one, is refused with 400 invalid_card.

Set "labels" (§4.1) to the project, client or mailbox the card concerns, so the person can filter by them: a list of up to 8, each 1–32 lowercase letters, digits or "-" (["billing-revamp"]). Set "about" to the day the card is about, as YYYY-MM-DD, when that is not today: tomorrow's agenda, a meeting moved to Friday. Either one broken is refused with 400 invalid_card.

**\`at\` is when the subject happens.** A card has three times and they answer three different questions. \`emitted_at\` is when the producer wrote the card; every card has one. \`about\` is the day the card belongs to in the person's life; set it when that is not the day the card was sent. \`at\` is the moment the thing the card is about happens or starts, and \`until\` when it ends; set them whenever the subject has a time of day — a meeting, a deadline, a due time, a departure, an expiry — so that a head can put the card on the day's timeline beside cards from other producers. Do not write the time only there: a time in the title or summary is for the person, who reads the brief's line; \`at\` is for the head, which reads nothing else. A subject with a day but no time (an all-day event, a date-only deadline) takes \`about\` alone. Both are timestamps in UTC ending in Z ("2026-11-03T09:15:00Z"); "until" needs "at" and is not before it, or the card is refused with 400 invalid_card.

Set "kind" by what the card asks of the person: "decision" to choose (with "actions"; open until they decide), "signal" to know that something happened, "artifact" to read something made for them (a report, a record). Set "urgency" by when they should see it: "brief" (the default) waits for their next brief, "immediate" interrupts and is only for a decision that cannot wait or a signal about the next few hours, and "log" is only recorded, for routine records such as a completed task.

Leave out "to_person": the server addresses the card to the person the head is for.

Returns { status, id, state, change_seq, card }: the head's answer, with the card as it stored it. That answer is the confirmation that the card landed. 201: new card stored. 200: already current; read card.state and card.decision, since the person may already have answered. 409: the person already decided an earlier version; card carries that decision. Never re-submit the same id after a 409; submit a new card with "supersedes" set to the old id if you still need an answer.`;

const POLL = `Read what changed on your cards since a cursor (PBCP §7.2). Pass after = 0 the first time, then the "next" from the previous call.

Returns { changes: [{ seq, card }], next }. A decided card has state "decided" and a "decision" (one of its actions, or edited with edited_proposal, dismissed, delegated). When next equals after there is nothing newer; otherwise call again with next. If you are an executor, orders addressed to you (or to *) arrive here too: kind "order", with to_producer and exec_state.`;

const CLAIM = `Claim an order, or renew a lease you hold (PBCP Appendix A.2). Pass the order id and lease_seconds (default 60). Renew at least every half lease while you work, and always just before an irreversible step (sending, paying, deleting): only proceed if the renewal succeeds.

Returns the order with exec_state "claimed" and claim_seq. A renewal keeps claim_seq; a new claim (after a lease lapsed) gets a new one. This server remembers the claim, so report_progress and complete_order can write the order's cards for you: never assemble an order card id yourself.

Errors: 409 lease_held — another executor has it; stand down. 410 order_terminal — the order is done, failed or cancelled; stop, never retry, and report what you did and did not do with complete_order, result "failed". 400 invalid_lease — lease_seconds must be a positive integer.`;

const PROGRESS = `Tell the person how an order you claimed is going (PBCP Appendix A.3). Pass the order id and a note: one or two plain sentences, the first line short enough to be a title ("Started: booking the dentist for next week."). The person reads these notes in their brief, in the order's thread, to see that the work is moving and what it has touched; a step they cannot see is a step they cannot stop or undo.

Report when you start ("Started: <what you will do>"), after each step that changes something outside the head (a mail sent, an event booked, a file written), when you are waiting on something external, and just before an irreversible step, after renewing the claim with claim_order.

The note is posted as a progress card in the order's thread (kind signal, urgency log, so it is recorded without interrupting anyone). You only need the order id: the server mints the card's id from the claim it holds. Refused if this server has not claimed the order; call claim_order first.

Returns { status, id, state, change_seq, card }, as submit_card does.`;

const COMPLETE = `Close an order you claimed with its outcome (PBCP Appendix A.3). Call it exactly once per claim, when the work is done, when it failed, or when a claim_order renewal answered 410 (the person cancelled). This card is the person's answer to the order: it is what they read in their brief, so the title says what happened ("Booked the dentist for Tue 3 Nov 09:00", "Could not book: the clinic is closed until Monday") and the body says what you did, with links, and, if you stopped early, what was and was not done.

result is "done" or "failed". kind is "artifact" (the default) for a record of what you did, "signal" for something the person should know happened, or "decision" when you propose something that needs their approval before it takes effect ("here is the draft, send it?"): then give "actions" and a "summary" that states the proposal. Optional fields are as on any card (see submit_card): summary, source, labels, about, at, until, urgency.

You only need the order id: the server mints the outcome's id and sets orders.claim_seq from the claim it holds, and thread and references to the order. Refused if this server has not claimed the order.

Returns { status, id, state, change_seq, card }, as submit_card does. The order's exec_state then becomes done or failed, unless it was already cancelled; the outcome is still stored as your report.`;

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

/** A claim this server holds: the root that holds it, its claim_seq, and the progress cards it has written (A.3, A.4). */
interface Held {
  root: string;
  seq: number;
  n: number;
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim() !== '')?.trim().slice(0, 200);

export function createServer(head: Pick<HeadClient, 'submit' | 'sync' | 'claim' | 'describe'>, opts: { toPerson?: string } = {}): McpServer {
  const server = new McpServer({ name: 'pbcp', version: VERSION });
  const held = new Map<string, Held>();
  const holding = (id: string): Held => {
    const h = held.get(id);
    if (!h) throw new NotClaimed(`this server holds no claim on ${id}; call claim_order first. If you claimed it and a renewal answered 409 lease_held, another executor has it: stand down.`);
    return h;
  };
  /** A card in the order's thread, under the claiming root's namespace `order` (A.4). */
  const own = async (orderId: string, h: Held, intent: string, fields: Record<string, unknown> & { kind: ProducerCard['kind']; title: string; body: string }) =>
    build({ ...fields, producer: h.root, namespace: 'order', upstream: ulidOf(orderId), intent, to_person: await ready(), thread: orderId, references: [orderId] });
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
        const order = await head.claim(id, lease_seconds);
        const h = held.get(id);
        // A renewal keeps claim_seq and the progress count; a new claim starts both over (A.2).
        if (order.claimed_by && order.claim_seq && h?.seq !== order.claim_seq) held.set(id, { root: order.claimed_by, seq: order.claim_seq, n: 0 });
        return result({ order });
      } catch (e) {
        // 409: another root holds the lease now. A 410 keeps the claim, so complete_order can still report (A.5).
        if (e instanceof ClaimRefusal && e.code === 'lease_held') held.delete(id);
        return refusal(e);
      }
    },
  );

  server.registerTool(
    'report_progress',
    {
      description: PROGRESS,
      inputSchema: {
        order_id: z.string().describe('The order id, head:order:<ulid>'),
        note: z.string().trim().min(1).describe('One or two sentences for the person; the first line is the title'),
      },
      annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ order_id, note }) => {
      try {
        const h = holding(order_id);
        const res = await head.submit(await own(order_id, h, `progress-${h.seq}-${h.n + 1}`, { kind: 'signal', urgency: 'log', title: firstLine(note)!, body: note }));
        h.n += 1;
        return result(landed(res));
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    'complete_order',
    {
      description: COMPLETE,
      inputSchema: {
        order_id: z.string().describe('The order id, head:order:<ulid>'),
        result: z.enum(['done', 'failed']).describe('"done", or "failed" if you could not do it or the order was cancelled'),
        title: z.string().describe('One line: what happened'),
        body: z.string().describe('What you did, with links; if you stopped early, what was and was not done'),
        kind: z.enum(['artifact', 'signal', 'decision']).default('artifact').describe('"artifact" (default), "signal", or "decision" when you propose something'),
        actions: z.array(z.unknown()).optional().describe('For a decision: the choices, e.g. ["approve", "reject", "edit"]'),
        summary: z.string().optional().describe('One plain line for the brief (§4.1)'),
        source: z.object({ url: z.string(), label: z.string().optional() }).optional().describe('Opens what the outcome is about'),
        labels: z.array(z.string()).optional(),
        about: z.string().optional().describe('YYYY-MM-DD'),
        at: z.string().optional().describe('UTC timestamp ending in Z'),
        until: z.string().optional().describe('UTC timestamp ending in Z'),
        urgency: z.enum(['immediate', 'brief', 'log']).optional(),
      },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ order_id, result: outcome, ...fields }) => {
      try {
        const h = holding(order_id);
        const res = await head.submit(await own(order_id, h, `outcome-${h.seq}`, { ...fields, [OUTCOME_CLAIM_SEQ]: h.seq, [OUTCOME_RESULT]: outcome }));
        held.delete(order_id);
        return result(landed(res));
      } catch (e) {
        return refusal(e);
      }
    },
  );

  return server;
}
