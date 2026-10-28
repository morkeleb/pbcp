// The Setup section of this connector's README, from one template with the three values filled in. scripts/readme-setup.ts
// writes the README from it with placeholders; connect.test.ts checks the README matches. A head's settings page can use it too.

import { exportLine, producerConfig, type Connection } from '@pbcp/client';

const FENCE = '```';

export function connect(c: Connection): string {
  return [
    `The token is bound to the root \`todoist\` (RFC §12) and is an executor's: the head must let it claim orders (Appendix A). On the reference head that is \`pnpm mint-token ${c.owner} todoist --executor\`.`,
    '',
    `${FENCE}sh`,
    'pnpm install && pnpm --filter @pbcp/connector-todoist build',
    exportLine(producerConfig(c)),
    'export TODOIST_TOKEN=… TODOIST_TZ=Europe/Copenhagen',
    'node connectors/todoist/dist/src/index.js',
    FENCE,
    '',
    'The project, polling and lease settings are under [Configuration](#configuration).',
  ].join('\n');
}
