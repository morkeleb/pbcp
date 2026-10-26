// The matcher language described in README.md.

export type Vars = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMatcher = (v: unknown): v is Record<string, unknown> => isObj(v) && Object.keys(v).some((k) => k.startsWith('$'));

/** Replaces every `{ "$var": name }` with the saved value. */
export function resolve(v: unknown, vars: Vars): unknown {
  if (Array.isArray(v)) return v.map((x) => resolve(x, vars));
  if (isObj(v)) {
    if (Object.keys(v).length === 1 && typeof v.$var === 'string') {
      if (!(v.$var in vars)) throw new Error(`unknown variable ${v.$var}`);
      return vars[v.$var];
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, vars)]));
  }
  return v;
}

/** Returns a list of mismatch descriptions; empty means the value matched. */
export function match(actual: unknown, expected: unknown, vars: Vars, path = '$'): string[] {
  if (isMatcher(expected)) return matchOps(actual, expected, vars, path);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array, got ${show(actual)}`];
    if (actual.length !== expected.length) return [`${path}: expected ${expected.length} elements, got ${actual.length}`];
    return expected.flatMap((e, i) => match(actual[i], e, vars, `${path}[${i}]`));
  }
  if (isObj(expected)) {
    if (!isObj(actual)) return [`${path}: expected an object, got ${show(actual)}`];
    return Object.entries(expected).flatMap(([k, e]) => match(actual[k], e, vars, `${path}.${k}`));
  }
  return Object.is(actual, expected) ? [] : [`${path}: expected ${show(expected)}, got ${show(actual)}`];
}

function num(v: unknown, vars: Vars): number {
  const r = resolve(v, vars);
  if (typeof r !== 'number') throw new Error(`expected a number operand, got ${show(r)}`);
  return r;
}

function matchOps(actual: unknown, m: Record<string, unknown>, vars: Vars, path: string): string[] {
  const out: string[] = [];
  const fail = (msg: string) => out.push(`${path}: ${msg}`);
  for (const [op, arg] of Object.entries(m)) {
    switch (op) {
      case '$var':
        if (!Object.is(actual, resolve(m, vars))) fail(`expected $${String(arg)} = ${show(vars[String(arg)])}, got ${show(actual)}`);
        break;
      case '$gt':
        if (typeof actual !== 'number' || !(actual > num(arg, vars))) fail(`expected > ${num(arg, vars)}, got ${show(actual)}`);
        break;
      case '$lt':
        if (typeof actual !== 'number' || !(actual < num(arg, vars))) fail(`expected < ${num(arg, vars)}, got ${show(actual)}`);
        break;
      case '$adjacent':
        if (typeof actual !== 'number' || Math.abs(actual - num(arg, vars)) !== 1) fail(`expected adjacent to ${num(arg, vars)}, got ${show(actual)}`);
        break;
      case '$absent':
        if (actual !== undefined) fail(`expected absent, got ${show(actual)}`);
        break;
      case '$present':
        if (actual === undefined || actual === null) fail('expected present');
        break;
      case '$type': {
        const t = Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual;
        if (t !== arg) fail(`expected type ${String(arg)}, got ${t}`);
        break;
      }
      case '$len': {
        const len = Array.isArray(actual) || typeof actual === 'string' ? actual.length : undefined;
        if (len !== num(arg, vars)) fail(`expected length ${num(arg, vars)}, got ${show(len)}`);
        break;
      }
      case '$contains':
        if (!Array.isArray(actual)) { fail(`expected an array, got ${show(actual)}`); break; }
        for (const e of arg as unknown[]) {
          if (!actual.some((a) => match(a, e, vars).length === 0)) fail(`no element matches ${show(e)}`);
        }
        break;
      case '$none':
        if (!Array.isArray(actual)) { fail(`expected an array, got ${show(actual)}`); break; }
        actual.forEach((a, i) => { if (match(a, arg, vars).length === 0) fail(`element ${i} matches ${show(arg)}`); });
        break;
      case '$every':
        if (!Array.isArray(actual)) { fail(`expected an array, got ${show(actual)}`); break; }
        actual.forEach((a, i) => out.push(...match(a, arg, vars, `${path}[${i}]`)));
        break;
      case '$oneOf':
        if (!(arg as unknown[]).some((e) => match(actual, e, vars).length === 0)) fail(`matches none of ${show(arg)}`);
        break;
      case '$includes':
      case '$excludes': {
        const needle = resolve(arg, vars);
        const has = typeof actual === 'string' ? typeof needle === 'string' && actual.includes(needle)
          : Array.isArray(actual) ? actual.some((a) => match(a, needle, vars).length === 0)
          : undefined;
        if (has === undefined) fail(`expected a string or array, got ${show(actual)}`);
        else if (has !== (op === '$includes')) fail(`expected ${op === '$includes' ? 'to include' : 'not to include'} ${show(needle)}`);
        break;
      }
      default:
        throw new Error(`unknown matcher ${op} at ${path}`);
    }
  }
  return out;
}

/** Dotted path with `[k=v]` find segments, e.g. `body.changes.[card.id=a:b:c].seq`. */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.match(/\[[^\]]*\]|[^.]+/g) ?? []) {
    if (cur === undefined || cur === null) return undefined;
    const find = /^\[([^=\]]+)=([^\]]*)\]$/.exec(seg);
    if (find) {
      if (!Array.isArray(cur)) return undefined;
      const [, key, value] = find;
      cur = cur.find((el) => String(getPath(el, key!)) === value);
    } else {
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 200 ? s.slice(0, 200) + '…' : s;
}
