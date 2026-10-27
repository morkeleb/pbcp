// /llms.txt: a short index of this site for agents.

import { HEAD_OPENAPI_URL, RFC_FILE, absolute } from '../config';

export function GET(): Response {
  const text = `# Personal Brief Card Protocol

> PBCP is a small HTTP protocol for the decisions that autonomous software needs from one person. A producer (an agent, a script, a mail reader) submits a card, a JSON object with a markdown body, with PUT /cards/{id} under an id it mints, so a retry is harmless. The person decides in their head, the service that stores their cards, and the producer reads the decision back with GET /changes?after={cursor}. A decided card never changes. The head never connects to a producer. The current specification is draft ${RFC_FILE.version}.

- [The specification, as markdown](${absolute('/rfc.md')}): the full current draft, normative.
- [Producer quickstart](${absolute('/producers/')}): read the owner, get a token, PUT a card, sync decisions; with curl, @pbcp/client or the MCP server.
- [Reference head OpenAPI](${HEAD_OPENAPI_URL}): the reference head's API for the owner's apps; the producer protocol is in the specification.
`;
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
