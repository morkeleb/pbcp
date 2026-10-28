// The Setup section of this connector's README, from one template with the three values filled in. scripts/readme-setup.ts
// writes the README from it with placeholders; connect.test.ts checks the README matches. A head's settings page can use it too.

import { exportLine, producerConfig, type Connection } from '@pbcp/client';

const FENCE = '```';

export function connect(c: Connection): string {
  return [
    'The token is bound to the root `cal` (RFC §12): every card id this connector mints starts with `cal:`.',
    '',
    `${FENCE}sh`,
    'pnpm install && pnpm --filter @pbcp/connector-caldav build',
    exportLine(producerConfig(c)),
    'export CALDAV_URL=https://cal.example.com/dav/ CALDAV_USER=me CALDAV_PASSWORD=… CALDAV_TZ=Europe/Copenhagen',
    'node connectors/caldav/dist/src/index.js',
    FENCE,
    '',
    'Several calendars, the agenda time and the rest are under [Configuration](#configuration).',
  ].join('\n');
}
