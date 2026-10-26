import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HeadClient, card } from '@pbcp/client';
import { toFrontMatter } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { stubHead } from '../../client/test/stub.js';
import { configFrom, createServer } from './index.js';

const sample = (title = 'Hi') =>
  card({ producer: 'hermes', namespace: 'gmail', upstream: 'x1', kind: 'decision', to_person: 'morten', title, body: 'b', actions: ['approve', 'reject', 'edit'], emitted_at: '2026-10-26T10:00:00Z' });

async function setup() {
  const stub = stubHead({ pageSize: 2 });
  const server = createServer(new HeadClient({ baseUrl: 'https://head.test', token: 'tok', fetch: stub.fetch }));
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
  it('exposes exactly submit_card and poll_changes', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['poll_changes', 'submit_card']);
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
      await call('submit_card', { card: card({ producer: 'hermes', namespace: 'gmail', upstream: u, kind: 'signal', to_person: 'morten', title: u, body: '' }) });
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
