// RFC §7.5: GET / describes the head.

import { z } from 'zod';
import { PROTOCOL } from './card.js';

export const MERMAID_TIERS = ['core', 'extended'] as const;

export const HeadDescriptionSchema = z.looseObject({
  protocol: z.literal(PROTOCOL),
  owner: z.string().min(1),
  extensions: z.array(z.string()),
  render: z.looseObject({ mermaid: z.array(z.enum(MERMAID_TIERS)) }),
});

export type HeadDescription = z.infer<typeof HeadDescriptionSchema>;
