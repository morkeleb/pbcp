#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HeadClient } from '@pbcp/client';
import { configFrom, createServer } from './index.js';

try {
  const server = createServer(new HeadClient(configFrom(process.argv.slice(2), process.env)));
  await server.connect(new StdioServerTransport());
} catch (e) {
  process.stderr.write(`pbcp-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
}
