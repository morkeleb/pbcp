import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@pbcp\/core\/conformance\/vitest$/, replacement: here('./packages/core/conformance/vitest.ts') },
      { find: /^@pbcp\/core\/conformance\/render$/, replacement: here('./packages/core/conformance/render.ts') },
      { find: /^@pbcp\/core\/conformance$/, replacement: here('./packages/core/conformance/index.ts') },
      { find: /^@pbcp\/core$/, replacement: here('./packages/core/src/index.ts') },
      { find: /^@pbcp\/client\/testing$/, replacement: here('./packages/client/src/testing.ts') },
      { find: /^@pbcp\/client$/, replacement: here('./packages/client/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/{src,test,conformance}/**/*.test.ts', 'connectors/*/{src,test}/**/*.test.ts'],
  },
});
