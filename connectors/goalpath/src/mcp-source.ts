import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { toolSource, type GoalPathSource } from './source.js';

/** What a tool returned: `structuredContent` if present, else its first text block as JSON (or as text when it is not JSON). */
export function toolResult(res: unknown): unknown {
  const r = res as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
  const text = r.content?.find((c) => c.type === 'text')?.text;
  if (r.isError) throw new Error(`GoalPath tool error: ${text ?? 'no message'}`);
  if (r.structuredContent !== undefined) return r.structuredContent;
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return text;
  }
}

/** The GoalPath MCP over streamable HTTP with a bearer token. */
export async function mcpSource(url: string, token: string, projectId: string): Promise<GoalPathSource & { close(): Promise<void> }> {
  const client = new Client({ name: 'pbcp-goalpath', version: '0.4.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => toolResult(await client.callTool({ name, arguments: args }));
  return { ...toolSource(call, projectId), close: () => client.close() };
}
