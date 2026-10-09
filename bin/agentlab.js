#!/usr/bin/env node
// Checked before loading anything else, so an old Node.js gets a clear message rather than a syntax error.
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write(`agentlab needs Node.js 22 or newer; this is ${process.versions.node}.\n`);
  process.exit(1);
}
await import('../dist/cli/main.js');
