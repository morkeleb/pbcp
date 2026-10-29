// The site's constants. Each can be overridden by an environment variable of the same name at build time.

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const fromEnv = (name: string) => process.env[name]?.trim() || undefined;

/** A custom domain, e.g. `pbcp.example.org`. When set, the build writes `public/CNAME` and the site defaults to its root. */
export const CUSTOM_DOMAIN = fromEnv('CUSTOM_DOMAIN');

/** Where the site is published. Every internal link is made under its path. */
export const SITE_URL = (fromEnv('SITE_URL') ?? (CUSTOM_DOMAIN ? `https://${CUSTOM_DOMAIN}` : 'https://morkeleb.github.io/pbcp')).replace(/\/+$/, '');

/** The reference head's OpenAPI document, linked from /llms.txt and /heads/. */
export const HEAD_OPENAPI_URL = fromEnv('HEAD_OPENAPI_URL') ?? 'https://pbcp.vercel.app/api/openapi.json';

export const REPO_URL = 'https://github.com/morkeleb/pbcp';
export const HEAD_REPO_URL = 'https://github.com/morkeleb/pbcp-head';

/** The repository root. The site is built from `site/`, so the RFC, changelog and connectors are one level up. */
export const REPO_ROOT = resolve(process.cwd(), '..');

/** Every draft in `rfc/`, oldest first. A draft kept beside a newer one stays reachable at `/rfc/<version>/`. */
export const RFC_DRAFTS = readdirSync(resolve(REPO_ROOT, 'rfc'))
  .flatMap((f) => {
    const m = /^pbcp-draft-(\d+)\.(\d+)\.md$/.exec(f);
    return m ? [{ path: resolve(REPO_ROOT, 'rfc', f), name: f, version: `${m[1]}.${m[2]}`, v: [Number(m[1]), Number(m[2])] as const }] : [];
  })
  .sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1])
  .map(({ path, name, version }) => ({ path, name, version }));

/** The newest draft in `rfc/`, so the site follows a new draft without a change here. */
export const RFC_FILE = (() => {
  const last = RFC_DRAFTS.at(-1);
  if (!last) throw new Error('no rfc/pbcp-draft-*.md found');
  return last;
})();

/** A path on this site, under SITE_URL's path: `href('/rfc/')` → `/pbcp/rfc/`. */
export function href(path: string): string {
  const base = new URL(`${SITE_URL}/`).pathname.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** An absolute URL on this site, for documents read outside it (`/llms.txt`). */
export const absolute = (path: string) => `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
