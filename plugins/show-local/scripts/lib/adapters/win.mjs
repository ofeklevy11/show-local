// Windows: open with the https browser's own command line, Explorer, or the file's default
// app; verify through scripts/win/windows.ps1 (EnumWindows + Shell.Application).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs, resolveWindowsBrowser, windowsAppFor } from '../browser.mjs';
import { run, sha1, stateDir } from '../util.mjs';

const WATCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../win/windows.ps1');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

let prunedIn = null;

/**
 * Helpers compiled from older versions of windows.ps1 are never loaded again: remove them,
 * once per process and per state folder. Best effort: a helper that a running watcher still
 * has loaded is locked, and simply stays until next time.
 */
export function pruneOldHelpers(dir, current) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    if (name === current || !/^ShowLocalWin-[0-9a-f]{10}\.dll$/.test(name)) continue;
    try { rmSync(path.join(dir, name), { force: true }); removed.push(name); } catch { /* in use */ }
  }
  return removed;
}

function helperDll() {
  let tag = 'v1';
  try { tag = sha1(readFileSync(WATCHER, 'utf8')).slice(0, 10); } catch { /* keep default */ }
  const dir = stateDir();
  const name = `ShowLocalWin-${tag}.dll`;
  if (prunedIn !== dir) { prunedIn = dir; pruneOldHelpers(dir, name); }
  return path.join(dir, name);
}

/** Start a program without waiting for it and without a shell. Resolves once it has spawned. */
export function spawnDetached(cmd, args, opts = {}, spawnFn = spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
    } catch (e) { resolve({ ok: false, error: e.message }); return; }
    child.once('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
}

/** Run the watcher. `ready` resolves after its before-snapshot; `result` with its verdict. */
function watch(env, timeoutMs, spawnFn = spawn) {
  let readyResolve;
  let child;
  const ready = new Promise((r) => { readyResolve = r; });
  const result = new Promise((resolve) => {
    let out = '';
    let err = '';
    try {
      child = spawnFn('powershell.exe', [...PS_ARGS, '-File', WATCHER], {
        env: { ...process.env, SHOW_LOCAL_TIMEOUT: String(timeoutMs), SHOW_LOCAL_DLL: helperDll(), ...env },
        windowsHide: true,
      });
    } catch (e) {
      readyResolve();
      resolve({ matched: null, reason: `could not start the window watcher: ${e.message}` });
      return;
    }
    const guard = setTimeout(() => child.kill(), timeoutMs + 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      if (/(^|\n)READY\r?\n/.test(out)) readyResolve();
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(guard); readyResolve(); resolve({ matched: null, reason: `window watcher failed: ${e.message}` }); });
    child.on('close', () => {
      clearTimeout(guard);
      readyResolve();
      const line = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
      if (!line) { resolve({ matched: null, reason: `window watcher gave no result${err ? `: ${err.trim().slice(0, 200)}` : ''}` }); return; }
      try { resolve(JSON.parse(line)); } catch { resolve({ matched: null, reason: 'window watcher output was not JSON' }); }
    });
  });
  // Stop watching when the open itself failed, instead of waiting out the timeout.
  const cancel = () => { try { child?.kill(); } catch { /* already gone */ } };
  return { ready, result, cancel };
}

export function createWindowsAdapter({ runFn = run, spawnFn = spawn } = {}) {
  return {
    platform: 'win32',
    resolveBrowser: () => resolveWindowsBrowser(runFn),

    async openUrl(url, browser) {
      if (browser?.exe && existsSync(browser.exe)) {
        const r = await spawnDetached(browser.exe, browserArgs(browser, url), {}, spawnFn);
        if (r.ok) return { ok: true, with: browser.name, how: `${path.basename(browser.exe)} (default https browser)`, exe: browser.exe };
      }
      // Fallback: let the shell pick the handler for the URL. The URL travels in an env var.
      const r = runFn('powershell.exe', [...PS_ARGS, '-Command', 'Start-Process -FilePath $env:SHOW_LOCAL_TARGET'], { env: { SHOW_LOCAL_TARGET: url } });
      return r.status === 0
        ? { ok: true, with: 'default handler', how: 'Start-Process (browser could not be resolved from the registry)' }
        : { ok: false, error: (r.stderr || r.error || 'Start-Process failed').trim() };
    },

    async openFolder(dir, select) {
      // Windows paths cannot contain double quotes, so quoting here cannot be broken out of.
      const arg = select ? `/select,"${select}"` : `"${dir}"`;
      const r = await spawnDetached('explorer.exe', [arg], { windowsVerbatimArguments: true }, spawnFn);
      return r.ok ? { ok: true, with: 'File Explorer', how: select ? 'explorer /select' : 'explorer' } : r;
    },

    async openApp(file, app = this.appFor(file)) {
      const r = runFn('powershell.exe', [...PS_ARGS, '-Command', 'Invoke-Item -LiteralPath $env:SHOW_LOCAL_TARGET'], { env: { SHOW_LOCAL_TARGET: file } });
      return r.status === 0
        ? { ok: true, with: app?.name || 'default app', how: 'Invoke-Item (file association)' }
        : { ok: false, error: (r.stderr || r.error || 'Invoke-Item failed').trim() };
    },

    /** The program associated with a file type, when the registry says so (doctor reads the same). */
    appFor(file) {
      return windowsAppFor(runFn, path.extname(file).toLowerCase());
    },

    watchWindows({ tokens = [], processes = [], timeoutMs = 5000 }) {
      return watch({ SHOW_LOCAL_MODE: 'window', SHOW_LOCAL_TOKENS: JSON.stringify(tokens), SHOW_LOCAL_PROCESSES: JSON.stringify(processes) }, timeoutMs, spawnFn);
    },

    watchAppWindows(opts) { return this.watchWindows(opts); },

    /**
     * Every result carries selectedOk: true or false as windows.ps1 saw the file in the window
     * when one was asked for, null when none was asked for or the selection could not be read
     * (a watcher that failed, or gave no answer about it). `altDir` and `altSelect` are the
     * same folder and file under their 8.3 short spelling, when that is what Explorer was
     * given: a window on either spelling counts.
     */
    watchFolder({ dir, select, altDir, altSelect, timeoutMs = 5000 }) {
      const alt = { ...(altDir ? { SHOW_LOCAL_DIR_ALT: altDir } : {}), ...(altSelect ? { SHOW_LOCAL_SELECT_ALT: altSelect } : {}) };
      const w = watch({ SHOW_LOCAL_MODE: 'explorer', SHOW_LOCAL_DIR: dir, SHOW_LOCAL_SELECT: select || '', ...alt }, timeoutMs, spawnFn);
      const selectedOk = (r) => (select && typeof r.selectedOk === 'boolean' ? r.selectedOk : null);
      return { ...w, result: w.result.then((r) => ({ ...r, selectedOk: selectedOk(r) })) };
    },

    snapshot() {
      const r = runFn('powershell.exe', [...PS_ARGS, '-File', WATCHER], { env: { SHOW_LOCAL_MODE: 'snapshot', SHOW_LOCAL_DLL: helperDll() }, timeout: 20000 });
      const line = r.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
      try { return JSON.parse(line); } catch { return { ok: false, error: (r.stderr || r.error || 'no output').trim() }; }
    },
  };
}
