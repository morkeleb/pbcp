import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HeadClient, card } from '@pbcp/client';
import { toFrontMatter } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { stubHead } from '@pbcp/client/testing';
import { configFrom, createServer } from './index.js';

const sample = (title = 'Hi') =>
  card({ producer: 'hermes', namespace: 'gmail', upstream: 'x1', kind: 'decision', to_person: 'morten', title, body: 'b', actions: ['approve', 'reject', 'edit'], emitted_at: '2026-10-26T10:00:00Z' });

async function setup(opts: { executors?: string[]; stub?: ReturnType<typeof stubHead>; token?: string } = {}) {
  const stub = opts.stub ?? stubHead({ pageSize: 2, executors: opts.executors, roots: { tok: 'hermes' } });
  const server = createServer(new HeadClient({ baseUrl: 'https://head.test', token: opts.token ?? 'tok', fetch: stub.fetch }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
    return { isError: res.isError ?? false, json: JSON.parse(res.content[0]!.text), structured: res.structuredContent };
  };
  return { stub, client, call };
}

describe('@pbcp/mcp', () => {
  it('exposes exactly submit_card, poll_changes and claim_order', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['claim_order', 'poll_changes', 'submit_card']);
  });

  it('claims and renews an order, and reports 409 and 410 as tool errors with their code', async () => {
    const { call, stub } = await setup({ executors: ['hermes', 'cal'] });
    const o = stub.order({ to_producer: '*', title: 'Book the dentist', body: '' });
    expect(await call('claim_order', { id: o.id })).toMatchObject({ isError: false, json: { order: { exec_state: 'claimed', claimed_by: 'hermes', claim_seq: 1 } } });
    expect((await call('claim_order', { id: o.id, lease_seconds: 30 })).json.order.claim_seq).toBe(1); // a renewal keeps claim_seq
    const cal = await setup({ stub, token: 'cal' });
    expect(await cal.call('claim_order', { id: o.id })).toMatchObject({ isError: true, json: { status: 409, error: 'lease_held', order: { claimed_by: 'hermes' } } });
    stub.decideHere(o.id, { decision: 'dismissed' });
    expect(await call('claim_order', { id: o.id })).toMatchObject({ isError: true, json: { status: 410, error: 'order_terminal', order: { exec_state: 'cancelled' } } });
    expect(await call('claim_order', { id: 'head:order:01J9Q3K7X2ABCDEFGHJKMNPQRS' })).toMatchObject({ isError: true, json: { status: 404, error: 'not_found' } });
  });

  it('closes an order with an outcome card that carries orders.claim_seq', async () => {
    const { call, stub } = await setup({ executors: ['hermes'] });
    const o = stub.order({ to_producer: 'hermes', title: 'Water the plants', body: '' });
    const seq = (await call('claim_order', { id: o.id })).json.order.claim_seq;
    const ulid = o.id.split(':')[2]!;
    const res = await call('submit_card', { card: card({ producer: 'hermes', namespace: 'order', upstream: ulid, intent: `outcome-${seq}`, kind: 'signal', to_person: 'morten', title: 'Watered', body: '', thread: o.id, references: [o.id], 'orders.claim_seq': seq, 'orders.result': 'done' }) });
    expect(res.json.status).toBe(201);
    expect(stub.cards.get(o.id)).toMatchObject({ exec_state: 'done' });
  });

  it('submits a card given as an object, as JSON text, or as front-matter text', async () => {
    const { call } = await setup();
    const first = await call('submit_card', { card: sample() });
    expect(first).toMatchObject({ isError: false, json: { status: 201, card: { id: 'hermes:gmail:x1', state: 'open' } } });
    expect(first.structured).toEqual(first.json);
    expect((await call('submit_card', { card: JSON.stringify(sample()) })).json.status).toBe(200);
    expect((await call('submit_card', { card: toFrontMatter(sample()) })).json).toMatchObject({ status: 200, card: { change_seq: 1 } });
  });

  it('returns a 409 with the decision as a result, not an error', async () => {
    const { call, stub } = await setup();
    await call('submit_card', { card: sample() });
    stub.decideHere('hermes:gmail:x1', { decision: 'edited', edited_proposal: 'shorter' });
    const res = await call('submit_card', { card: sample('Changed') });
    expect(res).toMatchObject({ isError: false, json: { status: 409, card: { decision: 'edited', edited_proposal: 'shorter' } } });
  });

  it('reports refusals as tool errors with the RFC status and code', async () => {
    const { call, stub } = await setup();
    const local = await call('submit_card', { card: { ...sample(), state: 'open' } });
    expect(local).toMatchObject({ isError: true, json: { status: 400, error: 'head_owned_field' } });
    expect(stub.requests).toHaveLength(0);
    expect((await call('submit_card', { card: '---\ntitle: |\n  x\n---\n' })).json).toMatchObject({ status: 400, error: 'yaml_outside_subset' });
    stub.script(403, { error: 'wrong_person', message: 'not the owner' });
    expect((await call('submit_card', { card: sample() })).json).toEqual({ status: 403, error: 'wrong_person', message: 'not the owner' });
    stub.script(502, 'bad gateway');
    expect((await call('poll_changes', { after: 0 })).json).toMatchObject({ status: 502, error: 'http', body: 'bad gateway' });
  });

  it('polls changes page by page with the cursor it returns', async () => {
    const { call, stub } = await setup();
    for (const u of ['a', 'b', 'c']) {
      await call('submit_card', { card: card({ producer: 'hermes', namespace: 'gmail', upstream: u, kind: 'decision', to_person: 'morten', title: u, body: '' }) });
    }
    stub.decideHere('hermes:gmail:a', { decision: 'approve' });
    const p1 = await call('poll_changes', { after: 0 });
    expect(p1.json).toMatchObject({ next: 3, changes: [{ seq: 2, card: { id: 'hermes:gmail:b' } }, { seq: 3 }] });
    expect(p1.json.changes).toHaveLength(2);
    const p2 = await call('poll_changes', { after: p1.json.next });
    expect(p2.json.changes.map((c: { seq: number }) => c.seq)).toEqual([4]);
    expect(p2.json.changes[0].card).toMatchObject({ id: 'hermes:gmail:a', state: 'decided', decision: 'approve' });
    expect((await call('poll_changes', { after: 4 })).json).toEqual({ changes: [], next: 4 });
  });

  it('rejects a cursor that is not a non-negative integer', async () => {
    const { client, stub } = await setup();
    expect(await client.callTool({ name: 'poll_changes', arguments: { after: -1 } })).toMatchObject({ isError: true });
    expect(stub.requests).toHaveLength(0);
  });
});

describe('configFrom', () => {
  it('reads the environment, and flags override it', () => {
    expect(configFrom([], { PBCP_HEAD_URL: 'https://h', PBCP_TOKEN: 't' })).toEqual({ baseUrl: 'https://h', token: 't' });
    expect(configFrom(['--head', 'https://f', '--token', 'ft'], { PBCP_HEAD_URL: 'https://h', PBCP_TOKEN: 't' })).toEqual({ baseUrl: 'https://f', token: 'ft' });
    expect(() => configFrom([], {})).toThrow(/PBCP_HEAD_URL/);
    expect(() => configFrom([], { PBCP_HEAD_URL: 'https://h' })).toThrow(/PBCP_TOKEN/);
  });
});
