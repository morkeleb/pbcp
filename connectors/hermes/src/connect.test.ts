import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS, setupOf } from '../../../scripts/setup-section.ts';
import { connect, mcpServer } from './connect.js';

const values = { api: 'https://head.example/api', owner: 'anna', token: "pbcp_it's" };

describe('connect', () => {
  it('is the README Setup section, with placeholders (scripts/readme-setup.ts writes it)', () => {
    expect(setupOf(readFileSync(new URL('../README.md', import.meta.url), 'utf8'))).toBe(connect(PLACEHOLDERS).trim());
  });

  it('fills in the three values', () => {
    const md = connect(values);
    expect(md).not.toMatch(/<head url>|<owner>|<token>/);
    expect(md).toContain(`export PBCP_HEAD_URL='https://head.example/api' PBCP_TOKEN='pbcp_it'\\''s'`);
    expect(md).toContain("head's owner (`anna`)");
    // Until @pbcp/mcp is on npm: a checkout at the release tag, and the server run from it (#20).
    expect(md).toContain('git clone --branch v');
    expect(mcpServer(values, '/srv/pbcp/').mcpServers.pbcp).toMatchObject({ command: 'node', args: ['/srv/pbcp/packages/mcp/dist/src/bin.js'] });
    expect(mcpServer(values).mcpServers.pbcp).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@pbcp/mcp'], env: { PBCP_HEAD_URL: 'https://head.example/api', PBCP_TOKEN: "pbcp_it's" } });
    // The hand-written config is mcp.json with the values written in.
    const shipped = JSON.parse(readFileSync(new URL('../mcp.json', import.meta.url), 'utf8')) as { mcpServers: { pbcp: Record<string, unknown> } };
    expect({ ...mcpServer(values).mcpServers.pbcp, env: shipped.mcpServers.pbcp.env }).toEqual(shipped.mcpServers.pbcp);
    expect(md).toContain('skills/pbcp-escalate/SKILL.md');
  });
});
