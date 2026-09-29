// Ports, waits, the time budget, the window timeout, recorded dev servers and result shapes:
//   - a static server gets the first free port from 4400 that no other launch.json entry claims,
//     and a folder keeps its own port while it is free (its launch.json entry or its live
//     registry entry)
//   - a direct open waits 4.5 s for a local server and finishes within its 9.6 s budget, measured
//     with a real watcher; a served next.then passes 10 s, a dev one 60 s
//   - SHOW_LOCAL_TIMEOUT_MS sets the default window timeout, validated; --timeout wins
//   - a dev server a page opened on is recorded, so `servers` lists it and `stop` ends it, and
//     never a process that cannot be tied to the project
//   - a page's own local scripts count for "needs http"; every browser open reports
//     browser {exe, name}; every error carries verified:false with its evidence
//
// Nothing here opens a window, a browser or an app: in-process calls use a recording fake
// adapter (the budget measurement runs the real Windows watcher with an opener that opens
// nothing), the CLI runs only --help, plan, serve, servers and stop, against a private state
// folder, and the only real processes are loopback servers this file starts and stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeRun, freePort, lib, ROOT, SHOW, tempDir } from './helpers.mjs';

const {
  show, timeoutFromEnv, adapterFor, DEFAULT_TIMEOUT_MS, DEFAULT_WAIT_MS, SERVED_WAIT_MS, DEV_WAIT_MS, TIMEOUT_ENV, MAX_ENV_TIMEOUT_MS,
  DIRECT_BUDGET_MS, WATCH_FLOOR_MS,
} = await import(lib('open.mjs'));
const registry = await import(lib('registry.mjs'));
const { slugFor } = await import(lib('util.mjs'));
const { detect, localScripts, needsServer, MAX_LOCAL_SCRIPTS, MAX_SCRIPT_SCAN } = await import(lib('detect.mjs'));
const { listeningPid } = await import(lib('portowner.mjs'));
const { isPortFree, PORT_MIN, PORT_MAX } = await import(lib('ports.mjs'));
const { pruneOldHelpers } = await import(lib('adapters/win.mjs'));
const { doctor } = await import(lib('doctor.mjs'));

const onWindows = process.platform === 'win32';
const STATE_NAME = typeof process.getuid === 'function' ? `show-local-${process.getuid()}` : 'show-local';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Paths inside the pasteable next.* commands use forward slashes on Windows.
const shellForm = (p) => (onWindows ? String(p).replace(/\\/g, '/') : String(p));

// ---------------------------------------------------------------------------------------------
// helpers

function write(file, text = '') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** A folder with index.html: a static site. */
function site(dir, name = 'site') {
  const root = path.join(dir, name);
  write(path.join(root, 'index.html'), '<!doctype html><title>Site</title>');
  return root;
}

/** Run fn(dir) in a fresh temp folder that is always removed. */
async function inTemp(fn) {
  const t = tempDir('show-local-a1-');
  try { return await fn(t.dir); } finally { try { t.cleanup(); } catch { /* a Windows handle may linger */ } }
}

/**
 * A private state folder (server registry, logs) for the length of fn: set in this process
 * for in-process calls, and handed over as `env` for CLI children. The user's real servers
 * are never seen or touched.
 */
async function withState(fn) {
  const t = tempDir('show-local-a1-state-');
  const env = { TEMP: t.dir, TMP: t.dir, TMPDIR: t.dir, XDG_RUNTIME_DIR: '' };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    return await fn({ env, serversDir: path.join(t.dir, STATE_NAME, 'servers') });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { t.cleanup(); } catch { /* a Windows handle may linger */ }
  }
}

/** process.env with `vars` set; Windows names are case-insensitive, so an inherited "Temp" must not shadow "TEMP". */
function childEnv(vars = {}) {
  const key = (k) => (onWindows ? k.toUpperCase() : k);
  const names = new Set(Object.keys(vars).map(key));
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!names.has(key(k))) out[k] = v;
  return { ...out, ...vars };
}

/** Run show.mjs; resolves with exit code, output and the parsed JSON (if any). */
function cli(args, { cwd = ROOT, env, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHOW, ...args], { cwd, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`show.mjs ${args.join(' ')} timed out\n${stdout}\n${stderr}`)); }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not one JSON document */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}

function jsonOf(r) {
  assert.ok(r.json && typeof r.json === 'object', `expected one JSON object, got:\n${r.stdout}\n${r.stderr}`);
  return r.json;
}

/**
 * A recording adapter: `win` is every watcher's verdict, `open` what every open* returns,
 * `browser` what resolveBrowser returns.
 */
function fakeAdapter({
  win = { matched: true, confidence: 'high', title: 'Fake page - Fake Browser' },
  open = { ok: true, with: 'Fake Browser', how: 'fake' },
  browser = { name: 'Fake Browser', process: 'fakebrowser', exe: '/opt/fake/fakebrowser' },
} = {}) {
  const calls = [];
  const watch = (fn) => (args) => { calls.push({ fn, args }); return { ready: Promise.resolve(), result: Promise.resolve(win), cancel() {} }; };
  return {
    calls,
    only: (fn) => calls.filter((c) => c.fn === fn),
    resolveBrowser() { return browser; },
    async openUrl(url, b) { calls.push({ fn: 'openUrl', args: [url, b] }); return open; },
    async openFolder(dir, sel) { calls.push({ fn: 'openFolder', args: [dir, sel] }); return open; },
    async openApp(file, a) { calls.push({ fn: 'openApp', args: [file, a] }); return open; },
    appFor() { return { name: 'Viewer', process: 'viewer' }; },
    watchWindows: watch('watchWindows'),
    watchAppWindows: watch('watchAppWindows'),
    watchFolder: watch('watchFolder'),
  };
}

/** Stands in for the title fetch of a plain remote page: the network is never used here. */
const offline = async () => ({ ok: false, error: 'offline (test)' });

/** A plain HTTP server on 127.0.0.1; sockets are tracked so it always closes. */
async function withHttp(handler, fn) {
  const port = await freePort();
  const sockets = new Set();
  const srv = http.createServer(handler);
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  try { return await fn(port); } finally { srv.close(); for (const s of sockets) s.destroy(); }
}

/** A pid that no process has right now. */
function deadPid() {
  for (let p = 4194301; p > 4000000; p -= 4) {
    try { process.kill(p, 0); } catch (e) { if (e.code === 'ESRCH') return p; }
  }
  throw new Error('could not find an unused pid');
}

/** isFree for pickPort: every port free except `busy`. */
const freeExcept = (busy = []) => { const set = new Set(busy); return async (p) => !set.has(p); };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// The OS lookups for "who listens on this port": Windows is faked as Windows (netstat +
// PowerShell), everywhere else as macOS (lsof + ps), so a real temp path is valid for it.
const HOST = onWindows ? 'win32' : 'darwin';
const winCommand = (argv) => argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
function ownerRun(port, procs) {
  const byPid = (pid) => procs.find((p) => String(p.pid) === String(pid));
  if (HOST === 'win32') {
    const rows = procs.map((p) => `  TCP    127.0.0.1:${port}      0.0.0.0:0              LISTENING       ${p.pid}`).join('\r\n');
    return fakeRun([
      ['netstat', { stdout: `\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n${rows}\r\n` }],
      [(cmd) => cmd === 'powershell.exe', (cmd, args, opts) => {
        const p = byPid(opts.env?.SHOW_LOCAL_PID);
        return { stdout: `${JSON.stringify(p ? [{ pid: p.pid, name: p.name, exe: '', commandLine: winCommand(p.argv) }] : [])}\r\n` };
      }],
    ]);
  }
  return fakeRun([
    ['lsof -nP', { stdout: procs.map((p) => `${p.pid}\n`).join('') }],
    [(cmd, args) => cmd === 'ps' && args[1] === 'command=', (cmd, args) => ({ stdout: `${byPid(args[3])?.argv.join(' ') || ''}\n` })],
    [(cmd, args) => cmd === 'ps' && args[1] === 'comm=', (cmd, args) => ({ stdout: `${byPid(args[3])?.argv[0] || ''}\n` })],
    [(cmd, args) => cmd === 'lsof' && args[0] === '-a', (cmd, args) => ({ stdout: `p${args[2]}\nfcwd\nn${byPid(args[2])?.cwd || '/'}\n` })],
  ]);
}
/** A process of the project: its script sits inside root. */
const ownProc = (root, pid = process.pid) => ({ pid, name: 'node', argv: ['node', path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], cwd: root });

function canConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(1000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// ---------------------------------------------------------------------------------------------
// ports: first free from 4400; the same folder keeps its port

test('a new folder is planned on 4400 when it is free, else on the next free port up', () => withState(() => inTemp(async (dir) => {
  const root = site(dir);
  const r = await show(root, { planOnly: true, cwd: dir, isFree: freeExcept() });
  assert.equal(r.action, 'start-server', JSON.stringify(r));
  assert.equal(r.server.port, 4400);
  assert.equal(r.server.portSource, 'first-free');
  assert.equal(r.server.url, 'http://127.0.0.1:4400/');
  const busy = await show(root, { planOnly: true, cwd: dir, isFree: freeExcept([4400, 4401, 4403]) });
  assert.equal(busy.server.port, 4402);
  const full = await show(root, { planOnly: true, cwd: dir, isFree: freeExcept(range(PORT_MIN, PORT_MAX)) });
  assert.equal(full.error, 'no-free-port');
})));

test('--desktop: the same folder keeps its launch.json entry and port; when that port is busy it moves to the first free one', () => withState(() => inTemp(async (dir) => {
  const root = site(dir);
  const cwd = path.join(dir, 'project');
  mkdirSync(cwd);
  const file = path.join(cwd, '.claude', 'launch.json');

  const first = await show(root, { planOnly: true, desktop: true, cwd, isFree: freeExcept(range(4400, 4456)) });
  assert.equal(first.server.port, 4457);
  assert.equal(first.launchJson.action, 'created');
  const bytes = readFileSync(file);

  const again = await show(root, { planOnly: true, desktop: true, cwd, isFree: freeExcept() });
  assert.equal(again.server.port, 4457, 'same folder, same port, although 4400 is free');
  assert.equal(again.server.portSource, 'launch.json');
  assert.equal(again.server.name, first.server.name);
  assert.equal(again.launchJson.action, 'unchanged');
  assert.ok(readFileSync(file).equals(bytes), 'launch.json untouched');

  const moved = await show(root, { planOnly: true, desktop: true, cwd, isFree: freeExcept([4457]) });
  assert.equal(moved.server.port, 4400, 'its own port is busy: the first free one');
  assert.equal(moved.server.portSource, 'first-free');
  assert.equal(moved.launchJson.action, 'updated');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).configurations[0].port, 4400);

  // Without --desktop the entry still gives the folder its port, and nothing is written.
  const before = readFileSync(file);
  const plain = await show(root, { planOnly: true, cwd, isFree: freeExcept() });
  assert.equal(plain.server.port, 4400);
  assert.equal(plain.server.portSource, 'launch.json');
  assert.equal(plain.launchJson, null);
  assert.ok(readFileSync(file).equals(before));
})));

test("another folder's entry does not move a new folder off the first free port", () => withState(() => inTemp(async (dir) => {
  const cwd = path.join(dir, 'project');
  mkdirSync(cwd);
  const a = await show(site(dir, 'a'), { planOnly: true, desktop: true, cwd, isFree: freeExcept(range(4400, 4409)) });
  assert.equal(a.server.port, 4410);
  const b = await show(site(dir, 'b'), { planOnly: true, desktop: true, cwd, isFree: freeExcept() });
  assert.equal(b.server.port, 4400);
  assert.equal(b.launchJson.action, 'added');
})));

test('--desktop: a new entry never shares a port with another configuration, the user\'s own entries included', () => withState(() => inTemp(async (dir) => {
  const cwd = path.join(dir, 'project');
  const file = write(path.join(cwd, '.claude', 'launch.json'), `${JSON.stringify({
    version: '0.0.1',
    configurations: [
      { name: 'my-api', runtimeExecutable: 'npm', runtimeArgs: ['run', 'api'], port: 4400 },
      { name: 'docs', runtimeExecutable: 'npx', runtimeArgs: ['serve'], port: 4401 },
    ],
  }, null, 2)}\n`);
  // Every port is free on the machine: the claims alone move the new entry.
  const a = await show(site(dir, 'a'), { planOnly: true, desktop: true, cwd, isFree: freeExcept() });
  assert.equal(a.server.port, 4402, JSON.stringify(a.server));
  assert.equal(a.server.portSource, 'first-free');
  assert.equal(a.launchJson.action, 'added');
  const b = await show(site(dir, 'b'), { planOnly: true, desktop: true, cwd, isFree: freeExcept() });
  assert.equal(b.server.port, 4403, "another folder's show-local entry is a claim too");
  const ports = JSON.parse(readFileSync(file, 'utf8')).configurations.map((c) => c.port);
  assert.deepEqual(ports, [4400, 4401, 4402, 4403]);
  assert.equal(new Set(ports).size, ports.length, 'no two configurations share a port');
  // Without --desktop the plan skips the same ports, so its server never lands on a claimed one.
  const plain = await show(site(dir, 'c'), { planOnly: true, cwd, isFree: freeExcept() });
  assert.equal(plain.server.port, 4404);
  // The folder's own entry is its claim: it keeps its port.
  const again = await show(site(dir, 'a'), { planOnly: true, desktop: true, cwd, isFree: freeExcept() });
  assert.equal(again.server.port, 4402);
  assert.equal(again.server.portSource, 'launch.json');
  assert.equal(again.launchJson.action, 'unchanged');
})));

test("the folder's own remembered port still wins when another configuration names it too", () => withState(() => inTemp(async (dir) => {
  const root = site(dir);
  const cwd = path.join(dir, 'project');
  write(path.join(cwd, '.claude', 'launch.json'), JSON.stringify({
    version: '0.0.1',
    configurations: [
      { name: 'my-api', runtimeExecutable: 'npm', port: 4457 },
      { name: `show-${slugFor(root)}`, runtimeExecutable: 'node', port: 4457 },
    ],
  }, null, 2));
  const r = await show(root, { planOnly: true, desktop: true, cwd, isFree: freeExcept() });
  assert.equal(r.server.port, 4457);
  assert.equal(r.server.portSource, 'launch.json');
  // Once it is busy, the folder moves to the first free port, as any new entry does.
  const moved = await show(root, { planOnly: true, desktop: true, cwd, isFree: freeExcept([4457]) });
  assert.equal(moved.server.port, 4400);
  assert.equal(moved.server.portSource, 'first-free');
})));

test("a live registry entry gives the folder its port back when the port is free; a dead one does not", () => withState(() => inTemp(async (dir) => {
  const root = site(dir);
  registry.register({ kind: 'static', port: 4466, pid: process.pid, root, url: 'http://127.0.0.1:4466/' });
  const r = await show(root, { planOnly: true, cwd: dir, isFree: freeExcept() });
  assert.equal(r.server.port, 4466, JSON.stringify(r.server));
  assert.equal(r.server.portSource, 'registry');

  const other = site(dir, 'other');
  registry.register({ kind: 'static', port: 4467, pid: deadPid(), root: other });
  const o = await show(other, { planOnly: true, cwd: dir, isFree: freeExcept() });
  assert.equal(o.server.port, 4400);
  assert.equal(o.server.portSource, 'first-free');
})));

test('serve without --port takes the port of the folder\'s launch.json entry in --cwd, and registers as a static server', (t) => withState(({ env, serversDir }) => inTemp(async (dir) => {
  let port = null;
  for (let p = PORT_MAX; p >= PORT_MIN && port === null; p--) if (await isPortFree(p)) port = p;
  if (port === null) { t.skip(`no free port in ${PORT_MIN}-${PORT_MAX} on this machine`); return; }
  const root = site(dir);
  const cwd = path.join(dir, 'project');
  write(path.join(cwd, '.claude', 'launch.json'), JSON.stringify({ version: '0.0.1', configurations: [{ name: `show-${slugFor(root)}`, runtimeExecutable: 'node', port }] }, null, 2));
  const child = spawn(process.execPath, [SHOW, 'serve', root, '--cwd', cwd], { cwd: ROOT, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 300 && !out.includes('\n') && child.exitCode === null; i++) await sleep(50);
    const info = JSON.parse(out.split('\n')[0]);
    assert.equal(info.ok, true, out);
    assert.equal(info.port, port, 'the remembered port, not 4400');
    const entry = JSON.parse(readFileSync(path.join(serversDir, `${port}.json`), 'utf8'));
    assert.equal(entry.kind, 'static');
    assert.equal(entry.pid, child.pid);
    const stop = jsonOf(await cli(['stop', String(port)], { env }));
    assert.deepEqual(stop, { ok: true, stopped: [{ port, root }], notFound: [] });
    await Promise.race([exited, sleep(10000)]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(5000)]); }
  }
})));

// ---------------------------------------------------------------------------------------------
// waits and the budget: a direct open finishes within 9.6 s end to end; a served next.then passes 10 s

test('the waits: 4.5 s for a direct open, 10 s passed by a static next.then, 60 s by a dev one; a 9.6 s budget', () => {
  assert.equal(DEFAULT_WAIT_MS, 4500);
  assert.equal(SERVED_WAIT_MS, 10000);
  assert.equal(DEV_WAIT_MS, 60000);
  assert.equal(DIRECT_BUDGET_MS, 9600);
  assert.equal(WATCH_FLOOR_MS, 1000);
});

/**
 * A local page that starts answering `afterMs` after the returned start time: every request is
 * held until then (like a server that is still starting), then answered 200 with a title no
 * window shows.
 */
async function withLateServer(afterMs, fn) {
  let readyAt = Infinity;
  const hold = (s) => { if (Date.now() >= readyAt) { s.setHeader('content-type', 'text/html'); s.end('<title>show-local budget check (no window has this title)</title>'); } else setTimeout(() => hold(s), 20).unref(); };
  await withHttp((q, s) => hold(s), async (port) => {
    const start = Date.now();
    readyAt = start + afterMs;
    await fn(`http://127.0.0.1:${port}/`, start);
  });
}

/** An adapter whose watcher takes `readyMs` to start, then watches for its full timeout and sees nothing. */
function slowWatcherAdapter(readyMs) {
  const adapter = fakeAdapter();
  adapter.watchWindows = (args) => {
    adapter.calls.push({ fn: 'watchWindows', args });
    let cancelled = false;
    const ready = sleep(readyMs);
    const result = ready.then(() => sleep(args.timeoutMs)).then(() => (cancelled
      ? { matched: null, reason: 'cancelled' }
      : { matched: false, reason: `no new window matching the target appeared within ${args.timeoutMs} ms` }));
    return { ready, result, cancel() { cancelled = true; } };
  };
  return adapter;
}

test('budget: a server that answers after 4.3 s and a watcher that takes 700 ms to start still finish within 9.6 s', () => withLateServer(4300, async (url, start) => {
  const adapter = slowWatcherAdapter(700);
  const r = await show(url, { adapter, cwd: ROOT, t0: start, env: {} });
  const wall = Date.now() - start;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.opened, true);
  assert.equal(r.verified, false, 'the watcher looked for its whole (shortened) watch and saw nothing');
  const watchMs = adapter.only('watchWindows')[0].args.timeoutMs;
  assert.ok(watchMs < DEFAULT_TIMEOUT_MS && watchMs >= WATCH_FLOOR_MS, `the watch got what the budget had left: ${watchMs} ms`);
  assert.ok(wall <= DIRECT_BUDGET_MS, `${wall} ms end to end (watch ${watchMs} ms)`);
  assert.ok(r.ms <= DIRECT_BUDGET_MS, `${r.ms} ms`);
}));

test('budget: a watcher far slower to start than expected is stopped at the budget, with a null verdict that says why', () => withLateServer(4300, async (url, start) => {
  const adapter = slowWatcherAdapter(2500);
  const r = await show(url, { adapter, cwd: ROOT, t0: start, env: {} });
  const wall = Date.now() - start;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verified, null);
  assert.match(r.evidence[1], /^the window watch was stopped at the 9600 ms budget before it saw the window \(the watcher took \d+ ms to start\)$/);
  assert.ok(wall <= DIRECT_BUDGET_MS + 100, `${wall} ms end to end`);
}));

test('budget: an explicit --timeout is the caller\'s choice and is not cut; neither is an explicit --wait\'s longer budget', () => withLateServer(0, async (url, start) => {
  const explicit = slowWatcherAdapter(0);
  await show(url, { adapter: explicit, cwd: ROOT, t0: start - 8000, timeoutMs: 1500, env: {} });
  assert.equal(explicit.only('watchWindows')[0].args.timeoutMs, 1500, 'even 8 s into the budget');
  const cut = slowWatcherAdapter(0);
  await show(url, { adapter: cut, cwd: ROOT, t0: start - 8000, env: {} });
  assert.equal(cut.only('watchWindows')[0].args.timeoutMs, WATCH_FLOOR_MS, 'the default watch is cut, never below the floor');
  const served = slowWatcherAdapter(0);
  await show(url, { adapter: served, cwd: ROOT, t0: start - 8000, waitMs: SERVED_WAIT_MS, env: { SHOW_LOCAL_TIMEOUT_MS: '2000' } });
  assert.equal(served.only('watchWindows')[0].args.timeoutMs, 2000, 'a served next.then (--wait 10000) has 15.1 s, so 8 s in, the watch is not cut');
}));

test('budget, measured: a server answering after 4.3 s, the real Windows watcher and a no-op opener finish within 10 s', { skip: !onWindows && 'the real watcher measured here is the Windows one' }, async (t) => {
  for (const afterMs of [4300, 4450]) {
    await withLateServer(afterMs, async (url, start) => {
      const real = adapterFor('win32');
      const opened = [];
      // The real watcher looks at the real windows; the opener opens nothing.
      const adapter = { ...real, openUrl: async (u) => { opened.push(u); return { ok: true, with: 'no-op', how: 'no-op opener (test): nothing was opened' }; } };
      let watchMs = null;
      adapter.watchWindows = (args) => { watchMs = args.timeoutMs; return real.watchWindows(args); };
      const r = await show(url, { adapter, cwd: ROOT, t0: start, env: {} });
      const wall = Date.now() - start;
      t.diagnostic(`server after ${afterMs} ms: ${wall} ms end to end, result ms ${r.ms}, watch ${watchMs} ms, verified ${r.verified}, evidence ${JSON.stringify(r.evidence)}`);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(opened, [url]);
      assert.ok(wall <= 10000, `${wall} ms end to end`);
      assert.ok(r.ms <= DIRECT_BUDGET_MS + 100, `${r.ms} ms`);
      assert.notEqual(r.verified, true, 'nothing was opened, so nothing can be proven');
    });
  }
});

test('a local URL whose server is down fails after 4.5 s, within the 10 s budget, and opens nothing', async () => {
  const port = await freePort();
  const adapter = fakeAdapter();
  const r = await show(`http://127.0.0.1:${port}/`, { adapter, cwd: ROOT });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'server-not-responding');
  assert.match(r.detail, /within 4500 ms; nothing was opened/);
  assert.ok(r.ms >= 4400 && r.ms < 10000, `${r.ms} ms`);
  assert.equal(adapter.only('openUrl').length, 0);
});

test('next.then: a static server gets --wait 10000, a dev server --wait 60000 and its --dev-root', () => withState(() => inTemp(async (dir) => {
  const page = write(path.join(dir, 'app', 'app.html'), '<title>App</title><script type="module" src="main.js"></script>');
  const s = await show(page, { planOnly: true, cwd: dir, isFree: freeExcept() });
  assert.equal(s.next.then, `node '${shellForm(path.resolve(SHOW))}' '${s.server.url}' --wait 10000 --log '${shellForm(s.server.log)}'`);

  const port = await freePort();
  const proj = path.join(dir, 'shop');
  write(path.join(proj, 'package.json'), JSON.stringify({ scripts: { dev: `vite --port ${port}` } }));
  const d = await show(proj, { planOnly: true, cwd: dir, runFn: fakeRun([]), platform: HOST });
  assert.equal(d.action, 'start-server', JSON.stringify(d));
  assert.equal(d.next.then, `node '${shellForm(path.resolve(SHOW))}' 'http://localhost:${port}/' --wait 60000 --dev-root '${shellForm(proj)}'`);

  const unknown = path.join(dir, 'mystery');
  write(path.join(unknown, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const u = await show(unknown, { planOnly: true, cwd: dir });
  assert.equal(u.error, 'dev-port-unknown');
  assert.ok(u.next.then.endsWith(`'<that address>' --wait 60000 --dev-root '${shellForm(unknown)}'`), u.next.then);
})));

test("a project's dev server that listens but is still building gets the dev wait, not the 4.5 s direct one", () => inTemp(async (dir) => {
  // Every request is held until readyAt. Set 7 s ahead of the open: its 2 s "already up?" probe
  // sees silence, and a 4.5 s wait after that would give up at about 6.5 s.
  let readyAt = Infinity;
  const hold = (s) => { if (Date.now() >= readyAt) s.end('<title>Built</title>'); else setTimeout(() => hold(s), 50).unref(); };
  await withHttp((q, s) => hold(s), async (port) => {
    const root = path.join(dir, 'shop');
    write(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: `vite --port ${port}` } }));
    const runFn = ownerRun(port, [ownProc(root)]);
    const quick = await show(root, { adapter: fakeAdapter(), runFn, platform: HOST, cwd: dir, waitMs: 300 });
    assert.equal(quick.error, 'server-not-responding', '--wait is honoured as given');
    readyAt = Date.now() + 7000;
    const r = await show(root, { adapter: fakeAdapter(), runFn, platform: HOST, cwd: dir, timeoutMs: 100 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.alreadyRunning, true);
    assert.equal(r.opened, true);
    assert.ok(r.evidence.includes(`HTTP 200 from localhost:${port}`), JSON.stringify(r.evidence));
  });
}));

// ---------------------------------------------------------------------------------------------
// SHOW_LOCAL_TIMEOUT_MS

test('timeoutFromEnv accepts whole milliseconds from 0 to the maximum and falls back to 5000 otherwise, with a note', () => {
  assert.equal(TIMEOUT_ENV, 'SHOW_LOCAL_TIMEOUT_MS');
  assert.deepEqual(timeoutFromEnv({}), { ms: 5000, note: null });
  assert.deepEqual(timeoutFromEnv({ SHOW_LOCAL_TIMEOUT_MS: '' }), { ms: 5000, note: null });
  assert.deepEqual(timeoutFromEnv({ SHOW_LOCAL_TIMEOUT_MS: '   ' }), { ms: 5000, note: null });
  for (const [raw, ms] of [['1', 1], ['0', 0], [' 750 ', 750], ['0500', 500], [String(MAX_ENV_TIMEOUT_MS), MAX_ENV_TIMEOUT_MS]]) {
    assert.deepEqual(timeoutFromEnv({ SHOW_LOCAL_TIMEOUT_MS: raw }), { ms, note: null }, raw);
  }
  for (const raw of [String(MAX_ENV_TIMEOUT_MS + 1), 'abc', '-5', '1.5', '1e3', '0x10', '5 s', '99999999999999999999999']) {
    const r = timeoutFromEnv({ SHOW_LOCAL_TIMEOUT_MS: raw });
    assert.equal(r.ms, 5000, raw);
    assert.match(r.note, /^SHOW_LOCAL_TIMEOUT_MS=".+" is not a whole number of milliseconds from 0 to 600000, so the default 5000 ms was used$/, raw);
  }
  assert.ok(timeoutFromEnv({ SHOW_LOCAL_TIMEOUT_MS: 'x'.repeat(500) }).note.length < 200, 'a long value is shortened in the note');
});

test('the window watch in every mode uses SHOW_LOCAL_TIMEOUT_MS; --timeout still wins', () => inTemp(async (dir) => {
  const page = write(path.join(dir, 'report.html'), '<title>Report</title>');
  const pdf = write(path.join(dir, 'doc.pdf'), '%PDF-1.4');
  const out = path.join(dir, 'out');
  write(path.join(out, 'a.png'), 'png');
  const watched = async (target, opts) => {
    const adapter = fakeAdapter();
    const r = await show(target, { adapter, cwd: dir, ...opts });
    return { r, timeout: adapter.calls.find((c) => c.fn.startsWith('watch')).args.timeoutMs };
  };
  for (const target of [page, pdf, out]) {
    assert.equal((await watched(target, { env: {} })).timeout, 5000, target);
    assert.equal((await watched(target, { env: { SHOW_LOCAL_TIMEOUT_MS: '1' } })).timeout, 1, target);
    assert.equal((await watched(target, { env: { SHOW_LOCAL_TIMEOUT_MS: '1' }, timeoutMs: 300 })).timeout, 300, `${target}: --timeout wins`);
    const bad = await watched(target, { env: { SHOW_LOCAL_TIMEOUT_MS: 'soon' } });
    assert.equal(bad.timeout, 5000);
    assert.ok(bad.r.notes?.some((n) => /SHOW_LOCAL_TIMEOUT_MS="soon" is not a whole number/.test(n)), JSON.stringify(bad.r.notes));
  }
}));

test('a SHOW_LOCAL_TIMEOUT_MS above the default moves the budget with it, so a slow machine gets the whole watch', () => inTemp(async (dir) => {
  const page = write(path.join(dir, 'report.html'), '<title>Report</title>');
  const pdf = write(path.join(dir, 'doc.pdf'), '%PDF-1.4');
  const out = path.join(dir, 'out');
  write(path.join(out, 'a.png'), 'png');
  for (const target of [page, pdf, out]) {
    for (const ms of [20000, 60000]) {
      const adapter = fakeAdapter();
      const r = await show(target, { adapter, cwd: dir, env: { SHOW_LOCAL_TIMEOUT_MS: String(ms) } });
      assert.equal(adapter.calls.find((c) => c.fn.startsWith('watch')).args.timeoutMs, ms, `${target}: ${ms}`);
      assert.equal(r.notes, undefined, JSON.stringify(r.notes));
    }
  }
}));

test('a SHOW_LOCAL_TIMEOUT_MS watch that the budget still cuts says so in a note', () => withLateServer(0, async (url, start) => {
  // 8 s into the open (a long server wait): the budget, moved by 15 s, leaves less than 20 s.
  const adapter = fakeAdapter();
  const r = await show(url, { adapter, cwd: ROOT, t0: start - 8000, env: { SHOW_LOCAL_TIMEOUT_MS: '20000' } });
  const watchMs = adapter.only('watchWindows')[0].args.timeoutMs;
  assert.ok(watchMs > 14000 && watchMs < 20000, `${watchMs} ms`);
  assert.ok(r.notes?.some((n) => n === `the window watch was cut from the 20000 ms that SHOW_LOCAL_TIMEOUT_MS asks for to ${watchMs} ms, what the open's time budget had left; --timeout is never cut`), JSON.stringify(r.notes));
}));

test("a project's dev server opened with a long SHOW_LOCAL_TIMEOUT_MS gets the whole watch too", () => inTemp(async (dir) => {
  await withHttp((q, s) => s.end('<title>Shop</title>'), async (port) => {
    const root = path.join(dir, 'shop');
    write(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: `vite --port ${port}` } }));
    const adapter = fakeAdapter();
    // 8 s into the open: only the dev branch's own deadline, moved by the setting, leaves 20 s.
    const r = await show(root, { adapter, runFn: ownerRun(port, [ownProc(root)]), platform: HOST, cwd: dir, t0: Date.now() - 8000, env: { SHOW_LOCAL_TIMEOUT_MS: '20000' } });
    assert.equal(r.alreadyRunning, true, JSON.stringify(r));
    assert.equal(adapter.only('watchWindows')[0].args.timeoutMs, 20000);
  });
}));

test('a 0 ms window timeout looks for no window after the open: verified null with the reason, never false', () => inTemp(async (dir) => {
  const page = write(path.join(dir, 'report.html'), '<title>Report</title>');
  const pdf = write(path.join(dir, 'doc.pdf'), '%PDF-1.4');
  const out = path.join(dir, 'out');
  write(path.join(out, 'a.png'), 'png');
  const reason = 'the window timeout is 0 ms, so no window was looked for after the open';
  for (const target of [page, pdf, out]) {
    for (const opts of [{ env: { SHOW_LOCAL_TIMEOUT_MS: '0' } }, { timeoutMs: 0, env: {} }]) {
      // A watcher asked to watch for 0 ms could only say "not seen".
      const adapter = fakeAdapter({ win: { matched: false, reason: 'no new window matching the target appeared within 0 ms' } });
      const r = await show(target, { adapter, cwd: dir, ...opts });
      const label = `${target} ${JSON.stringify(opts)}`;
      assert.equal(r.ok, true, label);
      assert.equal(r.opened, true, label);
      assert.equal(r.verified, null, `${label}: ${JSON.stringify(r)}`);
      assert.deepEqual(r.evidence, [reason], label);
      assert.equal(adapter.calls.filter((c) => c.fn.startsWith('watch')).length, 0, `${label}: no watcher was started`);
      if (target === out) assert.equal(r.selected, null, `${label}: the selection was not checked either`);
    }
  }
}));

test('a window that does not show up in time is opened:true with verified:false, never a claim that it opened', () => inTemp(async (dir) => {
  const page = write(path.join(dir, 'report.html'), '<title>Report</title>');
  const adapter = fakeAdapter({ win: { matched: false, reason: 'no new window matching the target appeared within 1 ms' } });
  const r = await show(page, { adapter, cwd: dir, env: { SHOW_LOCAL_TIMEOUT_MS: '1' } });
  assert.equal(r.ok, true);
  assert.equal(r.opened, true);
  assert.equal(r.verified, false);
  assert.equal(r.confidence, null);
  assert.deepEqual(r.evidence, ['no new window matching the target appeared within 1 ms']);
}));

test('cli: an unusable SHOW_LOCAL_TIMEOUT_MS is reported in notes; a valid one is silent', async () => {
  const bad = jsonOf(await cli(['plan', 'https://example.com/'], { env: { SHOW_LOCAL_TIMEOUT_MS: 'abc' } }));
  assert.equal(bad.ok, true);
  assert.ok(bad.notes?.some((n) => /SHOW_LOCAL_TIMEOUT_MS="abc"/.test(n)), JSON.stringify(bad));
  const good = jsonOf(await cli(['plan', 'https://example.com/'], { env: { SHOW_LOCAL_TIMEOUT_MS: '2500' } }));
  assert.equal(good.notes, undefined);
});

// ---------------------------------------------------------------------------------------------
// dev servers are recorded once a page opens on them

test('--dev-root records the dev server the page opened on; servers lists it while its pid owns the port', () => withState(() => withHttp((q, s) => s.end('<title>Shop</title>'), (port) => inTemp(async (dir) => {
  const root = path.join(dir, 'shop');
  mkdirSync(root);
  const adapter = fakeAdapter();
  const r = await show(`http://127.0.0.1:${port}/`, { adapter, devRoot: root, runFn: ownerRun(port, [ownProc(root)]), platform: HOST, cwd: ROOT, timeoutMs: 100 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.registered, { kind: 'dev', port, pid: process.pid, root });
  const entry = registry.entryAt(port);
  assert.equal(entry.kind, 'dev');
  assert.equal(entry.url, `http://127.0.0.1:${port}/`);
  assert.ok(!Number.isNaN(Date.parse(entry.started)));

  assert.deepEqual((await registry.listServers({ owners: () => [process.pid] })).map((e) => [e.port, e.kind, e.pid]), [[port, 'dev', process.pid]]);
  assert.equal(await registry.findServerFor(root), null, 'a dev server is never reused as a static one');
  // Its pid no longer owns the port: the entry is stale and goes.
  assert.deepEqual(await registry.listServers({ owners: () => [process.pid + 1] }), []);
  assert.equal(registry.entryAt(port), null);
}))));

test('a relative --dev-root resolves against --cwd', () => withState(() => withHttp((q, s) => s.end('<title>Shop</title>'), (port) => inTemp(async (dir) => {
  const root = path.join(dir, 'shop');
  mkdirSync(root);
  const r = await show(`http://127.0.0.1:${port}/`, { adapter: fakeAdapter(), devRoot: 'shop', runFn: ownerRun(port, [ownProc(root)]), platform: HOST, cwd: dir, timeoutMs: 100 });
  assert.deepEqual(r.registered, { kind: 'dev', port, pid: process.pid, root });
}))));

test('nothing is recorded unless the listener can be tied to the project (stop must never end a stranger)', () => withState(() => withHttp((q, s) => s.end('<title>x</title>'), (port) => inTemp(async (dir) => {
  const root = path.join(dir, 'shop');
  mkdirSync(root);
  const url = `http://127.0.0.1:${port}/`;
  const cases = [
    ['a stranger listens', ownerRun(port, [{ pid: process.pid, name: 'python', argv: ['python', path.join(dir, 'elsewhere', 'srv.py')], cwd: path.join(dir, 'elsewhere') }]), root, /could be tied to/],
    ['a sibling folder with the same prefix', ownerRun(port, [ownProc(`${root}-v2`)]), root, /could be tied to/],
    ['the OS cannot name the listener', fakeRun([]), root, /could not be identified/],
    ['--dev-root is not a folder', ownerRun(port, [ownProc(root)]), path.join(dir, 'missing'), /is not a folder/],
  ];
  for (const [label, runFn, devRoot, why] of cases) {
    const r = await show(url, { adapter: fakeAdapter(), devRoot, runFn, platform: HOST, cwd: ROOT, timeoutMs: 100 });
    assert.equal(r.ok, true, `${label}: the page itself opened`);
    assert.equal(r.registered, undefined, label);
    assert.ok(r.notes?.some((n) => why.test(n) && /was not recorded; stop it the way it was started/.test(n)), `${label}: ${JSON.stringify(r.notes)}`);
    assert.equal(registry.entryAt(port), null, label);
  }
}))));

test('a port held by a live show-local static server is never overwritten with a dev entry', () => withState(() => withHttp((q, s) => s.end('<title>x</title>'), (port) => inTemp(async (dir) => {
  const root = path.join(dir, 'shop');
  mkdirSync(root);
  const staticEntry = { kind: 'static', port, pid: process.pid, root: dir };
  registry.register(staticEntry);
  const r = await show(`http://127.0.0.1:${port}/`, { adapter: fakeAdapter(), devRoot: root, runFn: ownerRun(port, [ownProc(root)]), platform: HOST, cwd: ROOT, timeoutMs: 100 });
  assert.equal(r.registered, undefined);
  assert.ok(r.notes?.some((n) => /belongs to a show-local static server/.test(n)), JSON.stringify(r.notes));
  assert.deepEqual(registry.entryAt(port), staticEntry);
}))));

test('nothing is recorded when nothing opened, and --dev-root outside URL mode is ignored with a note', () => withState(() => inTemp(async (dir) => {
  const root = path.join(dir, 'shop');
  mkdirSync(root);
  const port = await freePort();
  const down = await show(`http://127.0.0.1:${port}/`, { adapter: fakeAdapter(), devRoot: root, waitMs: 200, cwd: ROOT });
  assert.equal(down.error, 'server-not-responding');
  assert.equal(down.registered, undefined);
  assert.equal(registry.entryAt(port), null);

  await withHttp((q, s) => s.end('<title>x</title>'), async (p) => {
    const failed = await show(`http://127.0.0.1:${p}/`, { adapter: fakeAdapter({ open: { ok: false, error: 'no browser' } }), devRoot: root, runFn: ownerRun(p, [ownProc(root)]), platform: HOST, cwd: ROOT });
    assert.equal(failed.error, 'open-failed');
    assert.equal(registry.entryAt(p), null);
  });

  // A plain remote page is fetched for its title: the fetch is faked, so no test touches the network.
  const remote = await show('https://example.com/', { adapter: fakeAdapter(), devRoot: root, cwd: ROOT, timeoutMs: 100, fetchFn: offline });
  assert.equal(remote.registered, undefined);
  assert.ok(remote.notes?.some((n) => /applies only to a local http\(s\) address/.test(n)), JSON.stringify(remote.notes));

  const page = write(path.join(dir, 'p.html'), '<title>P</title>');
  const file = await show(page, { adapter: fakeAdapter(), devRoot: root, cwd: ROOT, timeoutMs: 100 });
  assert.ok(file.notes?.some((n) => /--dev-root applies only when opening a local http\(s\) address, so it was ignored/.test(n)), JSON.stringify(file.notes));
})));

test('a dev entry stays listed only while its process lives and listens; its kind must be known', () => withState(async ({ serversDir }) => {
  registry.register({ kind: 'dev', port: 5173, pid: deadPid(), root: os.tmpdir() });
  assert.deepEqual(await registry.listServers({ owners: () => [] }), []);
  assert.equal(existsSync(path.join(serversDir, '5173.json')), false, 'a dead dev server is pruned');
  writeFileSync(path.join(serversDir, '5174.json'), JSON.stringify({ kind: 'daemon', port: 5174, pid: process.pid, root: os.tmpdir() }));
  assert.deepEqual(await registry.listServers({ owners: () => [process.pid] }), [], 'an unknown kind is not an entry');
  assert.equal(registry.kindOf({}), 'static', 'entries written before kinds existed are static');
  assert.equal(registry.kindOf({ kind: 'dev' }), 'dev');
}));

test('end to end: a real dev server a page opened on is listed by servers and ended by stop <port>', (t) => withState(({ env }) => inTemp(async (dir) => {
  const root = path.join(dir, 'dev-app');
  const script = write(path.join(root, 'server.cjs'), [
    "const http = require('http');",
    "const srv = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end('<title>Dev app</title>'); });",
    "srv.listen(Number(process.argv[2]), '127.0.0.1', () => console.log('listening'));",
  ].join('\n'));
  const port = await freePort();
  const child = spawn(process.execPath, [script, String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 200 && !out.includes('listening'); i++) await sleep(50);
    assert.ok(out.includes('listening'), 'the dev server started');
    if (listeningPid(port) === null) { t.skip('this machine cannot name the process that owns a port (no netstat, lsof or ss)'); return; }

    const r = await show(`http://127.0.0.1:${port}/`, { adapter: fakeAdapter(), devRoot: root, cwd: dir, timeoutMs: 100 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.registered, { kind: 'dev', port, pid: child.pid, root }, JSON.stringify(r));

    const listed = jsonOf(await cli(['servers'], { env }));
    const entry = listed.servers.find((s) => s.port === port);
    assert.ok(entry, JSON.stringify(listed));
    assert.equal(entry.kind, 'dev');
    assert.equal(entry.pid, child.pid);
    assert.equal(entry.root, root);

    const stop = jsonOf(await cli(['stop', String(port)], { env }));
    assert.deepEqual(stop, { ok: true, stopped: [{ port, root, kind: 'dev' }], notFound: [] });
    await Promise.race([exited, sleep(10000)]);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'the dev server process ended');
    assert.equal(await canConnect(port), false, 'its port refuses connections');
    assert.equal(registry.entryAt(port), null, 'its entry is gone');
    assert.deepEqual(jsonOf(await cli(['servers'], { env })).servers, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(5000)]); }
  }
})));

test('stop never ends a process that a dev entry names but that does not own the port', (t) => withState(({ env, serversDir }) => withHttp((q, s) => s.end('x'), async (port) => {
  if (listeningPid(port) === null) { t.skip('this machine cannot name the process that owns a port'); return; }
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const gone = new Promise((resolve) => bystander.once('exit', resolve));
  try {
    mkdirSync(serversDir, { recursive: true });
    writeFileSync(path.join(serversDir, `${port}.json`), JSON.stringify({ kind: 'dev', port, pid: bystander.pid, root: os.tmpdir(), url: `http://127.0.0.1:${port}/` }));
    const r = await cli(['stop', String(port)], { env });
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(jsonOf(r), { ok: false, stopped: [], notFound: [String(port)] });
    await sleep(300);
    assert.ok(bystander.exitCode === null && bystander.signalCode === null, 'the named process is still running');
  } finally {
    bystander.kill();
    await Promise.race([gone, sleep(5000)]);
  }
})));

test('doctor labels a recorded dev server', async () => {
  const r = await doctor({ platform: 'linux', runFn: fakeRun([]), env: {}, cwd: ROOT, countFreePorts: async () => 100, serversFn: async () => [{ kind: 'dev', port: 5173, pid: 1, root: '/work/shop' }] });
  assert.match(r.checks.find((c) => c.id === 'servers').detail, /5173 → \/work\/shop \(dev server\)/);
});

// ---------------------------------------------------------------------------------------------
// a page's own local scripts count for "needs http"

const REASON = { fetch: 'fetch() call', dynImport: 'dynamic import()', xhr: 'XMLHttpRequest', worker: 'Web Worker', sw: 'service worker' };

test('a classic script next to the page that calls fetch() makes the page served, and says which file', () => inTemp((dir) => {
  write(path.join(dir, 'app.js'), 'fetch("data.json").then((r) => r.json()).then(render);');
  const page = write(path.join(dir, 'page.html'), '<title>P</title><script src="app.js"></script>');
  assert.deepEqual(detect(page, { platform: 'linux' }), {
    ok: true, mode: 'serve', path: page, root: dir, entry: 'page.html', reasons: [`${REASON.fetch} in app.js`], title: 'P',
  });
}));

test('every script-level construct is found in a local script, in subfolders too, each reason once', () => inTemp((dir) => {
  write(path.join(dir, 'js', 'a.js'), 'import("./chunk.js"); new XMLHttpRequest();');
  write(path.join(dir, 'js', 'sub', 'w.js'), 'const w = new Worker("w2.js"); navigator.serviceWorker.register("sw.js"); fetch("x");');
  write(path.join(dir, 'js', 'c.js'), 'fetch("again")');
  const html = '<script>fetch("inline")</script><script src="./js/a.js"></script><script src="js/sub/w.js?v=3#x"></script><script src="js/c.js"></script>';
  assert.deepEqual(needsServer(html, { dir, platform: 'linux' }).reasons, [
    REASON.fetch, `${REASON.dynImport} in js/a.js`, `${REASON.xhr} in js/a.js`, `${REASON.worker} in js/sub/w.js`, `${REASON.sw} in js/sub/w.js`,
  ]);
  assert.deepEqual(needsServer(html).reasons, [REASON.fetch], 'without dir only the page itself is read');
}));

test('encoded, entity-escaped and quoted src forms resolve; only relative addresses in the folder are read', () => inTemp((dir) => {
  const js = 'fetch("x")';
  write(path.join(dir, 'my app.js'), js);
  write(path.join(dir, 'a&b.js'), js);
  write(path.join(dir, 'plain.js'), js);
  const found = (tag) => localScripts(tag, dir, 'linux').map((f) => path.relative(dir, f).split(path.sep).join('/'));
  assert.deepEqual(found('<script src="my%20app.js"></script>'), ['my app.js']);
  assert.deepEqual(found('<script src="a&amp;b.js"></script>'), ['a&b.js']);
  assert.deepEqual(found("<script src='plain.js'></script>"), ['plain.js']);
  assert.deepEqual(found('<SCRIPT SRC=plain.js defer></SCRIPT>'), ['plain.js']);
  assert.deepEqual(found('<script type="text/javascript" src="plain.js"></script><script src="plain.js"></script>'), ['plain.js'], 'once');
  for (const tag of [
    '<script src="../outside.js"></script>', '<script src="sub/../../outside.js"></script>', '<script src="/root.js"></script>',
    '<script src="//cdn.example/x.js"></script>', '<script src="https://cdn.example/x.js"></script>', '<script src="data:text/javascript,fetch(1)"></script>',
    '<script src="file:///etc/x.js"></script>', '<script src="%2e%2e/outside.js"></script>', '<script src=""></script>',
    '<script type="text/template" src="plain.js"></script>', '<script>var src = "plain.js"</script>',
  ]) assert.deepEqual(found(tag), [], tag);
  assert.deepEqual(found('<base href="https://cdn.example/"><script src="plain.js"></script>'), [], 'a <base href> changes what relative means');
}));

test('scripts outside the folder, missing, or not files are never read, and the page stays file:///', () => inTemp((dir) => {
  const pages = path.join(dir, 'pages');
  write(path.join(dir, 'outside.js'), 'fetch("x")');
  mkdirSync(path.join(pages, 'folder.js'), { recursive: true });
  const page = write(path.join(pages, 'p.html'), '<title>P</title><script src="../outside.js"></script><script src="missing.js"></script><script src="folder.js"></script>');
  assert.equal(detect(page, { platform: 'linux' }).mode, 'file');
}));

test('at most 10 scripts are read, and at most 512 KB of each', () => inTemp((dir) => {
  const tags = [];
  for (let i = 1; i <= MAX_LOCAL_SCRIPTS; i++) { write(path.join(dir, `s${i}.js`), 'console.log(1)'); tags.push(`<script src="s${i}.js"></script>`); }
  write(path.join(dir, 'late.js'), 'fetch("x")');
  tags.push('<script src="late.js"></script>');
  assert.equal(MAX_LOCAL_SCRIPTS, 10);
  assert.equal(localScripts(tags.join(''), dir, 'linux').length, 10);
  assert.deepEqual(needsServer(tags.join(''), { dir, platform: 'linux' }).reasons, [], 'the 11th script is not read');

  assert.equal(MAX_SCRIPT_SCAN, 512 * 1024);
  write(path.join(dir, 'big.js'), `${'/'.repeat(MAX_SCRIPT_SCAN)}\nfetch("x")`);
  write(path.join(dir, 'early.js'), `fetch("x")\n${'/'.repeat(MAX_SCRIPT_SCAN)}`);
  assert.deepEqual(needsServer('<script src="big.js"></script>', { dir, platform: 'linux' }).reasons, [], 'past 512 KB');
  assert.deepEqual(needsServer('<script src="early.js"></script>', { dir, platform: 'linux' }).reasons, [`${REASON.fetch} in early.js`]);
}));

test('on Windows, device names, drive letters and streams in a script address are skipped', () => inTemp((dir) => {
  for (const src of ['con.js', 'NUL', 'aux.txt.js', 'COM1.js', 'lpt9', 'c:evil.js', 'a.js:stream']) {
    assert.deepEqual(localScripts(`<script src="${src}"></script>`, dir, 'win32'), [], src);
  }
  assert.equal(localScripts('<script src="console.js"></script>', dir, 'win32').length, 1, 'a name that only starts like a device is fine');
  assert.equal(localScripts('<script src="con.js"></script>', dir, 'linux').length, 1, 'elsewhere con.js is an ordinary name');
}));

test('a script reached through a link to a network share is never read', (t) => inTemp((dir) => {
  write(path.join(dir, 'local.js'), 'console.log(1)');
  try { symlinkSync('\\\\show-local-test.invalid\\share\\x.js', path.join(dir, 'net.js'), 'file'); } catch { t.skip('links to a network path are not allowed here'); return; }
  const page = write(path.join(dir, 'p.html'), '<title>P</title><script src="net.js"></script><script src="local.js"></script>');
  const d = detect(page, { platform: 'win32' });
  assert.equal(d.mode, 'file', JSON.stringify(d));
}));

// ---------------------------------------------------------------------------------------------
// browser {exe, name} on every browser open

test('every browser open reports browser {exe, name}: what was launched, or what was tried', () => withHttp((q, s) => s.end('<title>Home</title>'), (port) => inTemp(async (dir) => {
  const page = write(path.join(dir, 'report.html'), '<title>Report</title>');
  const chrome = { ok: true, with: 'Google Chrome', how: 'chrome.exe (default https browser)', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' };
  const cases = [
    ['file', page, {}],
    ['local url', `http://127.0.0.1:${port}/`, {}],
    ['remote url', 'https://example.com/', { fetchFn: offline }],
    ['--no-verify', page, { verify: false }],
  ];
  for (const [label, target, opts] of cases) {
    const r = await show(target, { adapter: fakeAdapter({ open: chrome }), cwd: dir, timeoutMs: 100, ...opts });
    assert.deepEqual(r.browser, { exe: chrome.exe, name: 'Google Chrome' }, label);
  }
  const fallback = await show(page, { adapter: fakeAdapter({ open: { ok: true, with: 'default handler', how: 'Start-Process' } }), cwd: dir, timeoutMs: 100 });
  assert.deepEqual(fallback.browser, { exe: null, name: 'default handler' }, 'the system chose the program');
  const failed = await show(page, { adapter: fakeAdapter({ open: { ok: false, error: 'spawn failed' } }), cwd: dir, timeoutMs: 100 });
  assert.deepEqual(failed.browser, { exe: '/opt/fake/fakebrowser', name: 'Fake Browser' }, 'the browser that was tried');
})));

// ---------------------------------------------------------------------------------------------
// every error carries verified:false and its detail as the evidence

test('every error result carries verified:false and evidence [detail]', () => withState(() => inTemp(async (dir) => {
  const page = write(path.join(dir, 'report.html'), '<title>R</title>');
  const pdf = write(path.join(dir, 'a.pdf'), '%PDF-1.4');
  const out = path.join(dir, 'out');
  write(path.join(out, 'a.png'), 'png');
  const noPort = path.join(dir, 'dev0');
  write(path.join(noPort, 'package.json'), JSON.stringify({ scripts: { dev: 'node s.js' } }));
  const fail = () => fakeAdapter({ open: { ok: false, error: 'the opener failed' } });
  const results = {
    'not-found': await show(path.join(dir, 'missing.html'), { cwd: dir }),
    'bad-url': await show('http://', { cwd: dir }),
    'server-not-responding': await show(`http://127.0.0.1:${await freePort()}/`, { adapter: fakeAdapter(), waitMs: 200, cwd: dir }),
    'open-failed (file)': await show(page, { adapter: fail(), cwd: dir }),
    'open-failed (app)': await show(pdf, { adapter: fail(), cwd: dir }),
    'open-failed (folder)': await show(out, { adapter: fail(), cwd: dir }),
    'dev-port-unknown': await show(noPort, { planOnly: true, cwd: dir }),
    'no-free-port': await show(site(dir), { planOnly: true, cwd: dir, isFree: freeExcept(range(PORT_MIN, PORT_MAX)) }),
  };
  await withHttp((q, s) => s.end('x'), async (port) => {
    const proj = path.join(dir, 'shop');
    write(path.join(proj, 'package.json'), JSON.stringify({ scripts: { dev: `vite --port ${port}` } }));
    const stranger = { pid: 777, name: 'python', argv: ['python', path.join(dir, 'elsewhere', 'srv.py')], cwd: path.join(dir, 'elsewhere') };
    results['port-busy'] = await show(proj, { adapter: fakeAdapter(), runFn: ownerRun(port, [stranger]), platform: HOST, cwd: dir });
  });
  for (const [label, r] of Object.entries(results)) {
    assert.equal(r.ok, false, `${label}: ${JSON.stringify(r)}`);
    assert.equal(r.verified, false, label);
    assert.equal(typeof r.detail, 'string', label);
    assert.deepEqual(r.evidence, [r.detail], label);
    assert.notEqual(r.opened, true, label);
  }
})));

test('cli errors carry verified:false and evidence too; results without a detail keep their shape', async () => {
  const usage = await cli(['--frobnicate']);
  assert.equal(usage.code, 2);
  assert.deepEqual(jsonOf(usage), { ok: false, error: 'usage', detail: 'unknown option --frobnicate', verified: false, evidence: ['unknown option --frobnicate'] });
  const missing = jsonOf(await cli(['plan', path.join(os.tmpdir(), 'show-local-a1-missing', 'x.html')]));
  assert.equal(missing.verified, false);
  assert.deepEqual(missing.evidence, [missing.detail]);
  await withState(async ({ env }) => {
    const port = await freePort();
    assert.deepEqual(jsonOf(await cli(['stop', String(port)], { env })), { ok: false, stopped: [], notFound: [String(port)] });
  });
});

// ---------------------------------------------------------------------------------------------
// helpers compiled by older versions of the Windows watcher are removed

test('pruneOldHelpers removes only the helper DLLs of other watcher versions', () => inTemp((dir) => {
  const keep = ['ShowLocalWin-0123456789.dll', 'ShowLocalWin-abc.dll', 'other.dll', 'ShowLocalWin-abcdefabcd.dll.123.tmp', 'server-4400.log'];
  const old = ['ShowLocalWin-abcdefabcd.dll', 'ShowLocalWin-f98d8ea4d8.dll'];
  for (const f of [...keep, ...old]) writeFileSync(path.join(dir, f), 'x');
  assert.deepEqual(pruneOldHelpers(dir, 'ShowLocalWin-0123456789.dll').sort(), [...old].sort());
  assert.deepEqual(readdirSync(dir).sort(), [...keep].sort());
  assert.deepEqual(pruneOldHelpers(path.join(dir, 'missing'), 'x'), [], 'a missing folder is fine');
}));
