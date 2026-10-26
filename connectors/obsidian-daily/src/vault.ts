import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { HeadClient, ProducerOptions, StateStore } from '@pbcp/client';
import type { ProducerCard } from '@pbcp/core';
import { dateOf, namespaceOf, toCard } from './note.js';

export interface VaultConfig { vault: string; folder: string; toPerson: string; head: Pick<HeadClient, 'submit' | 'sync'>; state: StateStore<string> }

/** Hash of everything but emitted_at, so the head's own equality (§5) and the local skip agree. */
const digest = ({ emitted_at: _, ...rest }: ProducerCard) => createHash('sha256').update(JSON.stringify(rest)).digest('hex');

/** Producer options for one vault's daily notes. A note is re-sent only when its card differs from the last one the
 *  head answered (201, 200 or 409): the digest is recorded after submit returns, so a failed submit is retried. */
export function dailyNotes(cfg: VaultConfig): Omit<ProducerOptions, 'cursor'> {
  const dir = join(cfg.vault, cfg.folder);
  const vault = namespaceOf(basename(cfg.vault));
  return {
    head: {
      sync: (after) => cfg.head.sync(after),
      submit: (c) => cfg.head.submit(c).then(async (res) => (await cfg.state.set(c.id, digest(c)), res)),
    },
    async *produce() {
      for (const file of (await readdir(dir)).sort()) {
        const date = dateOf(file);
        if (!date) continue;
        const c = toCard(await readFile(join(dir, file), 'utf8'), date, { vault, toPerson: cfg.toPerson });
        if ((await cfg.state.get(c.id)) !== digest(c)) yield c;
      }
    },
    onDecision: async () => {}, // artifacts are never decided
  };
}
