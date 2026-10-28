import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { encodeUpstream, exampleCard } from '@pbcp/core';
import { afterEach, describe, expect, it } from 'vitest';
import { card } from './card.js';
import { curlSnippet, producerConfig, shellQuote } from './snippets.js';
import { stubHead } from './testing.js';

const sh = promisify(execFile);
let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/** The in-process test head over real HTTP, so the snippet runs with curl exactly as a person would paste it. */
async function serve(owner: string) {
  const stub = stubHead({ owner });
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    const r = await stub.fetch(`https://head.test${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
    res.writeHead(r.status, Object.fromEntries(r.headers)).end(await r.text());
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return { stub, api: `http://127.0.0.1:${(server!.address() as AddressInfo).port}` };
}

const run = async (snippet: string) => JSON.parse((await sh('sh', ['-c', snippet])).stdout) as Record<string, unknown>;

describe('curlSnippet', () => {
  it('PUTs the §3 example, addressed to the owner, and the head stores it; the same command again changes nothing', async () => {
    const { stub, api } = await serve('anna');
    const snippet = curlSnippet({ api, owner: 'anna', token: 'hermes' });
    const first = await run(snippet);
    expect(first).toMatchObject({ id: exampleCard.id, to_person: 'anna', state: 'open', change_seq: 1, labels: ['billing-revamp'] });
    expect(first.body).toBe(exampleCard.body);
    expect(stub.cards.get(exampleCard.id)).toMatchObject({ title: exampleCard.title, source: exampleCard.source });
    expect(await run(snippet)).toMatchObject({ change_seq: 1 });
  });

  it('PUTs a given card as it is, and survives quotes and a trailing slash in the values', async () => {
    const { stub, api } = await serve('morten');
    const own = card({ producer: 'demo', namespace: 'it', upstream: encodeUpstream("o'clock"), kind: 'artifact', to_person: 'morten', title: `It's $HOME "quoted"`, body: 'Line\nCARD\n`x`' });
    expect(await run(curlSnippet({ api: `${api}/`, owner: 'ignored', token: 'demo', card: own }))).toMatchObject({ id: own.id, title: own.title, body: own.body, state: 'open' });
    expect(stub.cards.has(own.id)).toBe(true);
  });

  it('writes placeholders as given, for documentation', () => {
    const text = curlSnippet({ api: '<head url>', owner: '<owner>', token: '<token>' });
    expect(text.split('\n').slice(0, 4)).toEqual([
      "curl -s -X PUT '<head url>/cards/hermes%3Agmail%3A19a4f2e7c3b1' \\",
      "  -H 'Authorization: Bearer <token>' \\",
      "  -H 'Content-Type: application/json' \\",
      "  --data-binary @- <<'CARD'",
    ]);
    expect(text).toContain('"to_person": "<owner>"');
  });
});

describe('producerConfig', () => {
  it('gives the three values under the names the connectors read', () => {
    expect(producerConfig({ api: 'https://head.example/api', owner: 'morten', token: 'pbcp_x' })).toEqual({ PBCP_HEAD_URL: 'https://head.example/api', PBCP_TO_PERSON: 'morten', PBCP_TOKEN: 'pbcp_x' });
  });

  it('quotes a shell word so the shell reads it back exactly', async () => {
    for (const s of ["it's", '$HOME', 'a b', '"q"', '`x`']) expect((await sh('sh', ['-c', `printf %s ${shellQuote(s)}`])).stdout).toBe(s);
  });
});
