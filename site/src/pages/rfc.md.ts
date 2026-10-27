// /rfc.md: the current draft, byte for byte.

import { readFileSync } from 'node:fs';
import { RFC_FILE } from '../config';

export function GET(): Response {
  return new Response(readFileSync(RFC_FILE.path), { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
}
