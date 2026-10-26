// Registers the fixtures as vitest tests. Import from a *.test.ts file.

import { describe, it } from 'vitest';
import { loadFixtures, runFixture } from './runner.js';
import type { HeadUnderTest, RenderUnderTest } from './types.js';

export function conformanceSuite(opts: { head?: () => HeadUnderTest; render?: () => RenderUnderTest; only?: RegExp }): void {
  const pick = (name: string) => !opts.only || opts.only.test(name);
  const head = opts.head;
  if (head) {
    describe('core conformance', () => {
      for (const f of loadFixtures('core').filter((f) => pick(f.name))) it(f.name, () => runFixture(f, { head: head() }));
    });
  }
  const render = opts.render;
  if (render) {
    describe('rendering conformance', () => {
      for (const f of loadFixtures('render').filter((f) => pick(f.name))) it(f.name, () => runFixture(f, { render: render() }));
    });
  }
}
