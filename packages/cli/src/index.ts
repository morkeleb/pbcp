// `pbcp`: the three operations and the description of RFC §7, from a shell. Every call goes through HeadClient.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { HeadClient, HeadHttpError } from '@pbcp/client';
import { PbcpError, parseCardOrThrow, type Decision } from '@pbcp/core';

export const USAGE = `usage: pbcp <command> [options]

  describe                                        GET /  (RFC §7.5)
  submit <file.md|file.json>                      PUT /cards/{id}  (§7.1); 409 is a result, not a failure
  sync [--after N] [--follow] [--interval S]      GET /changes  (§7.2); one JSON line per change
  decide <id> <decision> [--proposal FILE] [--comment TEXT]
                                                  POST /cards/{id}/decision  (§7.3); head-dependent

options:
  --head URL      head base URL   (default: $PBCP_HEAD_URL)
  --token TOKEN   bearer token    (default: $PBCP_TOKEN)
`;

export interface Io {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<string>;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Ends `sync --follow`. */
  signal?: AbortSignal;
}

const OPTIONS = {
  head: { type: 'string' },
  token: { type: 'string' },
  after: { type: 'string' },
  follow: { type: 'boolean' },
  interval: { type: 'string' },
  proposal: { type: 'string' },
  comment: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

class UsageError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const count = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a non-negative integer`);
  return Number(value);
};

/** Runs one command and returns the exit code: 0 done, 1 refused or failed, 2 usage. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const { values: o, positionals: [command, ...args] } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    if (o.help || command === undefined || command === 'help') {
      io.out(USAGE);
      return command === undefined && !o.help ? 2 : 0;
    }
    if (!['describe', 'submit', 'sync', 'decide'].includes(command)) throw new UsageError(`unknown command: ${command}`);
    const baseUrl = o.head ?? io.env.PBCP_HEAD_URL;
    const token = o.token ?? io.env.PBCP_TOKEN;
    if (!baseUrl) throw new UsageError('no head: pass --head or set PBCP_HEAD_URL');
    if (!token) throw new UsageError('no token: pass --token or set PBCP_TOKEN');
    const head = new HeadClient({ baseUrl, token, fetch: io.fetch });
    const read = io.readFile ?? ((p: string) => readFile(p, 'utf8'));
    const arity = (n: number) => {
      if (args.length !== n) throw new UsageError(`${command} takes ${n} argument${n === 1 ? '' : 's'}`);
    };

    switch (command) {
      case 'describe':
        arity(0);
        io.out(JSON.stringify(await head.describe(), null, 2));
        return 0;
      case 'submit': {
        arity(1);
        const res = await head.submit(parseCardOrThrow(await read(args[0]!)));
        io.out(JSON.stringify(res, null, 2));
        return 0;
      }
      case 'decide': {
        arity(2);
        const d: Decision = { decision: args[1]! };
        if (o.proposal !== undefined) d.edited_proposal = await read(o.proposal);
        if (o.comment !== undefined) d.comment = o.comment;
        io.out(JSON.stringify(await head.decide(args[0]!, d), null, 2));
        return 0;
      }
      case 'sync': {
        arity(0);
        let after = count('after', o.after, 0);
        const intervalMs = count('interval', o.interval, 10) * 1000;
        while (!io.signal?.aborted) {
          const page = await head.sync(after);
          for (const change of page.changes) io.out(JSON.stringify(change));
          if (page.next < after) throw new HeadHttpError(200, page, `sync after ${after} returned next ${page.next}`);
          if (page.next > after) {
            after = page.next;
            continue;
          }
          if (!o.follow) break;
          await (io.sleep ?? sleep)(intervalMs, io.signal);
        }
        io.err(`next: ${after}`);
        return 0;
      }
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err(`pbcp: ${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof PbcpError) io.err(`pbcp: ${e.status} ${e.code}: ${e.message}`);
    else if (e instanceof HeadHttpError) io.err(`pbcp: ${e.message}\n${typeof e.body === 'string' ? e.body : JSON.stringify(e.body)}`);
    else io.err(`pbcp: ${(e as Error).message ?? String(e)}`);
    return 1;
  }
}
