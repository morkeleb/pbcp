import { HeadClient, card } from '@pbcp/client';
import { stubHead, type Stub } from '@pbcp/client/testing';
import { describe, expect, it } from 'vitest';
import { pollContext as context, type PollOptions } from '../../fake-context.js';
import { PbcpTrigger } from './PbcpTrigger.node.js';

let stub: Stub;
/** A poll context whose `helpers.httpRequest` reaches the current stub head. */
const pollContext = (o: Omit<PollOptions, 'fetch'> & { fetch?: typeof fetch } = {}) => context({ fetch: (...a) => stub.fetch(...a), ...o });

/** A stub head holding `n` cards (seq 1..n), every other one a decision; the nodes reach it through n8n's request helper. */
async function headWith(n: number, pageSize = 2): Promise<Stub> {
  stub = stubHead({ pageSize });
  const head = new HeadClient({ baseUrl: 'https://head.test', token: 't', fetch: stub.fetch });
  for (let i = 1; i <= n; i++) {
    const kind = i % 2 ? 'decision' : 'artifact';
    await head.submit(card({ producer: 'n8n', namespace: 'test', upstream: `c${i}`, kind, to_person: 'morten', title: `card ${i}`, body: '' }));
  }
  stub.requests.length = 0;
  return stub;
}

const poll = (ctx: ReturnType<typeof pollContext>['ctx']) => new PbcpTrigger().poll.call(ctx);
const seqs = (out: Awaited<ReturnType<typeof poll>>) => out?.[0]?.map((i) => i.json.seq) ?? null;

describe('PbcpTrigger', () => {
  it("starts at the head's seq from describe on the first poll, without reading the feed, then emits only what changed after it", async () => {
    const stub = await headWith(3);
    stub.decideHere('n8n:test:c3', { decision: 'approve' }); // seq 4: the head's position is past the last card's first seq
    const { ctx, staticData } = pollContext();
    expect(await poll(ctx)).toBeNull();
    expect(staticData.after).toBe(4);
    expect(stub.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET https://head.test/']);

    stub.decideHere('n8n:test:c1', { decision: 'approve' });
    const out = await poll(ctx);
    expect(out?.[0]).toEqual([{ json: { seq: 5, card: expect.objectContaining({ id: 'n8n:test:c1', state: 'decided', decision: 'approve' }) } }]);
    expect(staticData.after).toBe(5);
    expect(await poll(ctx)).toBeNull();
    expect(stub.requests.filter((r) => r.url === 'https://head.test/')).toHaveLength(1);
  });

  it('sends through n8n\'s request helper: full response, status errors as responses, the JSON as a text body', async () => {
    await headWith(1);
    const { ctx, calls } = pollContext({ staticData: { after: 0 } });
    await poll(ctx);
    expect(calls[0]).toEqual({
      method: 'GET', url: 'https://head.test/changes?after=0', headers: { authorization: 'Bearer tok', accept: 'application/json' }, body: undefined,
      json: false, encoding: 'text', returnFullResponse: true, ignoreHttpStatusErrors: true,
    });
  });

  it('with startFrom beginning, pages through everything and stores the last next', async () => {
    await headWith(5);
    const { ctx, staticData } = pollContext({ params: { startFrom: 'beginning' } });
    expect(seqs(await poll(ctx))).toEqual([1, 2, 3, 4, 5]);
    expect(staticData.after).toBe(5);
  });

  it('filters: only decisions, only states; filtered-out changes still advance the cursor', async () => {
    const stub = await headWith(5);
    stub.decideHere('n8n:test:c3', { decision: 'reject' });
    const decisions = pollContext({ params: { onlyDecisions: true }, staticData: { after: 0 } });
    const out = await poll(decisions.ctx);
    expect(out?.[0]?.map((i) => (i.json.card as { id: string }).id)).toEqual(['n8n:test:c3']);
    expect(decisions.staticData.after).toBe(6);

    const open = pollContext({ params: { states: ['open'] }, staticData: { after: 0 } });
    expect(seqs(await poll(open.ctx))).toEqual([1, 2, 4, 5]);
    expect(open.staticData.after).toBe(6);

    const none = pollContext({ params: { states: ['superseded'] }, staticData: { after: 0 } });
    expect(await poll(none.ctx)).toBeNull();
    expect(none.staticData.after).toBe(6);
  });

  it('a later page that fails is not skipped: earlier items are returned and only their cursor stored', async () => {
    const stub = await headWith(5);
    let n = 0;
    const flaky: typeof fetch = (...args) => {
      if (++n === 2) stub.script(500, { error: 'boom' });
      return stub.fetch(...args);
    };
    const { ctx, staticData, warnings } = pollContext({ staticData: { after: 0 }, fetch: flaky });
    expect(seqs(await poll(ctx))).toEqual([1, 2]);
    expect(staticData.after).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(seqs(await poll(ctx))).toEqual([3, 4, 5]);
    expect(staticData.after).toBe(5);
  });

  it('throws when the first page fails, cursor untouched', async () => {
    const stub = await headWith(2);
    stub.script(500, { error: 'boom' });
    const { ctx, staticData } = pollContext({ staticData: { after: 1 } });
    await expect(poll(ctx)).rejects.toThrow(/500/);
    expect(staticData.after).toBe(1);
  });

  it('a next lower than after is an error and leaves the cursor', async () => {
    const stub = await headWith(0);
    stub.script(200, { changes: [], next: 3 });
    const { ctx, staticData } = pollContext({ staticData: { after: 10 } });
    await expect(poll(ctx)).rejects.toThrow(/returned next 3/);
    expect(staticData.after).toBe(10);
  });

  it('returns null when nothing changed', async () => {
    await headWith(2);
    const { ctx, staticData } = pollContext({ staticData: { after: 2 } });
    expect(await poll(ctx)).toBeNull();
    expect(staticData.after).toBe(2);
  });

  it('in manual mode returns the latest matching change and leaves the cursor alone', async () => {
    await headWith(5);
    const fresh = pollContext({ mode: 'manual', params: { onlyDecisions: false, states: ['open'] } });
    expect(seqs(await poll(fresh.ctx))).toEqual([5]);
    expect(fresh.staticData.after).toBeUndefined();

    const stored = pollContext({ mode: 'manual', params: { onlyDecisions: true }, staticData: { after: 3 } });
    expect(await poll(stored.ctx)).toBeNull();
    expect(stored.staticData.after).toBe(3);
  });
});
