import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@pbcp\/core\/conformance$/, replacement: here('./packages/core/conformance/index.ts') },
      { find: /^@pbcp\/core$/, replacement: here('./packages/core/src/index.ts') },
      { find: /^@pbcp\/client$/, replacement: here('./packages/client/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/{src,test,conformance}/**/*.test.ts', 'connectors/*/{src,test}/**/*.test.ts'],
  },
});
