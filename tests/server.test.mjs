// lib/server.mjs: the loopback static server behind serve mode.
// Real servers on freePort() over temp folders, raw HTTP via node:http / node:net.
// Nothing here opens a window, a browser or an app.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freePort, lib, tempDir } from './helpers.mjs';

const {
  SERVER_HEADER, createStaticServer, listen, logHits, mimeOf, resolveRequestPath, rootTag,
} = await import(lib('server.mjs'));
const { pathKey, sha1 } = await import(lib('util.mjs'));

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

const SECRET = 'TOP-SECRET-OUTSIDE-THE-ROOT';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0x00, 0x10, 0x80]);
const BIG = Buffer.alloc(300000);
for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 31 + (i >> 8)) & 0xff;
const HEB_FILE = 'שלום.html';
const HEB_DIR = 'תיקייה';
const HEB_BODY = '<!doctype html><title>שלום עולם</title><p>עברית</p>';

const FILES = {
  'index.html': '<!doctype html><title>Home</title><p>home</p>',
  'page.html': '<!doctype html><title>Page</title><p>ROOT PAGE</p>',
  'style.css': 'body{color:red}',
  'app.js': 'console.log(1);',
  'app.mjs': 'export default 1;',
  'data.json': '{"a":1}',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'notes.txt': 'plain notes',
  'ten.txt': '0123456789',
  'empty.txt': '',
  'blob.bin': 'opaque bytes',
  README: 'no extension here',
  'space name.txt': 'spaced out',
  'sub/index.html': 'SUB INDEX',
  'sub/page.html': 'SUB PAGE',
  'htmdir/index.htm': 'HTM INDEX',
  'both/index.html': 'BOTH HTML',
  'both/index.htm': 'BOTH HTM',
  'noindex/alpha-listing-probe.txt': 'alpha',
  'noindex/beta-listing-probe.txt': 'beta',
  'dirindex/index.htm': 'DIRINDEX HTM',
  [HEB_FILE]: HEB_BODY,
  [`${HEB_DIR}/index.html`]: 'HEBREW DIR INDEX',
};

/** <dir>/site is the served root; <dir>/secret.txt and <dir>/outside/ must never be reachable. */
function buildSite(dir) {
  const root = path.join(dir, 'site');
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(FILES)) {
    const f = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  }
  mkdirSync(path.join(root, 'dirindex', 'index.html')); // a *directory* called index.html
  writeFileSync(path.join(root, 'pic.png'), PNG);
  writeFileSync(path.join(root, 'PHOTO.PNG'), PNG);
  writeFileSync(path.join(root, 'big.bin'), BIG);
  writeFileSync(path.join(dir, 'secret.txt'), SECRET);
  mkdirSync(path.join(dir, 'outside'));
  writeFileSync(path.join(dir, 'outside', 'secret.txt'), SECRET);
  writeFileSync(path.join(dir, 'outside', 'index.html'), SECRET);
  return root;
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) { resolve(); return; }
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

/**
 * Start a server over a fresh fixture, run fn, always tear down.
 * `opts` may be an object or (dir) => object, merged into createStaticServer's options.
 */
async function withSite(fn, opts = {}) {
  const { dir, cleanup } = tempDir();
  let server;
  try {
    const root = buildSite(dir);
    const port = await freePort();
    const extra = typeof opts === 'function' ? opts(dir) : opts;
    server = createStaticServer({ root, port, echo: false, ...extra });
    await listen(server, port);
    await fn({ dir, root, port, server, tag: rootTag(root) });
  } finally {
    await closeServer(server);
    cleanup();
  }
}

/** One HTTP request with an explicit Host header (default: the allowed 127.0.0.1:port). */
function request(port, p = '/', { method = 'GET', headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, agent: false,
      headers: { Host: host ?? `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString('utf8') });
      });
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error(`timeout: ${method} ${p}`)));
    req.on('error', reject);
    req.end();
  });
}

/** Write raw bytes to the server and parse whatever comes back (status null if nothing does). */
function raw(port, text, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const sock = net.connect(port, '127.0.0.1');
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      const buf = Buffer.concat(chunks);
      const s = buf.toString('latin1');
      const i = s.indexOf('\r\n\r\n');
      const head = i === -1 ? s : s.slice(0, i);
      const [statusLine = '', ...lines] = head.split('\r\n');
      const m = statusLine.match(/^HTTP\/1\.[01] (\d{3})/);
      const headers = {};
      for (const l of lines) {
        const k = l.indexOf(':');
        if (k > 0) headers[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim();
      }
      resolve({ status: m ? Number(m[1]) : null, headers, body: i === -1 ? Buffer.alloc(0) : buf.subarray(i + 4), error });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', (e) => finish(e.code || String(e)));
    sock.on('close', () => finish(null));
    sock.write(text);
  });
}

/** Try a TCP connect; resolves true only if it connects. */
function canConnect(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const sock = net.connect({ host, port });
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve(v); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
  });
}

const isSymlinkDenied = (e) => ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EINVAL'].includes(e && e.code);

// ---------------------------------------------------------------------------------------------
// Exports: SERVER_HEADER, rootTag, mimeOf
// ---------------------------------------------------------------------------------------------

test('SERVER_HEADER is X-Show-Local', () => {
  assert.equal(SERVER_HEADER, 'X-Show-Local');
});

test('rootTag: 16 lowercase hex chars derived from sha1(pathKey(root))', () => {
  const root = path.join(os.tmpdir(), 'show-local-some-root');
  const tag = rootTag(root);
  assert.match(tag, /^[0-9a-f]{16}$/);
  assert.equal(tag, sha1(pathKey(root)).slice(0, 16));
  assert.equal(rootTag(root), tag, 'deterministic');
});

test('rootTag: does not expose the path', () => {
  const root = path.join(os.tmpdir(), 'visible-folder-name');
  const tag = rootTag(root);
  assert.ok(!tag.includes('visible'));
  assert.ok(!tag.includes(path.sep));
});

test('rootTag: different folders get different tags', () => {
  const a = path.join(os.tmpdir(), 'show-local-a');
  const b = path.join(os.tmpdir(), 'show-local-b');
  assert.notEqual(rootTag(a), rootTag(b));
  assert.notEqual(rootTag(a), rootTag(path.join(a, 'child')));
});

test('rootTag: trailing separator and relative spelling resolve to the same tag', () => {
  const abs = path.resolve('some-relative-folder');
  assert.equal(rootTag(`${abs}${path.sep}`), rootTag(abs));
  assert.equal(rootTag('some-relative-folder'), rootTag(abs));
  assert.equal(rootTag(path.join(abs, 'x', '..')), rootTag(abs));
});

test('rootTag: case-insensitive on Windows/macOS, case-sensitive on Linux', () => {
  const lower = path.join(os.tmpdir(), 'show-local-case');
  const upper = path.join(os.tmpdir(), 'SHOW-LOCAL-CASE');
  if (process.platform === 'linux') assert.notEqual(rootTag(lower), rootTag(upper));
  else assert.equal(rootTag(lower), rootTag(upper));
});

test('mimeOf: known extensions map to the right Content-Type', () => {
  const table = {
    'a.html': 'text/html; charset=utf-8',
    'a.htm': 'text/html; charset=utf-8',
    'a.xhtml': 'application/xhtml+xml; charset=utf-8',
    'a.js': 'text/javascript; charset=utf-8',
    'a.mjs': 'text/javascript; charset=utf-8',
    'a.cjs': 'text/javascript; charset=utf-8',
    'a.css': 'text/css; charset=utf-8',
    'a.json': 'application/json; charset=utf-8',
    'a.map': 'application/json; charset=utf-8',
    'a.webmanifest': 'application/manifest+json',
    'a.txt': 'text/plain; charset=utf-8',
    'a.md': 'text/markdown; charset=utf-8',
    'a.csv': 'text/csv; charset=utf-8',
    'a.xml': 'application/xml; charset=utf-8',
    'a.vtt': 'text/vtt; charset=utf-8',
    'a.svg': 'image/svg+xml',
    'a.png': 'image/png',
    'a.jpg': 'image/jpeg',
    'a.jpeg': 'image/jpeg',
    'a.gif': 'image/gif',
    'a.webp': 'image/webp',
    'a.avif': 'image/avif',
    'a.ico': 'image/x-icon',
    'a.mp4': 'video/mp4',
    'a.webm': 'video/webm',
    'a.mp3': 'audio/mpeg',
    'a.wav': 'audio/wav',
    'a.pdf': 'application/pdf',
    'a.wasm': 'application/wasm',
    'a.woff2': 'font/woff2',
    'a.glb': 'model/gltf-binary',
  };
  for (const [f, type] of Object.entries(table)) assert.equal(mimeOf(f), type, f);
});

test('mimeOf: extension match is case-insensitive and uses the last extension', () => {
  assert.equal(mimeOf('INDEX.HTML'), 'text/html; charset=utf-8');
  assert.equal(mimeOf('Photo.PnG'), 'image/png');
  assert.equal(mimeOf('bundle.min.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeOf(path.join('a.html', 'b.css')), 'text/css; charset=utf-8');
});

test('mimeOf: unknown, missing and dotfile-only extensions fall back to octet-stream', () => {
  assert.equal(mimeOf('blob.bin'), 'application/octet-stream');
  assert.equal(mimeOf('archive.tar.gz'), 'application/octet-stream');
  assert.equal(mimeOf('README'), 'application/octet-stream');
  assert.equal(mimeOf('.html'), 'application/octet-stream');
  assert.equal(mimeOf(''), 'application/octet-stream');
});

// ---------------------------------------------------------------------------------------------
// resolveRequestPath (pure: never touches the disk)
// ---------------------------------------------------------------------------------------------

// A root that does not exist proves the function never touches the disk.
const R = path.resolve(os.tmpdir(), 'show-local-no-such-root-9f3a');
const resolves = (p, platform) => resolveRequestPath(R, p, platform);
const insideR = (file) => {
  const rel = path.relative(R, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

test('resolveRequestPath: "/" and "" map to the root itself', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    assert.deepEqual(resolves('/', platform), { ok: true, file: R });
    assert.deepEqual(resolves('', platform), { ok: true, file: R });
  }
});

test('resolveRequestPath: plain paths map under the root (non-existent root is fine)', () => {
  for (const platform of ['linux', 'win32']) {
    assert.deepEqual(resolves('/index.html', platform), { ok: true, file: path.join(R, 'index.html') });
    assert.deepEqual(resolves('/a/b/c.txt', platform), { ok: true, file: path.join(R, 'a', 'b', 'c.txt') });
    assert.deepEqual(resolves('/sub/', platform), { ok: true, file: path.join(R, 'sub') });
  }
});

test('resolveRequestPath: runs of separators collapse; backslash is a separator on every platform', () => {
  for (const platform of ['linux', 'win32']) {
    assert.deepEqual(resolves('//a///b', platform), { ok: true, file: path.join(R, 'a', 'b') });
    assert.deepEqual(resolves('/a%2Fb', platform), { ok: true, file: path.join(R, 'a', 'b') });
    assert.deepEqual(resolves('/a%5Cb', platform), { ok: true, file: path.join(R, 'a', 'b') });
    assert.deepEqual(resolves('/a\\b', platform), { ok: true, file: path.join(R, 'a', 'b') });
  }
});

test('resolveRequestPath: percent-decodes UTF-8 (Hebrew) and spaces', () => {
  assert.deepEqual(resolves(`/${encodeURIComponent(HEB_FILE)}`, 'linux'), { ok: true, file: path.join(R, HEB_FILE) });
  assert.deepEqual(resolves(`/${encodeURIComponent(HEB_DIR)}/index.html`, 'win32'), { ok: true, file: path.join(R, HEB_DIR, 'index.html') });
  assert.deepEqual(resolves('/space%20name.txt', 'linux'), { ok: true, file: path.join(R, 'space name.txt') });
});

test('resolveRequestPath: a segment starting with "." is refused with 403 at any depth; only .well-known itself is allowed', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const p of ['/.env', '/a/.git/config', '/.well-known/.env', '/sub/.hidden/x.txt', '/a/b/.env', '/%2Eenv', '/a/%2Egit/config', '/.well-known%2F.env']) {
      assert.deepEqual(resolves(p, platform), { ok: false, status: 403 }, `${platform} ${p}`);
    }
    assert.deepEqual(resolves('/.well-known/x.json', platform), { ok: true, file: path.join(R, '.well-known', 'x.json') }, platform);
    // A dot inside a name is not a dotfile.
    assert.deepEqual(resolves('/a.b/c.env', platform), { ok: true, file: path.join(R, 'a.b', 'c.env') }, platform);
  }
});

test('resolveRequestPath: every ".." or "." segment is refused with 403, however it is spelled', () => {
  const cases = [
    '/..', '/../x', '/a/..', '/a/../x', '/a/../../x', '/./x', '/a/.', '/a/./b',
    '/%2e%2e/x', '/%2E%2E/x', '/%2e./x', '/.%2e/x', '/%2e', '/a/%2e/b',
    '/..%2fx', '/..%2Fx', '/..%5cx', '/..%5Cx', '/%2e%2e%5c', '/%2e%2e%5cx', '/%2e%2e%2f%2e%2e%2fx',
    '/sub%2f..%2f..%2fx', '/..\\x', '\\..\\x', '/a\\..\\..\\x', '..', '../x',
  ];
  for (const platform of ['linux', 'win32']) {
    for (const p of cases) assert.deepEqual(resolves(p, platform), { ok: false, status: 403 }, `${platform} ${p}`);
  }
});

test('resolveRequestPath: NUL bytes are refused with 400', () => {
  for (const platform of ['linux', 'win32']) {
    for (const p of ['%00', '/%00', '/a%00b', '/index.html%00.txt', '/a\0b']) {
      assert.deepEqual(resolves(p, platform), { ok: false, status: 400 }, `${platform} ${JSON.stringify(p)}`);
    }
  }
});

test('resolveRequestPath: malformed percent-encoding is refused with 400', () => {
  for (const platform of ['linux', 'win32']) {
    for (const p of ['/%', '/%zz', '/a%2', '/%E0%A4%A', '/%c0%af', '/..%c0%afx', '/%ff']) {
      assert.deepEqual(resolves(p, platform), { ok: false, status: 400 }, `${platform} ${p}`);
    }
  }
});

test('resolveRequestPath win32: drive letters and NTFS alternate data streams are refused', () => {
  const cases = [
    '/C:', '/c:', '/C:/Windows/win.ini', '/C%3A%5CWindows%5Cwin.ini', '/c%3a/x',
    '/index.html::$DATA', '/file.txt:stream', '/sub/a:b', '/%3a', '/%5C%5C%3F%5CC%3A%5Cx',
  ];
  for (const p of cases) assert.deepEqual(resolves(p, 'win32'), { ok: false, status: 403 }, p);
});

test('resolveRequestPath linux: a colon is an ordinary filename character', () => {
  assert.deepEqual(resolves('/file.txt:stream', 'linux'), { ok: true, file: path.join(R, 'file.txt:stream') });
  assert.deepEqual(resolves('/sub/a%3Ab.txt', 'linux'), { ok: true, file: path.join(R, 'sub', 'a:b.txt') });
  assert.deepEqual(resolves('/file.txt:stream', 'darwin'), { ok: true, file: path.join(R, 'file.txt:stream') });
});

test('resolveRequestPath: platform defaults to process.platform', () => {
  for (const p of ['/file.txt:stream', '/index.html', '/../x', '/%zz']) {
    assert.deepEqual(resolveRequestPath(R, p), resolveRequestPath(R, p, process.platform), p);
  }
});

test('resolveRequestPath: an absolute path spelled into the URL still lands inside the root', () => {
  const abs = path.join(os.tmpdir(), 'elsewhere', 'secret.txt');
  for (const spelled of [`/${encodeURIComponent(abs)}`, `/${abs.split(path.sep).map(encodeURIComponent).join('/')}`]) {
    for (const platform of ['linux', 'win32']) {
      const r = resolves(spelled, platform);
      if (r.ok) assert.ok(insideR(r.file), `${platform} ${spelled} -> ${r.file}`);
      else assert.equal(r.status, 403, `${platform} ${spelled}`);
    }
  }
  assert.deepEqual(resolves('//etc/passwd', 'linux'), { ok: true, file: path.join(R, 'etc', 'passwd') });
});

test('resolveRequestPath: every accepted result is inside the root', () => {
  const samples = ['/', '/a', '/a/b', '//x//y', '/a%2Fb', '/a%5Cb', '/x..', '/x.', '/%20', '/.well-known/x', `/${encodeURIComponent(HEB_FILE)}`];
  for (const platform of ['linux', 'win32']) {
    for (const p of samples) {
      const r = resolves(p, platform);
      assert.equal(r.ok, true, `${platform} ${p}`);
      assert.ok(insideR(r.file), `${platform} ${p} -> ${r.file}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// createStaticServer / listen basics
// ---------------------------------------------------------------------------------------------

test('createStaticServer: returns an http.Server that is not yet listening', () => {
  const { dir, cleanup } = tempDir();
  try {
    const server = createStaticServer({ root: dir, port: 1, echo: false });
    assert.ok(server instanceof http.Server);
    assert.equal(server.listening, false);
  } finally { cleanup(); }
});

test('createStaticServer: a missing root throws ENOENT up front', () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.throws(() => createStaticServer({ root: path.join(dir, 'nope'), port: 1, echo: false }), { code: 'ENOENT' });
  } finally { cleanup(); }
});

test('listen: binds 127.0.0.1, resolves with the same server and leaves no error listener behind', async () => {
  const { dir, cleanup } = tempDir();
  const port = await freePort();
  const server = createStaticServer({ root: dir, port, echo: false });
  const before = server.listenerCount('error');
  try {
    const r = await listen(server, port);
    assert.equal(r, server);
    assert.equal(server.listening, true);
    const addr = server.address();
    assert.equal(addr.address, '127.0.0.1');
    assert.equal(addr.port, port);
    assert.equal(server.listenerCount('error'), before);
  } finally { await closeServer(server); cleanup(); }
});

test('listen: rejects with EADDRINUSE when the port is taken, without leaking an error listener', async () => {
  const { dir, cleanup } = tempDir();
  const port = await freePort();
  const blocker = net.createServer();
  const server = createStaticServer({ root: dir, port, echo: false });
  const before = server.listenerCount('error');
  try {
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen({ port, host: '127.0.0.1' }, resolve); });
    await assert.rejects(listen(server, port), { code: 'EADDRINUSE' });
    assert.equal(server.listening, false);
    assert.equal(server.listenerCount('error'), before);
  } finally {
    await closeServer(server);
    await new Promise((resolve) => blocker.close(() => resolve()));
    cleanup();
  }
});

test('listen: the server is not reachable on ::1', async () => {
  await withSite(async ({ port, server }) => {
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal(await canConnect('::1', port), false, 'connected over IPv6 loopback');
    assert.equal(await canConnect('127.0.0.1', port), true);
  });
});

test('listen: the server is not reachable on a LAN address', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && !i.internal && (i.family === 'IPv4' || i.family === 4));
  if (!lan) { t.skip('no non-internal IPv4 interface'); return; }
  await withSite(async ({ port }) => {
    assert.equal(await canConnect(lan.address, port), false, `connected via ${lan.address}`);
  });
});

// ---------------------------------------------------------------------------------------------
// Serving files
// ---------------------------------------------------------------------------------------------

test('GET a file: 200 with the right headers and exact body', async () => {
  await withSite(async ({ port, tag }) => {
    const r = await request(port, '/page.html');
    assert.equal(r.status, 200);
    assert.equal(r.text, FILES['page.html']);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['content-length'], String(Buffer.byteLength(FILES['page.html'])));
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-show-local'], tag);
    assert.equal(r.headers['content-range'], undefined);
  });
});

test('GET: Content-Type follows the file extension', async () => {
  await withSite(async ({ port }) => {
    const expect = {
      '/style.css': 'text/css; charset=utf-8',
      '/app.js': 'text/javascript; charset=utf-8',
      '/app.mjs': 'text/javascript; charset=utf-8',
      '/data.json': 'application/json; charset=utf-8',
      '/logo.svg': 'image/svg+xml',
      '/notes.txt': 'text/plain; charset=utf-8',
      '/pic.png': 'image/png',
      '/PHOTO.PNG': 'image/png',
      '/blob.bin': 'application/octet-stream',
      '/README': 'application/octet-stream',
    };
    for (const [p, type] of Object.entries(expect)) {
      const r = await request(port, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
    }
  });
});

test('GET: binary files come back byte-for-byte', async () => {
  await withSite(async ({ port }) => {
    const png = await request(port, '/pic.png');
    assert.ok(png.body.equals(PNG));
    const big = await request(port, '/big.bin');
    assert.equal(big.status, 200);
    assert.equal(big.headers['content-length'], String(BIG.length));
    assert.ok(big.body.equals(BIG), 'large streamed body differs');
  });
});

test('GET: a zero-byte file is served as 200 with Content-Length 0', async () => {
  await withSite(async ({ port, tag }) => {
    const r = await request(port, '/empty.txt');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-length'], '0');
    assert.equal(r.body.length, 0);
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(r.headers['x-show-local'], tag);
    const h = await request(port, '/empty.txt', { method: 'HEAD' });
    assert.equal(h.status, 200);
    assert.equal(h.headers['content-length'], '0');
  });
});

test('GET: the query string is ignored when mapping to a file', async () => {
  await withSite(async ({ port }) => {
    const r = await request(port, '/page.html?v=123&x=%2e%2e');
    assert.equal(r.status, 200);
    assert.equal(r.text, FILES['page.html']);
  });
});

test('GET: a percent-encoded space in the name is served', async () => {
  await withSite(async ({ port }) => {
    const r = await request(port, '/space%20name.txt');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'spaced out');
  });
});

test('GET: a Hebrew file name (percent-encoded URL) is served', async () => {
  await withSite(async ({ port }) => {
    const r = await request(port, `/${encodeURIComponent(HEB_FILE)}`);
    assert.equal(r.status, 200);
    assert.equal(r.text, HEB_BODY);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['content-length'], String(Buffer.byteLength(HEB_BODY)));
  });
});

test('GET: a Hebrew folder redirects with its encoding intact, then serves its index', async () => {
  await withSite(async ({ port }) => {
    const enc = `/${encodeURIComponent(HEB_DIR)}`;
    const r = await request(port, enc);
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, `${enc}/`);
    const idx = await request(port, `${enc}/`);
    assert.equal(idx.status, 200);
    assert.equal(idx.text, 'HEBREW DIR INDEX');
  });
});

test('GET: dotfiles and dot-folders are never served (.env, .git, "..notes"), .well-known is', async () => {
  await withSite(async ({ root, port }) => {
    writeFileSync(path.join(root, '..notes.txt'), 'DOTS INSIDE');
    writeFileSync(path.join(root, '.env'), 'TOKEN=secret');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'config'), '[core]');
    mkdirSync(path.join(root, '.well-known'), { recursive: true });
    writeFileSync(path.join(root, '.well-known', 'security.txt'), 'Contact: x');
    // Deeper down too: a nested .env or .git, and a dotfile inside .well-known.
    writeFileSync(path.join(root, 'sub', '.env'), 'TOKEN=secret');
    mkdirSync(path.join(root, 'sub', '.git'), { recursive: true });
    writeFileSync(path.join(root, 'sub', '.git', 'config'), '[core] secret');
    writeFileSync(path.join(root, '.well-known', '.env'), 'TOKEN=secret');
    for (const p of ['/..notes.txt', '/.env', '/.git/config', '/sub/../.env', '/%2Eenv',
      '/sub/.env', '/sub/.git/config', '/sub/%2Egit/config', '/.well-known/.env', '//sub//.env']) {
      const r = await request(port, p);
      assert.equal(r.status, 403, `${p} -> ${r.status}`);
      assert.ok(!r.text.includes('secret') && !r.text.includes('DOTS INSIDE'), p);
    }
    const wk = await request(port, '/.well-known/security.txt');
    assert.equal(wk.status, 200);
    assert.equal(wk.text, 'Contact: x');
  });
});

test('GET: missing files and paths through a file are 404', async () => {
  await withSite(async ({ port, tag, root }) => {
    for (const p of ['/missing.txt', '/missing/deeper/x.html', '/page.html/extra', '/sub/missing.html']) {
      const r = await request(port, p);
      assert.equal(r.status, 404, p);
      assert.equal(r.text, 'Not found\n', p);
      assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8', p);
      assert.equal(r.headers['x-show-local'], tag, p);
      assert.ok(!r.text.includes(root), 'error body must not disclose the root path');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------------------------

test('GET /: serves index.html', async () => {
  await withSite(async ({ port }) => {
    for (const p of ['/', '/?x=1']) {
      const r = await request(port, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.text, FILES['index.html'], p);
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', p);
    }
  });
});

test('GET dir/: serves its index.html', async () => {
  await withSite(async ({ port }) => {
    const r = await request(port, '/sub/');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'SUB INDEX');
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  });
});

test('GET dir/: falls back to index.htm, and prefers index.html when both exist', async () => {
  await withSite(async ({ port }) => {
    const htm = await request(port, '/htmdir/');
    assert.equal(htm.status, 200);
    assert.equal(htm.text, 'HTM INDEX');
    assert.equal(htm.headers['content-type'], 'text/html; charset=utf-8');
    const both = await request(port, '/both/');
    assert.equal(both.text, 'BOTH HTML');
  });
});

test('GET dir/: a directory named index.html is skipped in favour of index.htm', async () => {
  await withSite(async ({ port }) => {
    const r = await request(port, '/dirindex/');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'DIRINDEX HTM');
  });
});

test('GET dir without trailing slash: 301 to the slash form, query preserved, empty body', async () => {
  await withSite(async ({ port, tag }) => {
    const r = await request(port, '/sub');
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, '/sub/');
    assert.equal(r.body.length, 0);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-show-local'], tag);
    const q = await request(port, '/sub?x=1&y=two');
    assert.equal(q.status, 301);
    assert.equal(q.headers.location, '/sub/?x=1&y=two');
    const nested = await request(port, '/noindex');
    assert.equal(nested.status, 301);
    assert.equal(nested.headers.location, '/noindex/');
  });
});

test('GET dir redirect: Location stays on this origin (no protocol-relative "//host" open redirect)', async () => {
  await withSite(async ({ port }) => {
    const origin = `http://127.0.0.1:${port}`;
    // Dot segments are refused outright (browsers never send them); a real directory without its
    // trailing slash gets a same-origin redirect. Neither may produce a "//host" Location.
    for (const p of ['/.//sub', '/sub/..//sub']) {
      const r = await request(port, p);
      assert.equal(r.status, 403, p);
      assert.equal(r.headers.location, undefined, p);
    }
    for (const p of ['//sub', '/sub', '///sub']) {
      const r = await request(port, p);
      assert.equal(r.status, 301, p);
      const loc = r.headers.location;
      assert.equal(loc, '/sub/', p);
      assert.ok(!/^\/[/\\]/.test(loc), `${p} redirected to protocol-relative Location ${JSON.stringify(loc)}`);
      assert.equal(new URL(loc, `${origin}/`).origin, origin, `${p} -> ${loc} leaves the origin`);
    }
  });
});

test('GET folder without an index: 404 and no directory listing', async () => {
  await withSite(async ({ port }) => {
    const r = await request(port, '/noindex/');
    assert.equal(r.status, 404);
    assert.equal(r.text, 'Not found\n');
    assert.ok(!r.text.includes('alpha-listing-probe'));
    assert.ok(!r.text.includes('beta-listing-probe'));
    const f = await request(port, '/noindex/alpha-listing-probe.txt');
    assert.equal(f.status, 200, 'files inside an index-less folder are still served');
    assert.equal(f.text, 'alpha');
  });
});

test('GET: a path starting with "//" is still a path, not a host', async () => {
  await withSite(async ({ port }) => {
    // Runs of slashes collapse, so this is sub/page.html: never the root page.html ("sub" taken
    // as a host), and never a refusal of a legitimate path.
    for (const p of ['//sub/page.html', '///sub//page.html']) {
      const r = await request(port, p);
      assert.equal(r.status, 200, `${p} answered ${r.status} with ${JSON.stringify(r.text.slice(0, 60))}`);
      assert.equal(r.text, 'SUB PAGE', p);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------------------------

test('HEAD: 200 with full headers and no body', async () => {
  await withSite(async ({ port, tag }) => {
    const r = await request(port, '/page.html', { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 0);
    assert.equal(r.headers['content-length'], String(Buffer.byteLength(FILES['page.html'])));
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['x-show-local'], tag);
    // On the wire too: nothing after the header block.
    const w = await raw(port, `HEAD /page.html HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.equal(w.status, 200);
    assert.equal(w.body.length, 0);
  });
});

test('HEAD: error and redirect responses carry no body either', async () => {
  await withSite(async ({ port }) => {
    for (const [p, status] of [['/missing.txt', 404], ['/sub', 301], ['/..%2fsecret.txt', 403], ['/%zz', 400]]) {
      const w = await raw(port, `HEAD ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      assert.equal(w.status, status, p);
      assert.equal(w.body.length, 0, p);
    }
  });
});

test('POST and other methods: 405 with Allow: GET, HEAD', async () => {
  await withSite(async ({ port, tag }) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await request(port, '/page.html', { method });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, 'GET, HEAD', method);
      assert.equal(r.headers['x-show-local'], tag, method);
      assert.equal(r.headers['cache-control'], 'no-store', method);
      assert.ok(!r.text.includes('ROOT PAGE'), method);
    }
  });
});

test('405 comes before path handling (missing or hostile paths)', async () => {
  await withSite(async ({ port }) => {
    assert.equal((await request(port, '/missing.txt', { method: 'POST' })).status, 405);
    assert.equal((await request(port, '/..%2fsecret.txt', { method: 'POST' })).status, 405);
    const star = await raw(port, `OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.equal(star.status, 405);
  });
});

// ---------------------------------------------------------------------------------------------
// Range requests
// ---------------------------------------------------------------------------------------------

async function range(port, header, p = '/ten.txt', method = 'GET') {
  return request(port, p, { method, headers: { Range: header } });
}

test('Range bytes=0-3: 206 with Content-Range and the first 4 bytes', async () => {
  await withSite(async ({ port, tag }) => {
    const r = await range(port, 'bytes=0-3');
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 0-3/10');
    assert.equal(r.headers['content-length'], '4');
    assert.equal(r.text, '0123');
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-show-local'], tag);
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
  });
});

test('Range suffix bytes=-4: the last 4 bytes', async () => {
  await withSite(async ({ port }) => {
    const r = await range(port, 'bytes=-4');
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 6-9/10');
    assert.equal(r.headers['content-length'], '4');
    assert.equal(r.text, '6789');
  });
});

test('Range: open-ended, single-byte and over-long ranges', async () => {
  await withSite(async ({ port }) => {
    const cases = [
      ['bytes=4-', 'bytes 4-9/10', '456789'],
      ['bytes=0-0', 'bytes 0-0/10', '0'],
      ['bytes=9-9', 'bytes 9-9/10', '9'],
      ['bytes=9-', 'bytes 9-9/10', '9'],
      ['bytes=2-999', 'bytes 2-9/10', '23456789'],
      ['bytes=-100', 'bytes 0-9/10', '0123456789'],
      ['bytes=-10', 'bytes 0-9/10', '0123456789'],
      ['bytes=0-99999999999999999999', 'bytes 0-9/10', '0123456789'],
      ['  bytes=1-2  ', 'bytes 1-2/10', '12'],
    ];
    for (const [h, cr, body] of cases) {
      const r = await range(port, h);
      assert.equal(r.status, 206, h);
      assert.equal(r.headers['content-range'], cr, h);
      assert.equal(r.headers['content-length'], String(body.length), h);
      assert.equal(r.text, body, h);
    }
  });
});

test('Range: unsatisfiable ranges get 416 with Content-Range bytes */size and no body', async () => {
  await withSite(async ({ port, tag }) => {
    for (const h of ['bytes=10-', 'bytes=10-20', 'bytes=100-200', 'bytes=-0', 'bytes=5-2', 'bytes=99999999999999999999-']) {
      const r = await range(port, h);
      assert.equal(r.status, 416, h);
      assert.equal(r.headers['content-range'], 'bytes */10', h);
      assert.equal(r.body.length, 0, h);
      assert.equal(r.headers['x-show-local'], tag, h);
      assert.equal(r.headers['cache-control'], 'no-store', h);
    }
  });
});

test('Range on a zero-byte file is unsatisfiable (416 bytes */0)', async () => {
  await withSite(async ({ port }) => {
    for (const h of ['bytes=0-', 'bytes=0-0', 'bytes=-4']) {
      const r = await range(port, h, '/empty.txt');
      assert.equal(r.status, 416, h);
      assert.equal(r.headers['content-range'], 'bytes */0', h);
    }
  });
});

test('Range: unsupported or malformed specs are ignored (200, full body)', async () => {
  await withSite(async ({ port }) => {
    for (const h of ['items=0-3', 'bytes=0-1,3-4', 'bytes=abc', 'bytes=-', 'bytes=', 'bytes 0-3', 'bytes=1.5-3']) {
      const r = await range(port, h);
      assert.equal(r.status, 200, h);
      assert.equal(r.text, '0123456789', h);
      assert.equal(r.headers['content-range'], undefined, h);
      assert.equal(r.headers['content-length'], '10', h);
    }
  });
});

test('Range with HEAD: 206 headers, no body', async () => {
  await withSite(async ({ port }) => {
    const r = await range(port, 'bytes=0-3', '/ten.txt', 'HEAD');
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 0-3/10');
    assert.equal(r.headers['content-length'], '4');
    assert.equal(r.body.length, 0);
  });
});

test('Range inside a large file returns the exact slice', async () => {
  await withSite(async ({ port }) => {
    const r = await range(port, 'bytes=100000-100099', '/big.bin');
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], `bytes 100000-100099/${BIG.length}`);
    assert.ok(r.body.equals(BIG.subarray(100000, 100100)));
    const tail = await range(port, 'bytes=-7', '/big.bin');
    assert.ok(tail.body.equals(BIG.subarray(BIG.length - 7)));
  });
});

test('Range applies to a directory index too', async () => {
  await withSite(async ({ port }) => {
    const r = await range(port, 'bytes=0-8', '/');
    assert.equal(r.status, 206);
    assert.equal(r.text, FILES['index.html'].slice(0, 9));
    assert.equal(r.headers['content-range'], `bytes 0-8/${Buffer.byteLength(FILES['index.html'])}`);
  });
});

// ---------------------------------------------------------------------------------------------
// Headers on every kind of response
// ---------------------------------------------------------------------------------------------

test('Cache-Control: no-store and X-Show-Local = rootTag(root) on every status', async () => {
  await withSite(async ({ port, tag }) => {
    const cases = [
      ['/page.html', {}, 200],
      ['/ten.txt', { headers: { Range: 'bytes=0-1' } }, 206],
      ['/sub', {}, 301],
      ['/%zz', {}, 400],
      ['/..%2fsecret.txt', {}, 403],
      ['/page.html', { host: 'evil.com' }, 403],
      ['/missing.txt', {}, 404],
      ['/page.html', { method: 'POST' }, 405],
      ['/ten.txt', { headers: { Range: 'bytes=50-' } }, 416],
    ];
    for (const [p, opts, status] of cases) {
      const r = await request(port, p, opts);
      const label = `${opts.method || 'GET'} ${p} ${JSON.stringify(opts)}`;
      assert.equal(r.status, status, label);
      assert.equal(r.headers['cache-control'], 'no-store', label);
      assert.equal(r.headers['x-show-local'], tag, label);
    }
  });
});

test('X-Show-Local identifies the folder: two servers over two folders differ', async () => {
  await withSite(async ({ port: portA, tag: tagA }) => {
    await withSite(async ({ port: portB, tag: tagB }) => {
      assert.notEqual(tagA, tagB);
      assert.equal((await request(portA, '/')).headers['x-show-local'], tagA);
      assert.equal((await request(portB, '/')).headers['x-show-local'], tagB);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Host header (DNS-rebinding guard)
// ---------------------------------------------------------------------------------------------

test('Host header: loopback names on the served port are allowed', async (t) => {
  await withSite(async ({ port }) => {
    const allowed = [
      `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `foo.localhost:${port}`,
      `a.b-c.localhost:${port}`, `app1.localhost:${port}`, `LOCALHOST:${port}`, `Foo.LocalHost:${port}`,
    ];
    for (const host of allowed) {
      await t.test(host, async () => {
        const r = await request(port, '/page.html', { host });
        assert.equal(r.status, 200);
        assert.equal(r.text, FILES['page.html']);
      });
    }
  });
});

test('Host header: anything else is refused with 403 and no content', async (t) => {
  await withSite(async ({ port, tag }) => {
    const other = port === 65535 ? port - 1 : port + 1;
    const refused = [
      'evil.com', `evil.com:${port}`, `127.0.0.1:${other}`, `localhost:${other}`, `[::1]:${other}`,
      '127.0.0.1', 'localhost', '[::1]', `localhost.evil.com:${port}`, `localhost:${port}.evil.com`,
      `0.0.0.0:${port}`, `127.0.0.2:${port}`, `127.1:${port}`, `foo_bar.localhost:${port}`,
      `localhost.:${port}`, `.localhost:${port}`, `127.0.0.1:${port}@evil.com`, `127.0.0.1:0${port}`,
      `192.168.1.10:${port}`, `evil.com:${port}.localhost`,
    ];
    for (const host of refused) {
      await t.test(host, async () => {
        const r = await request(port, '/page.html', { host });
        assert.equal(r.status, 403);
        assert.equal(r.text, 'Forbidden host\n');
        assert.equal(r.headers['x-show-local'], tag);
        assert.ok(!r.text.includes('ROOT PAGE'));
      });
    }
  });
});

test('Host header: missing Host is refused (HTTP/1.0 -> 403; HTTP/1.1 -> 400 or 403 by Node version)', async () => {
  await withSite(async ({ port }) => {
    const v10 = await raw(port, 'GET /page.html HTTP/1.0\r\n\r\n');
    assert.equal(v10.status, 403);
    assert.equal(v10.body.toString('utf8'), 'Forbidden host\n');
    const v11 = await raw(port, 'GET /page.html HTTP/1.1\r\nConnection: close\r\n\r\n');
    assert.ok([400, 403].includes(v11.status), `HTTP/1.1 without Host -> ${v11.status}`);
    assert.ok(!v11.body.toString('utf8').includes('ROOT PAGE'));
    const empty = await raw(port, 'GET /page.html HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n');
    assert.ok([400, 403].includes(empty.status), `empty Host -> ${empty.status}`);
    assert.ok(!empty.body.toString('utf8').includes('ROOT PAGE'));
  });
});

test('Host check runs before the method and path checks', async () => {
  await withSite(async ({ port }) => {
    const post = await request(port, '/page.html', { method: 'POST', host: 'evil.com' });
    assert.equal(post.status, 403);
    assert.equal(post.headers.allow, undefined);
    const bad = await request(port, '/%zz', { host: 'evil.com' });
    assert.equal(bad.status, 403);
    assert.equal(bad.text, 'Forbidden host\n');
  });
});

// ---------------------------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------------------------

test('Traversal: no request reaches files outside the root; a traversal is refused with exactly 403 or 404', async (t) => {
  await withSite(async ({ dir, port }) => {
    const absSecret = path.join(dir, 'secret.txt');
    // Every spelling of a way out of the root. The answer is a refusal (403) or "not here"
    // (404), and nothing else: no redirect that could lead a browser on, no bad-request.
    const traversal = [
      '/../secret.txt', '/%2e%2e/secret.txt', '/%2E%2E/secret.txt', '/.%2e/secret.txt', '/%2e./secret.txt',
      '/..%2fsecret.txt', '/..%2Fsecret.txt', '/..%5csecret.txt', '/..%5Csecret.txt',
      '/%2e%2e%5csecret.txt', '/%2e%2e%2fsecret.txt', '/%2e%2e%5c', '/%2e%2e%2f',
      '/sub/../../secret.txt', '/sub/%2e%2e/%2e%2e/secret.txt', '/sub%2f..%2f..%2fsecret.txt',
      '/..\\secret.txt', '/sub\\..\\..\\secret.txt', '/./../secret.txt', '/../outside/secret.txt',
      '/..%2foutside%2f', '/..%2foutside', '/../outside', '/..%2foutside%2findex.html', '/%252e%252e/secret.txt',
      '/..%255csecret.txt', '/%2e%2e%5c%2e%2e%5csecret.txt', '/....//secret.txt', `/${encodeURIComponent(absSecret)}`,
      `/${absSecret.split(path.sep).map(encodeURIComponent).join('/')}`,
    ];
    // Encodings that do not decode to text at all (overlong UTF-8, NUL). These may also be
    // refused as a bad request (400), and still never with anything else.
    const undecodable = [
      '/..%c0%afsecret.txt', '/%c0%af..%c0%afsecret.txt', '/%c0%ae%c0%ae/secret.txt',
      '/..%00/secret.txt', '/%00../secret.txt', '/..%2f%00secret.txt',
    ];
    for (const [payloads, allowed] of [[traversal, [403, 404]], [undecodable, [400, 403, 404]]]) {
      for (const p of payloads) {
        await t.test(p, async () => {
          const r = await request(port, p);
          assert.ok(allowed.includes(r.status), `${p} -> ${r.status} (allowed: ${allowed.join(', ')})`);
          assert.ok(!r.text.includes(SECRET), `${p} leaked the secret`);
          assert.equal(r.headers.location, undefined, `${p} must not redirect`);
        });
      }
    }
  });
});

test('Traversal: encoded escapes the URL parser leaves alone are refused with the exact status', async () => {
  await withSite(async ({ port }) => {
    const exact = [
      ['/..%2fsecret.txt', 403], ['/..%2Fsecret.txt', 403], ['/..%5csecret.txt', 403], ['/%2e%2e%5c', 403],
      ['/%2e%2e%5csecret.txt', 403], ['/%2e%2e%2fsecret.txt', 403], ['/sub%2f..%2f..%2fsecret.txt', 403],
      ['/.%2e%2fsecret.txt', 403], ['/%00', 400], ['/index.html%00.txt', 400], ['/%zz', 400], ['/%', 400],
      ['/%E0%A4%A', 400], ['/..%c0%afsecret.txt', 400],
    ];
    for (const [p, status] of exact) {
      const r = await request(port, p);
      assert.equal(r.status, status, p);
      assert.equal(r.text, `${status}\n`, p);
      assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8', p);
    }
  });
});

test('Traversal: literal dot segments normalised by the URL parser never escape', async () => {
  await withSite(async ({ port }) => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/sub/../../secret.txt', '/..\\secret.txt']) {
      const r = await request(port, p);
      assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.ok(!r.text.includes(SECRET));
    }
    // Dot segments are refused even when they would land back inside the root: browsers resolve
    // them before sending, so only hand-made requests carry them.
    const inside = await request(port, '/sub/../page.html');
    assert.equal(inside.status, 403);
  });
});

test('The server keeps serving after refusing bad requests', async () => {
  await withSite(async ({ port }) => {
    for (const p of ['/%zz', '/%00', '/..%2fsecret.txt', '/missing']) await request(port, p);
    const r = await request(port, '/page.html');
    assert.equal(r.status, 200);
  });
});

test('A request-target the URL parser rejects gets a 4xx and does not crash the server', async () => {
  // Runs in a child process: if the handler throws, only the child dies.
  const { dir, cleanup } = tempDir();
  const root = buildSite(dir);
  const port = await freePort();
  const code = [
    'const { createStaticServer, listen } = await import(process.env.SL_LIB);',
    'const port = Number(process.env.SL_PORT);',
    'await listen(createStaticServer({ root: process.env.SL_ROOT, port, echo: false }), port);',
    'process.stdout.write("READY\\n");',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, SL_LIB: lib('server.mjs'), SL_ROOT: root, SL_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child not ready: ${stderr}`)), 10000);
      const check = () => { if (stdout.includes('READY')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', check);
      child.once('exit', (c) => { clearTimeout(timer); reject(new Error(`child exited ${c}: ${stderr}`)); });
      check();
    });
    for (const target of ['//[', 'http://[', 'http://']) {
      const r = await raw(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      // No answer usually means the process is going down: give it a moment so the report says so.
      if (r.status === null) await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
      const why = `target ${JSON.stringify(target)}: status ${r.status}, child exit code ${child.exitCode}, stderr: ${stderr.split('\n').filter(Boolean).slice(0, 6).join(' | ')}`;
      assert.ok(r.status !== null && r.status >= 400 && r.status < 500, why);
      assert.equal(child.exitCode, null, why);
      const ok = await raw(port, `GET /page.html HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      assert.equal(ok.status, 200, `server stopped answering after ${JSON.stringify(target)}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// The access log on stdout: serve's default, never in the test output
// ---------------------------------------------------------------------------------------------

test('echo: the access log reaches stdout by default, as `serve` prints it; echo: false keeps stdout clean', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const root = buildSite(dir);
    // A child serves one request to itself, then prints DONE: stdout holds exactly what the server wrote.
    const code = [
      'const http = await import("node:http");',
      'const { createStaticServer, listen } = await import(process.env.SL_LIB);',
      'const port = Number(process.env.SL_PORT);',
      'const server = createStaticServer({ root: process.env.SL_ROOT, port, ...(process.env.SL_ECHO === "off" ? { echo: false } : {}) });',
      'await listen(server, port);',
      'await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/page.html`, { agent: false }, (res) => { res.resume(); res.on("end", resolve); }).on("error", resolve));',
      'server.close();',
      'process.stdout.write("DONE\\n");',
    ].join('\n');
    const run = async (echo) => {
      const port = await freePort();
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, SL_LIB: lib('server.mjs'), SL_ROOT: root, SL_PORT: String(port), SL_ECHO: echo },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill(), 20000);
      await new Promise((resolve) => child.once('close', resolve));
      clearTimeout(timer);
      assert.match(stdout, /DONE\n$/, `echo ${echo}: ${stdout} ${stderr}`);
      return stdout;
    };
    assert.match(await run('default'), /^\S+ GET \/page\.html 200 "[^"]*"\nDONE\n$/);
    assert.equal(await run('off'), 'DONE\n');
  } finally { cleanup(); }
});

test("the tests' own static servers state echo, so no access log lands between test results", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const quiet = [];
  for (const name of readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort()) {
    readFileSync(path.join(here, name), 'utf8').split('\n').forEach((line, i) => {
      if (/createStaticServer\(\{/.test(line) && !/\becho: /.test(line)) quiet.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(quiet, [], 'each static server a test starts passes echo: false, unless the test is about echo itself');
});

// ---------------------------------------------------------------------------------------------
// Windows-specific refusals through the server (platform injected)
// ---------------------------------------------------------------------------------------------

test('platform win32: drive letters and ADS segments are refused by the server', async () => {
  await withSite(async ({ port }) => {
    for (const p of ['/page.html::$DATA', '/page.html:stream', '/C:/Windows/win.ini', '/c%3A%5Cwindows%5Cwin.ini', '/sub/a%3Ab']) {
      const r = await request(port, p);
      assert.equal(r.status, 403, p);
      assert.ok(!r.text.includes('ROOT PAGE'), p);
    }
  }, { platform: 'win32' });
});

test('platform linux: a file with a colon in its name is served', { skip: process.platform === 'win32' && 'NTFS treats ":" as a stream separator' }, async () => {
  await withSite(async ({ root, port }) => {
    writeFileSync(path.join(root, 'a:b.txt'), 'COLON');
    const r = await request(port, '/a%3Ab.txt');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'COLON');
  }, { platform: 'linux' });
});

// ---------------------------------------------------------------------------------------------
// Symlinks
// ---------------------------------------------------------------------------------------------

test('Symlink: a file link inside the root pointing outside is refused with 403', async (t) => {
  await withSite(async ({ dir, root, port }) => {
    try { symlinkSync(path.join(dir, 'secret.txt'), path.join(root, 'leak.txt'), 'file'); } catch (e) {
      if (isSymlinkDenied(e)) { t.skip(`cannot create file symlinks here (${e.code})`); return; }
      throw e;
    }
    const r = await request(port, '/leak.txt');
    assert.equal(r.status, 403);
    assert.ok(!r.text.includes(SECRET));
    const h = await request(port, '/leak.txt', { method: 'HEAD' });
    assert.equal(h.status, 403);
    const rg = await request(port, '/leak.txt', { headers: { Range: 'bytes=0-3' } });
    assert.equal(rg.status, 403);
  });
});

test('Symlink: a file link inside the root pointing inside it is served', async (t) => {
  await withSite(async ({ root, port }) => {
    try { symlinkSync(path.join(root, 'page.html'), path.join(root, 'alias.html'), 'file'); } catch (e) {
      if (isSymlinkDenied(e)) { t.skip(`cannot create file symlinks here (${e.code})`); return; }
      throw e;
    }
    const r = await request(port, '/alias.html');
    assert.equal(r.status, 200);
    assert.equal(r.text, FILES['page.html']);
  });
});

test('Symlink: a directory link (junction on Windows) pointing outside is refused', async (t) => {
  await withSite(async ({ dir, root, port }) => {
    try { symlinkSync(path.join(dir, 'outside'), path.join(root, 'jdir'), 'junction'); } catch (e) {
      if (isSymlinkDenied(e)) { t.skip(`cannot create directory links here (${e.code})`); return; }
      throw e;
    }
    for (const p of ['/jdir/secret.txt', '/jdir/', '/jdir/index.html']) {
      const r = await request(port, p);
      assert.equal(r.status, 403, p);
      assert.ok(!r.text.includes(SECRET), p);
    }
  });
});

test('Symlink: a directory link pointing inside the root is served', async (t) => {
  await withSite(async ({ root, port }) => {
    try { symlinkSync(path.join(root, 'sub'), path.join(root, 'subalias'), 'junction'); } catch (e) {
      if (isSymlinkDenied(e)) { t.skip(`cannot create directory links here (${e.code})`); return; }
      throw e;
    }
    const r = await request(port, '/subalias/page.html');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'SUB PAGE');
  });
});

test('Symlink: a root given through a link is served, tagged by the path it was given', async (t) => {
  const { dir, cleanup } = tempDir();
  let server;
  try {
    const real = buildSite(dir);
    const alias = path.join(dir, 'alias-root');
    try { symlinkSync(real, alias, 'junction'); } catch (e) {
      if (isSymlinkDenied(e)) { t.skip(`cannot create directory links here (${e.code})`); return; }
      throw e;
    }
    const port = await freePort();
    server = createStaticServer({ root: alias, port, echo: false });
    await listen(server, port);
    const r = await request(port, '/page.html');
    assert.equal(r.status, 200);
    assert.equal(r.text, FILES['page.html']);
    assert.equal(r.headers['x-show-local'], rootTag(alias));
    const out = await request(port, '/..%2fsecret.txt');
    assert.equal(out.status, 403);
  } finally {
    await closeServer(server);
    cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Access log + logHits
// ---------------------------------------------------------------------------------------------

// ISO METHOD URL STATUS "USER-AGENT": the agent tells the browser apart from show-local's own probe.
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (\S+) (\S+) (\d{3}) "([^"]*)"$/;

test('Access log: one "ISO METHOD URL STATUS" line per request, appended in order', async () => {
  let logFile;
  await withSite(async ({ port }) => {
    writeFileSync(logFile, 'EXISTING LINE\n');
    const t0 = Date.now();
    const heb = `/${encodeURIComponent(HEB_FILE)}`;
    const steps = [
      [['/page.html'], 'GET /page.html 200'],
      [['/page.html', { method: 'HEAD' }], 'HEAD /page.html 200'],
      [['/page.html?v=2'], 'GET /page.html?v=2 200'],
      [['/missing.txt'], 'GET /missing.txt 404'],
      [['/page.html', { method: 'POST' }], 'POST /page.html 405'],
      [['/page.html', { host: 'evil.com' }], 'GET /page.html 403'],
      [['/ten.txt', { headers: { Range: 'bytes=0-3' } }], 'GET /ten.txt 206'],
      [['/sub'], 'GET /sub 301'],
      [['/ten.txt', { headers: { Range: 'bytes=50-' } }], 'GET /ten.txt 416'],
      [['/%zz'], 'GET /%zz 400'],
      [['/..%2fsecret.txt'], 'GET /..%2fsecret.txt 403'],
      [[heb], `GET ${heb} 200`],
      [['/empty.txt'], 'GET /empty.txt 200'],
    ];
    for (const [args] of steps) await request(port, ...args);
    const t1 = Date.now();

    const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines[0], 'EXISTING LINE', 'the log is appended to, not truncated');
    const entries = lines.slice(1);
    assert.equal(entries.length, steps.length, entries.join('\n'));
    entries.forEach((line, i) => {
      const m = line.match(LOG_LINE);
      assert.ok(m, `malformed log line: ${line}`);
      assert.equal(new Date(m[1]).toISOString(), m[1]);
      const ms = Date.parse(m[1]);
      assert.ok(ms >= t0 - 1 && ms <= t1 + 1, `timestamp ${m[1]} outside the test window`);
      // The test client sends no user agent, so every line ends with an empty quoted agent.
      assert.equal(line.slice(m[1].length + 1), `${steps[i][1]} ""`);
    });
  }, (dir) => { logFile = path.join(dir, 'access.log'); return { logFile }; });
});

test('Access log: the line is on disk by the time the client has the response', async () => {
  let logFile;
  await withSite(async ({ port }) => {
    for (let i = 0; i < 5; i++) {
      await request(port, `/notes.txt?i=${i}`);
      const text = readFileSync(logFile, 'utf8');
      assert.equal(logHits(text, { pathname: '/notes.txt' }).length, i + 1);
    }
  }, (dir) => { logFile = path.join(dir, 'hits.log'); return { logFile }; });
});

test('Access log: an unwritable log path never breaks serving', async () => {
  let logFile;
  await withSite(async ({ port }) => {
    const r = await request(port, '/page.html');
    assert.equal(r.status, 200);
    assert.equal(r.text, FILES['page.html']);
    assert.equal((await request(port, '/missing')).status, 404);
    assert.equal(existsSync(logFile), false);
  }, (dir) => { logFile = path.join(dir, 'no', 'such', 'dir', 'access.log'); return { logFile }; });
});

test('Access log: no logFile option is fine', async () => {
  await withSite(async ({ port }) => {
    assert.equal((await request(port, '/page.html')).status, 200);
  });
});

test('logHits on a real log: filters by time, method and pathname', async () => {
  let logFile;
  await withSite(async ({ port }) => {
    writeFileSync(logFile, '2000-01-01T00:00:00.000Z GET /page.html 200\n');
    const t0 = Date.now();
    await request(port, '/page.html');
    await request(port, '/page.html', { method: 'HEAD' });
    await request(port, '/page.html?cache=1');
    await request(port, '/page.html', { host: 'evil.com' });
    await request(port, '/other.html');
    await request(port, '/page.html', { method: 'POST' });
    const heb = `/${encodeURIComponent(HEB_FILE)}`;
    await request(port, heb);
    const text = readFileSync(logFile, 'utf8');

    const pageGets = logHits(text, { sinceMs: t0, pathname: '/page.html' });
    assert.deepEqual(pageGets.map((h) => [h.url, h.status]), [['/page.html', 200], ['/page.html?cache=1', 200], ['/page.html', 403]]);
    assert.equal(logHits(text, { pathname: '/page.html' }).length, 4, 'sinceMs defaults to 0: the old line counts too');
    assert.equal(logHits(text, { sinceMs: t0, pathname: '/page.html', method: 'HEAD' }).length, 1);
    assert.deepEqual(logHits(text, { sinceMs: t0, method: 'POST' }).map((h) => h.status), [405]);
    assert.deepEqual(logHits(text, { sinceMs: t0, pathname: '/other.html' }).map((h) => h.status), [404]);
    assert.equal(logHits(text, { sinceMs: t0, pathname: heb }).length, 1);
    assert.deepEqual(logHits(text, { sinceMs: Date.now() + 60000 }), []);
    assert.equal(logHits(text, { sinceMs: t0 }).length, 5);
  }, (dir) => { logFile = path.join(dir, 'access.log'); return { logFile }; });
});

const SAMPLE = [
  '2026-01-01T00:00:00.000Z GET / 200',
  '2026-01-01T00:00:01.000Z HEAD /page.html 200',
  '2026-01-01T00:00:02.000Z GET /page.html?v=2 200',
  'show-local: some unrelated stdout noise',
  '',
  '2026-01-01T00:00:03.000Z GET /page.html/extra 404',
  '2026-01-01T00:00:04.000Z POST /page.html 405',
  '2026-01-01T00:00:05.000Z GET /page.htmlx 404',
  'not-a-date GET /page.html 200',
  '2026-01-01T00:00:06.000Z GET /page.html 2000',
  '2026-01-01T00:00:07.000Z GET /page.html 200 trailing',
  '2026-01-01T00:00:08.000Z GET /page.html 206',
].join('\r\n');
const at = (s) => Date.parse(`2026-01-01T00:00:0${s}.000Z`);

test('logHits: parses lines into {line, time, method, url, status}', () => {
  const [first] = logHits(SAMPLE);
  assert.deepEqual(first, { line: '2026-01-01T00:00:00.000Z GET / 200', time: at(0), method: 'GET', url: '/', status: 200, ua: '' });
  assert.equal(typeof first.status, 'number');
});

test('logHits: defaults to GET, keeps order, skips noise, CRLF and malformed lines', () => {
  const hits = logHits(SAMPLE);
  assert.deepEqual(hits.map((h) => h.url), ['/', '/page.html?v=2', '/page.html/extra', '/page.htmlx', '/page.html']);
  assert.ok(hits.every((h) => !h.line.includes('\r')));
});

test('logHits: sinceMs is inclusive', () => {
  assert.deepEqual(logHits(SAMPLE, { sinceMs: at(2) }).map((h) => h.url), ['/page.html?v=2', '/page.html/extra', '/page.htmlx', '/page.html']);
  assert.deepEqual(logHits(SAMPLE, { sinceMs: at(2) + 1 }).map((h) => h.url), ['/page.html/extra', '/page.htmlx', '/page.html']);
  assert.deepEqual(logHits(SAMPLE, { sinceMs: at(9) }), []);
});

test('logHits: pathname matches exactly, ignoring the query string only', () => {
  assert.deepEqual(logHits(SAMPLE, { pathname: '/page.html' }).map((h) => [h.url, h.status]), [['/page.html?v=2', 200], ['/page.html', 206]]);
  assert.deepEqual(logHits(SAMPLE, { pathname: '/' }).map((h) => h.url), ['/']);
  assert.deepEqual(logHits(SAMPLE, { pathname: '/nope' }), []);
});

test('logHits: method selects other verbs', () => {
  assert.deepEqual(logHits(SAMPLE, { method: 'HEAD' }).map((h) => h.url), ['/page.html']);
  assert.deepEqual(logHits(SAMPLE, { method: 'POST', pathname: '/page.html' }).map((h) => h.status), [405]);
  assert.deepEqual(logHits(SAMPLE, { method: 'get' }), [], 'method comparison is exact');
});

test('logHits: empty, missing and Buffer input', () => {
  assert.deepEqual(logHits(''), []);
  assert.deepEqual(logHits(undefined), []);
  assert.deepEqual(logHits(null), []);
  assert.deepEqual(logHits('\n\n\r\n'), []);
  assert.equal(logHits(Buffer.from(SAMPLE, 'utf8')).length, 5);
});

test('logHits: requests made by show-local itself (user agent "show-local") never count as the browser', () => {
  const text = [
    '2026-01-01T00:00:00.000Z GET / 200 "show-local"',
    '2026-01-01T00:00:01.000Z GET / 200 "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140"',
    '2026-01-01T00:00:02.000Z GET / 200 "SHOW-LOCAL/1.0"',
  ].join('\n');
  const hits = logHits(text);
  assert.equal(hits.length, 1);
  assert.match(hits[0].ua, /Mozilla/);
});

test('Access log: the user agent is logged, quotes and newlines in it cannot forge a line', async () => {
  let logFile;
  await withSite(async ({ port }) => {
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/page.html', headers: { 'user-agent': 'evil" 200 "x' } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end();
    });
    const lines = readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    assert.match(last, LOG_LINE, last);
    assert.ok(!last.slice(last.indexOf('"') + 1, -1).includes('"'), 'no quote survives inside the logged agent');

    // Node's own client refuses CR/LF in a header, so newlines go over a raw socket: CRLF (a
    // second "header" that reads like a log line), bare LF, bare CR and a folded header.
    const forged = '2026-01-01T00:00:00.000Z GET /forged 200 "Mozilla/5.0"';
    for (const ua of [`evil\r\n${forged}`, `evil\n${forged}`, `evil\r${forged}`, `evil\r\n ${forged}`]) {
      const r = await raw(port, `GET /page.html HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUser-Agent: ${ua}\r\nConnection: close\r\n\r\n`);
      assert.ok(r.status === 200 || r.status === 400, `${JSON.stringify(ua)} -> ${r.status}`);
    }
    const after = readFileSync(logFile, 'utf8');
    assert.ok(after.endsWith('\n'), 'every entry ends its own line');
    for (const line of after.split('\n').filter(Boolean)) {
      assert.match(line, LOG_LINE, `every line is one well-formed entry: ${JSON.stringify(line)}`);
      assert.ok(!line.includes('/forged'), `nothing from inside the user agent became (part of) a line: ${JSON.stringify(line)}`);
    }
  }, (dir) => { logFile = path.join(dir, 'ua.log'); return { logFile }; });
});
