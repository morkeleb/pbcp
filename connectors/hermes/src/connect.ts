// The Setup section of this connector's README, from one template with the three values filled in. scripts/readme-setup.ts
// writes the README from it with placeholders; connect.test.ts checks the README matches. A head's settings page can use it too.

import { exportLine, producerConfig, type Connection } from '@pbcp/client';

const FENCE = '```';

/** mcp.json with the two values Hermes passes to the server written in, for a client configured by hand. */
export function mcpServer(c: Connection) {
  const { PBCP_HEAD_URL, PBCP_TOKEN } = producerConfig(c);
  return { mcpServers: { pbcp: { type: 'stdio', command: 'npx', args: ['-y', '@pbcp/mcp'], env: { PBCP_HEAD_URL, PBCP_TOKEN } } } };
}

export function connect(c: Connection): string {
  const { PBCP_HEAD_URL, PBCP_TOKEN } = producerConfig(c);
  return [
    'The token is bound to the root `hermes` (RFC §12): the skills submit every card under `hermes:`. Cards are addressed to the owner `' + c.owner + '`, which the skills read from the head.',
    '',
    `${FENCE}sh`,
    exportLine({ PBCP_HEAD_URL, PBCP_TOKEN }),
    'hermes plugins install ./connectors/hermes',
    'hermes plugins enable pbcp',
    FENCE,
    '',
    '`mcp.json` passes the two variables to the server from the environment. To configure the server by hand instead:',
    '',
    `${FENCE}json`,
    JSON.stringify(mcpServer(c), null, 2),
    FENCE,
    '',
    'The skills are `skills/pbcp-escalate/SKILL.md` (ask before acting outside the user) and `skills/pbcp-executor/SKILL.md` (carry out orders, Appendix A). An executor needs a token the head lets claim orders.',
  ].join('\n');
}
