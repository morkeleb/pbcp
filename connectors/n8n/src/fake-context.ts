// Just enough of n8n's IPollFunctions / IExecuteFunctions for the nodes. Parameters arrive resolved, as n8n
// resolves expressions before a node reads them.

import type { IDataObject, IExecuteFunctions, INode, IPollFunctions } from 'n8n-workflow';

const node: INode = { id: 'n1', name: 'PBCP', type: 'n8n-nodes-pbcp.test', typeVersion: 1, position: [0, 0], parameters: {} };
const credentials = { headUrl: 'https://head.test/', token: 'tok' };

export interface PollOptions {
  params?: Record<string, unknown>;
  staticData?: IDataObject;
  mode?: 'trigger' | 'manual';
}

export function pollContext(o: PollOptions = {}) {
  const staticData = o.staticData ?? {};
  const warnings: string[] = [];
  const ctx = {
    getCredentials: async () => credentials,
    getNodeParameter: (name: string, fallback?: unknown) => (o.params && name in o.params ? o.params[name] : fallback),
    getWorkflowStaticData: () => staticData,
    getMode: () => o.mode ?? 'trigger',
    getNode: () => node,
    logger: { warn: (m: string) => warnings.push(m) },
  };
  return { ctx: ctx as unknown as IPollFunctions, staticData, warnings };
}

export function executeContext(items: Record<string, unknown>[], opts: { continueOnFail?: boolean } = {}) {
  const ctx = {
    getCredentials: async () => credentials,
    getInputData: () => items.map(() => ({ json: {} })),
    getNodeParameter: (name: string, i: number, fallback?: unknown) => (name in items[i]! ? items[i]![name] : fallback),
    continueOnFail: () => opts.continueOnFail ?? false,
    getNode: () => node,
  };
  return ctx as unknown as IExecuteFunctions;
}
