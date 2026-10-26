// Submit (RFC §7.1) as an n8n action: one card per input item. A 409 is an output, not an error.

import { card, type HeadClient } from '@pbcp/client';
import { encodeUpstream, type Kind, type ProducerCard, type Urgency } from '@pbcp/core';
import { NodeConnectionTypes, type IDataObject, type IExecuteFunctions, type INodeExecutionData, type INodeType, type INodeTypeDescription } from 'n8n-workflow';
import { actions, connect, errorJson, list, nodeError } from '../../shared.js';

interface Extra {
  thread?: string;
  urgency?: Urgency;
  actions?: unknown;
  references?: unknown;
  supersedes?: string;
  sourceUrl?: string;
  sourceLabel?: string;
}

/** The card for item `i`. Empty optional parameters are left out. */
function build(ctx: IExecuteFunctions, i: number, toPerson: string): ProducerCard {
  const p = (name: string) => ctx.getNodeParameter(name, i, '') as string;
  const x = ctx.getNodeParameter('additionalFields', i, {}) as Extra;
  return card({
    producer: p('producer'),
    namespace: p('namespace'),
    upstream: encodeUpstream(p('upstream')),
    intent: p('intent') || undefined,
    kind: p('kind') as Kind,
    to_person: toPerson,
    title: p('title'),
    body: p('body'),
    thread: x.thread || undefined,
    urgency: x.urgency || undefined,
    actions: x.actions ? actions(x.actions) : undefined,
    references: x.references ? list(x.references) : undefined,
    supersedes: x.supersedes || undefined,
    source: x.sourceUrl ? { url: x.sourceUrl, ...(x.sourceLabel ? { label: x.sourceLabel } : {}) } : undefined,
  });
}

export class PbcpSubmit implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'PBCP Submit',
    name: 'pbcpSubmit',
    icon: 'fa:paper-plane',
    group: ['output'],
    version: 1,
    subtitle: '={{$parameter["kind"]}}',
    description: 'Submits a card to a PBCP head and outputs the stored card',
    defaults: { name: 'PBCP Submit' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'pbcpApi', required: true }],
    properties: [
      { displayName: 'Producer', name: 'producer', type: 'string', default: '', required: true, description: "The token's producer root: the first segment of every id this token may submit" },
      { displayName: 'Namespace', name: 'namespace', type: 'string', default: '', required: true, description: 'Letters, digits and dashes' },
      { displayName: 'Upstream ID', name: 'upstream', type: 'string', default: '', required: true, description: "The upstream system's own key for the event; characters outside the id grammar are percent-encoded" },
      { displayName: 'Intent', name: 'intent', type: 'string', default: '', description: 'Optional suffix when one event yields several cards. Letters, digits and dashes.' },
      {
        displayName: 'Kind',
        name: 'kind',
        type: 'options',
        options: [
          { name: 'Decision', value: 'decision' },
          { name: 'Artifact', value: 'artifact' },
          { name: 'Signal', value: 'signal' },
        ],
        default: 'decision',
      },
      { displayName: 'To Person', name: 'toPerson', type: 'string', default: '', description: "Leave empty to address the head's owner" },
      { displayName: 'Title', name: 'title', type: 'string', default: '', required: true, description: 'One line' },
      { displayName: 'Body', name: 'body', type: 'string', typeOptions: { rows: 6 }, default: '', description: 'Markdown' },
      {
        displayName: 'Additional Fields',
        name: 'additionalFields',
        type: 'collection',
        placeholder: 'Add Field',
        default: {},
        options: [
          { displayName: 'Thread', name: 'thread', type: 'string', default: '' },
          {
            displayName: 'Urgency',
            name: 'urgency',
            type: 'options',
            options: [
              { name: 'Immediate', value: 'immediate' },
              { name: 'Brief', value: 'brief' },
              { name: 'Log', value: 'log' },
            ],
            default: 'brief',
          },
          {
            displayName: 'Actions',
            name: 'actions',
            type: 'string',
            default: '',
            placeholder: 'approve, reject',
            description: 'Decision cards only. Comma-separated ids, or a JSON array of ids and objects with id, label, body and default (RFC §4.4).',
          },
          { displayName: 'References', name: 'references', type: 'string', default: '', description: 'Comma-separated card ids' },
          { displayName: 'Supersedes', name: 'supersedes', type: 'string', default: '', description: 'ID of an earlier card in the same namespace' },
          { displayName: 'Source URL', name: 'sourceUrl', type: 'string', default: '' },
          { displayName: 'Source Label', name: 'sourceLabel', type: 'string', default: '' },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const head: HeadClient = await connect(this);
    let owner: Promise<string> | undefined;
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < this.getInputData().length; i++) {
      let fromHead = false;
      try {
        let toPerson = this.getNodeParameter('toPerson', i, '') as string;
        if (!toPerson) {
          fromHead = true;
          toPerson = await (owner ??= head.describe().then((d) => d.owner));
          fromHead = false;
        }
        const c = build(this, i, toPerson);
        fromHead = true;
        const { status, card: stored } = await head.submit(c);
        out.push({ json: { status, card: stored as unknown as IDataObject }, pairedItem: { item: i } });
      } catch (e) {
        if (this.continueOnFail()) {
          out.push({ json: { error: errorJson(e) }, pairedItem: { item: i } });
          continue;
        }
        throw nodeError(this.getNode(), e, fromHead, i);
      }
    }
    return [out];
  }
}
