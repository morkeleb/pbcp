// Sync (RFC §7.2) as an n8n polling trigger. The cursor lives in the node's workflow static data.

import type { Change, HeadClient } from '@pbcp/client';
import type { State } from '@pbcp/core';
import { NodeConnectionTypes, type IDataObject, type INodeExecutionData, type INodeType, type INodeTypeDescription, type IPollFunctions } from 'n8n-workflow';
import { connect, nodeError } from '../../shared.js';

interface Walk {
  changes: Change[];
  next: number;
  /** Why the walk stopped early; the pages before it stand. */
  error?: unknown;
}

/**
 * Pages from `after` until `next` stops moving, keeping the changes that pass `keep` (only the last `last`, if given).
 * A failed or backwards page ends the walk at the last good `next`; when it is the first page, it throws.
 */
export async function walk(head: Pick<HeadClient, 'sync'>, after: number, keep: (c: Change) => boolean, last = Infinity): Promise<Walk> {
  const changes: Change[] = [];
  let next = after;
  for (;;) {
    let error: unknown;
    try {
      const page = await head.sync(next);
      if (page.next < next) error = new Error(`sync after ${next} returned next ${page.next}; the cursor is not moved`);
      else {
        changes.push(...page.changes.filter(keep));
        changes.splice(0, changes.length - last);
        if (page.next === next) return { changes, next };
        next = page.next;
        continue;
      }
    } catch (e) {
      error = e;
    }
    if (next === after) throw error;
    return { changes, next, error };
  }
}

const item = (c: Change): INodeExecutionData => ({ json: { seq: c.seq, card: c.card as unknown as IDataObject } });

export class PbcpTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'PBCP Trigger',
    name: 'pbcpTrigger',
    icon: 'fa:inbox',
    group: ['trigger'],
    version: 1,
    description: 'Emits one item per card changed at a PBCP head since the last poll',
    defaults: { name: 'PBCP Trigger' },
    polling: true,
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'pbcpApi', required: true }],
    properties: [
      {
        displayName: 'Only Decisions',
        name: 'onlyDecisions',
        type: 'boolean',
        default: false,
        description: 'Whether to emit only decision cards the person has decided',
      },
      {
        displayName: 'Only Cards in These States',
        name: 'states',
        type: 'multiOptions',
        options: [
          { name: 'Open', value: 'open' },
          { name: 'Decided', value: 'decided' },
          { name: 'Superseded', value: 'superseded' },
        ],
        default: [],
        description: 'Emit only cards in these states; none selected emits every state',
      },
      {
        displayName: 'Start From',
        name: 'startFrom',
        type: 'options',
        options: [
          { name: 'Now', value: 'now', description: 'Skip changes made before the first poll' },
          { name: 'Beginning', value: 'beginning', description: 'Emit every change the head has, on the first poll' },
        ],
        default: 'now',
        description: 'Where the cursor starts when the workflow is first activated',
      },
    ],
  };

  async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
    const onlyDecisions = this.getNodeParameter('onlyDecisions', false) as boolean;
    const states = this.getNodeParameter('states', []) as State[];
    const keep = ({ card }: Change) =>
      (!onlyDecisions || (card.kind === 'decision' && card.state === 'decided')) && (states.length === 0 || states.includes(card.state));
    const data = this.getWorkflowStaticData('node') as { after?: number };
    const head = await connect(this);

    try {
      // A manual test run shows the latest matching change and leaves the cursor alone.
      if (this.getMode() === 'manual') {
        const { changes } = await walk(head, 0, keep, 1);
        return changes.length ? [changes.map(item)] : null;
      }
      if (data.after === undefined && this.getNodeParameter('startFrom', 'now') === 'now') {
        const { next, error } = await walk(head, 0, () => false);
        if (error) throw error;
        data.after = next;
        return null;
      }
      const { changes, next, error } = await walk(head, data.after ?? 0, keep);
      if (error) this.logger.warn(`pbcp: sync stopped at ${next}; the rest is fetched on the next poll`, { error: String(error) });
      data.after = next;
      return changes.length ? [changes.map(item)] : null;
    } catch (e) {
      throw nodeError(this.getNode(), e, true);
    }
  }
}
