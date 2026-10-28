// What a producer needs to reach a head, as text to paste: the three values (§7, §7.5, §10) and a curl that PUTs a card (§7.1).
// Pure: the head's settings page, the docs site and each connector's `connect()` build their snippets from these.

import { exampleCard, type ProducerCard } from '@pbcp/core';

/** The three values every producer needs: where the producer operations are (`api`, §7.5), the owner id (§10) and a token. */
export interface Connection {
  /** The base URL of the producer operations: the head's `api` (§7.5), or the URL its description is read from. */
  api: string;
  /** The owner's person id, from the head's description; cards are addressed to it (`to_person`). */
  owner: string;
  /** A producer token, bound to one namespace root (§12). */
  token: string;
}

/** A shell word that the shell reads back exactly: single-quoted, with `'` written as `'\''`. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The three values as the environment the repository's connectors read: `PBCP_HEAD_URL`, `PBCP_TO_PERSON`, `PBCP_TOKEN`. */
export function producerConfig({ api, owner, token }: Connection): { PBCP_HEAD_URL: string; PBCP_TO_PERSON: string; PBCP_TOKEN: string } {
  return { PBCP_HEAD_URL: api, PBCP_TO_PERSON: owner, PBCP_TOKEN: token };
}

/** The release a checkout should use until the packages are on npm; a test keeps it equal to this package's version. */
export const RELEASE_TAG = 'v0.8.0';

/**
 * Markdown for every Setup that installs from npm, until the packages are published there: build from a checkout of the
 * repository at a release tag instead. The npm commands stay in each Setup, marked as for once they are published.
 */
export function fromSource(tag = RELEASE_TAG): string {
  return [
    `**Until the packages are on npm**, the \`npm\` and \`npx\` commands here do not work yet. Use a checkout of the repository at a release tag, built:`,
    '',
    '```sh',
    checkoutCommands(tag),
    '```',
  ].join('\n');
}

/** The shell lines that check out the repository at a release tag and build it; the commands after them run in the checkout. */
export const checkoutCommands = (tag = RELEASE_TAG): string =>
  [`git clone --branch ${tag} --depth 1 https://github.com/morkeleb/pbcp && cd pbcp`, 'corepack pnpm install --frozen-lockfile && corepack pnpm build'].join('\n');

/** One `export` line for a shell, every value quoted: `export PBCP_HEAD_URL='…' PBCP_TOKEN='…'`. */
export const exportLine = (vars: Record<string, string>): string => `export ${Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')}`;

/**
 * A curl command that PUTs a card (§7.1) and prints the head's answer. Without `card` it sends the §3 example
 * addressed to `owner`; that card's id is under the root `hermes`, so the token must be bound to it (§12). A given
 * card is sent as it is. The JSON goes through a quoted heredoc, so the shell never expands it.
 */
export function curlSnippet({ api, owner, token, card }: Connection & { card?: ProducerCard }): string {
  const c = card ?? { ...exampleCard, to_person: owner };
  return [
    `curl -s -X PUT ${shellQuote(`${api.replace(/\/+$/, '')}/cards/${encodeURIComponent(c.id)}`)} \\`,
    `  -H ${shellQuote(`Authorization: Bearer ${token}`)} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  --data-binary @- <<'CARD'`,
    JSON.stringify(c, null, 2),
    'CARD',
  ].join('\n');
}
