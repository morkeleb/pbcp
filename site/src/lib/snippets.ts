// The /producers/ quickstart, as the exact text shown on the page. Every shell snippet runs as written once
// PBCP_HEAD_URL and PBCP_TOKEN are set; they need curl and jq.

export const env = `export PBCP_HEAD_URL=https://head.example/api   # your head's base URL (the reference head serves the protocol under /api)
export PBCP_TOKEN=…                              # a producer token, from step 2`;

export const describe = `curl -s "$PBCP_HEAD_URL"
# {"protocol":"pbcp/1","owner":"morten","seq":37,"extensions":["orders"],"render":{"mermaid":["core","extended"]}}

export PBCP_OWNER=$(curl -s "$PBCP_HEAD_URL" | jq -r .owner)`;

export const mint = `# in a checkout of the reference head, with DATABASE_URL set to the head's database
pnpm mint-token "$PBCP_OWNER" demo    # prints the token once; the head keeps only its hash`;

export const put = `curl -s -X PUT "$PBCP_HEAD_URL/cards/demo:quickstart:first-card" \\
  -H "Authorization: Bearer $PBCP_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d @- <<EOF
{
  "protocol": "pbcp/1",
  "id": "demo:quickstart:first-card",
  "producer": "demo",
  "kind": "decision",
  "to_person": "$PBCP_OWNER",
  "title": "Send the first card?",
  "summary": "A first card from the quickstart. Approve it to see the decision come back.",
  "body": "This card was sent with curl.\\n\\n## Proposal\\n\\nApprove it, then read it back with GET /changes.",
  "actions": ["approve", "reject"],
  "emitted_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF`;

export const putAgain = `# The same PUT again answers 200 instead of 201: the id names the card, so a retry is harmless.
# After the person has decided, the same PUT still answers 200, with the decided card in the body;
# a changed card under that id answers 409. A decided card never changes: send a new card that supersedes it.`;

export const sync = `curl -s "$PBCP_HEAD_URL/changes?after=0" -H "Authorization: Bearer $PBCP_TOKEN" \\
  | jq '{next, changes: [.changes[] | {seq, id: .card.id, state: .card.state, decision: .card.decision}]}'`;

export const syncNext = `# Keep "next" and pass it back as "after": each change is returned once, newest state only.
NEXT=$(curl -s "$PBCP_HEAD_URL/changes?after=0" -H "Authorization: Bearer $PBCP_TOKEN" | jq .next)
curl -s "$PBCP_HEAD_URL/changes?after=$NEXT" -H "Authorization: Bearer $PBCP_TOKEN" | jq '.changes | length'   # 0 until something changes`;

export const clientInstall = `npm install @pbcp/client`;

export const client = `// first-card.mjs — run with: node first-card.mjs
import { HeadClient, card } from '@pbcp/client';

const head = new HeadClient({ baseUrl: process.env.PBCP_HEAD_URL, token: process.env.PBCP_TOKEN });
const { owner } = await head.describe();

// card() builds the id demo:quickstart:second-card and fills protocol and emitted_at.
const result = await head.submit(card({
  producer: 'demo', namespace: 'quickstart', upstream: 'second-card',
  kind: 'decision', to_person: owner,
  title: 'Send the second card?',
  summary: 'The same card as before, sent with @pbcp/client. Approve it to see the decision come back.',
  body: 'This card was sent with @pbcp/client.\\n\\n## Proposal\\n\\nApprove it.',
  actions: ['approve', 'reject'],
}));
console.log(result.status, result.card.state); // 201 open, then 200 open on a re-run

const { changes, next } = await head.sync(0);
for (const { card: c } of changes) if (c.state === 'decided') console.log(c.id, c.decision);
console.log('next', next);`;

export const mcpRun = `npx -y @pbcp/mcp   # reads PBCP_HEAD_URL and PBCP_TOKEN; speaks MCP over stdin and stdout`;

export const mcpConfig = `{
  "command": "npx",
  "args": ["-y", "@pbcp/mcp"],
  "env": { "PBCP_HEAD_URL": "https://head.example/api", "PBCP_TOKEN": "…" }
}`;

/** Tool inputs, as an MCP client passes them. `to_person` is the owner id from step 1. */
export const mcpSubmit = `{
  "card": {
    "protocol": "pbcp/1",
    "id": "demo:quickstart:third-card",
    "producer": "demo",
    "kind": "decision",
    "to_person": "morten",
    "title": "Send the third card?",
    "body": "Sent through the MCP server.",
    "actions": ["approve", "reject"],
    "emitted_at": "2026-10-27T09:00:00Z"
  }
}`;

export const mcpPoll = `{ "after": 0 }`;
