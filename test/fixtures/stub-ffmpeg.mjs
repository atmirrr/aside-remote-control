#!/usr/bin/env node
// Stub ffmpeg for tests: converts nothing, just writes the output file
// (last argv). Honours STUB_FFMPEG_FAIL=1 to exit 2.
import { writeFileSync } from 'node:fs';
const out = process.argv[process.argv.length - 1];
if (process.env.STUB_FFMPEG_FAIL === '1') {
  process.stderr.write('ffmpeg exploded\n');
  process.exit(2);
}
writeFileSync(out, Buffer.from('RIFF-stub-wav-data'));
process.exit(0);
