// Portable test entry: Node 18–24 disagree on how `node --test <dir|glob>` is resolved, and
// cmd.exe does not expand globs, so list the files here and hand them over explicitly.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !only.length || only.some((o) => f.includes(o)))
  .sort()
  .map((f) => path.join(here, f));

if (!files.length) {
  console.error('no test files found');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
