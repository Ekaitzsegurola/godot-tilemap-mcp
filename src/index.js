#!/usr/bin/env node

// Compatibility entrypoint for v1 MCP configurations.
// Build first (`npm run build`); all implementation now lives in typed modules.
if (!process.argv.slice(2).includes("mcp")) process.argv.splice(2, 0, "mcp");
await import("../dist/cli.js");
