// The Setup section of this connector's README, from one template with the three values filled in. scripts/readme-setup.ts
// writes the README from it with placeholders; connect.test.ts checks the README matches. A head's settings page can use it too.

import { exportLine, fromSource, producerConfig, type Connection } from '@pbcp/client';

const FENCE = '```';

/**
 * mcp.json's server with the two values Hermes passes written in, for a client configured by hand. With `checkout`,
 * the server runs from a built checkout of the repository instead of `npx -y @pbcp/mcp`, which needs the package on npm.
 */
export function mcpServer(c: Connection, checkout?: string) {
  const { PBCP_HEAD_URL, PBCP_TOKEN } = producerConfig(c);
  const run = checkout ? { command: 'node', args: [`${checkout.replace(/\/+$/, '')}/packages/mcp/dist/src/bin.js`] } : { command: 'npx', args: ['-y', '@pbcp/mcp'] };
  return { mcpServers: { pbcp: { type: 'stdio', ...run, env: { PBCP_HEAD_URL, PBCP_TOKEN } } } };
}

export function connect(c: Connection): string {
  const { PBCP_HEAD_URL, PBCP_TOKEN } = producerConfig(c);
  return [
    'The token is bound to the root `hermes` (RFC §12): the skills submit every card under `hermes:`. A card the model sends without `to_person` is addressed to the head\'s owner (`' + c.owner + '`), which `@pbcp/mcp` reads from the head; set `PBCP_TO_PERSON` to name it instead.',
    '',
    fromSource(),
    '',
    'Then, in the checkout:',
    '',
    `${FENCE}sh`,
    exportLine({ PBCP_HEAD_URL, PBCP_TOKEN }),
    'hermes plugins install ./connectors/hermes',
    'hermes plugins enable pbcp',
    FENCE,
    '',
    '`mcp.json` starts the server with `npx -y @pbcp/mcp`, which works once the package is on npm. Until then, configure the server by hand to run it from the checkout (its path in place of `/path/to/pbcp`):',
    '',
    `${FENCE}json`,
    JSON.stringify(mcpServer(c, '/path/to/pbcp'), null, 2),
    FENCE,
    '',
    'Once it is published, the same with `npx`:',
    '',
    `${FENCE}json`,
    JSON.stringify(mcpServer(c), null, 2),
    FENCE,
    '',
    'The skills are `skills/pbcp-escalate/SKILL.md` (ask before acting outside the user) and `skills/pbcp-executor/SKILL.md` (carry out orders, Appendix A). An executor needs a token the head lets claim orders.',
  ].join('\n');
}

