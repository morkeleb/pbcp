// What both nodes share: the client from the credential, and errors in n8n's shape.

import { HeadClient, HeadHttpError } from '@pbcp/client';
import { PbcpError, type Action } from '@pbcp/core';
import { NodeApiError, NodeOperationError, type IExecuteFunctions, type INode, type IPollFunctions } from 'n8n-workflow';

/** A HeadClient on the global fetch; the nodes do not go through n8n's request helpers. */
export async function connect(ctx: IExecuteFunctions | IPollFunctions): Promise<HeadClient> {
  const { headUrl, token } = await ctx.getCredentials<{ headUrl: string; token: string }>('pbcpApi');
  return new HeadClient({ baseUrl: headUrl, token });
}

/** `{ status, code, message }` for a continueOnFail item; status and code only when the error has them. */
export function errorJson(e: unknown): { status?: number; code?: string; message: string } {
  if (e instanceof PbcpError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof HeadHttpError) return { status: e.status, message: e.message };
  return { message: e instanceof Error ? e.message : String(e) };
}

/** A refusal from the head is a NodeApiError carrying the RFC status and code (§7.4); anything local is a NodeOperationError. */
export function nodeError(node: INode, e: unknown, fromHead: boolean, itemIndex?: number): Error {
  if (e instanceof NodeApiError || e instanceof NodeOperationError) return e;
  const { status, code, message } = errorJson(e);
  const text = code ? `${code}: ${message}` : message;
  if (fromHead && status !== undefined) {
    const body = e instanceof HeadHttpError ? JSON.stringify(e.body) : undefined;
    return new NodeApiError(node, { error: code ?? null, message }, { message: text, description: body, httpCode: String(status), itemIndex });
  }
  return new NodeOperationError(node, text, { itemIndex });
}

/** `a, b ,c` → `[a, b, c]`; an array (from an expression) is taken as is. */
export const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Actions as `approve, reject` or as a JSON array of strings and §4.4 objects. Validation is the card's. */
export function actions(v: unknown): Action[] {
  if (Array.isArray(v)) return v as Action[];
  const s = String(v ?? '').trim();
  if (!s.startsWith('[')) return list(s);
  const parsed: unknown = JSON.parse(s);
  if (!Array.isArray(parsed)) throw new Error('actions: expected a JSON array');
  return parsed as Action[];
}
