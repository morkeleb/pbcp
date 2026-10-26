// An MCP adapter over HeadClient (RFC §7): submit_card and poll_changes. Not a second definition of the protocol.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HeadClient, HeadHttpError } from '@pbcp/client';
import { PbcpError, parseCardOrThrow } from '@pbcp/core';
import { z } from 'zod';

export const VERSION = '0.3.0';

export interface Config {
  baseUrl: string;
  token: string;
}

/** `--head URL` and `--token TOKEN` override `PBCP_HEAD_URL` and `PBCP_TOKEN`. */
export function configFrom(argv: string[], env: Record<string, string | undefined>): Config {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const baseUrl = flag('head') ?? env.PBCP_HEAD_URL;
  const token = flag('token') ?? env.PBCP_TOKEN;
  if (!baseUrl) throw new Error('no head: pass --head or set PBCP_HEAD_URL');
  if (!token) throw new Error('no token: pass --token or set PBCP_TOKEN');
  return { baseUrl, token };
}

const result = (value: object): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

/** Refusals come back as tool errors carrying the RFC status and code (§7.4), so the caller can fix the card. */
function refusal(e: unknown): CallToolResult {
  const error =
    e instanceof PbcpError ? { status: e.status, error: e.code, message: e.message }
    : e instanceof HeadHttpError ? { status: e.status, error: 'http', message: e.message, body: e.body }
    : { error: 'failed', message: e instanceof Error ? e.message : String(e) };
  return { content: [{ type: 'text', text: JSON.stringify(error, null, 2) }], isError: true };
}

const SUBMIT = `Submit a card to the person's head (PBCP §7.1). Pass the card as a JSON object, JSON text, or front-matter text (a YAML header between --- lines, then the markdown body).

Returns { status, card }. 201: new card stored. 200: already current; read card.state and card.decision, since the person may already have answered. 409: the person already decided an earlier version; card carries that decision. Never re-submit the same id after a 409; submit a new card with "supersedes" set to the old id if you still need an answer.`;

const POLL = `Read what changed on your cards since a cursor (PBCP §7.2). Pass after = 0 the first time, then the "next" from the previous call.

Returns { changes: [{ seq, card }], next }. A decided card has state "decided" and a "decision" (one of its actions, or edited with edited_proposal, dismissed, delegated). When next equals after there is nothing newer; otherwise call again with next.`;

export function createServer(head: Pick<HeadClient, 'submit' | 'sync'>): McpServer {
  const server = new McpServer({ name: 'pbcp', version: VERSION });

  server.registerTool(
    'submit_card',
    {
      description: SUBMIT,
      inputSchema: { card: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('The card: JSON object, JSON text, or front-matter text') },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ card }) => {
      try {
        return result(await head.submit(parseCardOrThrow(card)));
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

  return server;
}
