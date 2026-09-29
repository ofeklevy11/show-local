// Platform adapters (win / mac / linux), port choice, the server registry and doctor's checks.
// Nothing real is ever opened: every program an adapter would start goes through an injected
// runFn / spawnFn fake, and the registry runs against a private temp state folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCRIPTS, fakeRun, freePort, lib, programName, tempDir } from './helpers.mjs';

const { createWindowsAdapter, spawnDetached } = await import(lib('adapters/win.mjs'));
const { createMacAdapter } = await import(lib('adapters/mac.mjs'));
const { createLinuxAdapter } = await import(lib('adapters/linux.mjs'));
const ports = await import(lib('ports.mjs'));
const registry = await import(lib('registry.mjs'));
const { rootTag } = await import(lib('server.mjs'));
const { stateDir: stateDirNow } = await import(lib('util.mjs'));
const { doctor } = await import(lib('doctor.mjs'));

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const WATCHER = path.join(SCRIPTS, 'win', 'windows.ps1');
const START_PROCESS = 'Start-Process -FilePath $env:SHOW_LOCAL_TARGET';
const INVOKE_ITEM = 'Invoke-Item -LiteralPath $env:SHOW_LOCAL_TARGET';
const DETACHED = { detached: true, stdio: 'ignore', windowsHide: false };

// Paths a shell or PowerShell would interpret if they were ever spliced into a command string.
const NASTY_WIN_PATHS = [
  "C:\\Users\\me\\it's here\\report.pdf",
  'C:\\Users\\me\\$env:USERPROFILE\\$(calc)\\a.pdf',
  'C:\\Users\\me\\a & b ; c\\report.pdf',
  'C:\\Users\\me\\back`tick`\\x.pdf',
  'C:\\Users\\me\\100% %PATH% done\\x.pdf',
  'C:\\Users\\אופק\\מסמכים\\דוח שנתי.pdf',
  "C:\\Users\\אופק\\it's $x & y; `z` %TEMP%\\קובץ.html",
];
const NASTY_POSIX_PATHS = [
  "/home/me/it's here/report.pdf",
  '/home/me/$HOME/$(touch x)/a.pdf',
  '/home/me/a & b ; c/report.pdf',
  '/home/me/back`tick`/x.pdf',
  '/home/me/100% done/x.pdf',
  '/home/אופק/מסמכים/דוח שנתי.pdf',
];

// ---------------------------------------------------------------------------------------------
// fakes and helpers
// ---------------------------------------------------------------------------------------------

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Values from a list, one per call; the last one repeats. */
const seq = (items) => { let i = 0; return () => items[Math.min(i++, items.length - 1)]; };

/**
 * A fake spawn for detached launches. `behaviour` is 'spawn' | 'error' | 'error-no-code' | 'throw',
 * or a function (cmd, args, opts, index) returning one of those. Records every call.
 */
function fakeSpawn(behaviour = 'spawn') {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const call = { cmd: programName(cmd), path: cmd, args, opts, unrefed: false };
    calls.push(call);
    const b = typeof behaviour === 'function' ? behaviour(cmd, args, opts, calls.length - 1) : behaviour;
    if (b === 'throw') throw new Error('spawn EINVAL (fake)');
    const child = new EventEmitter();
    child.unref = () => { call.unrefed = true; };
    process.nextTick(() => {
      if (b === 'spawn') child.emit('spawn');
      else if (b === 'error-no-code') child.emit('error', new Error('fake failure without a code'));
      else child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** A fake spawn for the Windows watcher: a child with stdout/stderr that `drive` scripts. */
function fakeWatcherSpawn(drive = () => {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = (enc) => { child.encoding = enc; };
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    calls.push({ cmd: programName(cmd), path: cmd, args, opts, child });
    setImmediate(() => drive(child));
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** Set env vars for the duration of fn (sync or async); undefined deletes. Always restores. */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(restore);
  restore();
  return r;
}

/** Output of `reg query` for one value, as reg.exe prints it. */
const regOut = (key, name, data) => ({ stdout: `\r\nHKEY_${key}\r\n    ${name}    REG_SZ    ${data}\r\n\r\n` });

/** A runFn that answers `reg query <key> ...` from a {key: data} map (ProgId values or defaults). */
function regFake(map, extra = []) {
  return fakeRun([
    ...extra,
    [(c, a) => c === 'reg' && a[0] === 'query' && Object.prototype.hasOwnProperty.call(map, a[1]),
      (c, a) => regOut(a[1], a[2] === '/v' ? a[3] : '(ברירת מחדל)', map[a[1]])],
  ]);
}

const URL_CHOICE = (scheme) => `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`;
const FILE_CHOICE = (ext) => `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`;
const HKCR_CMD = (progId) => `HKCR\\${progId}\\shell\\open\\command`;

/**
 * A fakeRun entry for PowerShell's Unicode registry read (windowsCommandUnicode): it answers
 * a ProgId's open command with `answer(progId)`, and fails when that is null.
 */
const unicodeRead = (answer) => [
  (c, a, o) => c === 'powershell.exe' && a.includes('-Command') && !!o.env?.SHOW_LOCAL_PROGID,
  (c, a, o) => { const v = answer(o.env.SHOW_LOCAL_PROGID); return v ? { stdout: `${v}\r\n` } : { status: 1, stderr: 'timed out' }; },
];

/** Every argument of every recorded call, flattened. */
const allArgs = (calls) => calls.flatMap((c) => [c.cmd, ...(c.args || [])]);

// mac fakes ---------------------------------------------------------------------------------

const asOsaOutput = (frame) => (Array.isArray(frame) ? { status: 0, stdout: frame.map((t) => `${t}\n`).join('') } : frame);

/**
 * runFn for macOS: plutil answers LaunchServices with `bundleId` as the https handler;
 * osascript answers "is running" from `running`, tab titles from `titles`, Finder paths from `finder`
 * (each a list of frames consumed one per call; a frame is a title array or a raw result object,
 * and a `running` frame is the answer text or a raw result object).
 */
function macFake({ bundleId = 'com.google.Chrome', running = ['true'], titles = [[]], finder = [[]], plutil = true } = {}) {
  const nextRunning = seq(running);
  const nextTitles = seq(titles);
  const nextFinder = seq(finder);
  return fakeRun([
    [(c) => c === 'plutil', () => (plutil
      ? { stdout: JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' }, { LSHandlerURLScheme: 'https', LSHandlerRoleAll: bundleId }] }) }
      : { status: 1, stderr: 'plutil failed' })],
    [(c, a) => c === 'osascript' && a.length === 2 && / is running$/.test(a[1]), () => { const f = nextRunning(); return typeof f === 'string' ? { stdout: `${f}\n` } : f; }],
    [(c, a) => c === 'osascript' && /^tell application id "/.test(a[1] || ''), () => asOsaOutput(nextTitles())],
    [(c, a) => c === 'osascript' && a[1] === 'tell application "Finder"', () => asOsaOutput(nextFinder())],
  ]);
}

/** Run fn with HOME pointing at a temp home that holds a LaunchServices plist. */
function withFakeMacHome(fn, { plist = true } = {}) {
  const home = tempDir('show-local-home-');
  try {
    const file = path.join(home.dir, 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
    if (plist) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'bplist00');
    }
    return withEnv({ HOME: home.dir, USERPROFILE: home.dir }, () => fn(file));
  } finally {
    home.cleanup();
  }
}

/** A mac adapter whose default browser has been resolved (through the fake plutil). */
function macAdapter(fakeOpts = {}, env = {}) {
  const runFn = macFake(fakeOpts);
  const adapter = createMacAdapter({ runFn, env });
  const browser = withFakeMacHome(() => adapter.resolveBrowser());
  return { adapter, runFn, browser };
}

const osascriptCalls = (runFn) => runFn.calls.filter((c) => c.cmd === 'osascript');

// linux fakes -------------------------------------------------------------------------------

const wmctrlLines = (titles) => titles.map((t, i) => `0x0${(0x3a00003 + i).toString(16)}  ${i % 2 ? '-1' : '0'} my-host ${t}`).join('\n') + (titles.length ? '\n' : '');

/** runFn for Linux: `lister` is installed (or none), `wmctrl -l` answers frames of titles. */
function linuxFake({ lister = 'wmctrl', frames = [[]], extra = [] } = {}) {
  const next = seq(frames);
  return fakeRun([
    ...extra,
    [(c, a) => c === 'sh' && a[0] === '-c' && a[2] === lister, {}],
    [(c, a) => c === 'wmctrl' && a[0] === '-l', () => { const f = next(); return Array.isArray(f) ? { stdout: wmctrlLines(f) } : f; }],
  ]);
}

const X11 = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' };

// registry helpers --------------------------------------------------------------------------

/** Run fn with os.tmpdir() (and so show-local's state folder) redirected to a private temp dir. */
// The state folder is per user: "show-local" on Windows, "show-local-<uid>" on POSIX.
const STATE_NAME = typeof process.getuid === 'function' ? `show-local-${process.getuid()}` : 'show-local';

async function withState(fn) {
  const t = tempDir('show-local-state-');
  try {
    return await withEnv({ TEMP: t.dir, TMP: t.dir, TMPDIR: t.dir, XDG_RUNTIME_DIR: '' }, () => fn(path.join(t.dir, STATE_NAME)));
  } finally {
    t.cleanup();
  }
}

/** A pid that no process has right now. */
function deadPid() {
  for (let p = 4194301; p > 4000000; p -= 4) {
    try { process.kill(p, 0); } catch (e) { if (e.code === 'ESRCH') return p; }
  }
  throw new Error('could not find an unused pid');
}

/** A throwaway HTTP server on 127.0.0.1 and a free ephemeral port. */
async function httpServer(handler) {
  const port = await freePort();
  const srv = http.createServer(handler);
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', resolve); });
  return {
    port,
    close: () => new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(() => resolve()); }),
  };
}

const showLocalServer = (root) => httpServer((req, res) => { res.writeHead(200, { 'X-Show-Local': rootTag(root) }); res.end(); });

// ---------------------------------------------------------------------------------------------
// spawnDetached
// ---------------------------------------------------------------------------------------------

test('spawnDetached resolves ok once the child spawned, detaches it and unrefs it', async () => {
  const spawnFn = fakeSpawn('spawn');
  const r = await spawnDetached('prog', ['a', 'b c'], {}, spawnFn);
  assert.deepEqual(r, { ok: true });
  assert.equal(spawnFn.calls.length, 1);
  const call = spawnFn.calls[0];
  assert.equal(call.cmd, 'prog');
  assert.deepEqual(call.args, ['a', 'b c']);
  assert.deepEqual(call.opts, DETACHED);
  assert.equal(call.opts.shell, undefined, 'never through a shell');
  assert.equal(call.unrefed, true);
});

test('spawnDetached lets caller options override the defaults', async () => {
  const spawnFn = fakeSpawn('spawn');
  await spawnDetached('prog', [], { windowsVerbatimArguments: true, windowsHide: true }, spawnFn);
  assert.deepEqual(spawnFn.calls[0].opts, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
});

test('spawnDetached reports the error code when the program cannot start', async () => {
  const spawnFn = fakeSpawn('error');
  const r = await spawnDetached('missing-prog', [], {}, spawnFn);
  assert.deepEqual(r, { ok: false, error: 'ENOENT' });
  assert.equal(spawnFn.calls[0].unrefed, false);
});

test('spawnDetached falls back to the error message when there is no code', async () => {
  const r = await spawnDetached('prog', [], {}, fakeSpawn('error-no-code'));
  assert.deepEqual(r, { ok: false, error: 'fake failure without a code' });
});

test('spawnDetached resolves (never rejects) when spawn itself throws', async () => {
  const r = await spawnDetached('prog', [], {}, fakeSpawn('throw'));
  assert.deepEqual(r, { ok: false, error: 'spawn EINVAL (fake)' });
});

// ---------------------------------------------------------------------------------------------
// Windows adapter
// ---------------------------------------------------------------------------------------------

test('win: adapter reports its platform and never touches a real program when faked', () => {
  const runFn = fakeRun();
  const spawnFn = fakeSpawn();
  const a = createWindowsAdapter({ runFn, spawnFn });
  assert.equal(a.platform, 'win32');
  assert.equal(runFn.calls.length, 0);
  assert.equal(spawnFn.calls.length, 0);
});

test('win openFolder with a selection runs explorer.exe /select,"<file>" verbatim and detached', async () => {
  const runFn = fakeRun();
  const spawnFn = fakeSpawn();
  const a = createWindowsAdapter({ runFn, spawnFn });
  const file = 'C:\\Users\\me\\out\\report.pdf';
  const r = await a.openFolder('C:\\Users\\me\\out', file);
  assert.deepEqual(r, { ok: true, with: 'File Explorer', how: 'explorer /select' });
  assert.equal(spawnFn.calls.length, 1);
  const { cmd, args, opts } = spawnFn.calls[0];
  assert.equal(cmd, 'explorer.exe');
  assert.deepEqual(args, [`/select,"${file}"`]);
  assert.deepEqual(opts, { ...DETACHED, windowsVerbatimArguments: true });
  assert.equal(runFn.calls.length, 0, 'no PowerShell involved');
});

test('win openFolder without a selection opens the quoted folder', async () => {
  const spawnFn = fakeSpawn();
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
  const r = await a.openFolder('C:\\Users\\me\\My Site');
  assert.deepEqual(r, { ok: true, with: 'File Explorer', how: 'explorer' });
  assert.equal(spawnFn.calls[0].cmd, 'explorer.exe');
  assert.deepEqual(spawnFn.calls[0].args, ['"C:\\Users\\me\\My Site"']);
  assert.equal(spawnFn.calls[0].opts.windowsVerbatimArguments, true);
});

test('win openFolder passes paths with quotes, $, &, ;, backticks, % and Hebrew as one intact argument', async (t) => {
  for (const p of NASTY_WIN_PATHS) {
    await t.test(p, async () => {
      const runFn = fakeRun();
      const spawnFn = fakeSpawn();
      const a = createWindowsAdapter({ runFn, spawnFn });
      await a.openFolder(path.win32.dirname(p), p);
      await a.openFolder(path.win32.dirname(p));
      assert.equal(spawnFn.calls.length, 2);
      assert.deepEqual(spawnFn.calls[0].args, [`/select,"${p}"`]);
      assert.deepEqual(spawnFn.calls[1].args, [`"${path.win32.dirname(p)}"`]);
      for (const c of spawnFn.calls) {
        assert.equal(c.cmd, 'explorer.exe');
        assert.equal(c.opts.shell, undefined);
      }
      assert.equal(runFn.calls.length, 0, 'no -Command string is ever built for a folder');
    });
  }
});

test('win openFolder returns the spawn error when explorer cannot start', async () => {
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn: fakeSpawn('error') });
  assert.deepEqual(await a.openFolder('C:\\x', 'C:\\x\\y.txt'), { ok: false, error: 'ENOENT' });
});

test('win openUrl spawns the resolved browser exe with its template arguments, no shell, no PowerShell', async () => {
  const d = tempDir();
  try {
    const exe = path.join(d.dir, 'chrome.exe');
    writeFileSync(exe, '');
    const runFn = fakeRun();
    const spawnFn = fakeSpawn();
    const a = createWindowsAdapter({ runFn, spawnFn });
    const url = 'http://127.0.0.1:5173/index.html?a=1&b=2';
    const r = await a.openUrl(url, { exe, args: ['--single-argument', '%1'], name: 'Google Chrome' });
    // exe names the program that was launched: it becomes the result's browser.exe.
    assert.deepEqual(r, { ok: true, with: 'Google Chrome', how: 'chrome.exe (default https browser)', exe });
    assert.equal(spawnFn.calls.length, 1);
    assert.equal(spawnFn.calls[0].cmd, exe);
    assert.deepEqual(spawnFn.calls[0].args, ['--single-argument', url]);
    assert.deepEqual(spawnFn.calls[0].opts, DETACHED, 'node quotes the argv itself (no verbatim, no shell)');
    assert.equal(runFn.calls.length, 0);
  } finally {
    d.cleanup();
  }
});

test('win openUrl substitutes %1 / %L / %* and appends the URL when the template has no placeholder', async (t) => {
  const d = tempDir();
  try {
    const exe = path.join(d.dir, 'browser.exe');
    writeFileSync(exe, '');
    const url = 'https://example.com/?q=$&r=$1&s=%1';
    const cases = [
      [['-osint', '-url', '%1'], ['-osint', '-url', url]],
      [['--url=%1'], [`--url=${url}`]],
      [['%L'], [url]],
      [['--new-window', '%*'], ['--new-window', url]],
      [[], [url]],
      [['--profile-directory=Default'], ['--profile-directory=Default', url]],
    ];
    for (const [tmpl, expected] of cases) {
      await t.test(JSON.stringify(tmpl), async () => {
        const spawnFn = fakeSpawn();
        const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
        await a.openUrl(url, { exe, args: tmpl, name: 'X' });
        assert.deepEqual(spawnFn.calls[0].args, expected);
      });
    }
  } finally {
    d.cleanup();
  }
});

test('win openUrl falls back to Start-Process with the URL only in SHOW_LOCAL_TARGET when the exe is missing', async () => {
  const runFn = fakeRun([['powershell.exe', {}]]);
  const spawnFn = fakeSpawn();
  const a = createWindowsAdapter({ runFn, spawnFn });
  const url = 'https://example.com/a?b=1&c=2';
  const r = await a.openUrl(url, { exe: 'C:\\definitely\\not\\here\\chrome.exe', args: ['%1'], name: 'Google Chrome' });
  assert.equal(r.ok, true);
  assert.equal(r.with, 'default handler');
  assert.match(r.how, /^Start-Process/);
  assert.equal(spawnFn.calls.length, 0, 'the missing exe is never spawned');
  assert.equal(runFn.calls.length, 1);
  const { cmd, args, opts } = runFn.calls[0];
  assert.equal(cmd, 'powershell.exe');
  assert.deepEqual(args, [...PS_ARGS, '-Command', START_PROCESS]);
  assert.deepEqual(opts.env, { SHOW_LOCAL_TARGET: url });
  assert.ok(!args.some((x) => x.includes(url)), 'URL never in argv');
});

test('win openUrl falls back to Start-Process when there is no browser at all', async () => {
  const runFn = fakeRun([['powershell.exe', {}]]);
  const a = createWindowsAdapter({ runFn, spawnFn: fakeSpawn() });
  for (const b of [null, undefined, {}, { exe: null }, { exe: '' }]) {
    runFn.calls.length = 0;
    const r = await a.openUrl('https://example.com/', b);
    assert.equal(r.ok, true);
    assert.deepEqual(runFn.calls[0].args, [...PS_ARGS, '-Command', START_PROCESS]);
  }
});

test('win openUrl falls back to Start-Process when the browser exe fails to spawn', async () => {
  const d = tempDir();
  try {
    const exe = path.join(d.dir, 'msedge.exe');
    writeFileSync(exe, '');
    for (const mode of ['error', 'throw']) {
      const runFn = fakeRun([['powershell.exe', {}]]);
      const spawnFn = fakeSpawn(mode);
      const a = createWindowsAdapter({ runFn, spawnFn });
      const r = await a.openUrl('https://example.com/', { exe, args: ['%1'], name: 'Microsoft Edge' });
      assert.equal(spawnFn.calls.length, 1, mode);
      assert.equal(r.ok, true, mode);
      assert.equal(r.with, 'default handler', mode);
      assert.deepEqual(runFn.calls[0].opts.env, { SHOW_LOCAL_TARGET: 'https://example.com/' });
    }
  } finally {
    d.cleanup();
  }
});

test('win openUrl reports the Start-Process error text, or a default one', async () => {
  const withStderr = createWindowsAdapter({ runFn: fakeRun([['powershell.exe', { status: 1, stderr: '  Start-Process : cannot find\r\n' }]]), spawnFn: fakeSpawn() });
  assert.deepEqual(await withStderr.openUrl('https://x/', null), { ok: false, error: 'Start-Process : cannot find' });
  const withError = createWindowsAdapter({ runFn: fakeRun([['powershell.exe', { status: null, error: 'spawnSync powershell.exe ENOENT ' }]]), spawnFn: fakeSpawn() });
  assert.deepEqual(await withError.openUrl('https://x/', null), { ok: false, error: 'spawnSync powershell.exe ENOENT' });
  const silent = createWindowsAdapter({ runFn: fakeRun([['powershell.exe', { status: 1 }]]), spawnFn: fakeSpawn() });
  assert.deepEqual(await silent.openUrl('https://x/', null), { ok: false, error: 'Start-Process failed' });
});

test('win openUrl fallback never splices a hostile URL into the -Command string', async () => {
  const urls = [
    "https://example.com/it's?a=$(calc)&b=`whoami`;c=%TEMP%",
    'https://example.com/שלום/עולם?q=אופק',
    'file:///C:/Users/me/a%20&%20b/index.html',
  ];
  for (const url of urls) {
    const runFn = fakeRun([['powershell.exe', {}]]);
    const a = createWindowsAdapter({ runFn, spawnFn: fakeSpawn() });
    await a.openUrl(url, null);
    const call = runFn.calls.find((c) => c.cmd === 'powershell.exe');
    assert.equal(call.args[call.args.indexOf('-Command') + 1], START_PROCESS);
    assert.ok(!allArgs(runFn.calls).some((x) => x.includes(url)));
    assert.equal(call.opts.env.SHOW_LOCAL_TARGET, url);
  }
});

test('win openApp uses Invoke-Item -LiteralPath with the path only in SHOW_LOCAL_TARGET', async () => {
  const runFn = fakeRun([['powershell.exe', {}]]);
  const spawnFn = fakeSpawn();
  const a = createWindowsAdapter({ runFn, spawnFn });
  const file = 'C:\\Users\\me\\out\\clip.mp4';
  const r = await a.openApp(file);
  assert.deepEqual(r, { ok: true, with: 'default app', how: 'Invoke-Item (file association)' });
  const ps = runFn.calls.filter((c) => c.cmd === 'powershell.exe');
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0].args, [...PS_ARGS, '-Command', INVOKE_ITEM]);
  assert.deepEqual(ps[0].opts.env, { SHOW_LOCAL_TARGET: file });
  assert.equal(spawnFn.calls.length, 0);
});

test('win openApp keeps hostile paths out of every argv, PowerShell and reg alike', async (t) => {
  for (const p of NASTY_WIN_PATHS) {
    await t.test(p, async () => {
      const runFn = fakeRun([['powershell.exe', {}]]);
      const a = createWindowsAdapter({ runFn, spawnFn: fakeSpawn() });
      const r = await a.openApp(p);
      assert.equal(r.ok, true);
      const ps = runFn.calls.find((c) => c.cmd === 'powershell.exe');
      assert.deepEqual(ps.args, [...PS_ARGS, '-Command', INVOKE_ITEM]);
      assert.equal(ps.opts.env.SHOW_LOCAL_TARGET, p);
      for (const arg of allArgs(runFn.calls)) {
        assert.ok(!arg.includes(p), `path leaked into argument ${arg}`);
        assert.ok(!arg.includes('אופק') && !arg.includes('$(calc)') && !arg.includes('`'), `path fragment leaked into ${arg}`);
      }
      const regCalls = runFn.calls.filter((c) => c.cmd === 'reg');
      assert.ok(regCalls.length >= 1, 'the file association is looked up');
      assert.ok(regCalls.every((c) => c.args[1].includes(path.win32.extname(p).toLowerCase())));
    });
  }
});

test('win openApp reports the Invoke-Item error text, or a default one', async () => {
  const failing = createWindowsAdapter({ runFn: fakeRun([['powershell.exe', { status: 1, stderr: 'Invoke-Item : No application is associated\r\n' }]]), spawnFn: fakeSpawn() });
  assert.deepEqual(await failing.openApp('C:\\x\\a.weird'), { ok: false, error: 'Invoke-Item : No application is associated' });
  const silent = createWindowsAdapter({ runFn: fakeRun([['powershell.exe', { status: 1 }]]), spawnFn: fakeSpawn() });
  assert.deepEqual(await silent.openApp('C:\\x\\a.weird'), { ok: false, error: 'Invoke-Item failed' });
});

test('win appFor resolves the associated program from the registry', () => {
  const runFn = regFake({
    [FILE_CHOICE('.mp4')]: 'VLC.mp4',
    [HKCR_CMD('VLC.mp4')]: '"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" --started-from-file "%1"',
  });
  const a = createWindowsAdapter({ runFn, spawnFn: fakeSpawn() });
  assert.deepEqual(a.appFor('C:\\clips\\Intro.MP4'), {
    progId: 'VLC.mp4',
    exe: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    name: 'VLC media player',
    process: 'vlc',
  });
  assert.deepEqual(runFn.calls[0].args, ['query', FILE_CHOICE('.mp4'), '/v', 'ProgId'], 'extension lower-cased');
});

test('win appFor returns the ProgId alone when it has no open command, and null without a ProgId', () => {
  const a = createWindowsAdapter({ runFn: regFake({ [FILE_CHOICE('.xyz')]: 'Custom.Thing' }), spawnFn: fakeSpawn() });
  assert.deepEqual(a.appFor('C:\\a\\b.xyz'), { progId: 'Custom.Thing', name: 'Custom.Thing', process: null });
  const none = createWindowsAdapter({ runFn: fakeRun(), spawnFn: fakeSpawn() });
  assert.equal(none.appFor('C:\\a\\b.xyz'), null);
});

test('win appFor re-reads a path reg.exe garbled (U+FFFD or ?) as Unicode, and only then', async (t) => {
  const exe = 'C:\\Users\\אופק\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  const real = `"${exe}" --single-argument %1`;
  const psReads = (runFn) => runFn.calls.filter((c) => c.cmd === 'powershell.exe');
  // reg.exe prints in the console code page: a Hebrew letter comes back as U+FFFD (cp862) or '?' (cp437).
  for (const [name, garbled] of [['U+FFFD', real.replace('אופק', '\uFFFD'.repeat(4))], ['?', real.replace('אופק', '????')]]) {
    await t.test(name, () => {
      const runFn = regFake({ [FILE_CHOICE('.html')]: 'ChromeHTML', [HKCR_CMD('ChromeHTML')]: garbled }, [unicodeRead((id) => (id === 'ChromeHTML' ? real : null))]);
      assert.deepEqual(createWindowsAdapter({ runFn, spawnFn: fakeSpawn() }).appFor('C:\\site\\index.html'),
        { progId: 'ChromeHTML', exe, name: 'Google Chrome', process: 'chrome' });
      assert.equal(psReads(runFn).length, 1);
      assert.deepEqual(psReads(runFn)[0].opts.env, { SHOW_LOCAL_PROGID: 'ChromeHTML' }, 'the ProgId travels only in the environment');
    });
  }
  await t.test('PowerShell failing keeps the reg.exe answer', () => {
    const garbled = real.replace('אופק', '????');
    const runFn = regFake({ [FILE_CHOICE('.html')]: 'ChromeHTML', [HKCR_CMD('ChromeHTML')]: garbled }, [unicodeRead(() => null)]);
    assert.equal(createWindowsAdapter({ runFn, spawnFn: fakeSpawn() }).appFor('C:\\site\\index.html').exe, 'C:\\Users\\????\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
  });
  await t.test('a clean path, a \\\\?\\ path and a Store app never start PowerShell', () => {
    const runFn = regFake({
      [FILE_CHOICE('.mp4')]: 'VLC.mp4', [HKCR_CMD('VLC.mp4')]: '"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" "%1"',
      [FILE_CHOICE('.pdf')]: 'Long.pdf', [HKCR_CMD('Long.pdf')]: '"\\\\?\\C:\\Tools\\SumatraPDF.exe" "%1"',
      [FILE_CHOICE('.png')]: PHOTOS_PROGID,
    }, [unicodeRead(() => 'C:\\wrong.exe')]);
    const a = createWindowsAdapter({ runFn, spawnFn: fakeSpawn() });
    assert.equal(a.appFor('C:\\a\\b.mp4').exe, 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe');
    assert.equal(a.appFor('C:\\a\\b.pdf').exe, '\\\\?\\C:\\Tools\\SumatraPDF.exe');
    assert.equal(a.appFor('C:\\a\\b.png').exe, undefined);
    assert.equal(psReads(runFn).length, 0);
  });
});

// A Store app's association as the registry holds it: a ProgId with no open command, and an
// Application key whose ApplicationName names the package.
const PHOTOS_PROGID = 'AppX43hnxtbyyps62jhe9sqpdzxn1790zetc';
const APP_KEY = (progId) => `HKCR\\${progId}\\Application`;
const PHOTOS_APP_NAME = '@{Microsoft.Windows.Photos_2026.11080.24002.0_x64__8wekyb3d8bbwe?ms-resource://Microsoft.Windows.Photos/Resources/AppDisplayName}';

test('win appFor names a Store app from its package ("Photos"), and says "a Microsoft Store app" when it cannot', () => {
  const named = createWindowsAdapter({ runFn: regFake({ [FILE_CHOICE('.png')]: PHOTOS_PROGID, [APP_KEY(PHOTOS_PROGID)]: PHOTOS_APP_NAME }), spawnFn: fakeSpawn() });
  assert.deepEqual(named.appFor('C:\\pics\\shot.PNG'), { progId: PHOTOS_PROGID, name: 'Photos', process: null });
  const plain = createWindowsAdapter({ runFn: regFake({ [FILE_CHOICE('.png')]: PHOTOS_PROGID, [APP_KEY(PHOTOS_PROGID)]: 'Paint' }), spawnFn: fakeSpawn() });
  assert.equal(plain.appFor('C:\\pics\\shot.png').name, 'Paint', 'a plain application name is kept');
  const resourceOnly = createWindowsAdapter({ runFn: regFake({ [FILE_CHOICE('.png')]: PHOTOS_PROGID, [APP_KEY(PHOTOS_PROGID)]: '@%SystemRoot%\\system32\\shell32.dll,-12345' }), spawnFn: fakeSpawn() });
  assert.equal(resourceOnly.appFor('C:\\pics\\shot.png').name, 'a Microsoft Store app', 'an unresolvable resource string is not shown');
  const noKey = createWindowsAdapter({ runFn: regFake({ [FILE_CHOICE('.png')]: PHOTOS_PROGID }), spawnFn: fakeSpawn() });
  assert.equal(noKey.appFor('C:\\pics\\shot.png').name, 'a Microsoft Store app');
});

test('win openApp reports a Store app by its name', async () => {
  const runFn = regFake({ [FILE_CHOICE('.png')]: PHOTOS_PROGID, [APP_KEY(PHOTOS_PROGID)]: PHOTOS_APP_NAME }, [['powershell.exe', {}]]);
  const a = createWindowsAdapter({ runFn, spawnFn: fakeSpawn() });
  assert.deepEqual(await a.openApp('C:\\pics\\shot.png'), { ok: true, with: 'Photos', how: 'Invoke-Item (file association)' });
});

test('win openApp names the associated program when the registry knows it', async () => {
  const runFn = regFake({
    [FILE_CHOICE('.mp4')]: 'VLC.mp4',
    [HKCR_CMD('VLC.mp4')]: '"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" "%1"',
  }, [['powershell.exe', {}]]);
  const a = createWindowsAdapter({ runFn, spawnFn: fakeSpawn() });
  const r = await a.openApp('C:\\clips\\intro.mp4');
  assert.deepEqual(r, { ok: true, with: 'VLC media player', how: 'Invoke-Item (file association)' });
});

test('win resolveBrowser reads the https handler through the injected runFn, and openUrl then uses it', async () => {
  const d = tempDir();
  try {
    const exe = path.join(d.dir, 'chrome.exe');
    writeFileSync(exe, '');
    const runFn = regFake({
      [URL_CHOICE('https')]: 'ChromeHTML',
      [HKCR_CMD('ChromeHTML')]: `"${exe}" --single-argument %1`,
    });
    const spawnFn = fakeSpawn();
    const a = createWindowsAdapter({ runFn, spawnFn });
    const b = a.resolveBrowser();
    assert.equal(b.platform, 'win32');
    assert.equal(b.progId, 'ChromeHTML');
    assert.equal(b.exe, exe);
    assert.deepEqual(b.args, ['--single-argument', '%1']);
    assert.equal(b.name, 'Google Chrome');
    assert.equal(b.process, 'chrome');
    const r = await a.openUrl('http://127.0.0.1:8000/', b);
    assert.equal(r.ok, true);
    assert.equal(spawnFn.calls[0].cmd, exe);
    assert.deepEqual(spawnFn.calls[0].args, ['--single-argument', 'http://127.0.0.1:8000/']);
    assert.ok(runFn.calls.every((c) => c.cmd === 'reg'), 'only registry reads, no PowerShell');
  } finally {
    d.cleanup();
  }
});

test('win resolveBrowser falls back to the http handler and returns null when nothing is registered', () => {
  const http1 = createWindowsAdapter({
    runFn: regFake({ [URL_CHOICE('http')]: 'FirefoxURL-308046B0AF4A39CB', [HKCR_CMD('FirefoxURL-308046B0AF4A39CB')]: '"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"' }),
    spawnFn: fakeSpawn(),
  });
  const b = http1.resolveBrowser();
  assert.equal(b.name, 'Firefox');
  assert.deepEqual(b.args, ['-osint', '-url', '%1']);
  const none = createWindowsAdapter({ runFn: fakeRun(), spawnFn: fakeSpawn() });
  assert.equal(none.resolveBrowser(), null);
});

test('win watchWindows starts windows.ps1 through PowerShell with the query only in env vars', async () => {
  const spawnFn = fakeWatcherSpawn((child) => {
    child.stdout.emit('data', 'READY\n');
    child.stdout.emit('data', 'noise line\n{"matched":false,"reason":"old"}\n{"matched":true,"confidence":"high","title":"My Site"}\n');
    child.emit('close', 0);
  });
  const runFn = fakeRun();
  const a = createWindowsAdapter({ runFn, spawnFn });
  const w = a.watchWindows({ tokens: ['My Site', 'האתר שלי', "it's $x"], processes: ['chrome'], timeoutMs: 1234 });
  await w.ready;
  assert.deepEqual(await w.result, { matched: true, confidence: 'high', title: 'My Site' });
  assert.equal(spawnFn.calls.length, 1);
  const { cmd, args, opts, child } = spawnFn.calls[0];
  assert.equal(cmd, 'powershell.exe');
  assert.deepEqual(args, [...PS_ARGS, '-File', WATCHER]);
  assert.ok(existsSync(WATCHER), 'the watcher script ships with the plugin');
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.env.SHOW_LOCAL_MODE, 'window');
  assert.deepEqual(JSON.parse(opts.env.SHOW_LOCAL_TOKENS), ['My Site', 'האתר שלי', "it's $x"]);
  assert.deepEqual(JSON.parse(opts.env.SHOW_LOCAL_PROCESSES), ['chrome']);
  assert.equal(opts.env.SHOW_LOCAL_TIMEOUT, '1234');
  const tag = createHash('sha1').update(readFileSync(WATCHER, 'utf8')).digest('hex').slice(0, 10);
  assert.equal(opts.env.SHOW_LOCAL_DLL, path.join(stateDirNow(), `ShowLocalWin-${tag}.dll`));
  const someKey = Object.keys(process.env).find((k) => !k.startsWith('SHOW_LOCAL_'));
  assert.equal(opts.env[someKey], process.env[someKey], 'inherits the environment');
  assert.ok(!args.some((x) => x.includes('My Site')), 'tokens never in argv');
  assert.equal(child.encoding, 'utf8');
  assert.equal(child.killed, false);
  assert.equal(runFn.calls.length, 0);
});

test('win watcher: ready waits for a READY line (even split across chunks, CRLF)', async () => {
  const spawnFn = fakeWatcherSpawn();
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
  const w = a.watchWindows({ tokens: ['x'], timeoutMs: 50 });
  let ready = false;
  w.ready.then(() => { ready = true; });
  await tick();
  const { child } = spawnFn.calls[0];
  child.stdout.emit('data', 'loading\nnotREADY\nREA');
  await tick();
  assert.equal(ready, false, 'not ready before the READY line');
  child.stdout.emit('data', 'DY\r\n');
  await tick();
  assert.equal(ready, true);
  child.stdout.emit('data', '{"matched":false,"reason":"none"}\r\n');
  child.emit('close', 0);
  assert.deepEqual(await w.result, { matched: false, reason: 'none' });
});

test('win watcher without JSON output reports matched:null with the stderr text', async () => {
  const spawnFn = fakeWatcherSpawn((child) => {
    child.stderr.emit('data', '  Add-Type : compilation failed\r\n');
    child.emit('close', 1);
  });
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
  const w = a.watchWindows({ tokens: ['x'], timeoutMs: 50 });
  await w.ready; // resolves on close even without READY
  assert.deepEqual(await w.result, { matched: null, reason: 'window watcher gave no result: Add-Type : compilation failed' });
});

test('win watcher with no output at all, or a broken JSON line, reports matched:null', async () => {
  const quiet = createWindowsAdapter({ runFn: fakeRun(), spawnFn: fakeWatcherSpawn((c) => c.emit('close', 0)) });
  assert.deepEqual(await quiet.watchWindows({ tokens: ['x'], timeoutMs: 50 }).result, { matched: null, reason: 'window watcher gave no result' });
  const broken = createWindowsAdapter({
    runFn: fakeRun(),
    spawnFn: fakeWatcherSpawn((c) => { c.stdout.emit('data', 'READY\n{"matched": tru\n'); c.emit('close', 0); }),
  });
  assert.deepEqual(await broken.watchWindows({ tokens: ['x'], timeoutMs: 50 }).result, { matched: null, reason: 'window watcher output was not JSON' });
});

test('win watcher that fails to run reports matched:null and releases ready', async () => {
  const erroring = createWindowsAdapter({
    runFn: fakeRun(),
    spawnFn: fakeWatcherSpawn((c) => c.emit('error', new Error('spawn powershell.exe ENOENT'))),
  });
  const w1 = erroring.watchWindows({ tokens: ['x'], timeoutMs: 50 });
  await w1.ready;
  assert.deepEqual(await w1.result, { matched: null, reason: 'window watcher failed: spawn powershell.exe ENOENT' });

  const throwing = createWindowsAdapter({ runFn: fakeRun(), spawnFn: () => { throw new Error('EPERM'); } });
  const w2 = throwing.watchWindows({ tokens: ['x'], timeoutMs: 50 });
  await w2.ready;
  assert.deepEqual(await w2.result, { matched: null, reason: 'could not start the window watcher: EPERM' });
});

test('win watchFolder runs the watcher in explorer mode with dir and selection in env', async (t) => {
  const done = (c) => { c.stdout.emit('data', 'READY\n{"matched":true,"confidence":"high"}\n'); c.emit('close', 0); };
  await t.test('with selection', async () => {
    const spawnFn = fakeWatcherSpawn(done);
    const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
    const w = a.watchFolder({ dir: 'C:\\אופק\\out', select: 'C:\\אופק\\out\\a b.pdf', timeoutMs: 900 });
    // The watcher said nothing about the selection, so it is "could not be checked".
    assert.deepEqual(await w.result, { matched: true, confidence: 'high', selectedOk: null });
    const { env } = spawnFn.calls[0].opts;
    assert.equal(env.SHOW_LOCAL_MODE, 'explorer');
    assert.equal(env.SHOW_LOCAL_DIR, 'C:\\אופק\\out');
    assert.equal(env.SHOW_LOCAL_SELECT, 'C:\\אופק\\out\\a b.pdf');
    assert.equal(env.SHOW_LOCAL_TIMEOUT, '900');
    assert.deepEqual(spawnFn.calls[0].args, [...PS_ARGS, '-File', WATCHER]);
  });
  await t.test('without selection', async () => {
    const spawnFn = fakeWatcherSpawn(done);
    const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
    await a.watchFolder({ dir: 'C:\\out' }).result;
    const { env } = spawnFn.calls[0].opts;
    assert.equal(env.SHOW_LOCAL_SELECT, '');
    assert.equal(env.SHOW_LOCAL_TIMEOUT, '5000', 'default timeout');
    assert.equal('SHOW_LOCAL_DIR_ALT' in env || 'SHOW_LOCAL_SELECT_ALT' in env, false, 'no other spelling, none passed');
  });
  await t.test('a long path: the 8.3 short spelling Explorer was given travels beside the long one', async () => {
    const spawnFn = fakeWatcherSpawn(done);
    const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
    await a.watchFolder({ dir: 'C:\\long\\out', select: 'C:\\long\\out\\a b.pdf', altDir: 'C:\\LONG~1\\out', altSelect: 'C:\\LONG~1\\out\\ABB~1.PDF' }).result;
    const { env } = spawnFn.calls[0].opts;
    assert.equal(env.SHOW_LOCAL_DIR, 'C:\\long\\out');
    assert.equal(env.SHOW_LOCAL_SELECT, 'C:\\long\\out\\a b.pdf');
    assert.equal(env.SHOW_LOCAL_DIR_ALT, 'C:\\LONG~1\\out');
    assert.equal(env.SHOW_LOCAL_SELECT_ALT, 'C:\\LONG~1\\out\\ABB~1.PDF');
  });
});

test('win watchFolder: selectedOk is what windows.ps1 saw when a file was asked for, else null; never implied by matched', async (t) => {
  const answering = (json) => fakeWatcherSpawn((c) => { c.stdout.emit('data', `READY\n${json}\n`); c.emit('close', 0); });
  const cases = [
    // [label, select, watcher output, expected selectedOk]
    ['selected', 'C:\\out\\a.pdf', { matched: true, confidence: 'high', selectedOk: true }, true],
    ['not selected: still a match, and says so', 'C:\\out\\a.pdf', { matched: true, confidence: 'high', selectedOk: false, reason: 'the folder opened but the expected file was not selected' }, false],
    ['selection unreadable', 'C:\\out\\a.pdf', { matched: true, confidence: 'high', selectedOk: null }, null],
    ['no window at all', 'C:\\out\\a.pdf', { matched: false, selectedOk: false }, false],
    ['a watcher that did not report it', 'C:\\out\\a.pdf', { matched: true, confidence: 'high' }, null],
    ['a non-boolean answer', 'C:\\out\\a.pdf', { matched: true, confidence: 'high', selectedOk: 'yes' }, null],
    ['nothing asked for, even when an older watcher said true', '', { matched: true, confidence: 'high', selectedOk: true }, null],
    ['nothing asked for (undefined)', undefined, { matched: true, confidence: 'high', selectedOk: false }, null],
  ];
  for (const [label, select, out, want] of cases) {
    await t.test(label, async () => {
      const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn: answering(JSON.stringify(out)) });
      const r = await a.watchFolder({ dir: 'C:\\out', select, timeoutMs: 100 }).result;
      assert.deepEqual(r, { ...out, selectedOk: want });
      assert.equal(r.matched, out.matched, 'matched is passed through untouched');
    });
  }
  await t.test('a watcher that failed gives selectedOk null next to its reason', async () => {
    const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn: () => { throw new Error('EPERM'); } });
    const w = a.watchFolder({ dir: 'C:\\out', select: 'C:\\out\\a.pdf', timeoutMs: 100 });
    await w.ready;
    assert.deepEqual(await w.result, { matched: null, reason: 'could not start the window watcher: EPERM', selectedOk: null });
    assert.doesNotThrow(() => w.cancel());
  });
});

test('win watchAppWindows is the same window watcher', async () => {
  const spawnFn = fakeWatcherSpawn((c) => { c.stdout.emit('data', '{"matched":false}\n'); c.emit('close', 0); });
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
  await a.watchAppWindows({ tokens: ['clip.mp4'], processes: ['vlc'], timeoutMs: 10 }).result;
  const { env } = spawnFn.calls[0].opts;
  assert.equal(env.SHOW_LOCAL_MODE, 'window');
  assert.deepEqual(JSON.parse(env.SHOW_LOCAL_TOKENS), ['clip.mp4']);
  assert.deepEqual(JSON.parse(env.SHOW_LOCAL_PROCESSES), ['vlc']);
});

test('win watchWindows defaults to no tokens, no processes and a 5 s timeout', async () => {
  const spawnFn = fakeWatcherSpawn((c) => c.emit('close', 0));
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
  await a.watchWindows({}).result;
  const { env } = spawnFn.calls[0].opts;
  assert.equal(env.SHOW_LOCAL_TOKENS, '[]');
  assert.equal(env.SHOW_LOCAL_PROCESSES, '[]');
  assert.equal(env.SHOW_LOCAL_TIMEOUT, '5000');
});

test('win snapshot runs the watcher in snapshot mode and parses its last JSON line', () => {
  const runFn = fakeRun([['powershell.exe', { stdout: 'WARNING: something\r\n{"ok":false}\r\n{"ok":true,"windows":[{"process":"chrome","title":"A"}]}\r\n' }]]);
  const a = createWindowsAdapter({ runFn, spawnFn: fakeSpawn() });
  assert.deepEqual(a.snapshot(), { ok: true, windows: [{ process: 'chrome', title: 'A' }] });
  const { args, opts } = runFn.calls[0];
  assert.deepEqual(args, [...PS_ARGS, '-File', WATCHER]);
  assert.equal(opts.env.SHOW_LOCAL_MODE, 'snapshot');
  assert.match(opts.env.SHOW_LOCAL_DLL, /ShowLocalWin-[0-9a-f]{10}\.dll$/);
  assert.equal(opts.timeout, 20000);
});

// ---- watcher cancel and guard (show() cancels the watcher when the open itself failed) --------

/** Mock setTimeout/clearTimeout for this test; false where node:test has no mock timers (Node 18). */
function mockTimeouts(t) {
  const timers = t.mock?.timers;
  if (typeof timers?.enable !== 'function') return false;
  try { timers.enable({ apis: ['setTimeout'] }); } catch { timers.enable(['setTimeout']); } // Node 20.4–20.10 took an array
  return true;
}

/** A watcher child that, like a real process, exits (emits close) once it is killed. */
const killable = (onStart = () => {}) => fakeWatcherSpawn((c) => {
  c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); return true; };
  onStart(c);
});

test('win watcher: cancel() kills the PowerShell child and the result settles at once', async () => {
  const spawnFn = killable((c) => c.stdout.emit('data', 'READY\n'));
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
  const w = a.watchWindows({ tokens: ['x'], timeoutMs: 60000 });
  await w.ready;
  const { child } = spawnFn.calls[0];
  assert.equal(child.killed, false, 'running until cancelled');
  const t0 = Date.now();
  w.cancel();
  assert.equal(child.killed, true);
  assert.deepEqual(await w.result, { matched: null, reason: 'window watcher gave no result' });
  assert.ok(Date.now() - t0 < 1000, 'no waiting for the 60 s timeout');
  assert.doesNotThrow(() => w.cancel(), 'a second cancel after exit is harmless');
});

test('win watchFolder: cancel() kills its watcher too', async () => {
  const spawnFn = killable();
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
  const w = a.watchFolder({ dir: 'C:\\out', timeoutMs: 60000 });
  await tick();
  w.cancel();
  assert.equal(spawnFn.calls[0].child.killed, true);
  assert.equal((await w.result).matched, null);
});

test('win watcher: cancel() when PowerShell could not even start does not throw', async () => {
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn: () => { throw new Error('EPERM'); } });
  const w = a.watchWindows({ tokens: ['x'], timeoutMs: 50 });
  assert.doesNotThrow(() => w.cancel());
  assert.equal((await w.result).matched, null);
});

test('win watcher: a watcher that never exits is killed timeoutMs + 15 s later (and not before)', async (t) => {
  if (!mockTimeouts(t)) { t.skip('needs mock timers (Node 20.4+)'); return; }
  const spawnFn = killable((c) => c.stdout.emit('data', 'READY\n')); // then silence, forever
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
  const w = a.watchWindows({ tokens: ['x'], timeoutMs: 1000 });
  await w.ready;
  const { child } = spawnFn.calls[0];
  t.mock.timers.tick(1000 + 15000 - 1);
  assert.equal(child.killed, false, 'the watcher gets its own timeout plus 15 s');
  t.mock.timers.tick(1);
  assert.equal(child.killed, true, 'then it is killed');
  assert.deepEqual(await w.result, { matched: null, reason: 'window watcher gave no result' });
});

test('win watcher: a watcher that exits normally clears its guard (never killed afterwards)', async (t) => {
  if (!mockTimeouts(t)) { t.skip('needs mock timers (Node 20.4+)'); return; }
  const spawnFn = killable((c) => { c.stdout.emit('data', 'READY\n{"matched":false,"reason":"none"}\n'); c.emit('close', 0); });
  const a = createWindowsAdapter({ runFn: fakeRun(), spawnFn });
  const w = a.watchWindows({ tokens: ['x'], timeoutMs: 1000 });
  assert.deepEqual(await w.result, { matched: false, reason: 'none' });
  t.mock.timers.tick(1000 + 15000 + 1);
  assert.equal(spawnFn.calls[0].child.killed, false);
});

test('win snapshot reports ok:false when the watcher prints no JSON', () => {
  const failing = createWindowsAdapter({ runFn: fakeRun([['powershell.exe', { status: 1, stderr: 'boom\r\n' }]]), spawnFn: fakeSpawn() });
  assert.deepEqual(failing.snapshot(), { ok: false, error: 'boom' });
  const silent = createWindowsAdapter({ runFn: fakeRun([['powershell.exe', { status: 1 }]]), spawnFn: fakeSpawn() });
  assert.deepEqual(silent.snapshot(), { ok: false, error: 'no output' });
});

// ---- windows.ps1 Watch-Explorer: the selection verdict, on scripted Explorer windows ----------

// Dot-sources the watcher (which then only defines its functions) and runs Watch-Explorer (or
// Watch-Window for mode 'window') on each case. Every poll takes the next scripted window list;
// the last one repeats. A window's `selected` is the list of selected paths, or null when its
// selection could not be read. pollMs defaults to 0.
const EXPLORER_DRIVER = [
  "$ErrorActionPreference = 'Stop'",
  '. $env:SHOW_LOCAL_TEST_WATCHER',
  '$cases = $env:SHOW_LOCAL_TEST_CASES | ConvertFrom-Json',
  'foreach ($c in $cases) {',
  '  $st = @{ i = 0 }',
  '  $polls = @($c.polls)',
  '  $list = { $n = [Math]::Min($st.i, $polls.Count - 1); $st.i++; @($polls[$n]) | Where-Object { $_ } }.GetNewClosure()',
  '  $poll = if ($null -ne $c.pollMs) { [int]$c.pollMs } else { 0 }',
  "  if ($c.mode -eq 'window') {",
  '    Emit (Watch-Window -Before @{} -Tokens @($c.tokens) -Procs @() -Timeout $c.timeout -List $list -ProcOf { param($w) [string]$w.process } -PollMs $poll)',
  '  } else {',
  '    Emit (Watch-Explorer -Before @($c.before | Where-Object { $_ }) -Want @((NormPath $c.want), (NormPath $c.wantAlt)) -Select @((NormPath $c.select), (NormPath $c.selectAlt)) -Timeout $c.timeout -List $list -PollMs $poll)',
  '  }',
  '}',
].join('\n');

const xw = (hwnd, p, selected = []) => ({ hwnd, path: p, selected });
const FILE = 'C:\\X\\Report.PDF';
const FILE_SEL = 'c:\\x\\report.pdf'; // Explorer's selection, normalised as windows.ps1 reads it
const SHORT = 300; // ms: cases that must run into the timeout
// A folder and file under their long and their 8.3 short spelling.
const LONG_CASE = { want: 'C:\\Long Folder', wantAlt: 'C:\\LONGFO~1', select: 'C:\\Long Folder\\Report.PDF', selectAlt: 'C:\\LONGFO~1\\REPORT~1.PDF' };

const EXPLORER_CASES = {
  selectedNew: { select: FILE, timeout: 5000, before: [], polls: [[xw(1, 'C:\\X', [FILE_SEL])]] },
  selectedOnceLoaded: { select: FILE, timeout: 5000, before: [], polls: [[xw(1, 'C:\\X', null)], [xw(1, 'C:\\X', [])], [xw(1, 'C:\\X', [FILE_SEL])]] },
  notSelected: { select: FILE, timeout: SHORT, before: [], polls: [[xw(1, 'C:\\X', ['c:\\x\\other.pdf'])]] },
  unreadable: { select: FILE, timeout: SHORT, before: [], polls: [[xw(1, 'C:\\X', null)]] },
  notAsked: { select: '', timeout: 5000, before: [], polls: [[xw(1, 'C:\\X', [FILE_SEL])]] },
  notAskedNothing: { select: '', timeout: SHORT, before: [], polls: [[xw(1, 'C:\\A')]] },
  askedNothing: { select: FILE, timeout: SHORT, before: [], polls: [[xw(1, 'C:\\A')]] },
  preSelected: { select: FILE, timeout: SHORT, before: [xw(1, 'C:\\X', [FILE_SEL])], polls: [[xw(1, 'C:\\X', [FILE_SEL])]] },
  preNotSelected: { select: FILE, timeout: SHORT, before: [xw(1, 'C:\\X', [])], polls: [[xw(1, 'C:\\X', [])]] },
  preNotAsked: { select: '', timeout: SHORT, before: [xw(1, 'C:\\X', [FILE_SEL])], polls: [[xw(1, 'C:\\X', [FILE_SEL])]] },
  reusedSelects: { select: FILE, timeout: 5000, before: [xw(1, 'C:\\X', ['c:\\x\\other.pdf'])], polls: [[xw(1, 'C:\\X', [FILE_SEL])]] },
  // A real poll interval: the last pause ends at the deadline, not a whole interval after it.
  explorerDeadline: { select: FILE, timeout: 300, pollMs: 200, before: [], polls: [[xw(1, 'C:\\A')]] },
  windowDeadline: { mode: 'window', tokens: ['my page'], timeout: 300, pollMs: 200, polls: [[{ handle: 1, title: 'Other - Google Chrome', process: 'chrome' }]] },
  // Past MAX_PATH Explorer is given the 8.3 short spelling; it may show either one.
  shortShown: { ...LONG_CASE, timeout: 5000, before: [], polls: [[xw(1, 'C:\\LONGFO~1', ['c:\\longfo~1\\report~1.pdf'])]] },
  shortShownLongSelected: { ...LONG_CASE, timeout: 5000, before: [], polls: [[xw(1, 'C:\\LONGFO~1', ['c:\\long folder\\report.pdf'])]] },
  longShown: { ...LONG_CASE, timeout: 5000, before: [], polls: [[xw(1, 'C:\\Long Folder', ['c:\\longfo~1\\report~1.pdf'])]] },
  shortShownOtherFile: { ...LONG_CASE, timeout: SHORT, before: [], polls: [[xw(1, 'C:\\LONGFO~1', ['c:\\longfo~1\\other~1.pdf'])]] },
  shortElsewhere: { ...LONG_CASE, timeout: SHORT, before: [], polls: [[xw(1, 'C:\\OTHERF~1', ['c:\\otherf~1\\report~1.pdf'])]] },
};

test('windows.ps1 Watch-Explorer: selectedOk is checked on its own, never implied by matched', { skip: process.platform !== 'win32' && 'the watcher runs on Windows only' }, async (t) => {
  const names = Object.keys(EXPLORER_CASES);
  const cases = names.map((n) => ({ want: 'C:\\X', ...EXPLORER_CASES[n] }));
  const r = spawnSync('powershell.exe', [...PS_ARGS, '-Command', EXPLORER_DRIVER], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, SHOW_LOCAL_TEST_WATCHER: WATCHER, SHOW_LOCAL_TEST_CASES: JSON.stringify(cases) },
  });
  const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l.startsWith('{'));
  assert.equal(lines.length, names.length, `one result per case; stdout: ${r.stdout} stderr: ${r.stderr}`);
  const R = Object.fromEntries(names.map((n, i) => [n, JSON.parse(lines[i])]));

  await t.test('a new window with the file selected: matched, selectedOk true', () => {
    for (const name of ['selectedNew', 'selectedOnceLoaded']) {
      assert.equal(R[name].matched, true, `${name}: ${JSON.stringify(R[name])}`);
      assert.equal(R[name].confidence, 'high', name);
      assert.equal(R[name].selectedOk, true, name);
      assert.equal(R[name].newWindow, true, name);
    }
  });

  await t.test('the folder opened without the file selected: still a match, but selectedOk false, and the reason says so', () => {
    assert.equal(R.notSelected.matched, true, JSON.stringify(R.notSelected));
    assert.equal(R.notSelected.confidence, 'high');
    assert.equal(R.notSelected.selectedOk, false);
    assert.equal(R.notSelected.reason, 'the folder opened but the expected file was not selected');
    assert.deepEqual(R.notSelected.selected, ['c:\\x\\other.pdf']);
  });

  await t.test('a selection that could not be read is null (cannot tell), not false and not true', () => {
    assert.equal(R.unreadable.matched, true, JSON.stringify(R.unreadable));
    assert.equal(R.unreadable.selectedOk, null);
    assert.match(R.unreadable.reason, /could not be read/);
  });

  await t.test('no file asked for: selectedOk null, even when the window is a match', () => {
    assert.equal(R.notAsked.matched, true, JSON.stringify(R.notAsked));
    assert.equal(R.notAsked.selectedOk, null, 'a match does not imply a selection');
    assert.equal(R.notAskedNothing.matched, false);
    assert.equal(R.notAskedNothing.selectedOk, null);
    assert.equal(R.preNotAsked.matched, null);
    assert.equal(R.preNotAsked.selectedOk, null);
  });

  await t.test('a file asked for and no window came up: matched false, selectedOk false', () => {
    assert.equal(R.askedNothing.matched, false, JSON.stringify(R.askedNothing));
    assert.equal(R.askedNothing.selectedOk, false);
    assert.match(R.askedNothing.reason, /no Explorer window on this folder appeared/);
  });

  await t.test('a window already on the folder: matched null either way, selectedOk says what it shows', () => {
    assert.equal(R.preSelected.matched, null, JSON.stringify(R.preSelected));
    assert.equal(R.preSelected.selectedOk, true);
    assert.equal(R.preNotSelected.matched, null, JSON.stringify(R.preNotSelected));
    assert.equal(R.preNotSelected.selectedOk, false);
  });

  await t.test('a window already on the folder that now selects the file: matched, selectedOk true', () => {
    assert.equal(R.reusedSelects.matched, true, JSON.stringify(R.reusedSelects));
    assert.equal(R.reusedSelects.selectedOk, true);
    assert.equal(R.reusedSelects.reusedWindow, true);
  });

  await t.test('both watchers stop at their timeout, not a poll interval after it (polls at 0, 200, 300 ms; not 400)', () => {
    for (const name of ['explorerDeadline', 'windowDeadline']) {
      assert.equal(R[name].matched, false, `${name}: ${JSON.stringify(R[name])}`);
      assert.ok(R[name].elapsedMs >= 300 && R[name].elapsedMs < 380, `${name}: elapsedMs ${R[name].elapsedMs}`);
    }
  });

  await t.test('a long path: a window on the long or the 8.3 short spelling is the folder, and either spelling of the file is selected', () => {
    for (const name of ['shortShown', 'shortShownLongSelected', 'longShown']) {
      assert.equal(R[name].matched, true, `${name}: ${JSON.stringify(R[name])}`);
      assert.equal(R[name].confidence, 'high', name);
      assert.equal(R[name].selectedOk, true, name);
    }
    assert.equal(R.shortShownOtherFile.matched, true, JSON.stringify(R.shortShownOtherFile));
    assert.equal(R.shortShownOtherFile.selectedOk, false, 'another file selected is still not the file');
    assert.equal(R.shortElsewhere.matched, false, JSON.stringify(R.shortElsewhere));
    assert.equal(R.shortElsewhere.selectedOk, false);
  });
});

// ---------------------------------------------------------------------------------------------
// macOS adapter
// ---------------------------------------------------------------------------------------------

test('mac openUrl uses open -b <bundle> <url> for a safe bundle id', async () => {
  const runFn = fakeRun([['open', {}]]);
  const a = createMacAdapter({ runFn, env: {} });
  const url = 'http://127.0.0.1:5500/';
  const r = await a.openUrl(url, { bundleId: 'com.google.Chrome', name: 'Google Chrome' });
  assert.deepEqual(r, { ok: true, with: 'Google Chrome', how: 'open -b' });
  assert.deepEqual(runFn.calls.map((c) => [c.cmd, c.args]), [['open', ['-b', 'com.google.Chrome', url]]]);
});

test('mac openUrl refuses unsafe bundle ids and falls back to plain open <url>', async (t) => {
  const unsafe = [
    'com.google.chrome" & do shell script "touch /tmp/pwned',
    'com.google.chrome; rm -rf ~',
    'com.google chrome',
    '$(id)',
    'com.example.`x`',
    "com.example.it's",
    'com.אופק.browser',
    '',
  ];
  for (const bundleId of unsafe) {
    await t.test(JSON.stringify(bundleId), async () => {
      const runFn = fakeRun([['open', {}]]);
      const a = createMacAdapter({ runFn, env: {} });
      const r = await a.openUrl('https://example.com/', { bundleId, name: 'Weird' });
      assert.equal(r.ok, true);
      assert.equal(r.how, 'open');
      assert.deepEqual(runFn.calls.map((c) => [c.cmd, c.args]), [['open', ['https://example.com/']]]);
    });
  }
});

test('mac openUrl without a browser uses open <url> and says "default browser"', async () => {
  const runFn = fakeRun([['open', {}]]);
  const a = createMacAdapter({ runFn, env: {} });
  assert.deepEqual(await a.openUrl('https://example.com/', null), { ok: true, with: 'default browser', how: 'open' });
  assert.deepEqual(runFn.calls[0].args, ['https://example.com/']);
});

test('mac openUrl / openFolder / openApp report open failures', async () => {
  const a = createMacAdapter({ runFn: fakeRun([['open', { status: 1, stderr: 'LSOpenURLsWithRole() failed\n' }]]), env: {} });
  assert.deepEqual(await a.openUrl('https://x/', null), { ok: false, error: 'LSOpenURLsWithRole() failed' });
  assert.deepEqual(await a.openFolder('/tmp/x'), { ok: false, error: 'LSOpenURLsWithRole() failed' });
  assert.deepEqual(await a.openApp('/tmp/x/a.pdf'), { ok: false, error: 'LSOpenURLsWithRole() failed' });
  const silent = createMacAdapter({ runFn: fakeRun([['open', { status: 1 }]]), env: {} });
  assert.deepEqual(await silent.openUrl('https://x/', null), { ok: false, error: 'open failed' });
});

test('mac openFolder reveals a file with open -R and opens a folder with open <dir>', async () => {
  const runFn = fakeRun([['open', {}]]);
  const a = createMacAdapter({ runFn, env: {} });
  assert.deepEqual(await a.openFolder('/Users/me/out', '/Users/me/out/report.pdf'), { ok: true, with: 'Finder', how: 'open -R' });
  assert.deepEqual(await a.openFolder('/Users/me/out'), { ok: true, with: 'Finder', how: 'open' });
  assert.deepEqual(runFn.calls.map((c) => [c.cmd, c.args]), [
    ['open', ['-R', '/Users/me/out/report.pdf']],
    ['open', ['/Users/me/out']],
  ]);
});

test('mac openApp passes hostile paths to open as one argv element', async () => {
  for (const p of NASTY_POSIX_PATHS) {
    const runFn = fakeRun([['open', {}]]);
    const a = createMacAdapter({ runFn, env: {} });
    assert.deepEqual(await a.openApp(p), { ok: true, with: 'default app', how: 'open' });
    assert.deepEqual(runFn.calls.map((c) => [c.cmd, c.args]), [['open', [p]]]);
  }
});

test('mac appFor is null, snapshot is unavailable, platform is darwin', () => {
  const runFn = fakeRun();
  const a = createMacAdapter({ runFn, env: {} });
  assert.equal(a.platform, 'darwin');
  assert.equal(a.appFor('/x/a.pdf'), null);
  assert.deepEqual(a.snapshot(), { ok: false, error: 'not available on macOS' });
  assert.equal(runFn.calls.length, 0);
});

test('mac resolveBrowser reads the https handler from LaunchServices through plutil', async () => {
  const runFn = macFake({ bundleId: 'com.google.Chrome' });
  const a = createMacAdapter({ runFn, env: {} });
  let plistPath;
  const b = withFakeMacHome((plist) => { plistPath = plist; return a.resolveBrowser(); });
  assert.deepEqual(b, { platform: 'darwin', bundleId: 'com.google.Chrome', name: 'Google Chrome' });
  assert.deepEqual(runFn.calls[0].args, ['-convert', 'json', '-o', '-', plistPath]);
  const openRun = fakeRun([['open', {}]]);
  const r = await createMacAdapter({ runFn: openRun, env: {} }).openUrl('http://127.0.0.1:5500/', b);
  assert.deepEqual(r, { ok: true, with: 'Google Chrome', how: 'open -b' });
  assert.deepEqual(openRun.calls[0].args, ['-b', 'com.google.Chrome', 'http://127.0.0.1:5500/']);
});

test('mac watchAppWindows is honest: matched null because other apps cannot be read', async () => {
  const runFn = macFake();
  const a = createMacAdapter({ runFn, env: {} });
  const w = a.watchAppWindows({ tokens: ['clip.mp4'], timeoutMs: 100 });
  await w.ready;
  const res = await w.result;
  assert.equal(res.matched, null);
  assert.match(res.reason, /Accessibility/);
  assert.equal(osascriptCalls(runFn).length, 0);
});

test('mac watchWindows with no usable tokens returns matched null (title not known in advance)', async () => {
  const { adapter } = macAdapter();
  for (const tokens of [[], ['', '   '], undefined]) {
    const res = await adapter.watchWindows({ tokens, timeoutMs: 100 }).result;
    assert.deepEqual(res, { matched: null, reason: 'the page title is not known in advance' });
  }
});

test('mac watchWindows without an identifiable default browser returns matched null', async () => {
  // The LaunchServices plist exists but cannot be read: nothing is assumed.
  const runFn = macFake({ plutil: false });
  const a = createMacAdapter({ runFn, env: {} });
  const w = withFakeMacHome(() => a.watchWindows({ tokens: ['My Site'], timeoutMs: 100 }));
  assert.deepEqual(await w.result, { matched: null, reason: 'default browser could not be identified' });
  assert.equal(osascriptCalls(runFn).length, 0);
});

test('mac: no LaunchServices plist means the user never changed the default, so Safari is assumed', async () => {
  const runFn = macFake({ running: ['false'] });
  const a = createMacAdapter({ runFn, env: {} });
  const b = withFakeMacHome(() => a.resolveBrowser(), { plist: false });
  assert.equal(b.bundleId, 'com.apple.Safari');
  assert.equal(b.name, 'Safari');
});

test('mac watchWindows reports matched:null with a reason when osascript is refused (-1743)', async () => {
  const { adapter } = macAdapter({ titles: [{ status: 1, stderr: 'execution error: Not authorized to send Apple events to Google Chrome. (-1743)\n' }] });
  const w = adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 1000 });
  await w.ready;
  const res = await w.result;
  assert.deepEqual(res, { matched: null, reason: 'macOS Automation permission for the browser was not granted' });
});

test('mac watchWindows recognises the -1743 code alone and "not authorised" wording alone', async () => {
  for (const stderr of ['osascript: (-1743)', 'Not authorised to send Apple events']) {
    const { adapter } = macAdapter({ titles: [{ status: 1, stderr }] });
    const res = await adapter.watchWindows({ tokens: ['x'], timeoutMs: 1000 }).result;
    assert.equal(res.matched, null, stderr);
    assert.match(res.reason, /Automation permission/, stderr);
  }
});

test('mac watchWindows reports other AppleScript failures with their message', async () => {
  const { adapter } = macAdapter({ titles: [{ status: 1, stderr: '123:130: syntax error: Expected end of line. (-2741)\n' }] });
  const res = await adapter.watchWindows({ tokens: ['x'], timeoutMs: 1000 }).result;
  assert.deepEqual(res, { matched: null, reason: 'AppleScript failed: 123:130: syntax error: Expected end of line. (-2741)' });
});

test('mac watchWindows returns matched:null with a reason when SHOW_LOCAL_NO_OSASCRIPT=1', async () => {
  const { adapter } = macAdapter({ titles: [['My Site']] }, { SHOW_LOCAL_NO_OSASCRIPT: '1' });
  const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 1000 }).result;
  assert.deepEqual(res, { matched: null, reason: 'verification disabled (SHOW_LOCAL_NO_OSASCRIPT=1)' });
  const folder = await adapter.watchFolder({ dir: '/Users/me/out', timeoutMs: 1000 }).result;
  assert.deepEqual(folder, { matched: null, reason: 'verification disabled (SHOW_LOCAL_NO_OSASCRIPT=1)', selectedOk: null });
});

test('mac SHOW_LOCAL_NO_OSASCRIPT=1 starts no osascript at all (no Automation prompt)', async (t) => {
  await t.test('watchWindows', async () => {
    const { adapter, runFn } = macAdapter({ titles: [['My Site']] }, { SHOW_LOCAL_NO_OSASCRIPT: '1' });
    await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 1000 }).result;
    assert.deepEqual(osascriptCalls(runFn).map((c) => c.args[1]), [], 'osascript must not run when verification through AppleScript is disabled');
  });
  await t.test('watchFolder', async () => {
    const { adapter, runFn } = macAdapter({ finder: [['/Users/me/out']] }, { SHOW_LOCAL_NO_OSASCRIPT: '1' });
    await adapter.watchFolder({ dir: '/Users/me/out', timeoutMs: 1000 }).result;
    assert.deepEqual(osascriptCalls(runFn).map((c) => c.args[1]), [], 'osascript must not run when verification through AppleScript is disabled');
  });
});

test('mac watchWindows does not script a browser without a tab-title dictionary (Firefox)', async () => {
  const { adapter, runFn, browser } = macAdapter({ bundleId: 'org.mozilla.firefox' });
  assert.equal(browser.name, 'Firefox');
  const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 1000 }).result;
  assert.deepEqual(res, { matched: null, reason: 'window titles of org.mozilla.firefox are not readable from AppleScript' });
  assert.equal(osascriptCalls(runFn).length, 0);
});

test('mac watchWindows never puts an unsafe bundle id into AppleScript', async () => {
  const evil = 'com.google.chrome" to do shell script "touch /tmp/pwned';
  const { adapter, runFn, browser } = macAdapter({ bundleId: evil });
  assert.equal(browser.bundleId, evil);
  const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 1000 }).result;
  assert.equal(res.matched, null);
  assert.equal(osascriptCalls(runFn).length, 0);
  const openRun = fakeRun([['open', {}]]);
  await createMacAdapter({ runFn: openRun, env: {} }).openUrl('https://x/', browser);
  assert.deepEqual(openRun.calls[0].args, ['https://x/']);
});

test('mac watchWindows: a new matching tab title gives matched true / high', async () => {
  const { adapter, runFn } = macAdapter({ titles: [['Inbox (3) - Gmail'], ['Inbox (3) - Gmail', 'My   Site — Home']] });
  const w = adapter.watchWindows({ tokens: ['  my site '], timeoutMs: 3000 });
  await w.ready;
  const res = await w.result;
  assert.equal(res.matched, true);
  assert.equal(res.confidence, 'high');
  assert.equal(res.title, 'My   Site — Home');
  assert.equal(typeof res.elapsedMs, 'number');
  assert.ok(res.elapsedMs >= 0 && res.elapsedMs < 3000);
  const scripts = osascriptCalls(runFn);
  assert.ok(scripts.length >= 4, 'before snapshot + at least one poll, each a running check and a title read');
  assert.deepEqual(scripts[0].args, ['-e', 'application id "com.google.Chrome" is running']);
  assert.equal(scripts[0].opts.timeout, 4000);
  const titleScript = scripts[1].args.filter((x, i) => i % 2 === 1);
  assert.ok(scripts[1].args.every((x, i) => (i % 2 === 0 ? x === '-e' : true)), 'one -e per line');
  assert.equal(titleScript[0], 'tell application id "com.google.Chrome"');
  assert.ok(titleScript.some((l) => l.includes('title of active tab')));
  assert.ok(!titleScript.join('\n').includes('My Site'), 'the title being looked for is never put into the script');
});

test('mac watchWindows reads Safari tab titles through "name of current tab"', async () => {
  const { adapter, runFn } = macAdapter({ bundleId: 'com.apple.Safari', titles: [[], ['My Site']] });
  const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 3000 }).result;
  assert.equal(res.matched, true);
  assert.equal(res.confidence, 'high');
  const script = osascriptCalls(runFn).find((c) => c.args[1].startsWith('tell application id')).args.join('\n');
  assert.ok(script.includes('name of current tab'));
  assert.ok(!script.includes('title of active tab'));
});

test('mac watchWindows: a title that was already open gives matched null (cannot tell) after the timeout, never true', async () => {
  const { adapter } = macAdapter({ titles: [['My Site', 'Other']] });
  const start = Date.now();
  const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 700 }).result;
  assert.deepEqual(res, { matched: null, title: 'My Site', reason: 'a window with this title was already open before, and no new one appeared within 700 ms, so this open cannot be told apart from it' });
  assert.ok(Date.now() - start >= 650, 'waited for the timeout hoping for a new window');
});

test('mac watchWindows: a counter ticking in the page window that already showed the title is still null', async () => {
  const { adapter } = macAdapter({ titles: [['(1) My Site'], ['(2) My Site']] });
  const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 700 }).result;
  assert.equal(res.matched, null, JSON.stringify(res));
  assert.match(res.reason, /already open before/);
});

test('mac watchWindows: a second window with a title that was already open is new: matched true / high', async () => {
  const { adapter } = macAdapter({ titles: [['My Site', 'Other'], ['My Site', 'Other', 'My Site']] });
  const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 3000 }).result;
  assert.equal(res.matched, true, JSON.stringify(res));
  assert.equal(res.confidence, 'high');
  assert.equal(res.title, 'My Site');
});

test('mac watchWindows: an unrelated window changing its title never verifies (matched false)', async () => {
  const { adapter } = macAdapter({ titles: [['Inbox (1) - Gmail'], ['Inbox (2) - Gmail'], ['Inbox (3) - Gmail', 'Pixel Forge']] });
  const res = await adapter.watchWindows({ tokens: ['Example Domain'], timeoutMs: 700 }).result;
  assert.deepEqual(res, { matched: false, reason: 'no new window matching the target appeared within 700 ms' });
});

test('mac watchFolder: a Finder window already on the folder gives matched null, never true', async () => {
  const { adapter } = macAdapter({ finder: [['/Users/me/out/']] });
  const res = await adapter.watchFolder({ dir: '/Users/me/out', timeoutMs: 700 }).result;
  assert.equal(res.matched, null, JSON.stringify(res));
  assert.equal(res.title, '/Users/me/out');
  assert.match(res.reason, /already open before/);
});

test('mac watchWindows: nothing matching gives matched false with the timeout in the reason', async () => {
  const { adapter } = macAdapter({ titles: [['Other'], ['Other', 'Unrelated']] });
  const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 700 }).result;
  assert.deepEqual(res, { matched: false, reason: 'no new window matching the target appeared within 700 ms' });
});

test('mac watchWindows: a browser that was not running before counts as new', async () => {
  const { adapter, runFn } = macAdapter({ running: ['false', 'true'], titles: [['My Site']] });
  const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 3000 }).result;
  assert.equal(res.matched, true);
  assert.equal(res.confidence, 'high');
  const firstTitleRead = osascriptCalls(runFn).findIndex((c) => c.args[1].startsWith('tell application id'));
  assert.equal(firstTitleRead, 2, 'titles are not read while the browser is not running');
});

test('mac watchWindows: permission revoked during polling gives matched null', async () => {
  const { adapter } = macAdapter({ titles: [['Other'], { status: 1, stderr: 'Not authorized to send Apple events to Google Chrome. (-1743)' }] });
  const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 3000 }).result;
  assert.deepEqual(res, { matched: null, reason: 'macOS Automation permission for the browser was not granted' });
});

test('mac watchWindows and watchFolder: cancel() ends polling at once with matched null "cancelled"', async (t) => {
  const cases = {
    watchWindows: () => macAdapter({ titles: [['Other']] }),
    watchFolder: () => macAdapter({ finder: [['/Users/me/Desktop']] }),
  };
  for (const [method, make] of Object.entries(cases)) {
    await t.test(method, async () => {
      const { adapter, runFn } = make();
      const w = method === 'watchWindows'
        ? adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 8000 })
        : adapter.watchFolder({ dir: '/Users/me/My Site', timeoutMs: 8000 });
      await w.ready;
      await sleep(350); // let it poll once
      const t0 = Date.now();
      w.cancel();
      assert.deepEqual(await w.result, { matched: null, reason: 'cancelled', ...(method === 'watchFolder' ? { selectedOk: null } : {}) });
      assert.ok(Date.now() - t0 < 1500, `settled ${Date.now() - t0} ms after cancel, not at the 8 s timeout`);
      const polls = osascriptCalls(runFn).length;
      await sleep(700);
      assert.equal(osascriptCalls(runFn).length, polls, 'no AppleScript runs after cancel');
    });
  }
});

test('mac watchers that settle at once (no tokens, no AppleScript) accept cancel() too', async () => {
  const { adapter } = macAdapter();
  const w = adapter.watchWindows({ tokens: [], timeoutMs: 8000 });
  assert.doesNotThrow(() => w.cancel());
  assert.equal((await w.result).matched, null);
});

test('mac watchFolder: a new Finder window on the folder gives matched true / high', async () => {
  const { adapter, runFn } = macAdapter({ finder: [['/Users/me/Desktop/'], ['/Users/me/Desktop/', '/Users/me/My Site/']] });
  const res = await adapter.watchFolder({ dir: '/Users/me/My Site/', timeoutMs: 3000 }).result;
  assert.equal(res.matched, true);
  assert.equal(res.confidence, 'high');
  assert.equal(res.title, '/Users/me/My Site');
  const finderScript = osascriptCalls(runFn)[0].args.filter((x, i) => i % 2 === 1);
  assert.equal(finderScript[0], 'tell application "Finder"');
  assert.ok(!finderScript.join('\n').includes('My Site'), 'the folder path is never put into the script');
});

test('mac watchFolder: only an exact folder path matches, not a sibling with a longer name', async () => {
  const { adapter } = macAdapter({ finder: [[], ['/Users/me/My Site 2']] });
  const res = await adapter.watchFolder({ dir: '/Users/me/My Site', timeoutMs: 700 }).result;
  assert.equal(res.matched, false);
});

/**
 * runFn for a Finder that shows what `open` asked for: `open -R <item>` a window on the
 * item's parent folder, `open <dir>` one on the folder. The Finder AppleScript lists them.
 */
function finderShowingOpens() {
  const windows = [];
  return fakeRun([
    [(c) => c === 'open', (c, a) => { windows.push(a[0] === '-R' ? path.posix.dirname(a[1]) : a[0]); return {}; }],
    [(c, a) => c === 'osascript' && a[1] === 'tell application "Finder"', () => ({ stdout: windows.map((w) => `${w.replace(/\/*$/, '/')}\n`).join('') })],
  ]);
}

test('mac watchFolder waits for the window openFolder makes Finder show, a dotted folder revealed in its parent included', async (t) => {
  const cases = [
    ['a folder', '/Users/me/out', null],
    ['a folder with a file to select', '/Users/me/out', '/Users/me/out/a.pdf'],
    ['a dotted folder with nothing to select (Finder shows its parent)', '/Users/me/ofekai.co.il', null],
    ['a dotted folder with a file to select', '/Users/me/project.v2', '/Users/me/project.v2/notes.txt'],
    ['a dotted folder right under /', '/data.2026', null],
  ];
  for (const [name, dir, select] of cases) {
    await t.test(name, async () => {
      const a = createMacAdapter({ runFn: finderShowingOpens(), env: {} });
      const w = a.watchFolder({ dir, select, timeoutMs: 3000 });
      await w.ready;
      assert.equal((await a.openFolder(dir, select)).ok, true);
      const res = await w.result;
      assert.equal(res.matched, true, JSON.stringify(res));
      assert.equal(res.confidence, 'high');
    });
  }
});

test('mac watchFolder: a parent window already open when a dotted folder is revealed in it is "cannot tell", never "did not open"', async () => {
  const { adapter } = macAdapter({ finder: [['/Users/me/']] });
  const res = await adapter.watchFolder({ dir: '/Users/me/ofekai.co.il', select: null, timeoutMs: 400 }).result;
  assert.equal(res.matched, null, JSON.stringify(res));
  assert.equal(res.title, '/Users/me');
  assert.match(res.reason, /already open before/);
});

test('mac watchFolder reports Finder permission and Finder failures as matched null', async () => {
  const denied = macAdapter({ finder: [{ status: 1, stderr: 'Not authorized to send Apple events to Finder. (-1743)' }] });
  assert.deepEqual(await denied.adapter.watchFolder({ dir: '/x', timeoutMs: 1000 }).result,
    { matched: null, reason: 'macOS Automation permission for Finder was not granted', selectedOk: null });
  const broken = macAdapter({ finder: [{ status: 1, stderr: 'Finder got an error' }] });
  assert.deepEqual(await broken.adapter.watchFolder({ dir: '/x', timeoutMs: 1000 }).result,
    { matched: null, reason: 'Finder windows could not be read', selectedOk: null });
});

test('mac watchFolder: Finder\'s selection is not read, so every result says selectedOk null, a match included', async () => {
  const { adapter } = macAdapter({ finder: [[], ['/Users/me/out']] });
  const hit = await adapter.watchFolder({ dir: '/Users/me/out', select: '/Users/me/out/a.pdf', timeoutMs: 3000 }).result;
  assert.equal(hit.matched, true, JSON.stringify(hit));
  assert.equal(hit.confidence, 'high');
  assert.equal(hit.selectedOk, null, 'a matched window says nothing about the selection');
  const miss = await macAdapter({ finder: [[]] }).adapter.watchFolder({ dir: '/Users/me/out', select: '/Users/me/out/a.pdf', timeoutMs: 400 }).result;
  assert.deepEqual(miss, { matched: false, reason: 'no new window matching the target appeared within 400 ms', selectedOk: null });
});

test('mac watchWindows: when the "is running" check itself fails, the result is matched null with a reason, never false', async (t) => {
  const cases = [
    ['a non-zero exit', { status: 1, stderr: 'osascript: execution error: Application isn\'t running. (-600)\n' }, /could not check whether the browser is running: osascript failed \(exit 1\): osascript: execution error/],
    ['a timeout', { status: null, error: 'spawnSync osascript ETIMEDOUT' }, /could not check whether the browser is running: osascript did not answer within 4 s/],
    ['osascript not found', { status: null, error: 'spawnSync osascript ENOENT' }, /could not check whether the browser is running: osascript was not found/],
    ['an Automation refusal', { status: 1, stderr: 'Not authorized to send Apple events to System Events. (-1743)' }, /^macOS Automation permission for the browser was not granted$/],
    ['an answer that is neither true nor false', { status: 0, stdout: 'missing value\n' }, /osascript answered "missing value"/],
  ];
  for (const [label, frame, reason] of cases) {
    await t.test(label, async () => {
      const { adapter, runFn } = macAdapter({ running: [frame], titles: [['My Site']] });
      const t0 = Date.now();
      const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 5000 }).result;
      assert.equal(res.matched, null, JSON.stringify(res));
      assert.match(res.reason, reason);
      assert.ok(Date.now() - t0 < 2000, 'answered at once, not after the 5 s timeout');
      assert.equal(osascriptCalls(runFn).filter((c) => c.args[1].startsWith('tell application id')).length, 0, 'no titles read after a failed check');
    });
  }
  await t.test('a clean "false" is still "not running yet": the poll goes on and times out as false', async () => {
    const { adapter } = macAdapter({ running: ['false'] });
    const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 400 }).result;
    assert.deepEqual(res, { matched: false, reason: 'no new window matching the target appeared within 400 ms' });
  });
  await t.test('the check failing mid-poll is matched null too', async () => {
    const { adapter } = macAdapter({ running: ['true', { status: null, error: 'spawnSync osascript ETIMEDOUT' }], titles: [['Other']] });
    const res = await adapter.watchWindows({ tokens: ['My Site'], timeoutMs: 3000 }).result;
    assert.equal(res.matched, null, JSON.stringify(res));
    assert.match(res.reason, /did not answer within 4 s/);
  });
});

// ---------------------------------------------------------------------------------------------
// Linux adapter
// ---------------------------------------------------------------------------------------------

test('linux openUrl runs the Exec argv of the default browser .desktop file', async () => {
  const runFn = fakeRun();
  const spawnFn = fakeSpawn();
  const a = createLinuxAdapter({ runFn, spawnFn, env: X11 });
  const url = 'http://127.0.0.1:3000/';
  const b = { desktopId: 'firefox.desktop', name: 'Firefox', argv: ['/usr/lib/firefox/firefox', '--new-window', '%u'] };
  const r = await a.openUrl(url, b);
  assert.deepEqual(r, { ok: true, with: 'Firefox', how: 'firefox.desktop (default browser)', exe: '/usr/lib/firefox/firefox' });
  assert.equal(spawnFn.calls.length, 1);
  assert.equal(spawnFn.calls[0].cmd, '/usr/lib/firefox/firefox');
  assert.deepEqual(spawnFn.calls[0].args, ['--new-window', url]);
  assert.deepEqual(spawnFn.calls[0].opts, DETACHED);
  assert.equal(runFn.calls.length, 0);
});

test('linux openUrl resolves Exec field codes: %U used, %i/%c dropped, URL appended when absent', async (t) => {
  const url = 'https://example.com/?a=1&b=$HOME';
  const cases = [
    [['google-chrome-stable', '%U', '%i', '%c'], ['google-chrome-stable', [url]]],
    [['chromium', '--incognito'], ['chromium', ['--incognito', url]]],
    [['/opt/brave/brave', '--profile=%%default', '%F'], ['/opt/brave/brave', ['--profile=%default', url]]],
  ];
  for (const [argv, [cmd, args]] of cases) {
    await t.test(argv.join(' '), async () => {
      const spawnFn = fakeSpawn();
      const a = createLinuxAdapter({ runFn: fakeRun(), spawnFn, env: X11 });
      await a.openUrl(url, { desktopId: 'x.desktop', name: 'X', argv });
      assert.equal(spawnFn.calls[0].cmd, cmd);
      assert.deepEqual(spawnFn.calls[0].args, args);
    });
  }
});

test('linux openUrl uses xdg-open when there is no Exec argv', async () => {
  for (const b of [null, undefined, { desktopId: 'x.desktop', argv: null }, { argv: [] }]) {
    const spawnFn = fakeSpawn();
    const a = createLinuxAdapter({ runFn: fakeRun(), spawnFn, env: X11 });
    const r = await a.openUrl('https://example.com/', b);
    assert.deepEqual(r, { ok: true, with: 'default browser', how: 'xdg-open' });
    assert.deepEqual(spawnFn.calls.map((c) => [c.cmd, c.args]), [['xdg-open', ['https://example.com/']]]);
  }
});

test('linux openUrl falls back to xdg-open when the browser fails to start, and reports when both fail', async () => {
  const b = { desktopId: 'firefox.desktop', name: 'Firefox', argv: ['firefox', '%u'] };
  const spawnFn = fakeSpawn((cmd) => (cmd === 'firefox' ? 'error' : 'spawn'));
  const a = createLinuxAdapter({ runFn: fakeRun(), spawnFn, env: X11 });
  assert.deepEqual(await a.openUrl('https://x/', b), { ok: true, with: 'default browser', how: 'xdg-open' });
  assert.deepEqual(spawnFn.calls.map((c) => c.cmd), ['firefox', 'xdg-open']);

  const dead = createLinuxAdapter({ runFn: fakeRun(), spawnFn: fakeSpawn('error'), env: X11 });
  assert.deepEqual(await dead.openUrl('https://x/', b), { ok: false, error: 'ENOENT' });
});

test('linux openFolder with a selection calls FileManager1.ShowItems over D-Bus with the file:// URI', async () => {
  const runFn = fakeRun([['gdbus', {}]]);
  const spawnFn = fakeSpawn();
  const a = createLinuxAdapter({ runFn, spawnFn, env: X11 });
  const select = '/home/me/out/report 1.pdf';
  const r = await a.openFolder('/home/me/out', select);
  assert.deepEqual(r, { ok: true, with: 'file manager', how: 'FileManager1.ShowItems' });
  assert.equal(spawnFn.calls.length, 0);
  assert.equal(runFn.calls.length, 1);
  const { cmd, args } = runFn.calls[0];
  assert.equal(cmd, 'gdbus');
  const uri = pathToFileURL(select).href;
  assert.deepEqual(args, [
    'call', '--session', '--dest', 'org.freedesktop.FileManager1',
    '--object-path', '/org/freedesktop/FileManager1', '--method', 'org.freedesktop.FileManager1.ShowItems',
    `['${uri}']`, '',
  ]);
  assert.ok(uri.startsWith('file://') && uri.includes('report%201.pdf'));
});

test('linux openFolder without a selection calls ShowFolders with the folder URI', async () => {
  const runFn = fakeRun([['gdbus', {}]]);
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const r = await a.openFolder('/home/me/My Site');
  assert.deepEqual(r, { ok: true, with: 'file manager', how: 'FileManager1.ShowFolders' });
  const { args } = runFn.calls[0];
  assert.equal(args[7], 'org.freedesktop.FileManager1.ShowFolders');
  assert.equal(args[8], `['${pathToFileURL('/home/me/My Site').href}']`);
});

test('linux openFolder keeps the GVariant string literal intact for quotes, $, &, backticks and Hebrew', async (t) => {
  for (const p of NASTY_POSIX_PATHS) {
    await t.test(p, async () => {
      const runFn = fakeRun([['gdbus', {}]]);
      const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
      await a.openFolder(path.posix.dirname(p), p);
      const arg = runFn.calls[0].args[8];
      assert.ok(arg.startsWith("['") && arg.endsWith("']"), arg);
      const inner = arg.slice(2, -2);
      assert.ok(!inner.includes("'"), `a quote would end the GVariant string early: ${arg}`);
      assert.ok(!/\s/.test(inner), `whitespace is percent-encoded: ${inner}`);
      assert.equal(fileURLToPath(new URL(inner)), path.resolve(p), 'the URI still names exactly the same file');
    });
  }
});

test('linux openFolder falls back to xdg-open <dir> when D-Bus has no file manager', async () => {
  const runFn = fakeRun([['gdbus', { status: 1, stderr: 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown' }]]);
  const spawnFn = fakeSpawn();
  const a = createLinuxAdapter({ runFn, spawnFn, env: X11 });
  const r = await a.openFolder('/home/me/out', '/home/me/out/a.pdf');
  assert.deepEqual(r, { ok: true, with: 'file manager', how: 'xdg-open' });
  assert.deepEqual(spawnFn.calls.map((c) => [c.cmd, c.args]), [['xdg-open', ['/home/me/out']]]);
  assert.deepEqual(spawnFn.calls[0].opts, DETACHED);
});

test('linux openFolder reports failure when both D-Bus and xdg-open fail', async () => {
  const a = createLinuxAdapter({ runFn: fakeRun(), spawnFn: fakeSpawn('error'), env: X11 });
  assert.deepEqual(await a.openFolder('/home/me/out'), { ok: false, error: 'ENOENT' });
});

test('linux openApp uses xdg-open with the file as one argv element', async () => {
  for (const p of NASTY_POSIX_PATHS) {
    const runFn = fakeRun();
    const spawnFn = fakeSpawn();
    const a = createLinuxAdapter({ runFn, spawnFn, env: X11 });
    assert.deepEqual(await a.openApp(p), { ok: true, with: 'default app', how: 'xdg-open' });
    assert.deepEqual(spawnFn.calls.map((c) => [c.cmd, c.args, c.opts]), [['xdg-open', [p], DETACHED]]);
    assert.equal(runFn.calls.length, 0);
  }
  const failing = createLinuxAdapter({ runFn: fakeRun(), spawnFn: fakeSpawn('error'), env: X11 });
  assert.deepEqual(await failing.openApp('/x/a.pdf'), { ok: false, error: 'ENOENT' });
});

test('linux appFor is null and platform is linux', () => {
  const a = createLinuxAdapter({ runFn: fakeRun(), spawnFn: fakeSpawn(), env: X11 });
  assert.equal(a.platform, 'linux');
  assert.equal(a.appFor('/x/a.pdf'), null);
});

test('linux resolveBrowser reads Exec from the .desktop file and openUrl runs exactly that argv', async () => {
  const d = tempDir();
  try {
    const apps = path.join(d.dir, 'applications');
    mkdirSync(apps, { recursive: true });
    writeFileSync(path.join(apps, 'firefox.desktop'), [
      '[Desktop Entry]',
      'Name=Firefox',
      'Exec="/opt/fire fox/firefox" --name firefox %u',
      '',
      '[Desktop Action new-private-window]',
      'Exec=/opt/firefox/firefox --private-window %u',
      '',
    ].join('\n'));
    const runFn = fakeRun([['xdg-settings get default-web-browser', { stdout: 'firefox.desktop\n' }]]);
    const spawnFn = fakeSpawn();
    const a = createLinuxAdapter({ runFn, spawnFn, env: { ...X11, XDG_DATA_HOME: d.dir, XDG_DATA_DIRS: '/nonexistent-show-local-test' } });
    const b = a.resolveBrowser();
    assert.equal(b.desktopId, 'firefox.desktop');
    assert.equal(b.name, 'Firefox');
    assert.deepEqual(b.argv, ['/opt/fire fox/firefox', '--name', 'firefox', '%u'], 'the [Desktop Entry] Exec, not an action');
    const url = 'http://127.0.0.1:3000/index.html';
    assert.deepEqual(await a.openUrl(url, b), { ok: true, with: 'Firefox', how: 'firefox.desktop (default browser)', exe: '/opt/fire fox/firefox' });
    assert.deepEqual(spawnFn.calls.map((c) => [c.cmd, c.args]), [['/opt/fire fox/firefox', ['--name', 'firefox', url]]]);
  } finally {
    d.cleanup();
  }
});

test('linux resolveBrowser goes through the injected runFn (xdg-settings)', () => {
  const runFn = fakeRun();
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  assert.equal(a.resolveBrowser(), null);
  assert.deepEqual(runFn.calls.map((c) => [c.cmd, c.args]), [['xdg-settings', ['get', 'default-web-browser']]]);
});

test('linux verification is matched null on Wayland without DISPLAY, without probing anything', async () => {
  const runFn = linuxFake({ frames: [['My Site']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' } });
  const w = a.watchWindows({ tokens: ['My Site'], timeoutMs: 1000 });
  await w.ready;
  assert.deepEqual(await w.result, { matched: null, reason: 'Wayland does not expose window titles to other programs' });
  assert.deepEqual(a.snapshot(), { ok: false, error: 'Wayland does not expose window titles to other programs' });
  assert.equal(runFn.calls.length, 0);
});

test('linux Wayland with XWayland (DISPLAY set) still reads titles through wmctrl', () => {
  const runFn = linuxFake({ frames: [['Terminal']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' } });
  assert.deepEqual(a.snapshot(), { ok: true, windows: [{ process: '', title: 'Terminal' }] });
});

test('linux: WAYLAND_DISPLAY alone is a Wayland session, so with XWayland a miss is "cannot verify", never "did not open"', async (t) => {
  // sway started from a console login: logind leaves XDG_SESSION_TYPE at "tty" (or it is
  // unset), XWayland sets DISPLAY, and wmctrl lists the XWayland windows only.
  const reason = 'under Wayland only X11 windows are visible, so a native window cannot be confirmed';
  for (const session of [{ XDG_SESSION_TYPE: 'tty' }, {}]) {
    await t.test(session.XDG_SESSION_TYPE ? 'XDG_SESSION_TYPE=tty' : 'XDG_SESSION_TYPE unset', async () => {
      const env = { ...session, WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0' };
      const make = (frames) => createLinuxAdapter({ runFn: linuxFake({ frames }), spawnFn: fakeSpawn(), env });
      assert.deepEqual(await make([['xterm']]).watchWindows({ tokens: ['My Page'], timeoutMs: 400 }).result, { matched: null, reason });
      assert.deepEqual(await make([['xterm']]).watchAppWindows({ tokens: ['report.pdf'], timeoutMs: 400 }).result, { matched: null, reason });
      assert.deepEqual(await make([['xterm']]).watchFolder({ dir: '/home/me/out', timeoutMs: 400 }).result, { matched: null, reason, selectedOk: null });
      // The XWayland windows are still read: a new one that matches is still proof.
      const hit = await make([['xterm'], ['xterm', 'My Page — Chromium']]).watchWindows({ tokens: ['My Page'], timeoutMs: 3000 }).result;
      assert.equal(hit.matched, true, JSON.stringify(hit));
      assert.equal(hit.confidence, 'high');
    });
  }
});

test('linux verification is matched null when neither wmctrl nor xdotool is installed', async () => {
  const runFn = linuxFake({ lister: 'none' });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const res = await a.watchWindows({ tokens: ['My Site'], timeoutMs: 1000 }).result;
  assert.deepEqual(res, { matched: null, reason: 'no window lister installed (install wmctrl or xdotool to verify)' });
  const probes = runFn.calls.filter((c) => c.cmd === 'sh');
  assert.deepEqual(probes.map((c) => c.args), [['-c', 'command -v "$0"', 'wmctrl'], ['-c', 'command -v "$0"', 'xdotool']],
    'the binary name is passed as $0, never spliced into the script');
  assert.deepEqual(a.snapshot(), { ok: false, error: 'no window lister installed (install wmctrl or xdotool to verify)' });
});

test('linux wmctrl -l parsing keeps titles with spaces and drops the id/desktop/host columns', () => {
  const stdout = [
    '0x03a00003  0 my-host My Site — Mozilla Firefox',
    '0x01e00006 -1 my-host Desktop',
    '0x04400001  1 N/A אתר שלי - Chromium',
    '0x05000002  0 my-host',
    '',
  ].join('\n');
  const runFn = fakeRun([
    [(c, a) => c === 'sh' && a[2] === 'wmctrl', {}],
    [(c, a) => c === 'wmctrl' && a[0] === '-l', { stdout }],
  ]);
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  assert.deepEqual(a.snapshot(), {
    ok: true,
    windows: [
      { process: '', title: 'My Site — Mozilla Firefox' },
      { process: '', title: 'Desktop' },
      { process: '', title: 'אתר שלי - Chromium' },
    ],
  });
});

test('linux wmctrl failure is matched null "wmctrl could not list windows"', async () => {
  const runFn = linuxFake({ frames: [{ status: 1, stderr: 'Cannot open display.' }] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  assert.deepEqual(await a.watchWindows({ tokens: ['x'], timeoutMs: 1000 }).result, { matched: null, reason: 'wmctrl could not list windows' });
  assert.deepEqual(a.snapshot(), { ok: false, error: 'wmctrl could not list windows' });
});

test('linux falls back to xdotool when wmctrl is missing', () => {
  const names = { 111: 'My Site - Google Chrome', 222: '', 333: 'Files' };
  const runFn = fakeRun([
    [(c, a) => c === 'sh' && a[2] === 'xdotool', {}],
    [(c, a) => c === 'xdotool' && a[0] === 'search', { stdout: '111\n222\n333\n' }],
    [(c, a) => c === 'xdotool' && a[0] === 'getwindowname', (c, a) => ({ stdout: `${names[a[1]]}\n` })],
  ]);
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  assert.deepEqual(a.snapshot(), { ok: true, windows: [{ process: '', title: 'My Site - Google Chrome' }, { process: '', title: 'Files' }] });
  assert.deepEqual(runFn.calls.find((c) => c.cmd === 'xdotool').args, ['search', '--onlyvisible', '--name', '.+']);
});

test('linux xdotool with no windows gives an empty list, not an error', () => {
  const runFn = fakeRun([
    [(c, a) => c === 'sh' && a[2] === 'xdotool', {}],
    [(c, a) => c === 'xdotool' && a[0] === 'search', { status: 1, stdout: '' }],
  ]);
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  assert.deepEqual(a.snapshot(), { ok: true, windows: [] });
});

/** runFn for Linux with only xdotool installed; `search` answers each frame in turn (a raw result). */
const xdotoolFake = (...frames) => {
  const next = seq(frames);
  return fakeRun([
    [(c, a) => c === 'sh' && a[2] === 'xdotool', {}],
    [(c, a) => c === 'xdotool' && a[0] === 'search', () => next()],
    [(c, a) => c === 'xdotool' && a[0] === 'getwindowname', (c, a) => ({ stdout: `Window ${a[1]}\n` })],
  ]);
};

test('linux xdotool that cannot list windows is "cannot verify" (titles null), never "no windows"', async (t) => {
  const cases = [
    ["Can't open display", { status: 1, stderr: "Error: Can't open display: (null)\nFailed creating new xdo instance\n" }, /^xdotool cannot open the display/],
    ['another exit code with a message', { status: 2, stderr: 'xdo_search_windows: BadAccess\n' }, /^xdotool could not list windows \(exit 2\): xdo_search_windows: BadAccess$/],
    ['exit 1 with a message', { status: 1, stderr: 'XGetWindowProperty failed\n' }, /^xdotool could not list windows \(exit 1\): XGetWindowProperty failed$/],
    ['a timeout', { status: null, error: 'spawnSync xdotool ETIMEDOUT' }, /^xdotool could not list windows: spawnSync xdotool ETIMEDOUT$/],
    ['killed without a message', { status: null }, /^xdotool could not list windows \(exit null\)$/],
  ];
  for (const [label, frame, reason] of cases) {
    await t.test(label, async () => {
      const a = createLinuxAdapter({ runFn: xdotoolFake(frame), spawnFn: fakeSpawn(), env: X11 });
      const snap = a.snapshot();
      assert.equal(snap.ok, false, JSON.stringify(snap));
      assert.match(snap.error, reason);
      const t0 = Date.now();
      const res = await a.watchWindows({ tokens: ['My Site'], timeoutMs: 5000 }).result;
      assert.equal(res.matched, null, JSON.stringify(res));
      assert.match(res.reason, reason);
      assert.ok(Date.now() - t0 < 2000, 'answered at once, not after the 5 s timeout');
    });
  }
  await t.test('failing mid-poll is matched null too, not a miss', async () => {
    const a = createLinuxAdapter({ runFn: xdotoolFake({ stdout: '11\n' }, { status: 1, stderr: "Error: Can't open display: :0\n" }), spawnFn: fakeSpawn(), env: X11 });
    const res = await a.watchWindows({ tokens: ['My Site'], timeoutMs: 3000 }).result;
    assert.equal(res.matched, null, JSON.stringify(res));
    assert.match(res.reason, /cannot open the display/);
  });
  await t.test('a silent exit 1 stays "no windows": the watch runs to its timeout and misses', async () => {
    const a = createLinuxAdapter({ runFn: xdotoolFake({ status: 1 }), spawnFn: fakeSpawn(), env: X11 });
    const res = await a.watchWindows({ tokens: ['My Site'], timeoutMs: 400 }).result;
    assert.deepEqual(res, { matched: false, reason: 'no new window matching the target appeared within 400 ms' });
  });
  await t.test('windows listed through xdotool still verify', async () => {
    const a = createLinuxAdapter({ runFn: xdotoolFake({ stdout: '11\n' }, { stdout: '11\n22\n' }), spawnFn: fakeSpawn(), env: X11 });
    const res = await a.watchWindows({ tokens: ['Window 22'], timeoutMs: 3000 }).result;
    assert.equal(res.matched, true, JSON.stringify(res));
    assert.equal(res.title, 'Window 22');
  });
});

test('linux watchWindows: a new matching window title gives matched true / high', async () => {
  const runFn = linuxFake({ frames: [['Terminal', 'Inbox - Mozilla Firefox'], ['Terminal', 'Inbox - Mozilla Firefox', 'My   Site — Mozilla Firefox']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const w = a.watchWindows({ tokens: ['MY SITE'], timeoutMs: 3000 });
  await w.ready;
  const res = await w.result;
  assert.equal(res.matched, true);
  assert.equal(res.confidence, 'high');
  assert.equal(res.title, 'My Site — Mozilla Firefox');
  assert.ok(res.elapsedMs >= 0 && res.elapsedMs < 3000);
});

test('linux watchWindows: a title already open before gives matched null (cannot tell), never true', async () => {
  const runFn = linuxFake({ frames: [['My Site — Mozilla Firefox']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const res = await a.watchWindows({ tokens: ['My Site'], timeoutMs: 700 }).result;
  assert.deepEqual(res, { matched: null, title: 'My Site — Mozilla Firefox', reason: 'a window with this title was already open before, and no new one appeared within 700 ms, so this open cannot be told apart from it' });
});

test('linux watchWindows: an already-open title wins over the Wayland miss, and is still null', async () => {
  const runFn = linuxFake({ frames: [['My Site — Mozilla Firefox']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' } });
  const res = await a.watchWindows({ tokens: ['My Site'], timeoutMs: 700 }).result;
  assert.equal(res.matched, null);
  assert.match(res.reason, /already open before/);
  const miss = await createLinuxAdapter({ runFn: linuxFake({ frames: [['Terminal']] }), spawnFn: fakeSpawn(), env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' } })
    .watchWindows({ tokens: ['My Site'], timeoutMs: 700 }).result;
  assert.deepEqual(miss, { matched: null, reason: 'under Wayland only X11 windows are visible, so a native window cannot be confirmed' });
});

test('linux watchWindows: a counter ticking in the window that already showed the title is still null', async () => {
  const runFn = linuxFake({ frames: [['(1) My Site — Mozilla Firefox'], ['(2) My Site — Mozilla Firefox']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const res = await a.watchWindows({ tokens: ['My Site'], timeoutMs: 700 }).result;
  assert.equal(res.matched, null, JSON.stringify(res));
});

test('linux watchWindows: a second window with an already-open title is new: matched true / high', async () => {
  const runFn = linuxFake({ frames: [['My Site — Mozilla Firefox'], ['My Site — Mozilla Firefox', 'My Site — Mozilla Firefox']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const res = await a.watchWindows({ tokens: ['My Site'], timeoutMs: 3000 }).result;
  assert.equal(res.matched, true, JSON.stringify(res));
  assert.equal(res.confidence, 'high');
});

test('linux watchWindows: an unrelated window changing its title never verifies (matched false)', async () => {
  const runFn = linuxFake({ frames: [['Inbox (1) — Mozilla Firefox'], ['Inbox (2) — Mozilla Firefox'], ['Inbox (3) — Mozilla Firefox', 'Pixel Forge — Mozilla Firefox']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const res = await a.watchWindows({ tokens: ['Example Domain'], timeoutMs: 700 }).result;
  assert.deepEqual(res, { matched: false, reason: 'no new window matching the target appeared within 700 ms' });
});

test('linux watchFolder: a file manager window already on the folder gives matched null, never true', async () => {
  const runFn = linuxFake({ frames: [['My Site — Files']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const res = await a.watchFolder({ dir: '/home/me/My Site', timeoutMs: 700 }).result;
  assert.equal(res.matched, null, JSON.stringify(res));
  assert.match(res.reason, /already open before/);
});

test('linux watchWindows: nothing matching gives matched false after the timeout', async () => {
  const runFn = linuxFake({ frames: [['Terminal'], ['Terminal', 'Files']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const res = await a.watchWindows({ tokens: ['My Site'], timeoutMs: 700 }).result;
  assert.deepEqual(res, { matched: false, reason: 'no new window matching the target appeared within 700 ms' });
});

test('linux watchWindows: the lister failing mid-poll gives matched null', async () => {
  const runFn = linuxFake({ frames: [['Terminal'], { status: 1 }] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const res = await a.watchWindows({ tokens: ['My Site'], timeoutMs: 3000 }).result;
  assert.deepEqual(res, { matched: null, reason: 'wmctrl could not list windows' });
});

test('linux watchWindows and watchFolder: cancel() ends polling at once with matched null "cancelled"', async (t) => {
  for (const method of ['watchWindows', 'watchFolder']) {
    await t.test(method, async () => {
      const runFn = linuxFake({ frames: [['Terminal']] });
      const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
      const w = method === 'watchWindows'
        ? a.watchWindows({ tokens: ['My Site'], timeoutMs: 8000 })
        : a.watchFolder({ dir: '/home/me/My Site', timeoutMs: 8000 });
      await w.ready;
      await sleep(350);
      const t0 = Date.now();
      w.cancel();
      assert.deepEqual(await w.result, { matched: null, reason: 'cancelled', ...(method === 'watchFolder' ? { selectedOk: null } : {}) });
      assert.ok(Date.now() - t0 < 1500, `settled ${Date.now() - t0} ms after cancel, not at the 8 s timeout`);
      const polls = runFn.calls.filter((c) => c.cmd === 'wmctrl').length;
      await sleep(700);
      assert.equal(runFn.calls.filter((c) => c.cmd === 'wmctrl').length, polls, 'no window listing after cancel');
    });
  }
});

test('linux: cancel() beats a Wayland "cannot confirm" verdict, and a settled watcher ignores it', async () => {
  // XWayland: titles are readable, and a miss at the timeout would be matched:null. A cancel
  // must say "cancelled", so the caller knows the open failed rather than "cannot verify".
  const runFn = linuxFake({ frames: [['Terminal']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' } });
  const w = a.watchWindows({ tokens: ['My Site'], timeoutMs: 8000 });
  w.cancel();
  assert.deepEqual(await w.result, { matched: null, reason: 'cancelled' });
  const settled = createLinuxAdapter({ runFn: linuxFake(), spawnFn: fakeSpawn(), env: X11 }).watchWindows({ tokens: [], timeoutMs: 8000 });
  assert.doesNotThrow(() => settled.cancel());
  assert.equal((await settled.result).matched, null);
});

test('linux watchWindows with no usable tokens returns matched null without probing', async () => {
  const runFn = linuxFake();
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  for (const tokens of [[], [' ', ''], undefined]) {
    assert.deepEqual(await a.watchWindows({ tokens, timeoutMs: 100 }).result, { matched: null, reason: 'the page title is not known in advance' });
  }
  assert.equal(runFn.calls.length, 0);
});

test('linux watchFolder looks for the folder name in window titles', async () => {
  const runFn = linuxFake({ frames: [['Terminal'], ['Terminal', 'My Site — Files']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const res = await a.watchFolder({ dir: '/home/me/My Site/', timeoutMs: 3000 }).result;
  assert.equal(res.matched, true);
  assert.equal(res.confidence, 'high');
  assert.equal(res.title, 'My Site — Files');
});

test('linux watchFolder: window titles say nothing about the selection, so every result has selectedOk null', async () => {
  const hit = await createLinuxAdapter({ runFn: linuxFake({ frames: [[], ['out — Files']] }), spawnFn: fakeSpawn(), env: X11 })
    .watchFolder({ dir: '/home/me/out', select: '/home/me/out/a.pdf', timeoutMs: 3000 }).result;
  assert.equal(hit.matched, true, JSON.stringify(hit));
  assert.equal(hit.selectedOk, null, 'a matched window says nothing about the selection');
  const wayland = await createLinuxAdapter({ runFn: linuxFake(), spawnFn: fakeSpawn(), env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' } })
    .watchFolder({ dir: '/home/me/out', select: '/home/me/out/a.pdf', timeoutMs: 400 }).result;
  assert.deepEqual(wayland, { matched: null, reason: 'Wayland does not expose window titles to other programs', selectedOk: null });
  const miss = await createLinuxAdapter({ runFn: linuxFake({ frames: [['Terminal']] }), spawnFn: fakeSpawn(), env: X11 })
    .watchFolder({ dir: '/home/me/out', timeoutMs: 400 }).result;
  assert.deepEqual(miss, { matched: false, reason: 'no new window matching the target appeared within 400 ms', selectedOk: null });
});

test('linux watchAppWindows matches by window title like watchWindows', async () => {
  const runFn = linuxFake({ frames: [[], ['report.pdf — Document Viewer']] });
  const a = createLinuxAdapter({ runFn, spawnFn: fakeSpawn(), env: X11 });
  const res = await a.watchAppWindows({ tokens: ['report.pdf'], processes: ['evince'], timeoutMs: 3000 }).result;
  assert.equal(res.matched, true);
  assert.equal(res.confidence, 'high');
});

// ---------------------------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------------------------

test('ports: the range is 4400-4499', () => {
  assert.equal(ports.PORT_MIN, 4400);
  assert.equal(ports.PORT_MAX, 4499);
});

// Plan commitment 9: the first free port in 4400-4499, and the same folder gets its own port
// (and launch.json entry) back. A recorder for isFree: the ports asked about, in order.
const probeLog = (busy = new Set()) => {
  const tried = [];
  const isFree = async (p) => { tried.push(p); return !busy.has(p); };
  return { tried, isFree };
};

test('ports: pickPort takes 4400 when it is free, and asks about no other port', async () => {
  const { tried, isFree } = probeLog();
  assert.equal(await ports.pickPort({ isFree }), 4400);
  assert.deepEqual(tried, [4400]);
});

test('ports: pickPort counts up from 4400 past busy ports, in order', async () => {
  const { tried, isFree } = probeLog(new Set([4400, 4401, 4403]));
  assert.equal(await ports.pickPort({ isFree }), 4402);
  assert.deepEqual(tried, [4400, 4401, 4402]);
});

test("ports: pickPort gives a folder its own port back when that port is free, asking about it first", async () => {
  const { tried, isFree } = probeLog();
  assert.equal(await ports.pickPort({ prefer: [4457], isFree }), 4457);
  assert.deepEqual(tried, [4457]);
  const single = probeLog();
  assert.equal(await ports.pickPort({ prefer: 4499, isFree: single.isFree }), 4499, 'a single number works too');
  assert.deepEqual(single.tried, [4499]);
});

test("ports: when the folder's own port is busy, the first free port from 4400 is taken, and no port is probed twice", async () => {
  const a = probeLog(new Set([4457]));
  assert.equal(await ports.pickPort({ prefer: [4457], isFree: a.isFree }), 4400);
  assert.deepEqual(a.tried, [4457, 4400]);
  const b = probeLog(new Set([4400, 4401]));
  assert.equal(await ports.pickPort({ prefer: [4400], isFree: b.isFree }), 4402);
  assert.deepEqual(b.tried, [4400, 4401, 4402], '4400 was the remembered port: asked once, not again in the scan');
});

test('ports: of several remembered ports, the first free one wins, in the given order', async () => {
  const { tried, isFree } = probeLog(new Set([4460]));
  assert.equal(await ports.pickPort({ prefer: [4460, 4470, 4480], isFree }), 4470);
  assert.deepEqual(tried, [4460, 4470]);
  const dup = probeLog(new Set([4460]));
  assert.equal(await ports.pickPort({ prefer: [4460, 4460], isFree: dup.isFree }), 4400);
  assert.deepEqual(dup.tried, [4460, 4400], 'a repeated port is asked about once');
});

test('ports: remembered ports outside 4400-4499 or not integers are ignored', async () => {
  for (const prefer of [0, 80, 4399, 4500, 8080, 4450.5, '4450', null, undefined, NaN, [], [3000, 'x', {}]]) {
    const { tried, isFree } = probeLog();
    assert.equal(await ports.pickPort({ prefer, isFree }), 4400, JSON.stringify(prefer));
    assert.deepEqual(tried, [4400], JSON.stringify(prefer));
  }
  assert.equal(ports.inRange(4400), true);
  assert.equal(ports.inRange(4499), true);
  for (const p of [4399, 4500, 4450.5, '4450', null]) assert.equal(ports.inRange(p), false, String(p));
});

test('ports: pickPort returns null when every port is busy, after trying each exactly once', async () => {
  const tried = [];
  const port = await ports.pickPort({ prefer: [4470], isFree: (p) => { tried.push(p); return false; } });
  assert.equal(port, null);
  assert.equal(tried.length, 100);
  assert.equal(new Set(tried).size, 100);
  const expected = [4470];
  for (let p = 4400; p <= 4499; p++) if (p !== 4470) expected.push(p);
  assert.deepEqual(tried, expected);
});

test('ports: pickPort passes over the ports other configurations claim, without probing them', async () => {
  const { tried, isFree } = probeLog(new Set([4402]));
  assert.equal(await ports.pickPort({ taken: new Set([4400, 4401, 4403]), isFree }), 4404);
  assert.deepEqual(tried, [4402, 4404], 'claimed ports are never probed');
  const list = probeLog();
  assert.equal(await ports.pickPort({ taken: [4400], isFree: list.isFree }), 4401, 'an array works too');
  const all = probeLog();
  assert.equal(await ports.pickPort({ taken: new Set(Array.from({ length: 100 }, (_, i) => 4400 + i)), isFree: all.isFree }), null);
  assert.deepEqual(all.tried, [], 'every port claimed: nothing is left, nothing is probed');
});

test("ports: the folder's own remembered port still wins, even when another configuration names it too", async () => {
  const { tried, isFree } = probeLog();
  assert.equal(await ports.pickPort({ prefer: [4457], taken: new Set([4457, 4400]), isFree }), 4457);
  assert.deepEqual(tried, [4457]);
  // Busy: the scan goes on past every claimed port.
  const busy = probeLog(new Set([4457]));
  assert.equal(await ports.pickPort({ prefer: [4457], taken: new Set([4457, 4400]), isFree: busy.isFree }), 4401);
  assert.deepEqual(busy.tried, [4457, 4401]);
});

test("ports: claimedPorts lists every other configuration's port, the user's own entries included, never the folder's own", () => {
  const t = tempDir();
  try {
    const name = 'show-site-abc123';
    mkdirSync(path.join(t.dir, '.claude'), { recursive: true });
    const file = path.join(t.dir, '.claude', 'launch.json');
    assert.deepEqual([...ports.claimedPorts(t.dir, { name })], [], 'no launch.json');
    writeFileSync(file, `﻿${JSON.stringify({
      version: '0.0.1',
      configurations: [
        { name: 'my-api', runtimeExecutable: 'npm', runtimeArgs: ['run', 'api'], port: 4400 },
        { name: 'show-other-000000', runtimeExecutable: 'node', port: 4401 },
        { name: 'show-dev-app-111111', runtimeExecutable: 'node', port: 5173 },
        { runtimeExecutable: 'node', port: 4402 }, // no name: not the folder's own
        { name, runtimeExecutable: 'node', port: 4457 },
        { name: 'strings', port: '4403' }, { name: 'none' }, null, 7, [],
      ],
    })}`);
    assert.deepEqual([...ports.claimedPorts(t.dir, { name })].sort(), [4400, 4401, 4402, 5173]);
    assert.deepEqual([...ports.claimedPorts(t.dir, {})].sort(), [4400, 4401, 4402, 4457, 5173], 'no name: every entry claims its port');
    assert.deepEqual([...ports.claimedPorts(null, { name })], [], 'no working folder');
    writeFileSync(file, '{ // comments\n "configurations": [{ "name": "x", "port": 4400 }] }');
    assert.deepEqual([...ports.claimedPorts(t.dir, { name })], [], 'not strict JSON: nothing is read');
  } finally { t.cleanup(); }
  const unread = ports.claimedPorts('\\\\server\\share\\project', { name: 'show-x', platform: 'win32' });
  assert.deepEqual([...unread], [], 'a working folder on a network path is not read');
});

test("ports: rememberedPorts reads the folder's live registry entry, then its launch.json entry, and nothing else", async () => {
  await withState(async () => {
    const t = tempDir();
    try {
      const root = path.join(t.dir, 'site');
      const other = path.join(t.dir, 'other');
      const cwd = path.join(t.dir, 'project');
      mkdirSync(root, { recursive: true });
      mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      const name = 'show-site-abc123';
      writeFileSync(path.join(cwd, '.claude', 'launch.json'), `﻿${JSON.stringify({
        version: '0.0.1',
        configurations: [
          { name: 'show-other-000000', runtimeExecutable: 'node', port: 4411 },
          { name, runtimeExecutable: 'node', port: 4457 },
          { name, runtimeExecutable: 'node', port: 4458 },
        ],
      })}`);
      registry.register({ kind: 'static', port: 4462, pid: process.pid, root });
      registry.register({ port: 4463, pid: deadPid(), root }); // its process is gone
      registry.register({ port: 4464, pid: process.pid, root: other }); // another folder
      registry.register({ kind: 'dev', port: 4465, pid: process.pid, root }); // a dev server is not a static port
      registry.register({ port: 8080, pid: process.pid, root }); // outside the range
      assert.deepEqual(ports.rememberedPorts(root, { cwd, name }), [
        { port: 4462, source: 'registry' },
        { port: 4457, source: 'launch.json' },
      ], 'the first launch.json entry with that name, as mergeLaunchEntry picks it');
      assert.deepEqual(ports.rememberedPorts(root, { cwd }), [{ port: 4462, source: 'registry' }], 'no name: launch.json is not consulted');
      assert.deepEqual(ports.rememberedPorts(root, { name }), [{ port: 4462, source: 'registry' }], 'no cwd: launch.json is not consulted');
      assert.deepEqual(ports.rememberedPorts(other, { cwd, name: 'show-nope-000000' }), [{ port: 4464, source: 'registry' }]);
      registry.register({ kind: 'static', port: 4457, pid: process.pid, root });
      assert.deepEqual(ports.rememberedPorts(root, { cwd, name }).map((r) => r.port), [4457, 4462], 'a port is listed once, under its first source');
    } finally { t.cleanup(); }
  });
});

test('ports: rememberedPorts ignores a launch.json that is missing, not JSON, or has no usable port', async () => {
  await withState(async () => {
    const t = tempDir();
    try {
      const root = path.join(t.dir, 'site');
      const name = 'show-site-abc123';
      const file = path.join(t.dir, '.claude', 'launch.json');
      assert.deepEqual(ports.rememberedPorts(root, { cwd: t.dir, name }), [], 'no launch.json');
      mkdirSync(path.dirname(file), { recursive: true });
      for (const text of [
        '{ // comments\n "configurations": [] }',
        '[]',
        'null',
        JSON.stringify({ configurations: {} }),
        JSON.stringify({ configurations: [null, 7, [], { name, port: '4457' }] }),
        JSON.stringify({ configurations: [{ name, port: 8080 }] }),
        JSON.stringify({ configurations: [{ name }] }),
      ]) {
        writeFileSync(file, text);
        assert.deepEqual(ports.rememberedPorts(root, { cwd: t.dir, name }), [], text);
      }
    } finally { t.cleanup(); }
  });
});

test('ports: isPortFree is false for a port something is listening on, true once it is released', async () => {
  const port = await freePort();
  const srv = net.createServer((s) => s.destroy());
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', resolve); });
  try {
    assert.equal(await ports.isPortFree(port), false);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
  assert.equal(await ports.isPortFree(port), true);
});

// ---------------------------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------------------------

test('registry: pidAlive is true for this process and false for dead or invalid pids', () => {
  assert.equal(registry.pidAlive(process.pid), true);
  assert.equal(registry.pidAlive(deadPid()), false);
  for (const bad of [0, -1, 1.5, NaN, Infinity, '123', String(process.pid), null, undefined, {}]) {
    assert.equal(registry.pidAlive(bad), false, String(bad));
  }
});

test('registry: register writes <port>.json in the state folder and unregister removes it', async () => {
  await withState(async (state) => {
    const dir = registry.serversDir();
    assert.equal(dir, path.join(state, 'servers'));
    const info = { port: 44123, pid: process.pid, root: path.join(state, 'site'), url: 'http://127.0.0.1:44123/', startedAt: '2026-09-29T00:00:00.000Z' };
    registry.register(info);
    const file = path.join(dir, '44123.json');
    assert.ok(existsSync(file));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), info);
    registry.register({ ...info, pid: 1234 });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 1234, 'same port overwrites');
    registry.unregister(44123);
    assert.equal(existsSync(file), false);
    registry.unregister(44123); // already gone: no throw
    assert.equal(registry.logFileFor(44123), path.join(state, 'server-44123.log'));
  });
});

test('registry: listServers prunes entries whose process is dead', async () => {
  await withState(async () => {
    const d = tempDir();
    const srv = await showLocalServer(d.dir);
    try {
      // The port even answers as show-local for this root: only the dead pid disqualifies it.
      registry.register({ port: srv.port, pid: deadPid(), root: d.dir });
      assert.deepEqual(await registry.listServers(), []);
      assert.equal(existsSync(path.join(registry.serversDir(), `${srv.port}.json`)), false, 'dead entry removed from disk');
    } finally {
      await srv.close();
      d.cleanup();
    }
  });
});

test('registry: listServers prunes stale entries whose port no longer answers', async () => {
  await withState(async () => {
    const port = await freePort();
    registry.register({ port, pid: process.pid, root: os.tmpdir() });
    assert.deepEqual(await registry.listServers(), []);
    assert.deepEqual(readdirSync(registry.serversDir()), []);
  });
});

test('registry: answers() is false for a plain HTTP server that is not show-local', async () => {
  const srv = await httpServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Not us</title>'); });
  try {
    assert.equal(await registry.answers(srv.port), false);
    assert.equal(await registry.answers(srv.port, os.tmpdir()), false);
  } finally {
    await srv.close();
  }
});

test('registry: listServers prunes an entry whose port is held by a foreign HTTP server', async () => {
  await withState(async () => {
    const srv = await httpServer((req, res) => { res.writeHead(200); res.end('hello'); });
    try {
      registry.register({ port: srv.port, pid: process.pid, root: os.tmpdir() });
      assert.deepEqual(await registry.listServers(), []);
      assert.equal(existsSync(path.join(registry.serversDir(), `${srv.port}.json`)), false);
    } finally {
      await srv.close();
    }
  });
});

test('registry: answers() checks the X-Show-Local tag against the root', async () => {
  const a = tempDir();
  const b = tempDir();
  const srv = await showLocalServer(a.dir);
  try {
    assert.equal(await registry.answers(srv.port, a.dir), true);
    assert.equal(await registry.answers(srv.port), true, 'any show-local server when no root is given');
    assert.equal(await registry.answers(srv.port, b.dir), false, 'a show-local server for another folder');
  } finally {
    await srv.close();
    a.cleanup();
    b.cleanup();
  }
});

test('registry: answers() is false when nothing listens on the port', async () => {
  const port = await freePort();
  assert.equal(await registry.answers(port, os.tmpdir()), false);
});

test('registry: listServers keeps live servers sorted by port, prunes the rest, and findServerFor finds by folder', async () => {
  await withState(async () => {
    const a = tempDir();
    const b = tempDir();
    const other = tempDir();
    const sa = await showLocalServer(a.dir);
    const sb = await showLocalServer(b.dir);
    const wrongRoot = await showLocalServer(other.dir);
    try {
      const ea = { port: sa.port, pid: process.pid, root: a.dir, url: `http://127.0.0.1:${sa.port}/` };
      const eb = { port: sb.port, pid: process.pid, root: b.dir, url: `http://127.0.0.1:${sb.port}/` };
      const [first, second] = ea.port < eb.port ? [ea, eb] : [eb, ea];
      registry.register(second);
      registry.register(first);
      const deadPort = await freePort();
      registry.register({ port: deadPort, pid: deadPid(), root: a.dir });
      // Registered for folder a, but the server on that port serves another folder.
      registry.register({ port: wrongRoot.port, pid: process.pid, root: a.dir });

      assert.deepEqual(await registry.listServers(), [first, second]);
      const left = readdirSync(registry.serversDir()).sort();
      assert.deepEqual(left, [`${first.port}.json`, `${second.port}.json`].sort());

      assert.deepEqual(await registry.findServerFor(a.dir), ea);
      assert.deepEqual(await registry.findServerFor(b.dir), eb);
      assert.equal(await registry.findServerFor(other.dir), null);
      const upper = await registry.findServerFor(a.dir.toUpperCase());
      if (process.platform === 'linux') assert.equal(upper, null, 'Linux paths are case-sensitive');
      else assert.deepEqual(upper, ea, 'Windows/macOS paths are case-insensitive');
    } finally {
      await sa.close();
      await sb.close();
      await wrongRoot.close();
      a.cleanup();
      b.cleanup();
      other.cleanup();
    }
  });
});

test('registry: listServers ignores unreadable entries and non-JSON files', async () => {
  await withState(async () => {
    const dir = registry.serversDir();
    writeFileSync(path.join(dir, '4499.json'), '{ not json');
    writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    assert.deepEqual(await registry.listServers(), []);
    assert.ok(existsSync(path.join(dir, 'notes.txt')));
  });
});

test('registry: listServers on a fresh state folder is empty', async () => {
  await withState(async (state) => {
    assert.deepEqual(await registry.listServers(), []);
    assert.ok(existsSync(path.join(state, 'servers')), 'the servers folder is created on demand');
  });
});

// ---------------------------------------------------------------------------------------------
// doctor: read-only checks, every platform through fakes (no port probing, no real registry)
// ---------------------------------------------------------------------------------------------

const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

/** doctor on a fake machine: 100 free ports and no servers unless the test says otherwise. */
function runDoctor(opts) {
  return withState(() => doctor({ cwd: os.tmpdir(), countFreePorts: async () => 100, serversFn: async () => [], ...opts }));
}

const SNAPSHOT_OK = { ok: true, windows: [{ process: 'chrome', title: 'Inbox' }, { process: 'explorer', title: 'Downloads' }] };

/**
 * A Windows machine: the https default and .html open with `exe` (a real temp file, so the
 * "is the browser installed" check passes on any OS), .pdf with Acrobat, .png with a Store
 * app, .mp4 with nothing chosen. The window watcher's snapshot answers `snapshot`.
 * `httpsCommand` is the browser's open command as reg.exe prints it, and `unicode(progId)`
 * what PowerShell reads as Unicode (none: PowerShell is never asked).
 */
function winMachine({ exe, https = 'ChromeHTML', html = https, htmlCommand, httpsCommand = `"${exe}" --single-argument %1`, unicode, snapshot = SNAPSHOT_OK, pngAppName } = {}) {
  const map = {
    [FILE_CHOICE('.pdf')]: 'AcroExch.Document.DC',
    [HKCR_CMD('AcroExch.Document.DC')]: '"C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe" "%1"',
    [FILE_CHOICE('.png')]: PHOTOS_PROGID,
  };
  if (pngAppName) map[APP_KEY(PHOTOS_PROGID)] = pngAppName;
  if (https) { map[URL_CHOICE('https')] = https; map[HKCR_CMD(https)] = httpsCommand; }
  if (html) { map[FILE_CHOICE('.html')] = html; if (htmlCommand) map[HKCR_CMD(html)] = htmlCommand; }
  return regFake(map, [[
    (c, a) => c === 'powershell.exe' && a.includes('-File'),
    () => (snapshot ? { stdout: `${JSON.stringify(snapshot)}\r\n` } : { status: 1, stderr: 'Add-Type : blocked by policy\r\n' }),
  ], ...(unicode ? [unicodeRead(unicode)] : [])]);
}

test('doctor (Windows): a healthy machine is ok, and every check is a read', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = path.join(dir, 'Google', 'Chrome', 'chrome.exe');
    mkdirSync(path.dirname(exe), { recursive: true });
    writeFileSync(exe, '');
    const runFn = winMachine({ exe });
    const r = await runDoctor({ platform: 'win32', runFn, env: {}, cwd: dir });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'ok');
    assert.equal(r.platform, 'win32');
    assert.deepEqual(r.checks.map((c) => c.id), ['node', 'browser', 'html-association', 'app.pdf', 'app.mp4', 'app.png', 'window-titles', 'ports', 'servers', 'launch-json']);
    const c = byId(r);
    assert.equal(c.node.status, 'ok');
    assert.equal(c.browser.status, 'ok');
    assert.equal(c.browser.detail, `Default browser for https: Google Chrome (ChromeHTML) → ${exe}`);
    assert.equal(c['html-association'].status, 'ok');
    assert.match(c['html-association'].detail, /same browser \(Google Chrome\)/);
    assert.deepEqual([c['app.pdf'].status, c['app.mp4'].status, c['app.png'].status], ['ok', 'info', 'ok']);
    assert.match(c['app.pdf'].detail, /\.pdf opens with Adobe Acrobat \(AcroExch\.Document\.DC\)/);
    assert.match(c['app.png'].detail, /a Microsoft Store app/);
    assert.match(c['app.mp4'].detail, /no per-user default app/);
    assert.equal(c['window-titles'].status, 'ok');
    assert.match(c['window-titles'].detail, /\(2 visible windows\)/);
    assert.equal(c.ports.detail, '100 of 100 ports free in 4400-4499.');
    assert.equal(c.servers.detail, 'No show-local servers running.');
    assert.equal(c['launch-json'].status, 'info');
    assert.match(c['launch-json'].detail, /No \.claude\/launch\.json in this folder/);
    for (const check of r.checks) assert.equal('fix' in check, false, `${check.id}: nothing to fix on a healthy machine`);

    // Read-only: registry queries and the watcher in snapshot mode, nothing else.
    for (const call of runFn.calls) {
      if (call.cmd === 'reg') { assert.equal(call.args[0], 'query'); continue; }
      assert.equal(call.cmd, 'powershell.exe');
      assert.deepEqual(call.args, [...PS_ARGS, '-File', WATCHER]);
      assert.equal(call.opts.env.SHOW_LOCAL_MODE, 'snapshot');
    }
    assert.equal(runFn.calls.filter((x) => x.cmd === 'powershell.exe').length, 1);
  } finally { cleanup(); }
});

test('doctor (Windows): a Store app association shows the name the opener uses ("Photos"), with the raw ProgId in parentheses', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = path.join(dir, 'chrome.exe');
    writeFileSync(exe, '');
    const runFn = winMachine({ exe, pngAppName: PHOTOS_APP_NAME });
    const r = await runDoctor({ platform: 'win32', runFn, env: {} });
    const png = byId(r)['app.png'];
    assert.equal(png.status, 'ok');
    assert.equal(png.detail, `.png opens with Photos (${PHOTOS_PROGID})`);
    // The very same registry answers give the opener the same name.
    const opener = createWindowsAdapter({ runFn, spawnFn: fakeSpawn() }).appFor('C:\\pics\\a.png');
    assert.ok(png.detail.startsWith(`.png opens with ${opener.name} (`), `${png.detail} vs ${opener.name}`);
    assert.ok(runFn.calls.filter((c) => c.cmd === 'reg').every((c) => c.args[0] === 'query'), 'still read-only');
  } finally { cleanup(); }
});

test('doctor (Windows): .html in another browser is a warning with a "nothing to do" fix', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = path.join(dir, 'chrome.exe');
    writeFileSync(exe, '');
    const runFn = winMachine({ exe, html: 'MSEdgeHTM', htmlCommand: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1' });
    const r = await runDoctor({ platform: 'win32', runFn, env: {} });
    assert.equal(r.ok, true, 'a warning is not a failure');
    assert.equal(r.status, 'warn');
    const h = byId(r)['html-association'];
    assert.equal(h.status, 'warn');
    assert.match(h.detail, /associated with Microsoft Edge \(MSEdgeHTM\), but https links open in Google Chrome/);
    assert.match(h.fix, /^Nothing to do for show-local/);
  } finally { cleanup(); }
});

test('doctor (Windows): a browser under a non-ASCII user folder is the same browser for .html, though reg.exe garbles its path', async (t) => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = path.join(dir, 'אופק', 'Google', 'Chrome', 'chrome.exe');
    mkdirSync(path.dirname(exe), { recursive: true });
    writeFileSync(exe, '');
    const real = `"${exe}" --single-argument %1`;
    // reg.exe prints in the console code page (cp862): each Hebrew letter comes back as U+FFFD.
    const garbled = real.replace('אופק', '�'.repeat(4));
    let reads = 0;
    const cases = {
      'PowerShell reads both lookups as Unicode': () => real,
      // Both lookups read the same ProgId, so they are the same browser even when only one
      // re-read succeeded and the two paths differ.
      'PowerShell answers the https lookup only': () => (reads++ ? null : real),
    };
    for (const [name, unicode] of Object.entries(cases)) {
      await t.test(name, async () => {
        const runFn = winMachine({ exe, httpsCommand: garbled, unicode });
        const r = await runDoctor({ platform: 'win32', runFn, env: {} });
        const c = byId(r);
        assert.equal(c.browser.detail, `Default browser for https: Google Chrome (ChromeHTML) → ${exe}`);
        assert.equal(c['html-association'].status, 'ok', c['html-association'].detail);
        assert.equal(c['html-association'].detail, '.html files open in the same browser (Google Chrome).');
        assert.equal(r.status, 'ok');
        assert.equal(runFn.calls.filter((x) => x.cmd === 'powershell.exe' && x.opts.env?.SHOW_LOCAL_PROGID).length, 2, 'one Unicode read per garbled lookup');
      });
    }
  } finally { cleanup(); }
});

test('doctor (Windows): a registered browser whose exe is gone fails, with a fix', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const exe = path.join(dir, 'uninstalled', 'chrome.exe');
    const r = await runDoctor({ platform: 'win32', runFn: winMachine({ exe }), env: {} });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'fail');
    const b = byId(r).browser;
    assert.equal(b.status, 'fail');
    assert.ok(b.detail.endsWith(`→ ${exe}`), b.detail);
    assert.match(b.fix, /missing/);
  } finally { cleanup(); }
});

test('doctor (Windows): no https handler is a warning; unreadable window titles fail', async () => {
  const noBrowser = await runDoctor({ platform: 'win32', runFn: winMachine({ https: null, html: null }), env: {} });
  assert.equal(byId(noBrowser).browser.status, 'warn');
  assert.match(byId(noBrowser).browser.fix, /Default apps/);
  assert.equal('html-association' in byId(noBrowser), false, 'no .html choice, no association check');
  assert.equal(noBrowser.status, 'warn');

  const { dir, cleanup } = tempDir();
  try {
    const exe = path.join(dir, 'chrome.exe');
    writeFileSync(exe, '');
    const r = await runDoctor({ platform: 'win32', runFn: winMachine({ exe, snapshot: null }), env: {} });
    const w = byId(r)['window-titles'];
    assert.equal(w.status, 'fail');
    assert.match(w.detail, /Add-Type : blocked by policy/);
    assert.match(w.fix, /ExecutionPolicy Bypass/);
    assert.equal(r.ok, false);
  } finally { cleanup(); }
});

test('doctor (every platform): ports, servers and launch.json come from the injected sources and the given folder', async (t) => {
  const { dir, cleanup } = tempDir();
  try {
    const lj = path.join(dir, '.claude', 'launch.json');
    mkdirSync(path.dirname(lj), { recursive: true });
    const text = '{"version":"0.0.1","configurations":[]}\n';
    writeFileSync(lj, text);
    const servers = async () => [{ port: 4401, root: path.join(dir, 'site') }, { port: 4410, root: path.join(dir, 'docs') }];
    const machines = {
      win32: winMachine({ https: null, html: null }),
      darwin: fakeRun([['osascript', { stdout: '1\n' }]]),
      linux: fakeRun([]),
    };
    for (const [platform, runFn] of Object.entries(machines)) {
      await t.test(platform, async () => {
        const r = await runDoctor({ platform, runFn, env: {}, cwd: dir, countFreePorts: async () => 0, serversFn: servers });
        const c = byId(r);
        assert.equal(c.ports.status, 'fail');
        assert.equal(c.ports.detail, 'No free port in 4400-4499.');
        assert.match(c.ports.fix, /show\.mjs stop all/);
        assert.equal(c.servers.status, 'info');
        assert.equal(c.servers.detail, `2 show-local server(s) running: 4401 → ${path.join(dir, 'site')}; 4410 → ${path.join(dir, 'docs')}`);
        assert.equal(c['launch-json'].detail, `Desktop preview config present: ${lj}`);
        assert.equal(r.ok, false);
        assert.equal(r.status, 'fail');
      });
    }
    assert.equal(readFileSync(lj, 'utf8'), text, 'doctor never writes launch.json');
  } finally { cleanup(); }
});

/** HOME (and USERPROFILE) pointing at a temp home with a LaunchServices plist, for an async fn. */
async function withMacHome(fn) {
  const home = tempDir('show-local-home-');
  try {
    const plist = path.join(home.dir, 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(plist, 'bplist00');
    return await withEnv({ HOME: home.dir, USERPROFILE: home.dir }, fn);
  } finally {
    home.cleanup();
  }
}

test('doctor (macOS): the https handler from LaunchServices; a missing osascript is a warning, not a failure', async () => {
  await withMacHome(async () => {
    const launchServices = { LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.Chrome' }] };
    const good = fakeRun([
      [(c, a) => c === 'osascript' && a.join(' ') === '-e return 1', { stdout: '1\n' }],
      [(c) => c === 'plutil', { stdout: JSON.stringify(launchServices) }],
    ]);
    const r = await runDoctor({ platform: 'darwin', runFn: good, env: {} });
    assert.equal(byId(r).browser.status, 'ok');
    assert.equal(byId(r).browser.detail, 'Default browser for https: Google Chrome (com.google.Chrome)');
    assert.equal(byId(r).osascript.status, 'ok');
    assert.equal(r.status, 'ok');
    assert.deepEqual(good.calls.map((c) => c.cmd), ['plutil', 'osascript'], 'one LaunchServices read, one harmless AppleScript');

    const noOsa = macFake({ bundleId: 'com.apple.Safari' }); // answers no "return 1" script: status 1
    const r2 = await runDoctor({ platform: 'darwin', runFn: noOsa, env: {} });
    assert.equal(byId(r2).browser.detail, 'Default browser for https: Safari (com.apple.Safari)');
    assert.equal(byId(r2).osascript.status, 'warn');
    assert.match(byId(r2).osascript.detail, /will not be verified/);
    assert.equal(r2.ok, true);
    assert.equal(r2.status, 'warn');
  });
});

/** A Linux data folder holding one browser .desktop file; XDG_DATA_* point only there. */
function linuxDataHome(dir) {
  const apps = path.join(dir, 'share', 'applications');
  mkdirSync(apps, { recursive: true });
  writeFileSync(path.join(apps, 'firefox.desktop'), '[Desktop Entry]\nName=Firefox\nExec=firefox %u\n');
  return { XDG_DATA_HOME: path.join(dir, 'share'), XDG_DATA_DIRS: path.join(dir, 'no-such-dir') };
}

test('doctor (Linux): default browser from xdg-settings and its .desktop file; titles through wmctrl', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const env = { ...X11, ...linuxDataHome(dir) };
    const runFn = linuxFake({ lister: 'wmctrl', extra: [[(c, a) => c === 'xdg-settings' && a.join(' ') === 'get default-web-browser', { stdout: 'firefox.desktop\n' }]] });
    const r = await runDoctor({ platform: 'linux', runFn, env });
    const c = byId(r);
    assert.equal(c.browser.status, 'ok');
    assert.equal(c.browser.detail, 'Default browser: Firefox (firefox.desktop)');
    assert.equal(c['window-titles'].status, 'ok');
    assert.equal(c['window-titles'].detail, 'Window titles readable through wmctrl.');
    assert.equal(r.status, 'ok');
    // Probing for a lister passes the program name as $0, never inside the script text.
    for (const call of runFn.calls.filter((x) => x.cmd === 'sh')) assert.deepEqual(call.args.slice(0, 2), ['-c', 'command -v "$0"']);
    assert.ok(runFn.calls.every((x) => ['xdg-settings', 'sh'].includes(x.cmd)), runFn.calls.map((x) => x.cmd).join(','));
  } finally { cleanup(); }
});

test('doctor (Linux): no default browser, a missing .desktop file, Wayland and no window lister are warnings with fixes', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const data = linuxDataHome(dir);
    const none = await runDoctor({ platform: 'linux', runFn: fakeRun([]), env: { ...X11, ...data } });
    assert.equal(byId(none).browser.status, 'warn');
    assert.match(byId(none).browser.detail, /xdg-settings did not report a default browser/);
    assert.match(byId(none).browser.fix, /xdg-settings set default-web-browser/);
    assert.equal(byId(none)['window-titles'].status, 'warn');
    assert.match(byId(none)['window-titles'].fix, /Install wmctrl/);
    assert.equal(none.ok, true);
    assert.equal(none.status, 'warn');

    const ghost = fakeRun([[(c) => c === 'xdg-settings', { stdout: 'show-local-no-such-browser.desktop\n' }]]);
    const r = await runDoctor({ platform: 'linux', runFn: ghost, env: { ...X11, ...data } });
    assert.match(byId(r).browser.detail, /show-local-no-such-browser\.desktop found, but its \.desktop file was not/);

    const wayland = await runDoctor({ platform: 'linux', runFn: linuxFake({ lister: 'wmctrl' }), env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', ...data } });
    const w = byId(wayland)['window-titles'];
    assert.equal(w.status, 'warn');
    assert.match(w.detail, /^Wayland session: native windows hide their titles, so a missing match is reported as "cannot verify"/);
    const xwayland = await runDoctor({ platform: 'linux', runFn: linuxFake({ lister: 'xdotool' }), env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', ...data } });
    assert.match(byId(xwayland)['window-titles'].detail, /\(xdotool sees only X11\/XWayland windows\)/);
  } finally { cleanup(); }
});

test('doctor (Linux): a compositor started from a console login, with XWayland, is a Wayland session, not "titles readable"', async (t) => {
  const { dir, cleanup } = tempDir();
  try {
    const data = linuxDataHome(dir);
    for (const session of [{ XDG_SESSION_TYPE: 'tty' }, {}]) {
      await t.test(session.XDG_SESSION_TYPE ? 'XDG_SESSION_TYPE=tty' : 'XDG_SESSION_TYPE unset', async () => {
        const r = await runDoctor({ platform: 'linux', runFn: linuxFake({ lister: 'wmctrl' }), env: { ...session, WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0', ...data } });
        const w = byId(r)['window-titles'];
        assert.equal(w.status, 'warn', w.detail);
        assert.match(w.detail, /^Wayland session: native windows hide their titles \(wmctrl sees only X11\/XWayland windows\), so a missing match is reported as "cannot verify"/);
      });
    }
  } finally { cleanup(); }
});
