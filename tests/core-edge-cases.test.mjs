// The core libraries and the Windows watcher, on the cases that are easy to get wrong: the
// static server judges a file by its real long path, so 8.3 names and links never reach .env or
// .git; a local https dev server with a self-signed certificate counts as up; the response byte
// cap holds; the state folder survives an unusable or planted candidate; a slow live server
// keeps its registry entry; Chromium's windows are matched by chrome.exe; and the watcher's
// decisions (new window, changed title, new Explorer tab, selection) run on scripted window
// lists. Nothing here opens a window or a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fakeRun, freePort, lib, SCRIPTS, tempDir } from './helpers.mjs';

const { createStaticServer, listen, rootTag, servableReal } = await import(lib('server.mjs'));
const { httpRequest, requestOptions, stateDir } = await import(lib('util.mjs'));
const registry = await import(lib('registry.mjs'));
const { browserName, resolveWindowsBrowser } = await import(lib('browser.mjs'));

const onWindows = process.platform === 'win32';
const posix = typeof process.getuid === 'function';
const UID = posix ? process.getuid() : null;
const STATE_NAME = UID === null ? 'show-local' : `show-local-${UID}`;

// ---------------------------------------------------------------------------------------------
// helpers

function put(file, content = 'x') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** A temp folder for a served site. Windows may hold a just-served file open for a moment. */
function siteDir() {
  const { dir } = tempDir('show-local-srv-');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

/** A symlink (a junction for folders on Windows); false when this system does not allow it. */
function link(target, at, type = 'file') {
  try { symlinkSync(target, at, type); return true; } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EINVAL'].includes(e?.code)) return false;
    throw e;
  }
}

/** A raw request with no client-side interpretation. */
function request(port, target, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A show-local static server on a free port for `root`; always closed afterwards. */
async function serving(root, fn) {
  const port = await freePort();
  const server = createStaticServer({ root, port, echo: false });
  await listen(server, port);
  try { return await fn(port); } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

/** Listen on 127.0.0.1 and an ephemeral port the OS picks; resolves with the port. */
function listenAny(srv) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

async function closing(srv) {
  srv.closeAllConnections?.();
  await new Promise((resolve) => srv.close(() => resolve()));
}

/** A TCP server that takes connections and never answers: a live server that is too slow. */
function silentServer() {
  const held = [];
  const srv = net.createServer((s) => { held.push(s); });
  srv.stop = () => { for (const s of held) s.destroy(); return closing(srv); };
  return srv;
}

/** Point the state folder (registry, logs) at a fresh temp folder for the length of fn. */
async function withState(fn) {
  const t = tempDir('show-local-state-');
  const vars = { TEMP: t.dir, TMP: t.dir, TMPDIR: t.dir, XDG_RUNTIME_DIR: '' };
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(t.dir); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
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

// A self-signed certificate made here, so no private key lives in the repository and no
// openssl is needed: a minimal X.509 v1 certificate in DER, signed with ECDSA P-256.
function selfSigned(cn = 'localhost') {
  const der = (tag, ...parts) => {
    const body = Buffer.concat(parts);
    const n = body.length;
    const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
    return Buffer.concat([Buffer.from([tag, ...len]), body]);
  };
  const seq = (...p) => der(0x30, ...p);
  const oid = (hex) => der(0x06, Buffer.from(hex, 'hex'));
  const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from(cn)))));
  const time = (s) => der(0x17, Buffer.from(s, 'ascii'));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const alg = seq(oid('2a8648ce3d040302')); // ecdsa-with-SHA256
  const tbs = seq(der(0x02, Buffer.from([1])), alg, name, seq(time('250101000000Z'), time('491231235959Z')), name,
    publicKey.export({ type: 'spki', format: 'der' }));
  const cert = seq(tbs, alg, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem };
}

/** Does this volume make 8.3 short names? Only then can /ENV~1 reach .env at all. */
function shortNamesHere() {
  if (!onWindows) return false;
  const t = tempDir('show-local-83-');
  try {
    writeFileSync(path.join(t.dir, '.env'), 'x');
    return existsSync(path.join(t.dir, 'ENV~1'));
  } finally { t.cleanup(); }
}
const SHORT_NAMES = shortNamesHere();

// ---------------------------------------------------------------------------------------------
// server: what the request reaches on disk decides, not how it is spelled

test('servableReal: inside the folder and no dotfile anywhere in the resolved path', () => {
  const R = path.join(os.tmpdir(), 'r2-site'); // pure: never touches the disk
  for (const p of [R, path.join(R, 'index.html'), path.join(R, 'a', 'b.txt'), path.join(R, '.well-known', 'security.txt')]) {
    assert.equal(servableReal(R, p), true, p);
  }
  for (const p of [
    path.join(R, '.env'), path.join(R, '.git', 'config'), path.join(R, 'sub', '.ssh', 'id_rsa'),
    path.join(R, '..notes.txt'), path.join(R, '.well-known2', 'x'), path.join(R, 'a', '.well-known', '..', '.env'),
  ]) {
    assert.equal(servableReal(R, p), false, p);
  }
  for (const p of [path.dirname(R), path.join(R, '..', 'other', 'x.txt'), path.join(os.tmpdir(), 'r2-site-2', 'x')]) {
    assert.equal(servableReal(R, p), false, `outside: ${p}`);
  }
});

test('servableReal: short-name lookalikes are refused only where names could not be expanded', () => {
  const R = path.join(os.tmpdir(), 'r2-site');
  const short = path.join(R, 'ENV~1');
  assert.equal(servableReal(R, short, { platform: 'win32', expanded: false }), false);
  assert.equal(servableReal(R, path.join(R, 'GIT~1', 'config'), { platform: 'win32', expanded: false }), false);
  // Expanded, ENV~1 is a real long name (a file that is literally called that).
  assert.equal(servableReal(R, short, { platform: 'win32', expanded: true }), true);
  assert.equal(servableReal(R, short, { platform: 'linux', expanded: false }), true);
});

test('GET: 8.3 short names (/ENV~1, /GIT~1/config) never reach .env or .git', { skip: !SHORT_NAMES && 'this volume makes no 8.3 short names' }, async () => {
  const { dir, cleanup } = siteDir();
  try {
    put(path.join(dir, 'index.html'), '<title>site</title>');
    put(path.join(dir, '.env'), 'TOKEN=supersecret');
    put(path.join(dir, '.git', 'config'), '[remote "origin"] url = https://token@example.invalid/x');
    assert.ok(existsSync(path.join(dir, 'ENV~1')) && existsSync(path.join(dir, 'GIT~1', 'config')), 'fixture has short names');
    await serving(dir, async (port) => {
      for (const p of ['/ENV~1', '/env~1', '/GIT~1/config', '/git~1/CONFIG', '/GIT~1', '/GIT~1/']) {
        const r = await request(port, p);
        assert.equal(r.status, 403, `${p} -> ${r.status}`);
        assert.ok(!r.text.includes('supersecret') && !r.text.includes('token@'), p);
        assert.equal(r.headers.location, undefined, `${p} must not even redirect`);
      }
      // Win32 would drop a trailing dot or space; Node's file calls do not, so these are 404.
      for (const p of ['/ENV~1.', '/ENV~1%20']) {
        const r = await request(port, p);
        assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
        assert.ok(!r.text.includes('supersecret'), p);
      }
      assert.equal((await request(port, '/ENV~1', { method: 'HEAD' })).status, 403);
      assert.equal((await request(port, '/ENV~1', { headers: { Range: 'bytes=0-4' } })).status, 403);
      const ok = await request(port, '/index.html');
      assert.equal(ok.status, 200);
      assert.equal(ok.text, '<title>site</title>');
    });
  } finally { cleanup(); }
});

test('GET: a folder link inside the root that leads to .git is refused (and not redirected)', async (t) => {
  const { dir, cleanup } = siteDir();
  try {
    put(path.join(dir, 'index.html'), 'home');
    put(path.join(dir, '.git', 'config'), '[core] secret-ish');
    if (!link(path.join(dir, '.git'), path.join(dir, 'gitlink'), 'junction')) { t.skip('cannot create folder links here'); return; }
    await serving(dir, async (port) => {
      for (const p of ['/gitlink/config', '/gitlink', '/gitlink/']) {
        const r = await request(port, p);
        assert.equal(r.status, 403, `${p} -> ${r.status}`);
        assert.ok(!r.text.includes('secret-ish'), p);
      }
      assert.equal((await request(port, '/')).status, 200);
    });
  } finally { cleanup(); }
});

test('GET: a file link to .env, or an index.html that is one, is refused', async (t) => {
  const { dir, cleanup } = siteDir();
  try {
    put(path.join(dir, '.env'), 'TOKEN=supersecret');
    put(path.join(dir, 'page.html'), 'PAGE');
    mkdirSync(path.join(dir, 'docs'));
    if (!link(path.join(dir, '.env'), path.join(dir, 'link.txt'))) { t.skip('cannot create file links here'); return; }
    link(path.join(dir, '.env'), path.join(dir, 'docs', 'index.html'));
    link(path.join(dir, 'page.html'), path.join(dir, 'alias.html'));
    await serving(dir, async (port) => {
      for (const p of ['/link.txt', '/docs/', '/docs/index.html']) {
        const r = await request(port, p);
        assert.equal(r.status, 403, `${p} -> ${r.status}`);
        assert.ok(!r.text.includes('supersecret'), p);
      }
      const alias = await request(port, '/alias.html');
      assert.equal(alias.status, 200, 'a link to an ordinary file inside the folder is still served');
      assert.equal(alias.text, 'PAGE');
    });
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// util.httpRequest

test('httpRequest: a loopback https server with a self-signed certificate counts as up', async () => {
  const srv = https.createServer(selfSigned(), (q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end('<title>TLS dev</title>'); });
  const port = await listenAny(srv);
  try {
    for (const url of [`https://127.0.0.1:${port}/`, `https://my-app.localhost:${port}/`]) {
      const r = await httpRequest(url);
      assert.equal(r.ok, true, `${url}: ${r.error}`);
      assert.equal(r.status, 200);
      assert.equal(r.body, '<title>TLS dev</title>');
    }
  } finally { await closing(srv); }
});

test('requestOptions: only loopback https skips certificate checks; every other host keeps them', () => {
  for (const url of ['https://127.0.0.1:5173/', 'https://127.1.2.3/', 'https://localhost:3000/', 'https://[::1]:8443/', 'https://app.localhost/', 'https://0.0.0.0:3000/']) {
    assert.equal(requestOptions(new URL(url)).rejectUnauthorized, false, url);
  }
  for (const url of ['https://example.com/', 'https://10.0.0.1/', 'https://localhost.evil.com/', 'https://128.0.0.1/', 'http://127.0.0.1:5173/']) {
    const o = requestOptions(new URL(url));
    assert.equal(o.rejectUnauthorized, undefined, `${url} keeps Node's default verification`);
  }
  const o = requestOptions(new URL('https://app.localhost:4400/'), { method: 'HEAD', timeoutMs: 800 });
  assert.equal(o.method, 'HEAD');
  assert.equal(o.timeout, 800);
  assert.equal(o.headers['user-agent'], 'show-local');
  assert.equal(typeof o.lookup, 'function', '*.localhost still resolves to loopback');
});

test('requestOptions: every request accepts text/html as a browser loading a page does (an SPA history fallback needs it)', () => {
  for (const url of ['http://127.0.0.1:3000/dashboard', 'https://example.com/', 'https://app.localhost/']) {
    const accept = requestOptions(new URL(url)).headers.accept;
    assert.equal(typeof accept, 'string', url);
    assert.ok(accept.split(',')[0] === 'text/html' && accept.includes('*/*'), `${url}: ${accept}`);
  }
});

test('httpRequest: the byte cap stops an endless body long before the deadline', async () => {
  const chunk = Buffer.alloc(65536, 0x61);
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'text/plain' });
    const t = setInterval(() => { if (!r.destroyed) r.write(chunk); }, 2);
    r.on('close', () => clearInterval(t));
  });
  const port = await listenAny(srv);
  try {
    const t0 = Date.now();
    const r = await httpRequest(`http://127.0.0.1:${port}/`, { maxBytes: 100000, timeoutMs: 5000 });
    const ms = Date.now() - t0;
    assert.equal(r.ok, true, r.error);
    assert.equal(r.status, 200);
    assert.ok(r.body.length >= 100000, `read ${r.body.length} bytes`);
    assert.ok(r.body.length < 100000 + chunk.length, `stopped at the cap, read ${r.body.length} bytes`);
    assert.ok(ms < 2500, `returned after ${ms} ms, not at the 5000 ms deadline`);
  } finally { await closing(srv); }
});

// ---------------------------------------------------------------------------------------------
// util.stateDir

test('stateDir: an unusable XDG_RUNTIME_DIR falls back instead of failing', () => {
  const { dir, cleanup } = tempDir('show-local-state-');
  try {
    const blocker = put(path.join(dir, 'not-a-folder'));
    const opts = { platform: 'linux', tmpdir: path.join(dir, 'tmp'), home: path.join(dir, 'home'), uid: UID };
    // Another user's /run/user/<uid>, or a file in the way: mkdir fails, the temp folder is used.
    assert.equal(stateDir({ ...opts, env: { XDG_RUNTIME_DIR: path.join(blocker, 'run') } }), path.join(dir, 'tmp', STATE_NAME));
    // A usable one is still preferred, and a relative one is ignored.
    assert.equal(stateDir({ ...opts, env: { XDG_RUNTIME_DIR: path.join(dir, 'xdg') } }), path.join(dir, 'xdg', STATE_NAME));
    assert.equal(stateDir({ ...opts, env: { XDG_RUNTIME_DIR: 'relative/run' } }), path.join(dir, 'tmp', STATE_NAME));
    // XDG_RUNTIME_DIR is a Linux convention only.
    assert.equal(stateDir({ ...opts, platform: 'darwin', env: { XDG_RUNTIME_DIR: path.join(dir, 'xdg') } }), path.join(dir, 'tmp', STATE_NAME));
  } finally { cleanup(); }
});

test('stateDir: a file squatting on the temp folder sends it to ~/.cache/show-local', () => {
  const { dir, cleanup } = tempDir('show-local-state-');
  try {
    put(path.join(dir, 'tmp', STATE_NAME), 'squatter');
    const got = stateDir({ platform: 'linux', env: {}, tmpdir: path.join(dir, 'tmp'), home: path.join(dir, 'home'), uid: UID });
    assert.equal(got, path.join(dir, 'home', '.cache', 'show-local'));
    assert.ok(lstatSync(got).isDirectory());
  } finally { cleanup(); }
});

test('stateDir: with every candidate unusable, a fresh private folder, the same one each call', () => {
  const { dir, cleanup } = tempDir('show-local-state-');
  try {
    const tmp = path.join(dir, 'tmp');
    put(path.join(tmp, STATE_NAME), 'squatter');
    const home = put(path.join(dir, 'home-is-a-file')); // so ~/.cache cannot be made
    const opts = { platform: 'linux', env: {}, tmpdir: tmp, home, uid: UID };
    const got = stateDir(opts);
    assert.equal(path.dirname(got), tmp);
    assert.match(path.basename(got), /^show-local-/);
    assert.notEqual(got, path.join(tmp, STATE_NAME));
    assert.ok(lstatSync(got).isDirectory());
    if (posix) assert.equal(statSync(got).mode & 0o077, 0, 'mkdtemp folders are 0700');
    assert.equal(stateDir(opts), got, 'reused within the process, so the registry stays in one place');
  } finally { cleanup(); }
});

test('stateDir: a symlink planted at /tmp/show-local-<uid> is refused, not followed', { skip: !posix && 'POSIX ownership and symlinks' }, () => {
  const { dir, cleanup } = tempDir('show-local-state-');
  try {
    const tmp = path.join(dir, 'tmp');
    const victim = path.join(dir, 'victim-private');
    mkdirSync(victim, { mode: 0o700 });
    mkdirSync(tmp);
    symlinkSync(victim, path.join(tmp, STATE_NAME));
    const got = stateDir({ platform: 'linux', env: {}, tmpdir: tmp, home: path.join(dir, 'home'), uid: UID });
    assert.equal(got, path.join(dir, 'home', '.cache', 'show-local'));
    assert.ok(lstatSync(path.join(tmp, STATE_NAME)).isSymbolicLink(), 'the link is left alone');
  } finally { cleanup(); }
});

test('stateDir: an existing ~/.cache/show-local open to others is closed to 0700 before use', { skip: !posix && 'POSIX modes' }, () => {
  const { dir, cleanup } = tempDir('show-local-state-');
  try {
    const tmp = path.join(dir, 'tmp');
    put(path.join(tmp, STATE_NAME), 'squatter');
    const cache = path.join(dir, 'home', '.cache', 'show-local');
    mkdirSync(cache, { recursive: true });
    chmodSync(cache, 0o755);
    const got = stateDir({ platform: 'linux', env: {}, tmpdir: tmp, home: path.join(dir, 'home'), uid: UID });
    assert.equal(got, cache);
    assert.equal(statSync(cache).mode & 0o777, 0o700);
  } finally { cleanup(); }
});

test('stateDir: a folder others can write is never used, not even after a chmod', { skip: !posix && 'POSIX modes' }, () => {
  const { dir, cleanup } = tempDir('show-local-state-');
  try {
    const tmp = path.join(dir, 'tmp');
    const open = path.join(tmp, STATE_NAME);
    mkdirSync(open, { recursive: true });
    chmodSync(open, 0o777);
    const got = stateDir({ platform: 'linux', env: {}, tmpdir: tmp, home: path.join(dir, 'home'), uid: UID });
    assert.equal(got, path.join(dir, 'home', '.cache', 'show-local'));
    assert.equal(statSync(open).mode & 0o777, 0o777, 'left as it was: others may already have planted links in it');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// registry: a slow live server keeps its entry

test('registry.probe: ours, silent (no answer in time) and other (refused or foreign)', async () => {
  const a = tempDir();
  const b = tempDir();
  const ours = http.createServer((q, r) => { r.writeHead(200, { 'X-Show-Local': rootTag(a.dir) }); r.end(); });
  const foreign = http.createServer((q, r) => { r.writeHead(200); r.end('hello'); });
  const silent = silentServer();
  const p1 = await listenAny(ours);
  const p2 = await listenAny(foreign);
  const p3 = await listenAny(silent);
  const p4 = await freePort(); // taken after the others listen, so it is none of theirs
  try {
    assert.equal(await registry.probe(p1, a.dir), 'ours');
    assert.equal(await registry.probe(p1), 'ours', 'any show-local server when no root is given');
    assert.equal(await registry.probe(p1, b.dir), 'other', 'a show-local server for another folder');
    assert.equal(await registry.probe(p2, a.dir), 'other');
    assert.equal(await registry.probe(p3, a.dir), 'silent');
    assert.equal(await registry.probe(p4, a.dir), 'other', 'nothing listens');
    assert.equal(await registry.answers(p1, a.dir), true);
    assert.equal(await registry.answers(p3, a.dir), false);
  } finally {
    await silent.stop();
    await closing(ours);
    await closing(foreign);
    a.cleanup();
    b.cleanup();
  }
});

test('listServers: a live server that is slow to answer stays registered, listed with responding:false', async () => {
  await withState(async () => {
    const site = tempDir();
    const silent = silentServer();
    const port = await listenAny(silent);
    try {
      const entry = { port, pid: process.pid, root: site.dir, url: `http://127.0.0.1:${port}/` };
      registry.register(entry);
      assert.deepEqual(await registry.listServers(), [{ ...entry, responding: false }]);
      assert.ok(existsSync(path.join(registry.serversDir(), `${port}.json`)), 'the entry survives, so stop can still find it');
      assert.deepEqual(JSON.parse(readFileSync(path.join(registry.serversDir(), `${port}.json`), 'utf8')), entry, 'the file itself is not rewritten');
      assert.equal(await registry.findServerFor(site.dir), null, 'a server that does not answer is never reused');
    } finally {
      await silent.stop();
      site.cleanup();
    }
  });
});

test('listServers: a dead pid is still pruned, however its port behaves', async () => {
  await withState(async () => {
    const silent = silentServer();
    const port = await listenAny(silent);
    try {
      registry.register({ port, pid: deadPid(), root: os.tmpdir() });
      assert.deepEqual(await registry.listServers(), []);
      assert.equal(existsSync(path.join(registry.serversDir(), `${port}.json`)), false);
    } finally {
      await silent.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// browser: the process that owns the windows

test('browserName: Chromium installs chrome.exe, so its windows are matched as chrome', () => {
  assert.deepEqual(browserName(String.raw`C:\Users\Dana\AppData\Local\Chromium\Application\chrome.exe`), { name: 'Chromium', process: 'chrome' });
  assert.deepEqual(browserName(String.raw`C:\Program Files\ungoogled-chromium\chrome.exe`), { name: 'Chromium', process: 'chrome' });
  assert.deepEqual(browserName('C:/Users/Dana/AppData/Local/Chromium/Application/chrome.exe'), { name: 'Chromium', process: 'chrome' });
  // A launcher stub names no program: Opera's windows belong to opera.exe.
  assert.deepEqual(browserName(String.raw`C:\Users\Dana\AppData\Local\Programs\Opera\launcher.exe`), { name: 'Opera', process: 'opera' });
  // Unchanged: ids and the other browsers.
  assert.deepEqual(browserName('chromium.desktop'), { name: 'Chromium', process: 'chromium' });
  assert.deepEqual(browserName(String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`), { name: 'Google Chrome', process: 'chrome' });
  assert.deepEqual(browserName(String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`), { name: 'Microsoft Edge', process: 'msedge' });
  // A Windows path is read as one on every platform.
  assert.deepEqual(browserName(String.raw`C:\Tools\My Viewer\MyViewer.exe`), { name: 'MyViewer', process: 'myviewer' });
});

test('resolveWindowsBrowser: a Chromium default browser watches chrome windows', () => {
  const exe = String.raw`C:\Users\Dana\AppData\Local\Chromium\Application\chrome.exe`;
  const runFn = fakeRun([
    [(cmd, args) => cmd === 'reg' && /\\https\\UserChoice$/.test(args[1]), { stdout: '\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    ChromiumHTM.ABC123\r\n' }],
    [(cmd, args) => cmd === 'reg' && args[1] === 'HKCR\\ChromiumHTM.ABC123\\shell\\open\\command', { stdout: `\r\nHKEY_CLASSES_ROOT\\ChromiumHTM.ABC123\\shell\\open\\command\r\n    (Default)    REG_SZ    "${exe}" --single-argument %1\r\n` }],
  ]);
  const b = resolveWindowsBrowser(runFn, () => true);
  assert.equal(b.exe, exe);
  assert.equal(b.name, 'Chromium');
  assert.equal(b.process, 'chrome');
});

// ---------------------------------------------------------------------------------------------
// windows.ps1: the decision loops, fed scripted window lists

const WATCHER = path.join(SCRIPTS, 'win', 'windows.ps1');

// Dot-sources the watcher (which then only defines its functions) and runs each case through
// Watch-Window or Watch-Explorer. Every poll takes the next scripted list; the last one repeats.
// "{i}" in a title becomes the poll number, for a title that never settles. Input arrives in
// environment variables only.
const DRIVER = [
  "$ErrorActionPreference = 'Stop'",
  '. $env:SHOW_LOCAL_TEST_WATCHER',
  '$cases = $env:SHOW_LOCAL_TEST_CASES | ConvertFrom-Json',
  'foreach ($c in $cases) {',
  '  $tstState = @{ i = 0 }',
  '  $tstPolls = @($c.polls)',
  '  $list = {',
  '    $n = [Math]::Min($tstState.i, $tstPolls.Count - 1)',
  '    $tstState.i++',
  '    foreach ($w in @($tstPolls[$n])) {',
  '      $copy = $w.PSObject.Copy()',
  "      if ($null -ne $copy.title) { $copy.title = ([string]$copy.title).Replace('{i}', [string]$tstState.i) }",
  '      $copy',
  '    }',
  '  }.GetNewClosure()',
  "  if ($c.mode -eq 'window') {",
  '    $r = Watch-Window -Before (Get-TitleSnapshot @($c.before)) -Tokens @($c.tokens) -Procs @($c.procs) -Timeout $c.timeout -List $list -ProcOf { param($w) [string]$w.process } -PollMs 0',
  '  } else {',
  '    $r = Watch-Explorer -Before @($c.before) -Want (NormPath $c.want) -Select (NormPath $c.select) -Timeout $c.timeout -List $list -PollMs 0',
  '  }',
  '  Emit $r',
  '}',
].join('\n');

const win = (handle, title, proc = 'chrome') => ({ handle, title, process: proc });
const exp = (hwnd, p, selected = []) => ({ hwnd, path: p, selected });
const T = 300; // ms: cases that must run into the timeout

const CASES = {
  // with no title known in advance there is nothing to recognise the page by: matched:null
  // at once, whatever the browser's windows do (they used to give a low-confidence "match").
  reopen: { mode: 'window', tokens: [], procs: ['chrome'], timeout: T, before: [win(1, 'org/repo - GitHub - Google Chrome')], polls: [[win(1, 'org/repo - GitHub - Google Chrome')]] },
  flicker: { mode: 'window', tokens: [], procs: ['chrome'], timeout: T, before: [win(1, 'Inbox (1) - Mail - Google Chrome')], polls: [[win(1, 'Inbox (2) - Mail - Google Chrome')], [win(1, 'Inbox (1) - Mail - Google Chrome')]] },
  settles: { mode: 'window', tokens: [], procs: ['chrome'], timeout: 5000, before: [win(1, 'Old - Google Chrome')], polls: [[win(1, 'New page - Google Chrome')]] },
  unsettled: { mode: 'window', tokens: [], procs: ['chrome'], timeout: T, before: [win(1, 'Old - Google Chrome')], polls: [[win(1, 'Tick {i} - Google Chrome')]] },
  topmost: { mode: 'window', tokens: [], procs: ['chrome'], timeout: 5000, before: [win(1, 'A - Google Chrome'), win(2, 'B - Google Chrome')], polls: [[win(2, 'B2 - Google Chrome'), win(1, 'A2 - Google Chrome')]] },
  noProgram: { mode: 'window', tokens: [], procs: [], timeout: 5000, before: [], polls: [[win(5, 'Something - Mozilla Firefox', 'firefox')]] },
  // Known title: a new or changed window that shows it is high confidence, a miss is a clear no.
  titleHit: { mode: 'window', tokens: ['my page'], procs: ['chrome'], timeout: 5000, before: [win(1, 'Other - Google Chrome')], polls: [[win(1, 'My Page - Google Chrome')]] },
  titleMiss: { mode: 'window', tokens: ['my page'], procs: ['chrome'], timeout: T, before: [win(1, 'Other - Google Chrome')], polls: [[win(1, 'Other - Google Chrome')]] },
  newWindowHit: { mode: 'window', tokens: ['my page'], procs: ['chrome'], timeout: 5000, before: [win(1, 'Other - Google Chrome')], polls: [[win(2, 'My Page - Google Chrome'), win(1, 'Other - Google Chrome')]] },
  // Tokens arrive normalised from the main block; the function normalises them again.
  rawToken: { mode: 'window', tokens: ['  My   Page '], procs: ['chrome'], timeout: 5000, before: [win(1, 'Other - Google Chrome')], polls: [[win(1, 'my page - Google Chrome')]] },
  // an unrelated window changing its title (an unread counter) never verifies anything.
  unrelatedChange: { mode: 'window', tokens: ['my page'], procs: ['chrome'], timeout: T, before: [win(1, 'Inbox (1) - Mail - Google Chrome')], polls: [[win(1, 'Inbox (2) - Mail - Google Chrome')]] },
  unrelatedNewWindow: { mode: 'window', tokens: ['my page'], procs: ['chrome'], timeout: T, before: [], polls: [[win(7, 'New Tab - Google Chrome')], [win(7, 'Pixel Forge - Google Chrome')]] },
  // Another program's windows do not count, even with the right title.
  otherProgram: { mode: 'window', tokens: ['my page'], procs: ['chrome'], timeout: T, before: [], polls: [[win(5, 'My Page - Mozilla Firefox', 'firefox')]] },
  // a window that already showed the title before the open cannot be told apart: null.
  sameTitleBefore: { mode: 'window', tokens: ['my page'], procs: ['chrome'], timeout: T, before: [win(1, 'My Page - Google Chrome')], polls: [[win(1, 'My Page - Google Chrome')]] },
  sameTitleCounter: { mode: 'window', tokens: ['my page'], procs: ['chrome'], timeout: T, before: [win(1, '(1) My Page - Google Chrome')], polls: [[win(1, '(2) My Page - Google Chrome')]] },
  sameTitlePlusUnrelated: { mode: 'window', tokens: ['my page'], procs: ['chrome'], timeout: T, before: [win(1, 'My Page - Google Chrome'), win(2, 'Inbox (1) - Google Chrome')], polls: [[win(1, 'My Page - Google Chrome'), win(2, 'Inbox (2) - Google Chrome')]] },
  // ...but a second window showing it, beside the old one, is new: proof.
  sameTitleNewWindow: { mode: 'window', tokens: ['my page'], procs: ['chrome'], timeout: 5000, before: [win(1, 'My Page - Google Chrome')], polls: [[win(1, 'My Page - Google Chrome')], [win(2, 'My Page - Google Chrome'), win(1, 'My Page - Google Chrome')]] },
  // a new tab in an Explorer window that was already open is not a new window.
  newTab: { mode: 'explorer', want: 'C:\\x', select: '', timeout: 5000, before: [exp(100, 'C:\\a')], polls: [[exp(100, 'C:\\a'), exp(100, 'C:\\x')]] },
  newWindow: { mode: 'explorer', want: 'C:\\x', select: '', timeout: 5000, before: [exp(100, 'C:\\a')], polls: [[exp(100, 'C:\\a'), exp(200, 'C:\\x')]] },
  // a second tab on a folder already open in the same window is new, and its selection counts.
  secondTab: { mode: 'explorer', want: 'C:\\x', select: 'C:\\x\\f.txt', timeout: 5000, before: [exp(100, 'C:\\x')], polls: [[exp(100, 'C:\\x'), exp(100, 'C:\\x', ['c:\\x\\f.txt'])]] },
  alreadyOpen: { mode: 'explorer', want: 'C:\\x', select: 'C:\\x\\f.txt', timeout: T, before: [exp(100, 'C:\\x', ['c:\\x\\f.txt'])], polls: [[exp(100, 'C:\\x', ['c:\\x\\f.txt'])]] },
  alreadyOpenNoSelect: { mode: 'explorer', want: 'C:\\x', select: '', timeout: T, before: [exp(100, 'C:\\x')], polls: [[exp(100, 'C:\\x')]] },
  // Explorer reused the window already on the folder and selected the file in it: a change, proof.
  reusedSelects: { mode: 'explorer', want: 'C:\\x', select: 'C:\\x\\f.txt', timeout: 5000, before: [exp(100, 'C:\\x', ['c:\\x\\other.txt'])], polls: [[exp(100, 'C:\\x', ['c:\\x\\f.txt'])]] },
  notSelected: { mode: 'explorer', want: 'C:\\x', select: 'C:\\x\\f.txt', timeout: T, before: [], polls: [[exp(300, 'C:\\x')]] },
  nothing: { mode: 'explorer', want: 'C:\\x', select: '', timeout: T, before: [exp(100, 'C:\\a')], polls: [[exp(100, 'C:\\a')]] },
};

/** Run every case in one PowerShell process; results by case name. */
function runWatcherCases() {
  const names = Object.keys(CASES);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DRIVER], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    env: { ...process.env, SHOW_LOCAL_TEST_WATCHER: WATCHER, SHOW_LOCAL_TEST_CASES: JSON.stringify(names.map((n) => CASES[n])) },
  });
  const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l.startsWith('{'));
  assert.equal(lines.length, names.length, `one result per case; stdout: ${r.stdout} stderr: ${r.stderr}`);
  return Object.fromEntries(names.map((n, i) => [n, JSON.parse(lines[i])]));
}

test('windows.ps1 decisions on scripted windows', { skip: !onWindows && 'the watcher runs on Windows only' }, async (t) => {
  const R = runWatcherCases();
  const noConfidence = (r, label) => assert.equal('confidence' in r, false, `${label}: ${JSON.stringify(r)}`);

  await t.test('no title known in advance: matched null at once, whatever the windows do; never true', () => {
    for (const name of ['reopen', 'flicker', 'settles', 'unsettled', 'topmost', 'noProgram']) {
      assert.equal(R[name].matched, null, `${name}: ${JSON.stringify(R[name])}`);
      assert.match(R[name].reason, /not known in advance/, name);
      assert.equal(R[name].elapsedMs, 0, `${name}: nothing to wait for`);
      assert.equal('title' in R[name], false, `${name}: no window is named as proof`);
      noConfidence(R[name], name);
    }
  });

  await t.test('a known title: a new or changed window showing it is high, a miss is false', () => {
    assert.equal(R.titleHit.matched, true);
    assert.equal(R.titleHit.confidence, 'high');
    assert.equal(R.titleHit.title, 'My Page - Google Chrome');
    assert.equal(R.titleHit.process, 'chrome');
    assert.equal(R.titleHit.newWindow, false);
    assert.equal(R.newWindowHit.matched, true);
    assert.equal(R.newWindowHit.confidence, 'high');
    assert.equal(R.newWindowHit.newWindow, true);
    assert.equal(R.rawToken.matched, true, 'tokens are normalised like titles');
    assert.equal(R.titleMiss.matched, false);
    assert.match(R.titleMiss.reason, /"my page"/);
    assert.doesNotMatch(R.titleMiss.reason, /other windows/, 'nothing else changed either');
  });

  await t.test('an unrelated window changing its title never verifies: matched false, not true', () => {
    for (const name of ['unrelatedChange', 'unrelatedNewWindow']) {
      assert.equal(R[name].matched, false, `${name}: ${JSON.stringify(R[name])}`);
      assert.match(R[name].reason, /no new or changed window containing "my page"/, name);
      assert.match(R[name].reason, /other windows changed their titles, but none showed it/, name);
      assert.equal('title' in R[name], false, `${name}: the unrelated window is not named as proof`);
      noConfidence(R[name], name);
    }
    assert.equal(R.otherProgram.matched, false, "another program's window never counts, even with the title");
  });

  await t.test('a window that already showed the title before the open gives null (cannot tell), never true', () => {
    for (const name of ['sameTitleBefore', 'sameTitleCounter', 'sameTitlePlusUnrelated']) {
      assert.equal(R[name].matched, null, `${name}: ${JSON.stringify(R[name])}`);
      assert.match(R[name].reason, /already open before/, name);
      assert.match(R[name].title, /My Page - Google Chrome/, name);
      noConfidence(R[name], name);
    }
    assert.equal(R.sameTitleNewWindow.matched, true, 'a second window showing it, beside the old one, is new');
    assert.equal(R.sameTitleNewWindow.confidence, 'high');
    assert.equal(R.sameTitleNewWindow.newWindow, true);
  });

  await t.test('a new tab in an existing Explorer window is newWindow:false; a new window is true', () => {
    assert.equal(R.newTab.matched, true);
    assert.equal(R.newTab.confidence, 'high');
    assert.equal(R.newTab.newWindow, false);
    assert.equal(R.newWindow.matched, true);
    assert.equal(R.newWindow.newWindow, true);
  });

  await t.test('a second tab on a folder already open in that window is new, with its own selection', () => {
    assert.equal(R.secondTab.matched, true);
    assert.equal(R.secondTab.confidence, 'high', JSON.stringify(R.secondTab));
    assert.equal(R.secondTab.selectedOk, true);
    assert.equal(R.secondTab.newWindow, false);
  });

  await t.test('Explorer: a window already on the folder that did not change is null, never true', () => {
    for (const name of ['alreadyOpen', 'alreadyOpenNoSelect']) {
      assert.equal(R[name].matched, null, `${name}: ${JSON.stringify(R[name])}`);
      assert.match(R[name].reason, /already open before/, name);
      noConfidence(R[name], name);
    }
    assert.equal(R.alreadyOpen.selectedOk, true);
  });

  await t.test('Explorer: a window already on the folder that now selects the file is a change, high', () => {
    assert.equal(R.reusedSelects.matched, true, JSON.stringify(R.reusedSelects));
    assert.equal(R.reusedSelects.confidence, 'high');
    assert.equal(R.reusedSelects.selectedOk, true);
    assert.equal(R.reusedSelects.newWindow, false);
    assert.equal(R.reusedSelects.reusedWindow, true);
  });

  await t.test('Explorer: opened without the selection, and nothing at all', () => {
    assert.equal(R.notSelected.matched, true);
    assert.equal(R.notSelected.confidence, 'high');
    assert.equal(R.notSelected.selectedOk, false);
    assert.equal(R.notSelected.newWindow, true);
    assert.equal(R.nothing.matched, false);
  });
});
