// The Setup section of this connector's README, from one template with the three values filled in. scripts/readme-setup.ts
// writes the README from it with placeholders; connect.test.ts checks the README matches. A head's settings page can use it too.

import { checkoutCommands, exportLine, producerConfig, type Connection } from '@pbcp/client';

const FENCE = '```';

export function connect(c: Connection): string {
  return [
    'The token is bound to the root `goalpath` (RFC §12): every card id this connector mints starts with `goalpath:`.',
    '',
    'It runs from a checkout of the repository at a release tag (the packages are not on npm yet):',
    '',
    `${FENCE}sh`,
    checkoutCommands(),
    exportLine(producerConfig(c)),
    'export GOALPATH_MCP_URL=https://… GOALPATH_TOKEN=… GOALPATH_PROJECT=…',
    'node connectors/goalpath/dist/src/index.js',
    FENCE,
    '',
    'The label, milestones, digest time and the rest are under [Configuration](#configuration).',
  ].join('\n');
}
