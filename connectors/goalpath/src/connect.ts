// The Setup section of this connector's README, from one template with the three values filled in. scripts/readme-setup.ts
// writes the README from it with placeholders; connect.test.ts checks the README matches. A head's settings page can use it too.

import { exportLine, producerConfig, type Connection } from '@pbcp/client';

const FENCE = '```';

export function connect(c: Connection): string {
  return [
    'The token is bound to the root `goalpath` (RFC §12): every card id this connector mints starts with `goalpath:`.',
    '',
    `${FENCE}sh`,
    'pnpm install && pnpm --filter @pbcp/connector-goalpath build',
    exportLine(producerConfig(c)),
    'export GOALPATH_MCP_URL=https://… GOALPATH_TOKEN=… GOALPATH_PROJECT=…',
    'node connectors/goalpath/dist/src/index.js',
    FENCE,
    '',
    'The label, milestones, digest time and the rest are under [Configuration](#configuration).',
  ].join('\n');
}
