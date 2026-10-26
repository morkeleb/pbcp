// Parameters are plain values here: n8n resolves expressions ({{ $json.subject }}) before a node reads them,
// so a parameter set by expression is no different from one typed in.

import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubHead, type Stub } from '../../../../../packages/client/test/stub.js';
import { executeContext } from '../../fake-context.js';
import { PbcpSubmit } from './PbcpSubmit.node.js';

let stub: Stub;
beforeEach(() => {
  stub = stubHead({ owner: 'anna' });
  vi.stubGlobal('fetch', stub.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const base = { producer: 'n8n', namespace: 'alerts', upstream: 'disk-full', kind: 'decision', title: 'Disk full on db1', body: 'Evidence.' };
const run = (items: Record<string, unknown>[], continueOnFail = false) => new PbcpSubmit().execute.call(executeContext(items, { continueOnFail }));
const json = (out: Awaited<ReturnType<typeof run>>) => out[0]!.map((i) => i.json as { status?: number; card?: Record<string, unknown>; error?: unknown });

describe('PbcpSubmit', () => {
  it('outputs 201, then 200 for the same card, then 409 with the decision once it is locked', async () => {
    expect(json(await run([base]))[0]).toMatchObject({ status: 201, card: { id: 'n8n:alerts:disk-full', state: 'open', to_person: 'anna' } });
    expect(json(await run([base]))[0]!.status).toBe(200);
    stub.decideHere('n8n:alerts:disk-full', { decision: 'approve' });
    const out = await run([{ ...base, title: 'Disk still full on db1' }]);
    expect(out[0]![0]).toMatchObject({ json: { status: 409, card: { state: 'decided', decision: 'approve', title: 'Disk full on db1' } }, pairedItem: { item: 0 } });
  });

  it("defaults to_person to the head's owner, describing once per execution", async () => {
    const out = json(await run([base, { ...base, upstream: 'disk-full-2' }, { ...base, upstream: 'x', toPerson: 'morten' }]));
    expect(out.map((o) => o.card?.to_person)).toEqual(['anna', 'anna', 'morten']);
    expect(stub.requests.filter((r) => r.method === 'GET')).toHaveLength(1);
  });

  it('builds the optional fields: actions as a list or JSON, references, source; encodes the upstream key', async () => {
    const [a, b] = json(await run([
      {
        ...base,
        upstream: '<19a4@mail.example>',
        intent: 'reply',
        additionalFields: { thread: 'db1', urgency: 'immediate', actions: ' restart , ignore ', references: 'n8n:alerts:a, n8n:alerts:b', sourceUrl: 'https://grafana.example/d/1', sourceLabel: 'Dashboard' },
      },
      { ...base, upstream: 'choice', additionalFields: { actions: '[{"id":"now","label":"Now","default":true},"later","edit"]', supersedes: 'n8n:alerts:disk-full' } },
    ]));
    expect(a!.card).toMatchObject({
      id: 'n8n:alerts:%3C19a4%40mail.example%3E:reply',
      thread: 'db1',
      urgency: 'immediate',
      actions: ['restart', 'ignore'],
      references: ['n8n:alerts:a', 'n8n:alerts:b'],
      source: { url: 'https://grafana.example/d/1', label: 'Dashboard' },
    });
    expect(b!.card).toMatchObject({ actions: [{ id: 'now', label: 'Now', default: true }, 'later', 'edit'], supersedes: 'n8n:alerts:disk-full' });
  });

  it('refuses a card that does not conform before calling the head; continueOnFail emits the error', async () => {
    const bad = { ...base, namespace: 'not ok', toPerson: 'morten' };
    const err = await run([bad]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeOperationError);
    expect((err as Error).message).toMatch(/^invalid_id: /);
    expect(stub.requests).toHaveLength(0);

    const out = await run([bad, base], true);
    expect(out[0]![0]).toEqual({ json: { error: { status: 400, code: 'invalid_id', message: expect.any(String) } }, pairedItem: { item: 0 } });
    expect(out[0]![1]).toMatchObject({ json: { status: 201 }, pairedItem: { item: 1 } });
  });

  it('turns a head refusal into a NodeApiError with the RFC code, or an error item under continueOnFail', async () => {
    stub.script(403, { error: 'outside_root', message: 'token root is hermes' });
    const err = await run([{ ...base, toPerson: 'morten' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeApiError);
    expect(err).toMatchObject({ httpCode: '403', message: 'outside_root: token root is hermes' });

    stub.script(403, { error: 'outside_root', message: 'token root is hermes' });
    const out = await run([{ ...base, toPerson: 'morten' }], true);
    expect(out[0]![0]!.json).toEqual({ error: { status: 403, code: 'outside_root', message: 'token root is hermes' } });
  });

  it('rejects actions on an artifact, and JSON actions that are not an array', async () => {
    const out = json(await run([
      { ...base, kind: 'artifact', additionalFields: { actions: 'approve' } },
      { ...base, additionalFields: { actions: '[not json' } },
      { ...base, additionalFields: { actions: '[]' } },
    ], true));
    expect(out[0]!.error).toMatchObject({ status: 400 });
    expect(out[1]!.error).toMatchObject({ message: expect.stringMatching(/JSON/) });
    expect(out[2]!.status).toBe(201);
  });
});
