// RFC §5: id = producer ":" namespace ":" upstream-id [ ":" intent ]

export interface ParsedId {
  producer: string;
  namespace: string;
  upstream: string;
  intent?: string;
}

const SEGMENT = /^[A-Za-z0-9-]+$/;
const UPSTREAM = /^[A-Za-z0-9_.-]+$/;

export function parseId(id: string): ParsedId | null {
  const parts = id.split(':');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [producer, namespace, upstream, intent] = parts as [string, string, string, string | undefined];
  if (!SEGMENT.test(producer) || !SEGMENT.test(namespace) || !UPSTREAM.test(upstream)) return null;
  if (intent !== undefined && !SEGMENT.test(intent)) return null;
  return intent === undefined ? { producer, namespace, upstream } : { producer, namespace, upstream, intent };
}

export function isId(id: string): boolean {
  return parseId(id) !== null;
}

/** Same producer and namespace segments (§6, §8). False if either id is malformed. */
export function sameNamespace(a: string, b: string): boolean {
  const pa = parseId(a);
  const pb = parseId(b);
  return pa !== null && pb !== null && pa.producer === pb.producer && pa.namespace === pb.namespace;
}

/** The id's producer segment is exactly `root` (§5, §12). False if the id is malformed. */
export function inRoot(id: string, root: string): boolean {
  return parseId(id)?.producer === root;
}

/** Intent and choice-list ids share one grammar (§4.4). */
export function isIntent(s: string): boolean {
  return SEGMENT.test(s);
}
