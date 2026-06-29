#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
