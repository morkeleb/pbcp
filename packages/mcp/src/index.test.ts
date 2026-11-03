import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { HeadClient, RELEASE_TAG, card } from '@pbcp/client';
import { toFrontMatter } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { STUB_NOW, stubHead } from '@pbcp/client/testing';
import { configFrom, createServer } from './index.js';

const sample = (title = 'Hi') =>
  card({ producer: 'hermes', namespace: 'gmail', upstream: 'x1', kind: 'decision', to_person: 'morten', title, body: 'b', actions: ['approve', 'reject', 'edit'], emitted_at: '2026-10-26T10:00:00Z' });

async function setup(opts: { executors?: string[]; stub?: ReturnType<typeof stubHead>; token?: string; toPerson?: string; now?: () => string } = {}) {
  const stub = opts.stub ?? stubHead({ pageSize: 2, executors: opts.executors, roots: { tok: 'hermes' }, now: opts.now });
  const server = createServer(new HeadClient({ baseUrl: 'https://head.test', token: opts.token ?? 'tok', fetch: stub.fetch }), { toPerson: opts.toPerson });
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
  it('exposes exactly submit_card, poll_changes, claim_order, report_progress and complete_order', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['claim_order', 'complete_order', 'poll_changes', 'report_progress', 'submit_card']);
  });

  it('tells the model how to pick a kind and an urgency (RFC §4.1a)', async () => {
    const { client } = await setup();
    const submit = (await client.listTools()).tools.find((t) => t.name === 'submit_card')!.description!;
    expect(submit).toContain('"decision" to choose');
    expect(submit).toContain('"signal" to know');
    expect(submit).toContain('"artifact" to read');
    expect(submit).toContain('"log" is only recorded');
    expect(submit).toContain('**`at` is when the subject happens.** A card has three times and they answer three different questions.');
    expect(submit).toContain('A subject with a day but no time (an all-day event, a date-only deadline) takes `about` alone.');
    expect(submit).toContain("Do not write the time only there: a time in the title or summary is for the person, who reads the brief's line; `at` is for the head, which reads nothing else.");
    expect(submit).not.toContain('Write the time nowhere else');
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

  it('report_progress mints sequential ids per claim, and starts over on a new claim (A.3, A.4)', async () => {
    let now = STUB_NOW;
    const { call, stub } = await setup({ executors: ['hermes'], now: () => now });
    const o = stub.order({ to_producer: 'hermes', title: 'Book the dentist', body: '' });
    const ulid = o.id.split(':')[2]!;
    await call('claim_order', { id: o.id });
    const first = await call('report_progress', { order_id: o.id, note: 'Started: booking the dentist for next week.\nTrying Dr Holm first.' });
    expect(first).toMatchObject({ isError: false, json: { status: 201, id: `hermes:order:${ulid}:progress-1-1` } });
    expect(stub.cards.get(`hermes:order:${ulid}:progress-1-1`)).toMatchObject({
      kind: 'signal', urgency: 'log', thread: o.id, references: [o.id], to_person: 'morten',
      title: 'Started: booking the dentist for next week.', body: 'Started: booking the dentist for next week.\nTrying Dr Holm first.',
    });
    await call('claim_order', { id: o.id }); // a renewal keeps claim_seq and the count
    expect((await call('report_progress', { order_id: o.id, note: 'Booked Tue 09:00.' })).json.id).toBe(`hermes:order:${ulid}:progress-1-2`);
    now = '2026-10-26T13:00:00Z'; // the lease lapses; the next claim is claim_seq 2
    expect((await call('claim_order', { id: o.id })).json.order.claim_seq).toBe(2);
    expect((await call('report_progress', { order_id: o.id, note: 'Started again.' })).json.id).toBe(`hermes:order:${ulid}:progress-2-1`);
  });

  it('report_progress and complete_order refuse an order this server has not claimed, without a request', async () => {
    const { call, stub } = await setup({ executors: ['hermes'] });
    const o = stub.order({ to_producer: 'hermes', title: 'Book the dentist', body: '' });
    const before = stub.requests.length;
    expect(await call('report_progress', { order_id: o.id, note: 'Started.' })).toMatchObject({ isError: true, json: { error: 'not_claimed', message: expect.stringContaining('claim_order') } });
    expect(await call('complete_order', { order_id: o.id, result: 'done', title: 'Done', body: '' })).toMatchObject({ isError: true, json: { error: 'not_claimed' } });
    expect(stub.requests.length).toBe(before);
  });

  it('forgets a claim another executor took over (409), and keeps one for the report after a cancel (410, A.5)', async () => {
    let now = STUB_NOW;
    const { call, stub } = await setup({ executors: ['hermes', 'cal'], now: () => now });
    const o = stub.order({ to_producer: '*', title: 'Book the dentist', body: '' });
    await call('claim_order', { id: o.id });
    now = '2026-10-26T13:00:00Z';
    await (await setup({ stub, token: 'cal' })).call('claim_order', { id: o.id });
    expect((await call('claim_order', { id: o.id })).json).toMatchObject({ status: 409, error: 'lease_held' });
    expect((await call('report_progress', { order_id: o.id, note: 'Still here.' })).json.error).toBe('not_claimed');

    const p = stub.order({ to_producer: 'hermes', title: 'Water the plants', body: '' });
    await call('claim_order', { id: p.id });
    stub.decideHere(p.id, { decision: 'dismissed' });
    expect((await call('claim_order', { id: p.id })).json).toMatchObject({ status: 410, error: 'order_terminal' });
    const report = await call('complete_order', { order_id: p.id, result: 'failed', title: 'Stopped: the order was cancelled', body: 'Nothing was watered.' });
    expect(report).toMatchObject({ isError: false, json: { status: 201, card: { 'orders.result': 'failed' } } });
    expect(stub.cards.get(p.id)).toMatchObject({ exec_state: 'cancelled' });
  });

  it('complete_order posts a valid outcome: an artifact by default, or a decision that proposes (A.3)', async () => {
    const { call, stub } = await setup({ executors: ['hermes'] });
    const o = stub.order({ to_producer: 'hermes', title: 'Book the dentist', body: '' });
    const ulid = o.id.split(':')[2]!;
    await call('claim_order', { id: o.id });
    await call('report_progress', { order_id: o.id, note: 'Started.' });
    const res = await call('complete_order', {
      order_id: o.id, result: 'done', title: 'Booked the dentist for Tue 3 Nov 09:00', body: 'Dr Holm, 15 minutes.',
      summary: 'Booked the dentist for Tuesday at 09:00 with Dr Holm.', at: '2026-11-03T08:00:00Z', until: '2026-11-03T08:15:00Z',
      source: { url: 'https://calendar.example/e/1', label: 'Open in Calendar' },
    });
    expect(res).toMatchObject({ isError: false, json: { status: 201, id: `hermes:order:${ulid}:outcome-1` } });
    expect(stub.cards.get(`hermes:order:${ulid}:outcome-1`)).toMatchObject({
      kind: 'artifact', thread: o.id, references: [o.id], 'orders.claim_seq': 1, 'orders.result': 'done',
      at: '2026-11-03T08:00:00Z', until: '2026-11-03T08:15:00Z', source: { url: 'https://calendar.example/e/1' },
    });
    expect(stub.cards.get(o.id)).toMatchObject({ exec_state: 'done' });
    // The claim is closed: the server holds it no longer.
    expect((await call('report_progress', { order_id: o.id, note: 'More.' })).json.error).toBe('not_claimed');

    const d = stub.order({ to_producer: 'hermes', title: 'Answer Lars', body: '' });
    await call('claim_order', { id: d.id });
    const draft = await call('complete_order', { order_id: d.id, result: 'done', kind: 'decision', actions: ['approve', 'reject', 'edit'], title: 'Send this reply to Lars?', body: '> Yes.', summary: 'A reply to Lars accepting the renewal; send it?' });
    expect(draft.json).toMatchObject({ status: 201, card: { kind: 'decision', actions: ['approve', 'reject', 'edit'], 'orders.result': 'done' } });
    const bad = stub.order({ to_producer: 'hermes', title: 'X', body: '' });
    await call('claim_order', { id: bad.id });
    expect(await call('complete_order', { order_id: bad.id, result: 'done', title: 'two\nlines', body: '' })).toMatchObject({ isError: true, json: { status: 400, error: 'invalid_card' } });
  });

  it('the executor skill closes orders with the tools, not with ids it assembles', () => {
    const skill = readFileSync(new URL('../../../connectors/hermes/skills/pbcp-executor/SKILL.md', import.meta.url), 'utf8');
    expect(skill).toContain('`report_progress`');
    expect(skill).toContain('`complete_order`');
    expect(skill).not.toMatch(/progress-<claim_seq>|outcome-<claim_seq>/);
  });

  it('addresses a card without to_person to the head\'s owner, read once from its description (§7.5, §10)', async () => {
    const { call, stub } = await setup();
    const { to_person, ...bare } = sample();
    expect(to_person).toBe('morten');
    const first = await call('submit_card', { card: bare });
    expect(first).toMatchObject({ isError: false, json: { status: 201, id: 'hermes:gmail:x1', state: 'open', change_seq: 1, card: { to_person: 'morten' } } });
    expect(stub.cards.get('hermes:gmail:x1')).toMatchObject({ to_person: 'morten' });
    // The same card as JSON text and as front matter, still without to_person: identical, so 200 and no new change_seq.
    expect((await call('submit_card', { card: JSON.stringify(bare) })).json).toMatchObject({ status: 200, change_seq: 1 });
    const fm = toFrontMatter(sample()).replace(/^to_person: .*\n/m, '');
    expect(fm).not.toContain('to_person');
    expect((await call('submit_card', { card: fm })).json).toMatchObject({ status: 200, change_seq: 1 });
    expect(stub.requests.filter((r) => r.method === 'GET' && r.url === 'https://head.test/')).toHaveLength(1);
  });

  it('uses a configured addressee instead of describing the head, and leaves a given to_person alone', async () => {
    const { call, stub } = await setup({ toPerson: 'morten' });
    const { to_person: _, ...bare } = sample();
    expect((await call('submit_card', { card: bare })).json).toMatchObject({ status: 201, card: { to_person: 'morten' } });
    expect((await call('submit_card', { card: { ...sample('Other'), to_person: 'anna' } })).json).toMatchObject({ status: 403, error: 'wrong_person' });
    expect(stub.requests.some((r) => r.method === 'GET' && r.url === 'https://head.test/')).toBe(false);
  });

  it('submits a card given as an object, as JSON text, or as front-matter text', async () => {
    const { call } = await setup();
    const first = await call('submit_card', { card: sample() });
    expect(first).toMatchObject({ isError: false, json: { status: 201, card: { id: 'hermes:gmail:x1', state: 'open' } } });
    expect(first.structured).toEqual(first.json);
    expect((await call('submit_card', { card: JSON.stringify(sample()) })).json.status).toBe(200);
    expect((await call('submit_card', { card: toFrontMatter(sample()) })).json).toMatchObject({ status: 200, card: { change_seq: 1 } });
  });

  it('carries summary through in every form, and refuses one with a line break (§4.1)', async () => {
    const { call } = await setup();
    const withSummary = { ...sample(), summary: 'Anna asks to pay on the 20th. Approve the reply?' };
    expect((await call('submit_card', { card: withSummary })).json).toMatchObject({ status: 201, card: { summary: withSummary.summary } });
    expect((await call('submit_card', { card: toFrontMatter(withSummary) })).json).toMatchObject({ status: 200, card: { summary: withSummary.summary, change_seq: 1 } });
    const bad = await call('submit_card', { card: { ...sample(), summary: 'two\nlines' } });
    expect(bad).toMatchObject({ isError: true, json: { status: 400, error: 'invalid_card' } });
  });

  it('carries labels and about through in every form, and refuses ones that break §4.1', async () => {
    const { call } = await setup();
    const tagged = { ...sample(), labels: ['billing-revamp', 'nordic-supply'], about: '2026-10-30' };
    expect((await call('submit_card', { card: tagged })).json).toMatchObject({ status: 201, card: { labels: tagged.labels, about: '2026-10-30' } });
    expect((await call('submit_card', { card: toFrontMatter(tagged) })).json).toMatchObject({ status: 200, card: { labels: tagged.labels, about: '2026-10-30', change_seq: 1 } });
    for (const bad of [{ labels: ['Billing'] }, { labels: Array.from({ length: 9 }, (_, i) => `l${i}`) }, { about: '2026-02-30' }]) {
      expect(await call('submit_card', { card: { ...sample(), ...bad } })).toMatchObject({ isError: true, json: { status: 400, error: 'invalid_card' } });
    }
  });

  it('carries at and until through in every form, and refuses a pair that breaks §4.1', async () => {
    const { call } = await setup();
    const timed = { ...sample(), about: '2026-11-03', at: '2026-11-03T09:15:00Z', until: '2026-11-03T09:30:00Z' };
    expect((await call('submit_card', { card: timed })).json).toMatchObject({ status: 201, card: { at: timed.at, until: timed.until } });
    expect((await call('submit_card', { card: toFrontMatter(timed) })).json).toMatchObject({ status: 200, card: { at: timed.at, until: timed.until, change_seq: 1 } });
    for (const bad of [{ until: '2026-11-03T09:30:00Z' }, { at: '2026-11-03T09:30:00Z', until: '2026-11-03T09:15:00Z' }, { at: '2026-11-03' }]) {
      expect(await call('submit_card', { card: { ...sample('Other'), ...bad } })).toMatchObject({ isError: true, json: { status: 400, error: 'invalid_card' } });
    }
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
    expect(configFrom([], { PBCP_HEAD_URL: 'https://h', PBCP_TOKEN: 't', PBCP_TO_PERSON: 'anna' })).toEqual({ baseUrl: 'https://h', token: 't', toPerson: 'anna' });
    expect(configFrom(['--to-person', 'lars'], { PBCP_HEAD_URL: 'https://h', PBCP_TOKEN: 't', PBCP_TO_PERSON: 'anna' }).toPerson).toBe('lars');
    expect(configFrom([], { PBCP_HEAD_URL: 'https://h', PBCP_TOKEN: 't', PBCP_TO_PERSON: '' })).not.toHaveProperty('toPerson');
    expect(configFrom(['--head', 'https://f', '--token', 'ft'], { PBCP_HEAD_URL: 'https://h', PBCP_TOKEN: 't' })).toEqual({ baseUrl: 'https://f', token: 'ft' });
    expect(() => configFrom([], {})).toThrow(/PBCP_HEAD_URL/);
    expect(() => configFrom([], { PBCP_HEAD_URL: 'https://h' })).toThrow(/PBCP_TOKEN/);
  });
});

describe('README', () => {
  it('points a checkout at the current release tag (#20)', () => {
    expect(readFileSync(new URL('../README.md', import.meta.url), 'utf8')).toContain(`git clone --branch ${RELEASE_TAG} --depth 1`);
  });
});
