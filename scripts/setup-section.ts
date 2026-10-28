// The "Setup" section of a connector's README is generated from the connector's `connect()` (src/connect.ts), with
// placeholders for the three values. readme-setup.ts writes it; each connector's connect.test.ts checks it.

/** What the README shows in place of the three values. */
export const PLACEHOLDERS = { api: '<head url>', owner: '<owner>', token: '<token>' } as const;

export const BEGIN = '<!-- setup: generated from src/connect.ts by scripts/readme-setup.ts; edit the template there, not this section -->';
export const END = '<!-- /setup -->';

/** The generated section in a README, without its markers; undefined when the README has none. */
export function setupOf(readme: string): string | undefined {
  const [from, to] = [readme.indexOf(BEGIN), readme.indexOf(END)];
  return from < 0 || to < from ? undefined : readme.slice(from + BEGIN.length, to).trim();
}

/** The README with its generated section replaced by `md`. A README without markers is refused: where the section goes is the README's choice. */
export function withSetup(readme: string, md: string): string {
  const [from, to] = [readme.indexOf(BEGIN), readme.indexOf(END)];
  if (from < 0 || to < from) throw new Error(`no ${BEGIN} … ${END} markers`);
  return `${readme.slice(0, from + BEGIN.length)}\n\n${md.trim()}\n\n${readme.slice(to)}`;
}
