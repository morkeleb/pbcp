import { existsSync, rmSync, writeFileSync } from 'node:fs';
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
});
