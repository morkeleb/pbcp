// Card construction, so connectors never hand-write ids (§5) or protocol fields.

import { PROTOCOL, parseCardOrThrow, type ProducerCard } from '@pbcp/core';

type Known<T> = { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

export type CardInput = Omit<Known<ProducerCard>, 'id' | 'protocol' | 'producer' | 'emitted_at'> & {
  producer: string;
  namespace: string;
  upstream: string;
  intent?: string;
  emitted_at?: string;
  [extension: string]: unknown;
};

/** Builds `producer:namespace:upstream[:intent]`, fills protocol and emitted_at, and validates (§4.1, §5). */
export function card(input: CardInput): ProducerCard {
  const { producer, namespace, upstream, intent, emitted_at, ...rest } = input;
  const id = intent === undefined ? `${producer}:${namespace}:${upstream}` : `${producer}:${namespace}:${upstream}:${intent}`;
  const raw: Record<string, unknown> = { protocol: PROTOCOL, id, producer, ...rest, emitted_at: emitted_at ?? new Date().toISOString() };
  for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
  return parseCardOrThrow(raw);
}
