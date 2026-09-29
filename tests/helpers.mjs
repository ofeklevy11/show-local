// Shared test helpers. Tests never open real windows: GUI work goes through fakes.
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN = path.join(ROOT, 'plugins', 'show-local');
export const SCRIPTS = path.join(PLUGIN, 'scripts');
export const SHOW = path.join(SCRIPTS, 'show.mjs');
export const lib = (name) => new URL(`../plugins/show-local/scripts/lib/${name}`, import.meta.url).href;

/** A fresh temp folder; call the returned cleanup in finally. */
export function tempDir(prefix = 'show-local-test-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** An ephemeral free port outside show-local's 4400–4499 range. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** A fake runFn: map "cmd arg arg" (or a predicate) to canned results; records every call. */
export function fakeRun(table = []) {
  const calls = [];
  const fn = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    for (const [match, result] of table) {
      const key = `${cmd} ${args.join(' ')}`;
      const hit = typeof match === 'function' ? match(cmd, args, opts) : key.startsWith(match);
      if (hit) return { status: 0, stdout: '', stderr: '', error: null, ...(typeof result === 'function' ? result(cmd, args, opts) : result) };
    }
    return { status: 1, stdout: '', stderr: 'not faked', error: null };
  };
  fn.calls = calls;
  return fn;
}
