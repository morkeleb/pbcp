// The Setup section of this connector's README, from one template with the three values filled in. scripts/readme-setup.ts
// writes the README from it with placeholders; connect.test.ts checks the README matches. A head's settings page can use it too.

import { exportLine, producerConfig, type Connection } from '@pbcp/client';

const FENCE = '```';

export function connect(c: Connection): string {
  return [
    'The token is bound to the root `mail` (RFC §12): every card id this connector mints starts with `mail:`.',
    '',
    `${FENCE}sh`,
    'pnpm install && pnpm --filter @pbcp/connector-imap build',
    exportLine(producerConfig(c)),
    'export IMAP_HOST=imap.example.com IMAP_USER=me@example.com IMAP_PASSWORD=…',
    'node connectors/imap/dist/src/index.js',
    FENCE,
    '',
    'The other settings are optional; they are under [Configuration](#configuration).',
  ].join('\n');
}
