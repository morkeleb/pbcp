// Where a producer keeps its sync cursor (§7.2) and the small amount of state it needs to act on decisions (§3.1).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The sync cursor: the `next` of the last fully processed page. */
export interface CursorStore {
  get(): Promise<number>;
  set(n: number): Promise<void>;
}

/** Connector state under one namespace: string keys, JSON values. */
export interface KeyValue<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys starting with `prefix` (all keys when omitted), sorted. */
  keys(prefix?: string): Promise<string[]>;
}

/** The cursor, plus key/value state in named namespaces. Writes to one store are applied in the order they are made. */
export interface StateStore extends CursorStore {
  kv<T>(namespace: string): KeyValue<T>;
}

interface Data {
  after: number;
  state: Record<string, Record<string, unknown>>;
}

/** A StateStore over load/save of the whole document; every write is serialised behind the previous one. */
function storeOver(load: () => Promise<Data>, save: (d: Data) => Promise<void>): StateStore {
  let queue: Promise<unknown> = Promise.resolve();
  const write = (fn: (d: Data) => void) => {
    const run = queue.then(async () => {
      const d = await load();
      fn(d);
      await save(d);
    });
    queue = run.catch(() => {});
    return run;
  };
  const read = async () => {
    await queue;
    return load();
  };
  return {
    get: async () => (await read()).after,
    set: (n) => write((d) => void (d.after = n)),
    kv<T>(ns: string): KeyValue<T> {
      const of = (d: Data) => d.state[ns] ?? {};
      return {
        async get(key) {
          const all = of(await read());
          return Object.hasOwn(all, key) ? (all[key] as T) : undefined;
        },
        set: (key, value) => write((d) => void (d.state[ns] = { ...of(d), [key]: value })),
        delete: (key) =>
          write((d) => {
            const all = { ...of(d) };
            delete all[key];
            d.state[ns] = all;
          }),
        keys: async (prefix = '') => Object.keys(of(await read())).filter((k) => k.startsWith(prefix)).sort(),
      };
    },
  };
}

/** In memory, for tests and one-shot runs. */
export function memoryStore(after = 0): StateStore {
  let data: Data = { after, state: {} };
  return storeOver(
    async () => structuredClone(data),
    async (d) => void (data = d),
  );
}

/**
 * One JSON file, `{ "after": n, "state": { namespace: { key: value } } }`. A missing file is cursor 0 and no state;
 * writes go through a temp file and rename. A 0.3 cursor file (`{ "after": n }`) reads as is.
 */
export function fileStore(path: string): StateStore {
  return storeOver(
    async () => {
      const json = (await readJson(path)) as Partial<Data> | null | undefined;
      if (json === undefined) return { after: 0, state: {} };
      const after = json?.after;
      if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) throw new Error(`${path}: not a store file`);
      return { after, state: (json?.state ?? {}) as Data['state'] };
    },
    (d) => writeJson(path, Object.keys(d.state).length === 0 ? { after: d.after } : d),
  );
}

/** @deprecated since 0.4: use `fileStore`, which also keeps connector state. Removed in 0.5. */
export const fileCursor: (path: string) => CursorStore = fileStore;

/** @deprecated since 0.4: use `memoryStore`. Removed in 0.5. */
export const memoryCursor: (initial?: number) => CursorStore = memoryStore;

/** @deprecated since 0.4: use `fileStore(path).kv(namespace)`. A JSON object file keyed by card id. Removed in 0.5. */
export function fileState<T>(path: string): KeyValue<T> {
  const load = async () => ((await readJson(path)) ?? {}) as Record<string, T>;
  return storeOver(
    async () => ({ after: 0, state: { s: await load() } }),
    (d) => writeJson(path, d.state.s ?? {}),
  ).kv<T>('s');
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`);
  await rename(tmp, path);
}
