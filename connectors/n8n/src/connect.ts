// The Setup section of this connector's README, from one template with the three values filled in. scripts/readme-setup.ts
// writes the README from it with placeholders; connect.test.ts checks the README matches. A head's settings page can use it too.

import type { Connection } from '@pbcp/client';

const FENCE = '```';

/** The card the HTTP Request node submits. `emitted_at` is an n8n expression, so every run sends the time it ran. */
const nodeCard = (owner: string) => ({
  protocol: 'pbcp/1',
  id: 'n8n:workflow:first-card',
  producer: 'n8n',
  kind: 'decision',
  to_person: owner,
  title: 'Approve the first card from n8n?',
  summary: 'A first card from an n8n workflow. Approve it to see the decision come back through PBCP Trigger.',
  body: 'Sent by an HTTP Request node.\n\n## Proposal\n\nApprove it.',
  actions: ['approve', 'reject'],
  emitted_at: '{{ $now.toUTC().toISO() }}',
});

/** One HTTP Request node, as n8n copies and pastes nodes: a workflow fragment with no connections. */
export function httpRequestNode(c: Connection) {
  const card = nodeCard(c.owner);
  return {
    nodes: [
      {
        parameters: {
          method: 'PUT',
          url: `${c.api.replace(/\/+$/, '')}/cards/${encodeURIComponent(card.id)}`,
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'Authorization', value: `Bearer ${c.token}` }] },
          sendBody: true,
          specifyBody: 'json',
          jsonBody: `=${JSON.stringify(card, null, 2)}`,
        },
        name: 'Submit a card to PBCP',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [0, 0],
      },
    ],
    connections: {},
  };
}

export function connect(c: Connection): string {
  return [
    '**With these nodes.** Install the community package `n8n-nodes-pbcp`, then create a **PBCP Head** credential:',
    '',
    `- Head URL: \`${c.api}\``,
    `- Token: \`${c.token}\``,
    '',
    'Cards are addressed to the owner `' + c.owner + '`; PBCP Submit reads it from the head when its **To Person** field is empty.',
    '',
    '**Without them.** One HTTP Request node submits a card. Copy this and paste it into a workflow. The token must be bound to the root `n8n` (RFC §12), since the card id starts with `n8n:`.',
    '',
    `${FENCE}json`,
    JSON.stringify(httpRequestNode(c), null, 2),
    FENCE,
  ].join('\n');
}
