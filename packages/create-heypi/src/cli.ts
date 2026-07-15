#!/usr/bin/env node

process.argv.splice(2, 0, "create");
await import("@hunvreus/heypi/cli");
