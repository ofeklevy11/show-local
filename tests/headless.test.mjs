// How long servers live, and headless runs.
//
// Headless runs (`claude -p`, Agent SDK programs, subagents, workflow steps): a session that
// started a server in the background cannot exit while that server runs. So the plan gives
// such a session one foreground command instead, `oneshot`: it starts the server, opens and
// verifies, keeps serving for a short linger, and stops everything. CLAUDE_CODE_ENTRYPOINT
// starting with "sdk" (measured "sdk-cli" in a `claude -p` Bash tool; the desktop app says
// "claude-desktop", the terminal "cli") makes a start-server plan headless, and so does
// `plan --headless` (subagents and workflow steps inherit the desktop app's entrypoint).
//
// Servers live with what started them: `serve` and `dev-run` end when their parent process
// ends, and dev-run ends the project's whole process tree, also when it is killed outright.
//
// The environment is always injected (opts.env, or a CLI child's env), and the registry is a
// private temp folder. Nothing here opens a window: oneshot runs with an adapter whose "browser"
// is an HTTP GET. The real processes are loopback servers and tiny `npm run dev` projects in
// temp folders, all stopped by the end of each test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fakeRun, freePort, lib, SHOW, tempDir } from './helpers.mjs';

const { show, isHeadless, adapterFor, ENTRYPOINT_ENV } = await import(lib('open.mjs'));
const { oneshot, DEFAULT_LINGER_MS, ONESHOT_STATIC_BUDGET_MS } = await import(lib('oneshot.mjs'));
const { devRunIdentity, killTree, watchParent, watchSession, sessionHostPid, system32 } = await import(lib('devrun.mjs'));
const { stateDir } = await import(lib('util.mjs'));
const { createStaticServer, listen } = await import(lib('server.mjs'));
const registry = await import(lib('registry.mjs'));

const onWindows = process.platform === 'win32';
const HOST = onWindows ? 'win32' : 'darwin';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Paths inside the pasteable next.* commands use forward slashes on Windows.
const shellForm = (p) => (onWindows ? String(p).replace(/\\/g, '/') : String(p));
const oneshotCommand = (target, cwd) => `node '${shellForm(path.resolve(SHOW))}' oneshot '${shellForm(target)}' --cwd '${shellForm(cwd)}'`;
const allFree = async () => true;
const SDK = { [ENTRYPOINT_ENV]: 'sdk-cli' };
const DESKTOP = { [ENTRYPOINT_ENV]: 'claude-desktop' };
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

function write(file, text = '') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/**
 * A fresh temp folder that is also this process's private state folder (server registry,
 * logs), so the user's real servers are never seen. Restored and removed afterwards. `vars`
 * hands the same folder to CLI children.
 */
async function inState(fn) {
  const t = tempDir('show-local-headless-');
  const vars = { TEMP: t.dir, TMP: t.dir, TMPDIR: t.dir, XDG_RUNTIME_DIR: '', npm_config_update_notifier: 'false' };
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    return await fn(t.dir, vars);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // A Windows handle may linger for a moment after a process tree ends.
    for (let i = 0; i < 10; i++) { try { t.cleanup(); break; } catch { await sleep(300); } }
  }
}

/** process.env with `vars` set; Windows names are case-insensitive, so drop inherited spellings. */
function childEnv(vars) {
  const names = new Set(Object.keys(vars).map((k) => (onWindows ? k.toUpperCase() : k)));
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!names.has(onWindows ? k.toUpperCase() : k)) out[k] = v;
  return { ...out, ...vars };
}

/** Run show.mjs to completion: { code, json, stdout }. */
function cli(args, vars) {
  const r = spawnSync(process.execPath, [SHOW, ...args], { env: childEnv(vars), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not one JSON document */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const site = (dir) => { const root = path.join(dir, 'site'); write(path.join(root, 'index.html'), '<title>Site</title>'); return root; };

async function devProject(dir) {
  const port = await freePort();
  const root = path.join(dir, 'shop');
  write(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: `vite --port ${port}` } }));
  return { root, port };
}

// A zombie (ended, not yet collected) is gone: the same rule as show-local's own pidAlive.
const alive = (pid) => registry.pidAlive(pid);

function canConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(800, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** GET a URL as a browser would identify itself; resolves with { status, body } or null. */
const browserGet = (url) => new Promise((resolve) => {
  const req = http.get(url, { headers: { 'user-agent': CHROME_UA }, agent: false }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
    res.on('error', () => resolve(null));
  });
  req.on('error', () => resolve(null));
});

/** Wait until cond() is true (polled), or ms pass. Resolves with the last value. */
async function until(cond, ms, every = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v || Date.now() >= end) return v;
    await sleep(every);
  }
}

/**
 * An adapter whose "browser" is an HTTP GET with a browser's user agent: the page really gets
 * requested, and nothing is opened on screen. Its watcher reports `win`.
 */
function getAdapter({ win = { matched: false, reason: 'no window (test adapter)' } } = {}) {
  const calls = [];
  return {
    calls,
    resolveBrowser: () => ({ name: 'Test GET', process: 'testget' }),
    watchWindows: (args) => { calls.push(['watchWindows', args]); return { ready: Promise.resolve(), result: sleep(Math.min(args.timeoutMs, 800)).then(() => win), cancel() {} }; },
    async openUrl(url) { calls.push(['openUrl', url]); await sleep(5); await browserGet(url); return { ok: true, with: 'Test GET', how: 'an HTTP GET stands in for the browser (test)' }; },
  };
}

// ---------------------------------------------------------------------------------------------
// Headless plans

test('isHeadless: only an entrypoint starting with "sdk" is headless', () => {
  assert.equal(ENTRYPOINT_ENV, 'CLAUDE_CODE_ENTRYPOINT');
  for (const v of ['sdk-cli', 'sdk-ts', 'sdk-py', 'SDK-CLI', ' sdk-cli ']) assert.equal(isHeadless({ [ENTRYPOINT_ENV]: v }), true, v);
  for (const v of ['claude-desktop', 'cli', 'claude-vscode', 'mcp', '', 'desktop-sdk']) assert.equal(isHeadless({ [ENTRYPOINT_ENV]: v }), false, v);
  assert.equal(isHeadless({}), false, 'unset');
  assert.equal(isHeadless({ [ENTRYPOINT_ENV]: undefined }), false);
  assert.equal(isHeadless(null), false);
});

test('headless static plan: headless: true, and next is the one oneshot command, nothing else', () => inState(async (dir) => {
  const root = site(dir);
  const r = await show(root, { planOnly: true, cwd: dir, isFree: allFree, env: SDK });
  assert.equal(r.action, 'start-server', JSON.stringify(r));
  assert.equal(r.headless, true);
  assert.equal(r.lifetime, 'command', 'the server lives for that one command');
  assert.deepEqual(r.next, { oneshot: oneshotCommand(root, dir) });
  // POSIX single quotes around every path; the flag is bare.
  assert.ok(r.next.oneshot.startsWith(`node '`), r.next.oneshot);
  assert.equal(r.server.port, 4400, 'the server block still says what would be served');
}));

test('not headless (desktop app, terminal, unset): no headless field, next is start and then', () => inState(async (dir) => {
  const root = site(dir);
  for (const env of [DESKTOP, { [ENTRYPOINT_ENV]: 'cli' }, {}]) {
    const r = await show(root, { planOnly: true, cwd: dir, isFree: allFree, env });
    assert.equal(r.action, 'start-server', JSON.stringify(r));
    assert.equal('headless' in r, false, JSON.stringify(env));
    assert.equal(r.lifetime, 'session');
    assert.deepEqual(Object.keys(r.next).sort(), ['start', 'then'], JSON.stringify(env));
  }
}));

test('plan --headless (headless: true) forces the headless plan whatever the entrypoint says', () => inState(async (dir) => {
  const root = site(dir);
  for (const env of [DESKTOP, {}]) {
    const r = await show(root, { planOnly: true, cwd: dir, isFree: allFree, env, headless: true });
    assert.equal(r.headless, true, JSON.stringify(env));
    assert.deepEqual(r.next, { oneshot: oneshotCommand(root, dir) });
  }
}));

test('headless dev plan: next.oneshot starts the project, opens, verifies and stops it in one command', () => inState(async (dir) => {
  const { root } = await devProject(dir);
  const r = await show(root, { planOnly: true, cwd: dir, runFn: fakeRun([]), platform: HOST, env: SDK });
  assert.equal(r.action, 'start-server', JSON.stringify(r));
  assert.equal(r.server.kind, 'dev');
  assert.equal(r.headless, true);
  assert.deepEqual(r.next, { oneshot: oneshotCommand(root, dir) });

  const plain = await show(root, { planOnly: true, cwd: dir, runFn: fakeRun([]), platform: HOST, env: DESKTOP });
  assert.equal('headless' in plain, false);
  assert.deepEqual(Object.keys(plain.next).sort(), ['start', 'then']);
  assert.match(plain.next.start, / dev-run '/);
}));

test('headless never touches a result that starts nothing: a direct open or an unknown dev port', () => inState(async (dir) => {
  const file = write(path.join(dir, 'report.html'), '<title>Report</title>');
  const f = await show(file, { planOnly: true, cwd: dir, env: SDK });
  assert.equal(f.action, 'open', JSON.stringify(f));
  assert.equal('headless' in f, false);
  assert.equal(f.next, undefined);

  const mystery = path.join(dir, 'mystery');
  write(path.join(mystery, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const u = await show(mystery, { planOnly: true, cwd: dir, env: SDK });
  assert.equal(u.error, 'dev-port-unknown');
  assert.equal(u.next.oneshot, undefined, 'no port, so nothing a oneshot could open');
}));

test('CLI: `show.mjs plan` reads the entrypoint from its own environment; --headless forces it', () => inState(async (dir, vars) => {
  const root = site(dir);
  const plan = (extra, flags = []) => cli(['plan', root, '--cwd', dir, ...flags], { ...vars, ...extra }).json;
  const h = plan(SDK);
  assert.equal(h.headless, true, JSON.stringify(h));
  assert.deepEqual(h.next, { oneshot: oneshotCommand(root, dir) });
  const d = plan(DESKTOP);
  assert.equal(d.action, 'start-server', JSON.stringify(d));
  assert.equal('headless' in d, false);
  assert.equal(d.next.oneshot, undefined);
  const forced = plan(DESKTOP, ['--headless']);
  assert.equal(forced.headless, true, JSON.stringify(forced));
  assert.deepEqual(forced.next, { oneshot: oneshotCommand(root, dir) });
}));

// ---------------------------------------------------------------------------------------------
// oneshot

test('oneshot (static): serves, opens, proves it by the log, lingers, then stops and frees the port', () => inState(async (dir) => {
  const root = site(dir);
  const port = await freePort();
  const adapter = getAdapter();
  const t0 = Date.now();
  const r = await oneshot(root, { cwd: dir, port, lingerMs: 300, adapter, env: {} });
  const total = Date.now() - t0;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.mode, 'serve');
  assert.equal(r.target, root);
  assert.equal(r.url, `http://127.0.0.1:${port}/`);
  assert.equal(r.opened, true);
  assert.equal(r.verified, true, 'the GET of the page is in the access log');
  assert.ok(r.evidence.some((e) => /^server log: \S+ GET \/ 200 "Mozilla/.test(e)), JSON.stringify(r.evidence));
  assert.deepEqual(r.server, { kind: 'static', stopped: true, port, lingerMs: 300, root, url: `http://127.0.0.1:${port}/` });
  assert.ok(r.ms <= ONESHOT_STATIC_BUDGET_MS, `${r.ms} ms`);
  assert.ok(r.totalMs >= r.ms + 300 && r.totalMs <= total + 5, `${r.totalMs} ms`);
  assert.equal(await canConnect(port), false, 'the port is free again');
  assert.equal(registry.entryAt(port), null, 'its registry entry is gone');
  assert.deepEqual(adapter.calls.filter(([fn]) => fn === 'openUrl'), [['openUrl', `http://127.0.0.1:${port}/`]]);
  assert.equal(DEFAULT_LINGER_MS, 3000);
}));

test('oneshot (static): a page that fails to open lingers for nothing, and the server still stops', () => inState(async (dir) => {
  const root = site(dir);
  const port = await freePort();
  const adapter = { ...getAdapter(), async openUrl() { return { ok: false, error: 'no browser (test)' }; } };
  const r = await oneshot(root, { cwd: dir, port, lingerMs: 5000, adapter, env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'open-failed');
  assert.equal(r.server.stopped, true);
  assert.equal(r.server.lingerMs, 0);
  assert.equal(await canConnect(port), false);
}));

test('oneshot (static): a folder a show-local server already serves is opened there, and that server is left running', () => inState(async (dir) => {
  const root = site(dir);
  const port = await freePort();
  const log = path.join(dir, 'running.log');
  write(log, '');
  const server = createStaticServer({ root, port, logFile: log, echo: false });
  await listen(server, port);
  registry.register({ kind: 'static', pid: process.pid, port, root, url: `http://127.0.0.1:${port}/`, log });
  try {
    const r = await oneshot(root, { cwd: dir, adapter: getAdapter(), env: {} });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.alreadyRunning, true);
    assert.equal(r.verified, true);
    assert.equal(r.server.stopped, false);
    assert.equal(r.server.port, port);
    assert.equal(await canConnect(port), true, 'still serving');
  } finally { server.close(); server.closeAllConnections?.(); registry.unregister(port); }
}));

test('oneshot: a target that needs no server is opened directly, and nothing is started', () => inState(async (dir) => {
  const file = write(path.join(dir, 'report.html'), '<title>Report</title>');
  const opened = [];
  const adapter = { ...getAdapter({ win: { matched: true, confidence: 'high', title: 'Report' } }), async openUrl(u) { opened.push(u); return { ok: true, with: 'Test', how: 'test' }; } };
  const r = await oneshot(file, { cwd: dir, adapter, env: {} });
  assert.equal(r.mode, 'file');
  assert.equal(r.verified, true);
  assert.equal(r.server, undefined);
  assert.ok(r.notes.includes('nothing here needs a server, so it was opened directly and nothing was started'), JSON.stringify(r.notes));
  assert.equal(opened.length, 1);
}));

test('oneshot (dev): a project without a known port starts nothing; --port names it', () => inState(async (dir) => {
  const mystery = path.join(dir, 'mystery');
  write(path.join(mystery, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const r = await oneshot(mystery, { cwd: dir, adapter: getAdapter(), env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'dev-port-unknown');
  assert.match(r.detail, /pass --port/);
  assert.equal(r.opened, false);
}));

test('CLI oneshot: usage errors exit 2 before anything starts', () => inState(async (dir, vars) => {
  const none = cli(['oneshot'], vars);
  assert.equal(none.code, 2);
  assert.equal(none.json.error, 'usage');
  const linger = cli(['oneshot', site(dir), '--linger', 'soon'], vars);
  assert.equal(linger.code, 2, linger.stdout);
  assert.match(linger.json.detail, /--linger must be an integer from 0 to 600000/);
}));

test('CLI oneshot: a failure before anything opens prints one JSON error, exits 1, and leaves nothing running', () => inState(async (dir, vars) => {
  const missing = cli(['oneshot', path.join(dir, 'nope.html')], vars);
  assert.equal(missing.code, 1);
  assert.equal(missing.json.error, 'not-found');
  assert.equal(missing.json.verified, false);
  // The port is taken by someone else: nothing is served, nothing is opened.
  const port = await freePort();
  const squatter = net.createServer().listen(port, '127.0.0.1');
  await new Promise((resolve) => squatter.once('listening', resolve));
  try {
    const busy = cli(['oneshot', site(dir), '--port', String(port)], vars);
    assert.equal(busy.code, 1, busy.stdout);
    assert.equal(busy.json.error, 'EADDRINUSE');
    assert.match(busy.json.detail, /nothing was started or opened/);
    assert.equal(busy.json.opened, false);
    assert.equal(registry.entryAt(port), null);
  } finally { squatter.close(); }
}));

test('oneshot, measured (static): the real Windows watcher, a GET as the browser; verified by the log, then the port is free', { skip: !onWindows && 'the real watcher measured here is the Windows one' }, (t) => inState(async (dir) => {
  const root = site(dir);
  write(path.join(root, 'index.html'), '<title>show-local oneshot measurement (no window has this title)</title>');
  const port = await freePort();
  const real = adapterFor('win32');
  // The real watcher looks at the real windows; the "browser" is a GET, so nothing opens on screen.
  const adapter = { ...real, async openUrl(u) { await sleep(5); await browserGet(u); return { ok: true, with: 'Test GET', how: 'an HTTP GET stands in for the browser (measurement)' }; } };
  const t0 = Date.now();
  const r = await oneshot(root, { cwd: dir, port, lingerMs: 500, adapter, env: {}, t0 });
  const wall = Date.now() - t0;
  const free = !(await canConnect(port)) && !(await canConnect(port, '::1'));
  t.diagnostic(`oneshot measured: verified ${r.verified}, open ${r.ms} ms, total ${r.totalMs} ms (wall ${wall} ms, linger 500 ms), server ${JSON.stringify(r.server)}, port free afterwards: ${free}, evidence ${JSON.stringify(r.evidence)}`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verified, true);
  assert.equal(r.server.stopped, true);
  assert.equal(free, true);
  assert.ok(r.ms <= ONESHOT_STATIC_BUDGET_MS, `${r.ms} ms`);
}));

// ---------------------------------------------------------------------------------------------
// Servers live with what started them: the parent watch, dev-run and its process tree

test('watchParent: calls back once when the parent is gone, never while it lives', async () => {
  let calls = 0;
  let parentAlive = true;
  const w = watchParent(() => { calls += 1; }, { ppid: 4242, intervalMs: 20, alive: () => parentAlive, currentPpid: () => 4242 });
  await sleep(100);
  assert.equal(calls, 0);
  parentAlive = false;
  await sleep(100);
  assert.equal(calls, 1);
  await sleep(100);
  assert.equal(calls, 1, 'once');
  w.stop();
  // On POSIX an orphan is adopted at once: a changed ppid counts as the parent being gone.
  let adopted = 0;
  const w2 = watchParent(() => { adopted += 1; }, { ppid: 4242, intervalMs: 20, alive: () => true, currentPpid: (() => { let n = 0; return () => (n++ < 3 ? 4242 : 1); })() });
  await sleep(200);
  assert.equal(adopted, 1);
  w2.stop();
  // Already adopted by init: nothing to follow.
  let never = 0;
  watchParent(() => { never += 1; }, { ppid: 1, intervalMs: 20, alive: () => false }).stop();
  await sleep(60);
  assert.equal(never, 0);
});

test('pidAlive: a zombie (ended, not yet collected by its parent) counts as gone on Linux and macOS', () => {
  const me = process.pid; // alive for kill(pid, 0)
  const stat = (state) => () => `${me} (node) ) odd) ${state} 1 2 3`;
  assert.equal(registry.pidAlive(me, { platform: 'linux', readFile: stat('Z') }), false);
  assert.equal(registry.pidAlive(me, { platform: 'linux', readFile: stat('S') }), true);
  assert.equal(registry.pidAlive(me, { platform: 'linux', readFile: () => { throw new Error('no /proc'); } }), true);
  assert.equal(registry.pidAlive(me, { platform: 'darwin', psFn: () => 'Z+' }), false);
  assert.equal(registry.pidAlive(me, { platform: 'darwin', psFn: () => 'S' }), true);
  assert.equal(registry.pidAlive(me, { platform: 'win32', readFile: stat('Z'), psFn: () => 'Z' }), true, 'Windows has no zombies');
  assert.equal(registry.pidAlive(-1), false);
  assert.equal(registry.pidAlive(me), true, 'this process, for real');
});

test('sessionHostPid: the nearest claude ancestor on Windows, not the direct parent; null elsewhere', () => {
  const info = { pid: 10, parents: [{ pid: 20, name: 'bash.exe' }, { pid: 30, name: 'bash.exe' }, { pid: 40, name: 'claude.exe' }, { pid: 50, name: 'Claude.exe' }] };
  assert.equal(sessionHostPid({ info, platform: 'win32', ppid: 20 }), 40);
  assert.equal(sessionHostPid({ info, platform: 'win32', ppid: 40 }), null, 'already watched as the direct parent');
  assert.equal(sessionHostPid({ info: { pid: 10, parents: [{ pid: 20, name: 'explorer.exe' }] }, platform: 'win32', ppid: 20 }), null);
  assert.equal(sessionHostPid({ info: null, platform: 'win32' }), null, 'chain unreadable');
  assert.equal(sessionHostPid({ info, platform: 'linux', ppid: 20 }), null);
  assert.equal(sessionHostPid({ info, platform: 'darwin', ppid: 20 }), null);
});

test('watchSession: ends when the session host dies although the shell parent lives; calls back once', async () => {
  const dead = new Set();
  let calls = 0;
  const infoFn = () => ({ pid: process.pid, parents: [{ pid: 777001, name: 'bash.exe' }, { pid: 777002, name: 'claude.exe' }] });
  const w = watchSession(() => { calls += 1; }, { infoFn, platform: 'win32', intervalMs: 20, alive: (pid) => !dead.has(pid) && (pid === process.ppid || pid === 777002) });
  await sleep(120);
  assert.equal(w.hostPid(), 777002);
  assert.equal(calls, 0, 'both alive');
  dead.add(777002);
  await sleep(120);
  assert.equal(calls, 1);
  dead.add(process.ppid);
  await sleep(120);
  assert.equal(calls, 1, 'once, even when the parent goes too');
  w.stop();
  // No claude ancestor (or not Windows): only the direct parent is watched.
  const w2 = watchSession(() => {}, { infoFn: () => ({ pid: process.pid, parents: [] }), platform: 'win32', intervalMs: 20, alive: () => true });
  await sleep(60);
  assert.equal(w2.hostPid(), null);
  w2.stop();
});

test('killTree: Windows runs System32 taskkill /T /F on the pid; a bad pid does nothing', () => {
  const runFn = fakeRun([[() => true, { status: 0 }]]);
  assert.equal(killTree(1234, { platform: 'win32', runFn }), true);
  assert.deepEqual(runFn.calls.map((c) => [c.cmd, c.args]), [[system32('taskkill.exe'), ['/PID', '1234', '/T', '/F']]]);
  assert.match(system32('taskkill.exe', { SystemRoot: 'D:\\Win' }), /^D:\\Win\\System32\\taskkill\.exe$/);
  for (const bad of [0, -5, 1.5, null, '12']) assert.equal(killTree(bad, { platform: 'win32', runFn }), false, String(bad));
  assert.equal(runFn.calls.length, 1);
});

test('killTree: never pid 1 (POSIX kill(-1) signals every process of the user) and never this process', () => {
  const runFn = fakeRun([[() => true, { status: 0 }]]);
  for (const pid of [1, process.pid]) assert.equal(killTree(pid, { platform: 'win32', runFn }), false, String(pid));
  assert.equal(runFn.calls.length, 0, 'no taskkill');
  // POSIX: process.kill is recorded, never sent.
  const sent = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => { sent.push([pid, signal]); return true; };
  try {
    for (const pid of [1, process.pid]) {
      assert.equal(killTree(pid, { platform: 'linux' }), false, String(pid));
      assert.equal(killTree(pid, { platform: 'darwin', signal: 'SIGKILL' }), false, String(pid));
    }
    assert.deepEqual(sent, []);
    assert.equal(killTree(424242, { platform: 'linux', signal: 'SIGKILL' }), true);
    assert.deepEqual(sent, [[-424242, 'SIGKILL']], 'a guard is signalled as its process group');
  } finally { process.kill = realKill; }
});

test('devRunIdentity: a dev-run entry is proved against the OS, tied to its own port and guard', () => {
  const dir = path.join(path.parse(process.cwd()).root, 'plugin', 'scripts');
  const root = path.join(path.parse(process.cwd()).root, 'proj');
  const node = process.execPath;
  const show = (...args) => [node, path.join(dir, 'show.mjs'), ...args];
  const guard = (port, parent) => [node, path.join(dir, 'lib', 'devrun.mjs'), '--guard', 'npm', String(port), String(parent)];
  const e = { kind: 'dev', runner: 'dev-run', pid: 1000, childPid: 2000, port: 5173, root };
  /** processInfo stand-in: pid → { argv, parents } (null: not found); records the pids asked. */
  const infoOf = (table) => {
    const asked = [];
    const fn = (pid) => { asked.push(pid); return pid in table ? (table[pid] && { pid, name: 'node', ...table[pid] }) : null; };
    fn.asked = asked;
    return fn;
  };
  const id = (table, platform = 'linux', entry = e) => devRunIdentity(entry, { infoFn: infoOf(table), platform });

  // Its own process and its guard, for exactly this port and parent.
  assert.deepEqual(id({ 1000: { argv: show('dev-run', root, '--port', '5173') }, 2000: { argv: guard(5173, 1000) } }), { ours: true, guard: 2000 });
  assert.deepEqual(id({ 1000: { argv: show('oneshot', root) }, 2000: { argv: guard(5173, 1000) } }), { ours: true, guard: 2000 }, 'oneshot: the guard names the port');
  // Windows: the guard's parent process is the dev-run too, or the parent pid was reused.
  assert.deepEqual(id({ 1000: { argv: show('oneshot', root) }, 2000: { argv: guard(5173, 1000), parents: [{ pid: 1000 }] } }, 'win32'), { ours: true, guard: 2000 });
  assert.ok(id({ 1000: { argv: show('oneshot', root) }, 2000: { argv: guard(5173, 1000), parents: [{ pid: 3000 }] } }, 'win32').stale);
  assert.ok(id({ 1000: { argv: show('oneshot', root) }, 2000: { argv: guard(5173, 1000), parents: [] } }, 'win32').stale);

  // The pid now belongs to something else: stale, so the entry can go.
  assert.ok(id({ 1000: { argv: ['C:\\Windows\\System32\\svchost.exe', '-k', 'netsvcs'] } }).stale);
  assert.ok(id({ 1000: { argv: [] } }).stale, 'a process whose command line cannot be read is not one show-local started');
  assert.ok(id({ 1000: { argv: show('serve', root) } }).stale, 'a static server is not a dev-run');
  // Reused by another project's dev-run or oneshot: stale, never "ours".
  const other = id({ 1000: { argv: show('dev-run', root, '--port', '3000') }, 2000: { argv: guard(3000, 1000) } });
  assert.match(other.stale, /port 3000, not 5173/);
  assert.ok(id({ 1000: { argv: show('oneshot', root) }, 2000: { argv: guard(3000, 1000) } }).stale, 'its guard serves another port');
  assert.ok(id({ 1000: { argv: show('oneshot', root) }, 2000: { argv: guard(5173, 1001) } }).stale, 'its guard watches another parent');
  assert.ok(id({ 1000: { argv: show('oneshot', root) }, 2000: { argv: [node, '-e', 'setInterval(() => {}, 1000)'] } }).stale, 'the guard pid was reused');

  // Nothing could be looked up: unknown, so nothing is ended and the entry is kept.
  assert.ok(id({}).unknown);
  assert.ok(id({ 1000: { argv: show('oneshot', root) } }).unknown, 'a oneshot names no port itself, so its guard must');
  // The guard could not be looked up, but dev-run names this port itself: ours, with no tree to end.
  assert.deepEqual(id({ 1000: { argv: show('dev-run', root, '--port', '5173') } }), { ours: true, guard: null });

  // A childPid of 1 (or none) is never looked up, never the tree to end.
  for (const childPid of [1, 0, undefined]) {
    const infoFn = infoOf({ 1000: { argv: show('dev-run', root, '--port', '5173') }, 1: { argv: guard(5173, 1000) } });
    assert.deepEqual(devRunIdentity({ ...e, childPid }, { infoFn, platform: 'linux' }), { ours: true, guard: null }, String(childPid));
    assert.deepEqual(infoFn.asked, [1000]);
  }
});

/** Is `npm` runnable here (through cmd.exe on Windows, as dev-run runs it)? */
function npmWorks() {
  const r = onWindows
    ? spawnSync(system32('cmd.exe'), ['/d', '/s', '/c', '"npm --version"'], { windowsVerbatimArguments: true, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    : spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 30000 });
  return r.status === 0;
}
const NO_NPM = npmWorks() ? false : 'npm is not available here';

/**
 * A tiny npm project whose dev script is a node server on `port` that writes its pid to pid.txt
 * and answers every request with its working folder (and a title).
 */
function nodeDevProject(root, port) {
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'show-local-test-dev', private: true, scripts: { dev: `node server.cjs ${port}` } }));
  write(path.join(root, 'server.cjs'), [
    "const http = require('http');",
    "require('fs').writeFileSync('pid.txt', String(process.pid));",
    "http.createServer((q, s) => { s.setHeader('content-type', 'text/html; charset=utf-8'); s.end('<title>Dev shop</title>' + process.cwd()); })",
    "  .listen(Number(process.argv[2]), '127.0.0.1');",
  ].join('\n'));
  return root;
}

/** Wait for the dev server to answer; its pid (from pid.txt) and what it answered. */
async function devUp(root, port, ms = 45000) {
  const answer = await until(() => browserGet(`http://127.0.0.1:${port}/`), ms, 250);
  const pidFile = path.join(root, 'pid.txt');
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null;
  return { answer, pid };
}

/** Last resort for a failed test: end a tree this test started. */
function reap(...pids) {
  for (const pid of pids) if (Number.isInteger(pid) && alive(pid)) killTree(pid, onWindows ? {} : { signal: 'SIGKILL' });
  for (const pid of pids) { try { if (Number.isInteger(pid) && alive(pid)) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

test('dev-run: in a folder named with & and %USERNAME%, npm run dev runs there, is recorded, and SIGTERM ends the whole tree', { skip: NO_NPM }, () => inState(async (dir, vars) => {
  const port = await freePort();
  const root = nodeDevProject(path.join(dir, 'R&D %USERNAME% shop'), port);
  const child = spawn(process.execPath, [SHOW, 'dev-run', root, '--port', String(port), '--no-parent-watch'], { env: childEnv(vars), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let serverPid = null;
  try {
    const { answer, pid } = await devUp(root, port);
    serverPid = pid;
    assert.ok(answer, `the dev server answered; dev-run said:\n${out}`);
    // cmd.exe never saw the path: the server runs in exactly this folder, & and %USERNAME% intact.
    const cwd = answer.body.replace('<title>Dev shop</title>', '');
    assert.ok(cwd.includes('R&D %USERNAME% shop'), cwd);
    assert.equal(realpathSync.native(cwd), realpathSync.native(root));
    const line = JSON.parse(out.split('\n')[0]);
    assert.deepEqual(line, { ok: true, running: root, command: 'npm run dev', port, url: `http://localhost:${port}/`, pid: child.pid, parentWatch: false });
    const entry = registry.entryAt(port);
    assert.equal(entry.kind, 'dev');
    assert.equal(entry.runner, 'dev-run');
    assert.equal(entry.pid, child.pid);
    assert.equal(entry.root, root);
    assert.ok(Number.isInteger(entry.childPid));
    const listed = cli(['servers'], vars).json.servers;
    assert.deepEqual(listed.map((s) => [s.port, s.kind, s.runner, s.pid]), [[port, 'dev', 'dev-run', child.pid]]);

    // On Windows this terminates dev-run outright (no handler runs): its guard ends the tree.
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(10000)]);
    assert.equal(await until(() => !alive(serverPid), 10000), true, 'the dev server process ended');
    assert.equal(await until(async () => !(await canConnect(port)), 5000), true, 'its port is free');
    assert.equal(await until(() => alive(entry.childPid) === false, 5000), true, 'the guard ended too');
    assert.equal(await until(() => registry.entryAt(port) === null, 5000), true, 'the entry is gone');
  } finally { reap(child.pid, serverPid); }
}));

test('dev-run: when the process that started it dies, the whole tree ends', { skip: NO_NPM }, () => inState(async (dir, vars) => {
  const port = await freePort();
  const root = nodeDevProject(path.join(dir, 'shop'), port);
  // A parent that starts dev-run detached (so nothing but dev-run's own watch can end it), then waits.
  const parent = spawn(process.execPath, ['-e', [
    "const { spawn } = require('child_process');",
    `const c = spawn(process.execPath, ${JSON.stringify([SHOW, 'dev-run', root, '--port', String(port)])}, { stdio: 'ignore', detached: true, windowsHide: true });`,
    "console.log(c.pid); setInterval(() => {}, 1000);",
  ].join('\n')], { env: childEnv(vars), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let out = '';
  parent.stdout.setEncoding('utf8');
  parent.stdout.on('data', (d) => { out += d; });
  let devRunPid = null;
  let serverPid = null;
  try {
    devRunPid = Number(await until(() => (out.includes('\n') ? out.trim() : null), 15000));
    const { answer, pid } = await devUp(root, port);
    serverPid = pid;
    assert.ok(answer, 'the dev server answered');
    parent.kill();
    assert.equal(await until(() => !alive(devRunPid), 10000), true, 'dev-run saw its parent go and ended');
    assert.equal(await until(() => !alive(serverPid), 10000), true, 'the dev server ended with it');
    assert.equal(await until(async () => !(await canConnect(port)), 5000), true, 'its port is free');
    assert.equal(registry.entryAt(port), null);
  } finally { reap(parent.pid, devRunPid, serverPid); }
}));

test('stop <port> ends a dev-run and its whole tree', { skip: NO_NPM }, () => inState(async (dir, vars) => {
  const port = await freePort();
  const root = nodeDevProject(path.join(dir, 'shop'), port);
  const child = spawn(process.execPath, [SHOW, 'dev-run', root, '--port', String(port), '--no-parent-watch'], { env: childEnv(vars), stdio: 'ignore', windowsHide: true });
  let serverPid = null;
  try {
    const { answer, pid } = await devUp(root, port);
    serverPid = pid;
    assert.ok(answer);
    const stop = cli(['stop', String(port)], vars);
    assert.deepEqual(stop.json, { ok: true, stopped: [{ port, root, kind: 'dev' }], notFound: [] }, stop.stdout);
    assert.equal(stop.code, 0);
    assert.equal(await until(() => !alive(child.pid), 5000), true, 'dev-run ended');
    assert.equal(await until(() => !alive(serverPid), 5000), true);
    assert.deepEqual(cli(['servers'], vars).json.servers, []);
  } finally { reap(child.pid, serverPid); }
}));

test('oneshot (dev): starts npm run dev, opens and verifies, then ends the whole tree and frees the port', { skip: NO_NPM }, () => inState(async (dir) => {
  const port = await freePort();
  const root = nodeDevProject(path.join(dir, 'shop'), port);
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'show-local-test-dev', private: true, scripts: { dev: `node server.cjs ${port} --port ${port}` } }));
  const adapter = getAdapter({ win: { matched: true, confidence: 'high', title: 'Dev shop - Test' } });
  let serverPid = null;
  try {
    const r = await oneshot(root, { cwd: dir, lingerMs: 200, adapter, env: {} });
    serverPid = existsSync(path.join(root, 'pid.txt')) ? Number(readFileSync(path.join(root, 'pid.txt'), 'utf8')) : null;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.mode, 'dev');
    assert.equal(r.verified, true);
    assert.equal(r.url, `http://localhost:${port}/`);
    assert.deepEqual(r.server, { kind: 'dev', stopped: true, port, lingerMs: 200, root, url: `http://localhost:${port}/` });
    assert.match(r.caution, /ran the project's own code/);
    assert.equal(await until(() => !alive(serverPid), 5000), true, 'the dev server process ended');
    assert.equal(registry.entryAt(port), null);
  } finally { reap(serverPid); }
}));

test('serve ends when its parent dies; --no-parent-watch keeps it until it is stopped', () => inState(async (dir, vars) => {
  const root = site(dir);
  const start = async (flags) => {
    const port = await freePort();
    const parent = spawn(process.execPath, ['-e', [
      "const { spawn } = require('child_process');",
      `const c = spawn(process.execPath, ${JSON.stringify([SHOW, 'serve', root, '--port', String(port), ...flags])}, { stdio: 'ignore', detached: true, windowsHide: true });`,
      "console.log(c.pid); setInterval(() => {}, 1000);",
    ].join('\n')], { env: childEnv(vars), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    parent.stdout.setEncoding('utf8');
    parent.stdout.on('data', (d) => { out += d; });
    const pid = Number(await until(() => (out.includes('\n') ? out.trim() : null), 15000));
    assert.equal(await until(() => canConnect(port), 15000), true, 'serve is listening');
    return { parent, pid, port };
  };
  const watched = await start([]);
  const kept = await start(['--no-parent-watch']);
  try {
    watched.parent.kill();
    kept.parent.kill();
    assert.equal(await until(() => !alive(watched.pid), 8000), true, 'serve ended with its parent');
    assert.equal(await canConnect(watched.port), false);
    await sleep(2500);
    assert.equal(alive(kept.pid), true, '--no-parent-watch: still serving');
    assert.equal(await canConnect(kept.port), true);
    const stop = cli(['stop', String(kept.port)], vars);
    assert.equal(stop.json.ok, true, stop.stdout);
    assert.equal(await until(() => !alive(kept.pid), 5000), true);
  } finally { reap(watched.parent.pid, watched.pid, kept.parent.pid, kept.pid); }
}));

test('dev-run usage: a missing folder, a folder without a dev script, and a port another server holds start nothing', () => inState(async (dir, vars) => {
  const missing = cli(['dev-run', path.join(dir, 'nope')], vars);
  assert.equal(missing.code, 1);
  assert.equal(missing.json.error, 'not-found');
  const plain = path.join(dir, 'plain');
  write(path.join(plain, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
  const noDev = cli(['dev-run', plain], vars);
  assert.equal(noDev.code, 1);
  assert.equal(noDev.json.error, 'no-dev-script');
  const busy = path.join(dir, 'busy');
  write(path.join(busy, 'package.json'), JSON.stringify({ scripts: { dev: 'node never-started.js' } }));
  registry.register({ kind: 'static', pid: process.pid, port: 4499, root: plain });
  const held = cli(['dev-run', busy, '--port', '4499'], vars);
  assert.equal(held.code, 1, held.stdout);
  assert.equal(held.json.error, 'port-busy');
  assert.equal(existsSync(path.join(busy, 'pid.txt')), false);
  registry.unregister(4499);
}));

test('dev-run reads package.json only when it is a regular file of at most 1 MB', () => inState(async (dir, vars) => {
  // Over the cap: never read, so nothing is started (a link to /dev/zero would never finish).
  const big = path.join(dir, 'big');
  write(path.join(big, 'package.json'), JSON.stringify({ scripts: { dev: 'node never-started.js' }, pad: 'x'.repeat(1024 * 1024) }));
  const r = cli(['dev-run', big], vars);
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json?.error, 'no-dev-script', r.stdout);
  // A folder named package.json is no manifest either.
  const odd = path.join(dir, 'odd');
  mkdirSync(path.join(odd, 'package.json'), { recursive: true });
  assert.equal(cli(['dev-run', odd], vars).json?.error, 'no-dev-script');
}));

test('dev-run: a package.json that is a named pipe is never opened (it would block forever)', { skip: onWindows && 'mkfifo is POSIX' }, () => inState(async (dir, vars) => {
  const proj = path.join(dir, 'fifo');
  mkdirSync(proj);
  if (spawnSync('mkfifo', [path.join(proj, 'package.json')]).status !== 0) return;
  const r = spawnSync(process.execPath, [SHOW, 'dev-run', proj], { env: childEnv(vars), encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 1, `dev-run returned promptly: ${r.error?.message || r.stdout}`);
  assert.equal(JSON.parse(r.stdout).error, 'no-dev-script');
}));

// ---------------------------------------------------------------------------------------------
// Stale dev-run entries, and what stop may end

/** A live process that does nothing. */
function idle() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  return child;
}

/** The pid of a process that has ended. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

test('a dev-run entry is live only while its process and its guard both are: a half-dead one is pruned, never "already running"', () => inState(async (dir) => {
  const { root, port } = await devProject(dir);
  const proc = idle();
  const other = idle();
  try {
    const gone = await deadPid();
    // A tree kill or a reboot ended dev-run and its guard; its pid came back as something else.
    const entry = { kind: 'dev', runner: 'dev-run', pid: proc.pid, childPid: gone, port, root, url: `http://localhost:${port}/`, started: new Date().toISOString() };
    registry.register(entry);
    assert.equal(registry.devRunLive(entry), false);
    assert.equal(registry.entryAlive(entry), false, 'so dev-run and oneshot take the port instead of refusing port-busy');
    assert.equal(registry.devRunAt(port, root), null);
    const plan = await show(root, { planOnly: true, cwd: dir, runFn: fakeRun([]), platform: HOST, env: DESKTOP });
    assert.equal(plan.action, 'start-server', JSON.stringify(plan));
    assert.equal(plan.alreadyRunning, undefined);
    assert.deepEqual((await registry.listServers()).map((s) => s.port), []);
    assert.equal(registry.entryAt(port), null, 'listServers removed it');
    // Both pids alive: listed as before (stop then proves who they are).
    const both = { ...entry, childPid: other.pid };
    registry.register(both);
    assert.equal(registry.devRunLive(both), true);
    assert.deepEqual((await registry.listServers()).map((s) => s.port), [port]);
    assert.deepEqual(registry.devRunAt(port, root), both);
    // No guard recorded, or a pid no guard can have: not live.
    assert.equal(registry.devRunLive({ ...entry, childPid: undefined }), false);
    assert.equal(registry.devRunLive({ ...entry, childPid: 1 }), false);
  } finally { registry.unregister(port); proc.kill(); other.kill(); }
}));

test('stop removes a dev-run entry whose pids now belong to other processes, and ends nothing', () => inState(async (dir, vars) => {
  const port = await freePort();
  const a = idle();
  const b = idle();
  try {
    registry.register({ kind: 'dev', runner: 'dev-run', pid: a.pid, childPid: b.pid, port, root: path.join(dir, 'shop'), url: `http://localhost:${port}/` });
    assert.deepEqual(cli(['servers'], vars).json.servers.map((s) => s.port), [port], 'both pids alive: listed');
    const stop = cli(['stop', String(port)], vars);
    assert.equal(stop.code, 1, stop.stdout);
    const { removed, ...rest } = stop.json;
    assert.deepEqual(rest, { ok: false, stopped: [], notFound: [String(port)] }, 'no server was there');
    assert.deepEqual(removed.map(({ detail, ...r }) => r), [{ port, pid: a.pid, kind: 'dev' }]);
    assert.match(removed[0].detail, /no longer show-local's dev-run; the entry was stale, so it was removed and nothing was stopped/);
    assert.equal(registry.entryAt(port), null, 'the entry is gone');
    assert.deepEqual(cli(['servers'], vars).json.servers, []);
    await sleep(300);
    assert.equal(alive(a.pid), true, 'nothing was ended');
    assert.equal(alive(b.pid), true);
  } finally { a.kill(); b.kill(); }
}));

/**
 * Stand-ins for show-local's own processes, in <dir>/fake: show.mjs (dev-run or oneshot) starts
 * a detached devrun.mjs --guard <pm> <port> <its pid> (the port: its --port, else FAKE_GUARD_PORT)
 * whose "runner" child idles; a oneshot also starts a detached "browser", as the real one does.
 * Resolves with the fake show.mjs process and { guard, browser, runner } pids.
 */
async function fakeDevRun(dir, args, env = {}) {
  const fake = path.join(dir, 'fake');
  write(path.join(fake, 'show.mjs'), [
    "import { spawn } from 'node:child_process';",
    "import { fileURLToPath } from 'node:url';",
    "const at = (f) => fileURLToPath(new URL(f, import.meta.url));",
    'const args = process.argv.slice(2);',
    "const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : (process.env.FAKE_GUARD_PORT || '0');",
    "const detached = (file, extra) => { const c = spawn(process.execPath, [at(file), ...extra], { stdio: 'ignore', detached: true, windowsHide: true }); c.unref(); return c.pid; };",
    "const guard = detached('./devrun.mjs', ['--guard', 'npm', port, String(process.pid)]);",
    "const browser = args[0] === 'oneshot' ? detached('./browser.mjs', []) : null;",
    'process.stdout.write(`${JSON.stringify({ guard, browser })}\\n`);',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  write(path.join(fake, 'devrun.mjs'), [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    'writeFileSync(new URL(`./runner-${process.pid}.txt`, import.meta.url), String(runner.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  write(path.join(fake, 'browser.mjs'), 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [path.join(fake, 'show.mjs'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  const line = await until(() => (out.includes('\n') ? out.slice(0, out.indexOf('\n')) : null), 15000);
  const pids = JSON.parse(line);
  const runnerFile = path.join(fake, `runner-${pids.guard}.txt`);
  pids.runner = Number(await until(() => (existsSync(runnerFile) ? readFileSync(runnerFile, 'utf8') || null : null), 15000));
  return { child, ...pids };
}

test('stop never ends another project\'s dev-run or oneshot that got the recorded pids', () => inState(async (dir, vars) => {
  const port = await freePort();
  const elsewhere = await freePort();
  const root = path.join(dir, 'shop');
  mkdirSync(root);
  const runs = [];
  try {
    // Another dev-run (its own port on its command line), and another oneshot (its guard's port).
    runs.push(await fakeDevRun(dir, ['dev-run', root, '--port', String(elsewhere)]));
    runs.push(await fakeDevRun(dir, ['oneshot', root], { FAKE_GUARD_PORT: String(elsewhere) }));
    for (const run of runs) {
      registry.register({ kind: 'dev', runner: 'dev-run', pid: run.child.pid, childPid: run.guard, port, root, url: `http://localhost:${port}/` });
      const stop = cli(['stop', String(port)], vars);
      assert.equal(stop.code, 1, stop.stdout);
      assert.deepEqual(stop.json.stopped, [], stop.stdout);
      assert.deepEqual(stop.json.removed.map((r) => r.port), [port], stop.stdout);
      assert.equal(registry.entryAt(port), null);
      await sleep(300);
      for (const pid of [run.child.pid, run.guard, run.runner, run.browser].filter(Boolean)) assert.equal(alive(pid), true, `pid ${pid} still runs`);
    }
  } finally { for (const run of runs) reap(run.child.pid, run.guard, run.runner, run.browser); }
}));

test('stop of a oneshot ends it and its guard\'s tree, never the browser it launched as its child', () => inState(async (dir, vars) => {
  const port = await freePort();
  const root = path.join(dir, 'shop');
  mkdirSync(root);
  let run = null;
  try {
    run = await fakeDevRun(dir, ['oneshot', root], { FAKE_GUARD_PORT: String(port) });
    registry.register({ kind: 'dev', runner: 'dev-run', pid: run.child.pid, childPid: run.guard, port, root, url: `http://localhost:${port}/`, oneshot: true });
    const stop = cli(['stop', String(port)], vars);
    assert.deepEqual(stop.json, { ok: true, stopped: [{ port, root, kind: 'dev' }], notFound: [] }, stop.stdout);
    assert.equal(await until(() => !alive(run.child.pid), 5000), true, 'the oneshot ended');
    assert.equal(await until(() => !alive(run.guard), 5000), true, 'its guard ended');
    assert.equal(await until(() => !alive(run.runner), 5000), true, 'and the runner in the guard\'s tree');
    await sleep(500);
    assert.equal(alive(run.browser), true, 'the browser the oneshot started is still running');
    assert.equal(registry.entryAt(port), null);
  } finally { if (run) reap(run.child.pid, run.guard, run.runner, run.browser); }
}));

// ---------------------------------------------------------------------------------------------
// A registry that cannot be written never strands a server

/** Put a file where the registry folder goes: every register() then fails. */
function breakRegistry() {
  const file = path.join(stateDir(), 'servers');
  writeFileSync(file, 'in the way');
  return file;
}

test('register reports false instead of throwing when the registry cannot be written; unregister never throws', () => inState(async () => {
  breakRegistry();
  assert.equal(registry.register({ kind: 'static', pid: process.pid, port: 5321, root: process.cwd() }), false);
  assert.doesNotThrow(() => registry.unregister(5321));
  assert.equal(registry.entryAt(5321), null);
  assert.deepEqual(await registry.listServers(), []);
}));

/**
 * Run oneshot() in its own node process (an adapter whose "browser" is an HTTP GET) and let it
 * exit by itself: a server or tree left running would keep it alive until the timeout.
 */
function oneshotInChild(target, opts, vars) {
  const driver = path.join(path.dirname(target), `driver-${Date.now()}.mjs`);
  write(driver, [
    "import http from 'node:http';",
    `const { oneshot } = await import(${JSON.stringify(lib('oneshot.mjs'))});`,
    "const get = (url) => new Promise((resolve) => { http.get(url, { agent: false }, (res) => { res.resume(); res.on('end', resolve); }).on('error', resolve); });",
    'const adapter = {',
    "  resolveBrowser: () => ({ name: 'Test GET', process: 'testget' }),",
    "  watchWindows: (a) => ({ ready: Promise.resolve(), result: new Promise((r) => setTimeout(() => r({ matched: true, confidence: 'high', title: 'test' }), Math.min(a.timeoutMs, 300))), cancel() {} }),",
    "  async openUrl(url) { await new Promise((r) => setTimeout(r, 5)); await get(url); return { ok: true, with: 'Test GET', how: 'an HTTP GET stands in for the browser (test)' }; },",
    '};',
    `try { process.stdout.write(JSON.stringify(await oneshot(${JSON.stringify(target)}, { ...${JSON.stringify(opts)}, adapter, env: {} }))); }`,
    'catch (e) { process.stdout.write(JSON.stringify({ threw: e.message })); }',
  ].join('\n'));
  const r = spawnSync(process.execPath, [driver], { env: childEnv(vars), encoding: 'utf8', windowsHide: true, timeout: 45000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* nothing printed */ }
  return { status: r.status, timedOut: r.error?.code === 'ETIMEDOUT', json, stdout: r.stdout };
}

test('oneshot (static) with a registry that cannot be written: still opens, stops, frees the port and exits', () => inState(async (dir, vars) => {
  breakRegistry();
  const root = site(dir);
  const port = await freePort();
  const r = oneshotInChild(root, { cwd: dir, port, lingerMs: 100 }, vars);
  assert.equal(r.timedOut, false, 'the process ended by itself');
  assert.equal(r.status, 0);
  assert.equal(r.json?.threw, undefined, r.stdout);
  assert.equal(r.json.ok, true, r.stdout);
  assert.equal(r.json.server.stopped, true);
  assert.ok(r.json.notes.some((n) => /registry could not be written/.test(n)), JSON.stringify(r.json.notes));
  assert.equal(await canConnect(port), false);
}));

test('oneshot (dev) with a registry that cannot be written: still opens, ends the whole tree and exits', { skip: NO_NPM }, () => inState(async (dir, vars) => {
  breakRegistry();
  const port = await freePort();
  const root = nodeDevProject(path.join(dir, 'shop'), port);
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'show-local-test-dev', private: true, scripts: { dev: `node server.cjs ${port} --port ${port}` } }));
  let serverPid = null;
  try {
    const r = oneshotInChild(root, { cwd: dir, lingerMs: 100 }, vars);
    serverPid = existsSync(path.join(root, 'pid.txt')) ? Number(readFileSync(path.join(root, 'pid.txt'), 'utf8')) : null;
    assert.equal(r.timedOut, false, 'the process ended by itself');
    assert.equal(r.json?.threw, undefined, r.stdout);
    assert.equal(r.json.ok, true, r.stdout);
    assert.equal(r.json.server.stopped, true);
    assert.ok(r.json.notes.some((n) => /registry could not be written/.test(n)), JSON.stringify(r.json.notes));
    assert.equal(await until(() => !alive(serverPid), 5000), true, 'the dev server ended');
  } finally { reap(serverPid); }
}));

test('serve with a registry that cannot be written: says so, keeps serving, and still ends with its parent', () => inState(async (dir, vars) => {
  breakRegistry();
  const root = site(dir);
  const port = await freePort();
  const outFile = path.join(dir, 'serve.out');
  const parent = spawn(process.execPath, ['-e', [
    "const fs = require('fs'); const { spawn } = require('child_process');",
    `const out = fs.openSync(${JSON.stringify(outFile)}, 'w');`,
    `const c = spawn(process.execPath, ${JSON.stringify([SHOW, 'serve', root, '--port', String(port)])}, { stdio: ['ignore', out, 'ignore'], detached: true, windowsHide: true });`,
    "console.log(c.pid); setInterval(() => {}, 1000);",
  ].join('\n')], { env: childEnv(vars), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let out = '';
  parent.stdout.setEncoding('utf8');
  parent.stdout.on('data', (d) => { out += d; });
  let pid = null;
  try {
    pid = Number(await until(() => (out.includes('\n') ? out.trim() : null), 15000));
    const text = await until(() => { const s = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''; return s.includes('\n') ? s : null; }, 15000);
    const line = JSON.parse(text.slice(0, text.indexOf('\n')));
    assert.equal(line.ok, true, text);
    assert.equal(line.registered, false);
    assert.match(line.note, /servers and stop do not list this server/);
    assert.equal(await until(() => canConnect(port), 15000), true, 'serving');
    parent.kill();
    assert.equal(await until(() => !alive(pid), 8000), true, 'serve ended with its parent');
    assert.equal(await canConnect(port), false);
  } finally { reap(parent.pid, pid); }
}));

test('dev-run with a registry that cannot be written: says so in its JSON line, runs, and SIGTERM ends the tree', { skip: NO_NPM }, () => inState(async (dir, vars) => {
  breakRegistry();
  const port = await freePort();
  const root = nodeDevProject(path.join(dir, 'shop'), port);
  const child = spawn(process.execPath, [SHOW, 'dev-run', root, '--port', String(port), '--no-parent-watch'], { env: childEnv(vars), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  let serverPid = null;
  try {
    const { answer, pid } = await devUp(root, port);
    serverPid = pid;
    assert.ok(answer, `the dev server answered; dev-run said:\n${out}`);
    const line = JSON.parse(out.split('\n')[0]);
    assert.deepEqual(line, {
      ok: true, running: root, command: 'npm run dev', port, url: `http://localhost:${port}/`, pid: child.pid, parentWatch: false,
      registered: false, note: 'the server registry could not be written, so servers and stop do not list this server; it still ends with the process that started it',
    });
    assert.equal(out.split('\n').filter((l) => l.startsWith('{')).length, 1, `one JSON line only:\n${out}`);
    child.kill('SIGTERM');
    assert.equal(await until(() => !alive(serverPid), 10000), true, 'the dev server process ended');
    assert.equal(await until(async () => !(await canConnect(port)), 5000), true, 'its port is free');
  } finally { reap(child.pid, serverPid); }
}));
