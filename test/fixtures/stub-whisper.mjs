#!/usr/bin/env node
// Stub whisper-cli for tests: prints a canned transcript to stdout.
// Honours STUB_WHISPER_OUTPUT and STUB_WHISPER_FAIL=1.
import { writeFileSync } from 'node:fs';
if (process.env.STUB_WHISPER_FAIL === '1') {
  process.stderr.write('whisper crashed\n');
  process.exit(3);
}
process.stdout.write(process.env.STUB_WHISPER_OUTPUT || 'stub transcript');
if (process.env.STUB_WHISPER_LOGFILE) {
  writeFileSync(process.env.STUB_WHISPER_LOGFILE, JSON.stringify(process.argv.slice(2)) + '\n');
}
process.exit(0);
