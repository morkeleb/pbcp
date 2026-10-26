import type { IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { n8nTransport } from './shared.js';

/** A context whose request helper answers with `res`, as n8n's full response. */
const ctx = (res: unknown, calls: IHttpRequestOptions[] = []) =>
  ({ helpers: { httpRequest: async (o: IHttpRequestOptions) => (calls.push(o), res) } }) as unknown as IExecuteFunctions;

describe('n8nTransport', () => {
  it('sends the JSON text as is and maps the full response: lower-case headers, arrays joined', async () => {
    const calls: IHttpRequestOptions[] = [];
    const t = n8nTransport(ctx({ statusCode: 429, headers: { 'Retry-After': '3', 'set-cookie': ['a=1', 'b=2'] }, body: '{"error":"rate_limited"}' }, calls));
    const res = await t({ method: 'PUT', url: 'https://head.test/cards/x', headers: { 'content-type': 'application/json' }, body: '{"id":"x"}' });
    expect(res).toEqual({ status: 429, headers: { 'retry-after': '3', 'set-cookie': 'a=1, b=2' }, body: '{"error":"rate_limited"}' });
    expect(calls[0]).toMatchObject({ method: 'PUT', body: '{"id":"x"}', json: false, encoding: 'text', returnFullResponse: true, ignoreHttpStatusErrors: true });
  });

  it('turns a body the helper already parsed, a Buffer, or none back into text', async () => {
    const send = (body: unknown) => n8nTransport(ctx({ statusCode: 200, headers: {}, body }))({ method: 'GET', url: 'https://head.test/', headers: {} });
    expect((await send({ seq: 3 })).body).toBe('{"seq":3}');
    expect((await send(Buffer.from('{"seq":4}'))).body).toBe('{"seq":4}');
    expect((await send(undefined)).body).toBe('');
  });
});
