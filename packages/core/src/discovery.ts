// RFC §7.5: GET / describes the head.

import { z } from 'zod';
import { PROTOCOL } from './card.js';

/** Tiers defined by §3.1. A description may list others; a client ignores those it does not know. */
export const MERMAID_TIERS = ['core', 'extended', 'other'] as const;

export const HeadDescriptionSchema = z.looseObject({
  protocol: z.literal(PROTOCOL),
  owner: z.string().min(1),
  extensions: z.array(z.string()),
  render: z.looseObject({ mermaid: z.array(z.string()) }),
});

export type HeadDescription = z.infer<typeof HeadDescriptionSchema>;
