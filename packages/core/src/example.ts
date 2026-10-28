// RFC §3: the example card, in the RFC's field order. card.test.ts checks it against the file form in the RFC itself.

import type { ProducerCard } from './card.js';

/** The §3 example: a mail agent's proposed reply, waiting for the person's decision. */
export const exampleCard: ProducerCard = {
  protocol: 'pbcp/1',
  id: 'hermes:gmail:19a4f2e7c3b1',
  kind: 'decision',
  to_person: 'morten',
  producer: 'hermes',
  thread: 'gmail:19a4f2e7c3b1',
  labels: ['billing-revamp'],
  urgency: 'brief',
  title: 'Reply to Anna re invoice timing',
  summary: 'Anna asks to pay the September invoice on the 20th instead of the 15th. The proposed reply agrees for September only.',
  actions: ['approve', 'reject', 'edit'],
  references: [],
  emitted_at: '2026-10-07T13:02:11Z',
  source: { url: 'https://mail.google.com/mail/u/0/#search/rfc822msgid:CA%2Babc%3Ddef%40mail.example.com', label: 'Gmail thread' },
  body: [
    'Anna (Nordic Supply) asks whether the September invoice can be paid on the 20th instead of the 15th. Last three invoices were paid on time; no prior requests.',
    '',
    '## Proposed reply',
    '',
    "> Hi Anna — the 20th is fine for September. Let's keep the 15th from October on.",
    '>',
    '> Best, Morten',
  ].join('\n'),
};
