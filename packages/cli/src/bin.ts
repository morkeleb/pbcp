#!/usr/bin/env node
import { main } from './index.js';

const ac = new AbortController();
process.once('SIGINT', () => ac.abort());
process.once('SIGTERM', () => ac.abort());

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  signal: ac.signal,
});
