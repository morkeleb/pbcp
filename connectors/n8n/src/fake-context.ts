// Just enough of n8n's IPollFunctions / IExecuteFunctions for the nodes. Parameters arrive resolved, as n8n
// resolves expressions before a node reads them. `helpers.httpRequest` stands in for n8n's request helper over a
// fetch function (a stub head's); it implements only the options the nodes use.

import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, IN8nHttpFullResponse, INode, IPollFunctions } from 'n8n-workflow';

const node: INode = { id: 'n1', name: 'PBCP', type: 'n8n-nodes-pbcp.test', typeVersion: 1, position: [0, 0], parameters: {} };
const credentials = { headUrl: 'https://head.test/', token: 'tok' };

/** n8n's `helpers.httpRequest` over `fetch`, for `returnFullResponse` with a text body; records every call's options. */
export function httpHelper(f: typeof fetch) {
  const calls: IHttpRequestOptions[] = [];
  const httpRequest = async (o: IHttpRequestOptions): Promise<IN8nHttpFullResponse> => {
    calls.push(o);
    if (!o.returnFullResponse || o.json !== false || o.encoding !== 'text') throw new Error('fake httpRequest: unsupported options');
    const res = await f(o.url, { method: o.method ?? 'GET', headers: o.headers as Record<string, string>, body: o.body as string | undefined });
    if (!o.ignoreHttpStatusErrors && res.status >= 400) throw new Error(`Request failed with status code ${res.status}`);
    return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  };
  return { helpers: { httpRequest }, calls };
}

export interface PollOptions {
  params?: Record<string, unknown>;
  staticData?: IDataObject;
  mode?: 'trigger' | 'manual';
  fetch: typeof fetch;
}

export function pollContext(o: PollOptions) {
  const staticData = o.staticData ?? {};
  const warnings: string[] = [];
  const http = httpHelper(o.fetch);
  const ctx = {
    getCredentials: async () => credentials,
    getNodeParameter: (name: string, fallback?: unknown) => (o.params && name in o.params ? o.params[name] : fallback),
    getWorkflowStaticData: () => staticData,
    getMode: () => o.mode ?? 'trigger',
    getNode: () => node,
    logger: { warn: (m: string) => warnings.push(m) },
    helpers: http.helpers,
  };
  return { ctx: ctx as unknown as IPollFunctions, staticData, warnings, calls: http.calls };
}

export function executeContext(items: Record<string, unknown>[], opts: { continueOnFail?: boolean; fetch: typeof fetch }) {
  const ctx = {
    getCredentials: async () => credentials,
    getInputData: () => items.map(() => ({ json: {} })),
    getNodeParameter: (name: string, i: number, fallback?: unknown) => (name in items[i]! ? items[i]![name] : fallback),
    continueOnFail: () => opts.continueOnFail ?? false,
    getNode: () => node,
    helpers: httpHelper(opts.fetch).helpers,
  };
  return ctx as unknown as IExecuteFunctions;
}
