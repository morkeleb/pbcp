import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS, setupOf } from '../../../scripts/setup-section.ts';
import { parseCardOrThrow } from '@pbcp/core';
import { connect, httpRequestNode } from './connect.js';

const values = { api: 'https://head.example/api', owner: 'anna', token: "pbcp_it's" };

describe('connect', () => {
  it('is the README Setup section, with placeholders (scripts/readme-setup.ts writes it)', () => {
    expect(setupOf(readFileSync(new URL('../README.md', import.meta.url), 'utf8'))).toBe(connect(PLACEHOLDERS).trim());
  });

  it('fills in the three values', () => {
    const md = connect(values);
    expect(md).not.toMatch(/<head url>|<owner>|<token>/);
    expect(md).toContain('- Head URL: `https://head.example/api`');
    const node = httpRequestNode(values).nodes[0]!;
    expect(node).toMatchObject({ type: 'n8n-nodes-base.httpRequest', parameters: { method: 'PUT', url: 'https://head.example/api/cards/n8n%3Aworkflow%3Afirst-card', specifyBody: 'json' } });
    expect(node.parameters.headerParameters.parameters).toEqual([{ name: 'Authorization', value: "Bearer pbcp_it's" }]);
    // What n8n sends: the expression evaluated. It is a valid card for the owner, under the root n8n.
    const sent = node.parameters.jsonBody.slice(1).replace('{{ $now.toUTC().toISO() }}', '2026-10-27T13:02:11.000Z');
    expect(parseCardOrThrow(sent)).toMatchObject({ id: 'n8n:workflow:first-card', producer: 'n8n', to_person: 'anna' });
  });
});
