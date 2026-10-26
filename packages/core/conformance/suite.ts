// Registers the fixtures as vitest tests. Import from a *.test.ts file.

import { describe, it } from 'vitest';
import { loadFixtures, runFixture } from './runner.js';
import type { Fixture, HeadUnderTest, RenderUnderTest } from './types.js';

export function conformanceSuite(opts: {
  head?: () => HeadUnderTest;
  render?: () => RenderUnderTest;
  only?: RegExp;
  /** Include SHOULD-level fixtures (default true). */
  should?: boolean;
}): void {
  const pick = (f: Fixture) => (!opts.only || opts.only.test(f.name)) && (opts.should !== false || f.level !== 'SHOULD');
  const head = opts.head;
  if (head) {
    describe('core conformance', () => {
      for (const f of loadFixtures('core').filter(pick)) it(f.name, () => runFixture(f, { head: head() }));
    });
  }
  const render = opts.render;
  if (render) {
    describe('rendering conformance', () => {
      for (const f of loadFixtures('render').filter(pick)) it(f.name, () => runFixture(f, { render: render() }));
    });
  }
}
