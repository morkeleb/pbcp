import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { CUSTOM_DOMAIN, SITE_URL } from './src/config';

// GitHub Pages serves a custom domain from a CNAME file at the site root. Written only when CUSTOM_DOMAIN is set, and
// removed otherwise, so a build without it never carries a stale domain.
const cname = new URL('./public/CNAME', import.meta.url);
if (CUSTOM_DOMAIN) writeFileSync(cname, `${CUSTOM_DOMAIN}\n`);
else if (existsSync(cname)) rmSync(cname);

const url = new URL(`${SITE_URL}/`);

export default defineConfig({
  site: url.origin,
  base: url.pathname,
  trailingSlash: 'ignore',
  outDir: './dist',
  build: { format: 'directory' },
  // Compression drops the space where a line of text is followed by an element on the next line ("the <a>").
  compressHTML: false,
  // Snippets come from the packages themselves, read from source, so the site shows what the code produces. Needs the
  // repository's workspace installed (pnpm install at the root), for the packages' own dependencies.
  vite: {
    resolve: {
      alias: {
        '@pbcp/client': fileURLToPath(new URL('../packages/client/src/index.ts', import.meta.url)),
        '@pbcp/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
      },
    },
  },
});
