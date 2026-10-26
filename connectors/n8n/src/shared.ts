// What both nodes share: the client from the credential, and errors in n8n's shape.

import { HeadClient, HeadHttpError, type Transport } from '@pbcp/client';
import { PbcpError, type Action } from '@pbcp/core';
import {
  NodeApiError, NodeOperationError,
  type IExecuteFunctions, type IHttpRequestMethods, type IN8nHttpFullResponse, type INode, type IPollFunctions,
} from 'n8n-workflow';

/**
 * A Transport over n8n's own request helper, so the head is reached through n8n's proxy settings and request
 * logging. The body goes out as the client's JSON text and comes back as text; a non-2xx status is a response.
 */
export function n8nTransport(ctx: IExecuteFunctions | IPollFunctions): Transport {
  return async ({ method, url, headers, body }) => {
    const res = (await ctx.helpers.httpRequest({
      method: method as IHttpRequestMethods,
      url,
      headers,
      body,
      json: false,
      encoding: 'text',
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    })) as IN8nHttpFullResponse;
    const lower: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) lower[k.toLowerCase()] = v === undefined || v === null ? undefined : Array.isArray(v) ? v.join(', ') : String(v);
    return { status: res.statusCode, headers: lower, body: text(res.body) };
  };
}

/** The response body as text, whatever the helper made of it. */
function text(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return JSON.stringify(body); // already parsed as JSON by the helper
}

/** A HeadClient from the credential, sending through n8n's request helper. */
export async function connect(ctx: IExecuteFunctions | IPollFunctions): Promise<HeadClient> {
  const { headUrl, token } = await ctx.getCredentials<{ headUrl: string; token: string }>('pbcpApi');
  return new HeadClient({ baseUrl: headUrl, token, transport: n8nTransport(ctx) });
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
