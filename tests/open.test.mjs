// lib/open.mjs (the open/verify half of show()) and lib/portowner.mjs.
// A recording fake adapter stands in for the OS: nothing here opens a window, a browser or an
// app, and the OS lookups (netstat, PowerShell, ps, lsof, /proc) are faked per platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fakeRun, freePort, lib, ROOT, tempDir } from './helpers.mjs';

const { show, waitForHttp } = await import(lib('open.mjs'));
const { belongsTo, listeningPid, listeningPids, processInfo, windowsArgv } = await import(lib('portowner.mjs'));
const { createStaticServer, listen } = await import(lib('server.mjs'));

const write = (file, text = '') => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
const canonical = (p) => realpathSync.native(p);
const BROWSER_UA = 'Mozilla/5.0 (fake browser for tests)';

/** A GET as the browser would make it (any user agent other than show-local's). */
const browserGet = (url, ua = BROWSER_UA) => new Promise((resolve) => {
  const req = http.get(url, { headers: { 'user-agent': ua }, agent: false }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
  req.on('error', resolve);
});

/**
 * A recording adapter. `win` is the watcher's verdict (or 'pending': it settles only when
 * cancelled), `open` what every open* returns, `onOpen(url)` runs inside openUrl.
 */
function fakeAdapter({ win = { matched: null, reason: 'fake watcher' }, open = { ok: true, with: 'Fake Browser', how: 'fake' }, onOpen = null, browser = { name: 'Fake Browser', process: 'fakebrowser' }, app = { name: 'Viewer', process: 'viewer' } } = {}) {
  const calls = [];
  const watchers = [];
  const watch = (fn) => (args) => {
    calls.push({ fn, args });
    const w = { cancelled: false };
    let settle;
    const result = win === 'pending' ? new Promise((r) => { settle = r; }) : Promise.resolve(win);
    w.cancel = () => { w.cancelled = true; settle?.({ matched: null, reason: 'cancelled' }); };
    watchers.push(w);
    return { ready: Promise.resolve(), result, cancel: w.cancel };
  };
  return {
    calls,
    watchers,
    only: (fn) => calls.filter((c) => c.fn === fn),
    resolveBrowser() { calls.push({ fn: 'resolveBrowser', args: [] }); return browser; },
    // A real browser asks for the page a moment after it is opened, never in the same millisecond.
    async openUrl(url, b) { calls.push({ fn: 'openUrl', args: [url, b] }); if (onOpen) { await new Promise((r) => setTimeout(r, 5)); await onOpen(url); } return open; },
    async openFolder(dir, sel) { calls.push({ fn: 'openFolder', args: [dir, sel] }); return open; },
    async openApp(file, a) { calls.push({ fn: 'openApp', args: [file, a] }); return open; },
    appFor(file) { calls.push({ fn: 'appFor', args: [file] }); return app; },
    watchWindows: watch('watchWindows'),
    watchAppWindows: watch('watchAppWindows'),
    watchFolder: watch('watchFolder'),
  };
}

/**
 * A real show-local static server on a free port, writing its access log to `logFile`.
 * The log exists up front (as `serve` makes it) unless `createLog` is false: then the server
 * creates it on its first request.
 */
async function withSite(fn, { createLog = true } = {}) {
  const { dir, cleanup } = tempDir();
  const root = path.join(dir, 'site');
  write(path.join(root, 'index.html'), '<!doctype html><title>Fake Home</title><p>home</p>');
  write(path.join(root, 'שלום.html'), '<!doctype html><title>שלום</title>');
  const logFile = path.join(dir, 'server.log');
  if (createLog) write(logFile, '');
  const port = await freePort();
  const server = createStaticServer({ root, port, logFile, echo: false });
  await listen(server, port);
  try {
    await fn({ dir, root, port, logFile, url: `http://127.0.0.1:${port}/` });
  } finally {
    server.close();
    server.closeAllConnections?.();
    cleanup();
  }
}

/** A plain HTTP server on 127.0.0.1 with a custom handler; sockets are tracked so it always closes. */
async function withHttp(handler, fn) {
  const port = await freePort();
  const sockets = new Set();
  const srv = http.createServer(handler);
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  try { await fn(port); } finally { srv.close(); for (const s of sockets) s.destroy(); }
}

// ---------------------------------------------------------------------------------------------
// URL mode against a local server: verdicts, confidence and the server-log proof
// ---------------------------------------------------------------------------------------------

test('local URL: the window verdict alone maps to verified true/high, false and null; nothing weaker is true', async (t) => {
  await withSite(async ({ url, port }) => {
    const cases = [
      ['matched, high', { matched: true, confidence: 'high', title: 'Fake Home - Fake Browser', process: 'fakebrowser' }, true, 'high'],
      // A low-confidence match (as older watchers reported) is not proof: it never becomes verified:true.
      ['matched, low (legacy)', { matched: true, confidence: 'low', title: 'Fake Home - Fake Browser', reason: 'a window with this title was already open before' }, null, null],
      ['matched, no confidence', { matched: true, title: 'Fake Home - Fake Browser' }, null, null],
      ['already open (null with a title)', { matched: null, title: 'Fake Home - Fake Browser', reason: 'a window with this title was already open before, and no new one appeared within 300 ms, so this open cannot be told apart from it' }, null, null],
      ['not matched', { matched: false, reason: 'no new window matching the target appeared within 300 ms' }, false, null],
      ['cannot tell', { matched: null, reason: 'this system does not expose window titles' }, null, null],
    ];
    for (const [label, win, verified, confidence] of cases) {
      await t.test(label, async () => {
        const adapter = fakeAdapter({ win });
        const r = await show(url, { adapter, timeoutMs: 300, cwd: ROOT });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.opened, true);
        assert.equal(r.verified, verified);
        assert.equal(r.confidence, confidence);
        assert.equal(r.evidence[0], `HTTP 200 from 127.0.0.1:${port}`);
        assert.deepEqual(r.window, win);
        const [watch] = adapter.only('watchWindows');
        assert.deepEqual(watch.args.tokens, ['Fake Home'], 'the page title, read from the server, is the token');
        assert.deepEqual(watch.args.processes, ['fakebrowser']);
        assert.deepEqual(adapter.only('openUrl')[0].args, [url, { name: 'Fake Browser', process: 'fakebrowser' }]);
        if (verified === true) assert.equal(r.evidence[1], 'window "Fake Home - Fake Browser" (fakebrowser)');
        else assert.equal(r.evidence[1].startsWith('window "'), false, `no window is cited as proof: ${r.evidence[1]}`);
        if (win.matched === null && win.title) assert.equal(r.evidence[1], `${win.reason} (window "${win.title}")`);
      });
    }
  });
});

test("--log: a browser GET logged just before the open (inside the old 100 ms slack) is not proof", async () => {
  await withSite(async ({ url, logFile }) => {
    // The watcher's "ready" is the last step before the open: a GET made there lands in the log
    // a few milliseconds before the moment of opening.
    const calls = [];
    const adapter = {
      resolveBrowser: () => ({ name: 'Fake Browser', process: 'fakebrowser' }),
      watchWindows: (args) => { calls.push(args); return { ready: browserGet(url), result: Promise.resolve({ matched: null, reason: 'fake watcher' }), cancel() {} }; },
      async openUrl() { return { ok: true, with: 'Fake Browser', how: 'fake' }; },
    };
    const r = await show(url, { adapter, timeoutMs: 400, logFile, cwd: ROOT });
    assert.equal(calls.length, 1);
    assert.equal(r.verified, null, JSON.stringify(r));
    assert.ok(r.evidence.includes('server log: no GET of this page from the browser after opening'), r.evidence.join(' | '));
  });
});

test('local URL without a <title>: no watcher runs (nothing to recognise), verified null with the reason', async () => {
  await withHttp((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<p>no title here</p>'); }, async (port) => {
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'would be wrong' } });
    const r = await show(`http://127.0.0.1:${port}/`, { adapter, timeoutMs: 300, cwd: ROOT });
    assert.equal(r.opened, true, JSON.stringify(r));
    assert.equal(r.verified, null);
    assert.equal(r.confidence, null);
    assert.equal(adapter.only('watchWindows').length, 0);
    assert.match(r.evidence[1], /the page has no <title>, so no window can be recognised/);
  });
});

test("local URL + --log: the browser's own GET after opening is high-confidence proof, even when the window says no", async () => {
  await withSite(async ({ url, logFile }) => {
    const adapter = fakeAdapter({ win: { matched: false, reason: 'no window' }, onOpen: (u) => browserGet(u) });
    const r = await show(url, { adapter, timeoutMs: 3000, logFile, cwd: ROOT });
    assert.equal(r.verified, true, JSON.stringify(r));
    assert.equal(r.confidence, 'high');
    assert.ok(r.evidence.some((e) => /^server log: \S+ GET \/ 200 "Mozilla/.test(e)), r.evidence.join(' | '));
  });
});

test("--log: show-local's own readiness probe is never taken for the browser", async () => {
  await withSite(async ({ url, logFile }) => {
    // The "browser" here identifies as show-local: exactly what the probe looks like in the log.
    const adapter = fakeAdapter({ onOpen: (u) => browserGet(u, 'show-local/9.9') });
    const r = await show(url, { adapter, timeoutMs: 500, logFile, cwd: ROOT });
    assert.equal(r.verified, null, JSON.stringify(r));
    assert.ok(r.evidence.includes('server log: no GET of this page from the browser after opening'), r.evidence.join(' | '));
  });
});

test('--log: only the exact page path counts ("/" is not "/index.html"), and percent-encoded names are decoded', async (t) => {
  await withSite(async ({ url, logFile }) => {
    await t.test('/index.html is another path than /', async () => {
      const adapter = fakeAdapter({ onOpen: () => browserGet(`${url}index.html`) });
      const r = await show(url, { adapter, timeoutMs: 800, logFile, cwd: ROOT });
      assert.equal(r.verified, null, JSON.stringify(r));
      assert.ok(r.evidence.includes('server log: no GET of this page from the browser after opening'), r.evidence.join(' | '));
    });
    await t.test('Hebrew file name', async () => {
      const page = `${url}${encodeURIComponent('שלום.html')}`;
      const adapter = fakeAdapter({ onOpen: (u) => browserGet(u) });
      const r = await show(page, { adapter, timeoutMs: 3000, logFile, cwd: ROOT });
      assert.equal(r.verified, true, JSON.stringify(r));
      assert.deepEqual(adapter.only('watchWindows')[0].args.tokens, ['שלום']);
    });
  });
});

test('--log: a browser GET from before this open (an old tab) is not proof', async () => {
  await withSite(async ({ url, logFile }) => {
    await browserGet(url);
    await new Promise((r) => setTimeout(r, 400));
    const r = await show(url, { adapter: fakeAdapter(), timeoutMs: 500, logFile, cwd: ROOT });
    assert.equal(r.verified, null, JSON.stringify(r));
  });
});

test('--log is honoured even when the log file does not exist yet (server started a moment ago)', async () => {
  await withSite(async ({ url, logFile }) => {
    // Nothing has been requested yet, so the server has not created its log.
    assert.equal(existsSync(logFile), false);
    const adapter = fakeAdapter({ onOpen: (u) => browserGet(u) });
    const r = await show(url, { adapter, timeoutMs: 3000, logFile, cwd: ROOT });
    assert.equal(r.verified, true, JSON.stringify(r));
    assert.ok(r.evidence.some((e) => e.startsWith('server log: ')), r.evidence.join(' | '));
  }, { createLog: false });
});

test('--log on a network path is ignored on Windows, with a note (no SMB connection)', async () => {
  await withSite(async ({ url }) => {
    const r = await show(url, { adapter: fakeAdapter(), timeoutMs: 300, logFile: '\\\\show-local-test.invalid\\share\\server.log', platform: 'win32', cwd: ROOT });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.notes?.some((n) => /--log is a network path/.test(n)), JSON.stringify(r));
    assert.ok(!r.evidence.some((e) => e.startsWith('server log')), 'the network log was never read');
  });
});

test('--no-verify: no watcher at all, verified null, evidence says so', async () => {
  await withSite(async ({ url }) => {
    const adapter = fakeAdapter();
    const r = await show(url, { adapter, verify: false, cwd: ROOT });
    assert.equal(r.opened, true);
    assert.equal(r.verified, null);
    assert.deepEqual(r.evidence, ['verification skipped (--no-verify)']);
    assert.equal(adapter.only('watchWindows').length, 0);
  });
});

test('open failure: the watcher is cancelled at once and the result is open-failed', async () => {
  await withSite(async ({ url }) => {
    const adapter = fakeAdapter({ win: 'pending', open: { ok: false, error: 'no browser' } });
    const t0 = Date.now();
    const r = await show(url, { adapter, timeoutMs: 60000, cwd: ROOT });
    assert.equal(r.ok, false);
    assert.equal(r.opened, false);
    assert.equal(r.error, 'open-failed');
    assert.equal(r.detail, 'no browser');
    assert.equal(adapter.watchers.length, 1);
    assert.equal(adapter.watchers[0].cancelled, true);
    assert.ok(Date.now() - t0 < 20000, 'did not wait for the watcher timeout');
  });
});

test('a local server that never answers: server-not-responding, and nothing is opened', async () => {
  const port = await freePort();
  const adapter = fakeAdapter();
  const r = await show(`http://127.0.0.1:${port}/`, { adapter, waitMs: 300, cwd: ROOT });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'server-not-responding');
  assert.equal(adapter.only('openUrl').length, 0);
});

test('waitForHttp: localhost falls back to 127.0.0.1; a 404 is "not ready" unless any status is accepted', async () => {
  await withHttp((q, s) => { s.writeHead(q.url === '/' ? 404 : 200); s.end('x'); }, async (port) => {
    const strict = await waitForHttp(`http://localhost:${port}/`, 600);
    assert.equal(strict.ok, false);
    assert.equal(strict.status, 404);
    const any = await waitForHttp(`http://localhost:${port}/`, 600, { anyStatus: true });
    assert.equal(any.ok, true);
    assert.equal(any.status, 404);
    const page = await waitForHttp(`http://localhost:${port}/page`, 600);
    assert.equal(page.ok, true);
  });
});

// ---------------------------------------------------------------------------------------------
// The HTTP gate: only a 200 (after following redirects, as the browser will) opens anything
// ---------------------------------------------------------------------------------------------

test('waitForHttp: 204, 302 without a Location, 304 and 3xx loops are not ready; the result says where it ended', async () => {
  const hops = [];
  await withHttp((q, s) => {
    hops.push(q.url);
    if (q.url === '/empty') { s.writeHead(204); s.end(); return; }
    if (q.url === '/nowhere') { s.writeHead(302); s.end(); return; }
    if (q.url === '/cached') { s.writeHead(304); s.end(); return; }
    if (q.url.startsWith('/loop')) { const n = Number(q.url.slice(5) || 0); s.writeHead(302, { location: `/loop${n + 1}` }); s.end(); return; }
    if (q.url === '/a') { s.writeHead(301, { location: '/b' }); s.end(); return; }
    if (q.url === '/b') { s.writeHead(307, { location: 'http://127.0.0.1:' + s.socket.localPort + '/c' }); s.end(); return; }
    s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>C</title>');
  }, async (port) => {
    const at = (p) => `http://127.0.0.1:${port}${p}`;
    for (const [p, status] of [['/empty', 204], ['/nowhere', 302], ['/cached', 304]]) {
      const r = await waitForHttp(at(p), 400);
      assert.equal(r.ok, false, p);
      assert.equal(r.status, status, p);
      assert.equal(r.hops, 0, p);
      assert.equal(r.finalUrl, at(p), p);
    }
    const loop = await waitForHttp(at('/loop'), 400);
    assert.equal(loop.ok, false);
    assert.equal(loop.status, 302);
    assert.equal(loop.hops, 5, 'it follows at most 5 redirects');
    assert.equal(loop.why, 'it redirected more than 5 times');
    const chain = await waitForHttp(at('/a'), 2000);
    assert.equal(chain.ok, true, JSON.stringify(chain));
    assert.equal(chain.status, 200);
    assert.equal(chain.hops, 2);
    assert.equal(chain.finalUrl, at('/c'));
    assert.match(chain.body, /<title>C<\/title>/);
  });
});

test('waitForHttp: a redirect to a remote page is followed only when it is plain, and needs a 2xx there', async () => {
  const local = 'http://127.0.0.1:1/';
  const login = 'https://accounts.example.com/login?state=one-time';
  const plain = 'https://docs.example.com/welcome';
  const fetchFn = fakeFetch({
    [local]: { status: 302, headers: { location: login } },
    'http://127.0.0.1:2/': { status: 302, headers: { location: plain } },
    [plain]: { status: 200, body: '<title>Welcome</title>' },
    'http://127.0.0.1:3/': { status: 302, headers: { location: 'https://docs.example.com/gone' } },
    'https://docs.example.com/gone': { status: 410 },
  });
  const t0 = Date.now();
  const stopped = await waitForHttp(local, 3000, { fetchFn });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.status, 302);
  assert.match(stopped.why, /^it redirected to accounts\.example\.com, which is not fetched because it has a query$/);
  assert.ok(Date.now() - t0 < 1500, 'a page that must not be fetched cannot become ready by waiting: no polling');
  assert.ok(!fetchFn.calls.some((c) => c.url === login), 'the one-time link was never fetched');
  const remote = await waitForHttp('http://127.0.0.1:2/', 1000, { fetchFn });
  assert.equal(remote.ok, true);
  assert.equal(remote.status, 200);
  assert.equal(remote.finalUrl, plain);
  assert.equal(remote.hops, 1);
  const gone = await waitForHttp('http://127.0.0.1:3/', 400, { fetchFn });
  assert.equal(gone.ok, false);
  assert.equal(gone.status, 410);
});

test('waitForHttp: a plain remote address the redirects lead to is fetched once per wait, never polled', async (t) => {
  const sso = 'https://sso.example.com/login';
  const cases = [
    ['it answers 403 to a client that is not a browser', sso, { [sso]: { status: 403 } }, { status: 403, error: null }],
    ['it does not answer at all', 'https://sso-down.example.com/login', {}, { status: null, error: 'ENOTFOUND' }],
  ];
  for (const [label, remote, pages, want] of cases) {
    await t.test(label, async () => {
      // Every localhost variant redirects there, as one server on all of them would.
      const local = Object.fromEntries(['localhost', '127.0.0.1', '[::1]'].map((h) => [`http://${h}:1/`, { status: 302, headers: { location: remote } }]));
      const fetchFn = fakeFetch({ ...local, ...pages });
      const t0 = Date.now();
      const r = await waitForHttp('http://localhost:1/', 2000, { fetchFn });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.status, want.status);
      assert.equal(r.error, want.error);
      assert.equal(r.remote, true);
      assert.equal(r.finalUrl, remote);
      assert.equal(fetchFn.calls.filter((c) => c.url === remote).length, 1, 'the remote site sees one request, not one per variant and pass');
      assert.ok(Date.now() - t0 < 1000, 'waiting cannot change a remote answer: no polling');
    });
  }
});

test('the readiness check asks for a page as a browser does (Accept: text/html), so an SPA deep link is served', async () => {
  // connect-history-api-fallback (webpack-dev-server, CRA, Vue CLI) rewrites a deep link to
  // index.html only for a request whose Accept header takes text/html; any other gets a 404.
  const seen = [];
  await withHttp((q, s) => {
    seen.push(q.headers.accept);
    const html = typeof q.headers.accept === 'string' && q.headers.accept.includes('text/html');
    if (q.url !== '/' && !html) { s.writeHead(404); s.end('Cannot GET'); return; }
    s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>Dashboard</title>');
  }, async (port) => {
    const url = `http://127.0.0.1:${port}/dashboard`;
    const up = await waitForHttp(url, 600);
    assert.equal(up.ok, true, JSON.stringify({ ...up, body: undefined }));
    assert.equal(up.status, 200);
    const adapter = fakeAdapter();
    const r = await show(url, { adapter, timeoutMs: 100, cwd: ROOT });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(adapter.only('openUrl').map((c) => c.args[0]), [url]);
    assert.deepEqual(adapter.only('watchWindows')[0].args.tokens, ['Dashboard']);
    assert.ok(seen.every((a) => /text\/html/.test(a)), JSON.stringify(seen));
  });
});

test('a local page that redirects to a hosted sign-in (a one-time query) opens, unverified, and the sign-in is never fetched', async () => {
  const signIn = 'https://my-app.accounts.dev/sign-in?redirect_url=http%3A%2F%2Flocalhost%3A3000%2F';
  const remote = [];
  const saved = https.request;
  // Only the local http server is asked; any https request would be the sign-in link.
  https.request = (...a) => { remote.push(String(a[0])); return saved(...a); };
  try {
    await withHttp((q, s) => { s.writeHead(307, { location: signIn }); s.end(); }, async (port) => {
      const url = `http://127.0.0.1:${port}/`;
      const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'would be wrong' } });
      const t0 = Date.now();
      const r = await show(url, { adapter, timeoutMs: 200, cwd: ROOT });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.opened, true);
      assert.equal(r.error, undefined);
      assert.deepEqual(adapter.only('openUrl').map((c) => c.args[0]), [url], 'the browser gets the local address and follows the redirect itself');
      assert.equal(adapter.only('watchWindows').length, 0, 'no title, so no watcher');
      assert.equal(r.verified, null);
      assert.equal(r.evidence[0], `HTTP 307 from 127.0.0.1:${port}`);
      assert.match(r.evidence[1], /^the page title is not known: it redirected to my-app\.accounts\.dev, which is not fetched because it has a query/);
      assert.ok(r.notes?.some((n) => /^the remote address the page redirects to was not fetched before opening: .*a fetch could spend a one-time link$/.test(n)), JSON.stringify(r.notes));
      assert.ok(Date.now() - t0 < 3000, 'no wait for a server that already answered');
    });
  } finally { https.request = saved; }
  assert.deepEqual(remote, [], 'the one-time sign-in link was never fetched');
});

test('a local page that redirects only a request without cookies (a sign-in) is never verified false by a missing window', async (t) => {
  // A signed-in browser gets the dashboard at /; show-local's check, with no cookies, is sent to /login.
  await withHttp((q, s) => {
    if (q.url === '/' && /sid=1/.test(q.headers.cookie || '')) { s.end('<title>Dashboard</title>'); return; }
    if (q.url === '/') { s.writeHead(302, { location: '/login' }); s.end(); return; }
    s.end('<title>Sign in</title>');
  }, async (port) => {
    const url = `http://127.0.0.1:${port}/`;
    await t.test('the window never shows "Sign in": null, with why', async () => {
      const adapter = fakeAdapter({ win: { matched: false, reason: 'no new or changed window containing "sign in" appeared within 200 ms' } });
      const r = await show(url, { adapter, timeoutMs: 200, cwd: ROOT });
      assert.equal(r.opened, true, JSON.stringify(r));
      assert.deepEqual(adapter.only('watchWindows')[0].args.tokens, ['Sign in'], 'the page the check reached is still looked for');
      assert.equal(r.verified, null, JSON.stringify(r));
      assert.equal(r.window.matched, null);
      assert.match(r.evidence[1], /^no new or changed window containing "sign in" appeared within 200 ms; the page redirected when show-local fetched it without the browser's cookies/);
    });
    await t.test('a window that does show it is still proof', async () => {
      const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'Sign in - Fake Browser' } });
      const r = await show(url, { adapter, timeoutMs: 200, cwd: ROOT });
      assert.equal(r.verified, true, JSON.stringify(r));
    });
  });
});

test('the gate: /sub without an index answers 301 then 404, so nothing opens and the error says so', async () => {
  const { dir, cleanup } = tempDir();
  const root = path.join(dir, 'site');
  write(path.join(root, 'index.html'), '<title>Home</title>');
  mkdirSync(path.join(root, 'sub'));
  write(path.join(root, 'sub', 'notes.txt'), 'no index here');
  const port = await freePort();
  const server = createStaticServer({ root, port, echo: false });
  await listen(server, port);
  try {
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'Not found' } });
    const r = await show(`http://127.0.0.1:${port}/sub`, { adapter, waitMs: 600, timeoutMs: 300, cwd: ROOT });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'server-not-responding');
    assert.equal(r.verified, false);
    assert.match(r.detail, /only answered HTTP 404 after 1 redirect, at \/sub\/ within 600 ms; nothing was opened\.$/);
    assert.equal(adapter.only('openUrl').length, 0, 'no window was opened');
    assert.equal(adapter.only('watchWindows').length, 0);
  } finally { server.close(); server.closeAllConnections?.(); cleanup(); }
});

test('the gate: /sub that redirects to /sub/ with an index.html is ready, and the log proof is the GET of /sub/', async (t) => {
  const { dir, cleanup } = tempDir();
  const root = path.join(dir, 'site');
  write(path.join(root, 'index.html'), '<title>Home</title>');
  write(path.join(root, 'sub', 'index.html'), '<title>Sub page</title>');
  const logFile = path.join(dir, 'server.log');
  write(logFile, '');
  const port = await freePort();
  const server = createStaticServer({ root, port, logFile, echo: false });
  await listen(server, port);
  const url = `http://127.0.0.1:${port}/sub`;
  try {
    await t.test('the browser follows the 301: GET /sub/ 200 is the proof', async () => {
      const adapter = fakeAdapter({ win: { matched: false, reason: 'no window' }, onOpen: async (u) => { await browserGet(u); await browserGet(`${u}/`); } });
      const r = await show(url, { adapter, timeoutMs: 3000, logFile, cwd: ROOT });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.evidence[0], `HTTP 200 from 127.0.0.1:${port} after 1 redirect, at /sub/`);
      assert.deepEqual(adapter.only('watchWindows')[0].args.tokens, ['Sub page'], "the title is the final page's");
      assert.equal(adapter.only('openUrl')[0].args[0], url, 'the browser gets the address as asked, and follows the redirect itself');
      assert.equal(r.verified, true);
      assert.ok(r.evidence.some((e) => /^server log: \S+ GET \/sub\/ 200 "Mozilla/.test(e)), r.evidence.join(' | '));
    });
    await t.test('a GET that only reached the 301 proves nothing', async () => {
      const adapter = fakeAdapter({ onOpen: (u) => browserGet(u) });
      const r = await show(url, { adapter, timeoutMs: 800, logFile, cwd: ROOT });
      assert.equal(r.verified, null, JSON.stringify(r));
      assert.ok(r.evidence.includes('server log: no GET of this page from the browser after opening'), r.evidence.join(' | '));
    });
  } finally { server.close(); server.closeAllConnections?.(); cleanup(); }
});

test('the log proof: only 200, 206 or 304 for the exact path, never an Electron or Claude app user agent', async () => {
  const { logHits, NOT_THE_BROWSER } = await import(lib('server.mjs'));
  const claudePane = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.2553.13 Chrome/152.0.7977.76 Safari/537.36 MSIX';
  const electron = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SomeApp/1.0 Chrome/150.0.0.0 Electron/38.1.0 Safari/537.36';
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  for (const ua of [claudePane, electron, 'show-local', 'show-local/9.9', 'curl show-local']) assert.equal(NOT_THE_BROWSER.test(ua), true, ua);
  for (const ua of [chrome, 'Mozilla/5.0 (Macintosh) Firefox/140.0', 'Mozilla/5.0 (X11; Linux x86_64) Edg/150.0']) assert.equal(NOT_THE_BROWSER.test(ua), false, ua);
  const lines = [
    `2026-01-01T00:00:01.000Z GET / 200 "${claudePane}"`,
    `2026-01-01T00:00:02.000Z GET / 200 "${electron}"`,
    `2026-01-01T00:00:03.000Z GET / 200 "${chrome}"`,
  ].join('\n');
  assert.deepEqual(logHits(lines).map((h) => h.time), [Date.parse('2026-01-01T00:00:03.000Z')]);

  await withSite(async ({ url, logFile }) => {
    // Claude's own preview pane loads the page right after the open: that is not the user's browser.
    const pane = await show(url, { adapter: fakeAdapter({ onOpen: (u) => browserGet(u, claudePane) }), timeoutMs: 800, logFile, cwd: ROOT });
    assert.equal(pane.verified, null, JSON.stringify(pane));
    const app = await show(url, { adapter: fakeAdapter({ onOpen: (u) => browserGet(u, electron) }), timeoutMs: 800, logFile, cwd: ROOT });
    assert.equal(app.verified, null, JSON.stringify(app));
  });

  // 206 (a range request, e.g. a video page) and 304 count; 301, 404 and 500 do not.
  await withHttp((q, s) => s.end('<title>T</title>'), async (port) => {
    const { dir, cleanup } = tempDir();
    try {
      const logFile = path.join(dir, 'log.txt');
      for (const [status, proof] of [[206, true], [304, true], [301, false], [404, false], [500, false]]) {
        // Like a real browser, the request comes a moment after the open (never in the same millisecond).
        const adapter = fakeAdapter({ onOpen: async () => { await new Promise((r) => setTimeout(r, 5)); writeFileSync(logFile, `${new Date().toISOString()} GET / ${status} "${chrome}"\n`); } });
        const r = await show(`http://127.0.0.1:${port}/`, { adapter, timeoutMs: 600, logFile, cwd: ROOT });
        assert.equal(r.verified, proof ? true : null, `${status}: ${JSON.stringify(r.evidence)}`);
      }
    } finally { cleanup(); }
  });
});

/** Run fn with every http/https request trapped: it records the attempt and fails it. */
async function withNoNetwork(fn) {
  const fetched = [];
  const saved = { hr: http.request, hg: http.get, sr: https.request, sg: https.get };
  const trap = (name) => (...a) => { fetched.push(`${name} ${String(a[0])}`); throw new Error('network use is forbidden in this test'); };
  http.request = trap('http.request'); http.get = trap('http.get');
  https.request = trap('https.request'); https.get = trap('https.get');
  try { await fn(fetched); } finally {
    Object.assign(http, { request: saved.hr, get: saved.hg });
    Object.assign(https, { request: saved.sr, get: saved.sg });
  }
}

/** A stand-in for httpRequest: answers per URL from `pages`, and records every call. */
function fakeFetch(pages) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const p = pages[url];
    if (!p) return { ok: false, error: 'ENOTFOUND' };
    return { ok: true, status: p.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...(p.headers || {}) }, body: p.body ?? '' };
  };
  fn.calls = calls;
  return fn;
}

test('a remote URL with a query is not fetched before opening, and gives verified null with a clear reason', async () => {
  await withNoNetwork(async (fetched) => {
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'would be wrong' } });
    const url = 'https://example.com/invite/one-time?token=abc';
    const fetchFn = fakeFetch({});
    const r = await show(url, { adapter, timeoutMs: 200, cwd: ROOT, fetchFn });
    assert.equal(r.opened, true, JSON.stringify(r));
    assert.deepEqual(fetched, [], 'no request of any kind');
    assert.equal(fetchFn.calls.length, 0, 'the title fetch is never tried');
    assert.equal(adapter.only('openUrl')[0].args[0], url);
    assert.equal(adapter.only('watchWindows').length, 0, 'no title, so no watcher: no unrelated window can "verify" it');
    assert.equal(r.verified, null);
    assert.equal(r.confidence, null);
    assert.deepEqual(r.evidence, ['the page title is not known: the address was not fetched before opening, because it has a query, so no window can be recognised as this page']);
    assert.ok(r.notes?.some((n) => /^remote page not fetched before opening, because it has a query/.test(n)), JSON.stringify(r.notes));
  });
});

test('remote addresses that are not plain are never fetched: fragment, user info, long or token-like segments', async (t) => {
  const cases = [
    ['https://example.com/#access_token=abc', /it has a fragment/],
    ['https://example.com/?', /it has a query/],
    ['https://user:pw@example.com/', /user name or password/],
    ['https://example.com/reset/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', /longer than 32 characters/],
    ['https://example.com/invite/123e4567-e89b-12d3-a456-426614174000', /longer than 32|looks like a token/],
    ['https://example.com/verify/9f86d081884c7d659a2feaa0c55ad015', /looks like a token/],
    ['https://example.com/magic/eyJhbGciOiJIUzI1NiJ9', /looks like a token/],
    ['https://example.com/s/Q2xhdWRlQ29kZTEyMw==', /looks like a token/],
    ['https://example.com/l/aB3dE5fG7hJ9kL1m', /looks like a token/],
  ];
  for (const [url, why] of cases) {
    await t.test(url, async () => {
      const fetchFn = fakeFetch({ [url]: { body: '<title>Secret page</title>' } });
      const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'Secret page - Fake Browser' } });
      const r = await show(url, { adapter, timeoutMs: 200, cwd: ROOT, fetchFn });
      assert.equal(fetchFn.calls.length, 0, 'not fetched');
      assert.equal(adapter.only('watchWindows').length, 0);
      assert.equal(r.verified, null, JSON.stringify(r));
      assert.match(r.evidence[0], why);
    });
  }
});

test('unfetchableReason: plain addresses pass; queries, fragments, user info, long and token-like segments do not', async () => {
  const { unfetchableReason, PLAIN_SEGMENT_MAX } = await import(lib('open.mjs'));
  assert.equal(PLAIN_SEGMENT_MAX, 32);
  for (const url of [
    'https://example.com', 'https://example.com/', 'http://example.com/docs/intro.html',
    'https://github.com/anthropics/claude-code', 'https://en.wikipedia.org/wiki/Main_Page',
    'https://docs.python.org/3/library/os.html', 'https://example.com/blog/how-to-install-node-18-on-a-mac',
    'https://example.com/%D7%A9%D7%9C%D7%95%D7%9D', 'https://example.com/abcdefghijklmnopqrstuvwxyz-abcde',
    'https://github.com/anthropics/claude-code/issues/123', 'https://example.com/JavaScriptTutorial',
  ]) {
    assert.equal(unfetchableReason(url), null, url);
  }
  const not = {
    'https://example.com/?q=1': 'it has a query',
    'https://example.com/a?': 'it has a query',
    'https://example.com/a#b': 'it has a fragment',
    'https://example.com/a#': 'it has a fragment',
    'https://u@example.com/': 'it carries a user name or password',
    [`https://example.com/${'a'.repeat(33)}`]: 'a path segment is longer than 32 characters',
    'https://example.com/x/0123456789abcdef0': 'a path segment looks like a token',
    'https://example.com/x/123e4567e89b12d3a456426614174000': 'a path segment looks like a token',
    'https://example.com/x/123e4567-e89b-12d3-a456-426614174000': 'a path segment is longer than 32 characters',
    'https://example.com/x/eyJhbGciOi': 'a path segment looks like a token',
    'https://example.com/x/abcDEF12==': 'a path segment looks like a token',
    'https://example.com/x/Zm9vYmFyYmF6cXV4MTIz': 'a path segment looks like a token',
    'https://example.com/x/AbCdEfGhIjKlMnOpQrStUvWx': 'a path segment looks like a token',
    'not a url': 'it is not a valid URL',
  };
  for (const [url, why] of Object.entries(not)) assert.equal(unfetchableReason(url), why, url);
});

test('a plain remote URL is fetched once for its title, and the window showing that title is the proof', async () => {
  await withNoNetwork(async (fetched) => {
    const url = 'https://example.com/';
    const fetchFn = fakeFetch({ [url]: { body: '<!doctype html><title>Example   Domain</title>' } });
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'Example Domain - Fake Browser', process: 'fakebrowser', newWindow: false } });
    const r = await show(url, { adapter, timeoutMs: 200, cwd: ROOT, fetchFn });
    assert.deepEqual(fetched, [], 'only the injected fetch is used');
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(fetchFn.calls[0].url, url);
    assert.ok(fetchFn.calls[0].opts.timeoutMs <= 3000, 'the fetch stays within its budget');
    const [watch] = adapter.only('watchWindows');
    assert.deepEqual(watch.args.tokens, ['Example Domain'], 'the fetched title is what the window must show');
    assert.deepEqual(watch.args.processes, ['fakebrowser']);
    assert.equal(r.verified, true, JSON.stringify(r));
    assert.equal(r.confidence, 'high');
    assert.deepEqual(r.evidence, ['HTTP 200 from example.com', 'window "Example Domain - Fake Browser" (fakebrowser)']);
    assert.ok(r.notes?.some((n) => /fetched once before opening, for its title "Example Domain"/.test(n)), JSON.stringify(r.notes));
  });
});

test('a plain remote URL whose title never shows up is verified false; a title already open is null', async () => {
  const url = 'https://example.com/';
  const page = { [url]: { body: '<title>Example Domain</title>' } };
  const miss = await show(url, { adapter: fakeAdapter({ win: { matched: false, reason: 'no new or changed window containing "example domain" appeared within 200 ms (other windows changed their titles, but none showed it)' } }), timeoutMs: 200, cwd: ROOT, fetchFn: fakeFetch(page) });
  assert.equal(miss.opened, true);
  assert.equal(miss.verified, false, JSON.stringify(miss));
  assert.match(miss.evidence[1], /other windows changed their titles, but none showed it/);
  const pre = await show(url, { adapter: fakeAdapter({ win: { matched: null, title: 'Example Domain - Fake Browser', reason: 'a window showing this title was already open before' } }), timeoutMs: 200, cwd: ROOT, fetchFn: fakeFetch(page) });
  assert.equal(pre.verified, null, JSON.stringify(pre));
  assert.equal(pre.confidence, null);
});

test('the title fetch: redirects to plain addresses are followed; anything else leaves the title unknown (null)', async (t) => {
  const url = 'https://example.com/';
  await t.test('plain redirect followed, relative Location resolved', async () => {
    const fetchFn = fakeFetch({
      [url]: { status: 301, headers: { location: 'https://www.example.com/' } },
      'https://www.example.com/': { status: 302, headers: { location: '/en/' } },
      'https://www.example.com/en/': { body: '<title>Welcome</title>' },
    });
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'Welcome - Fake Browser' } });
    const r = await show(url, { adapter, timeoutMs: 200, cwd: ROOT, fetchFn });
    assert.deepEqual(fetchFn.calls.map((c) => c.url), [url, 'https://www.example.com/', 'https://www.example.com/en/']);
    assert.deepEqual(adapter.only('watchWindows')[0].args.tokens, ['Welcome']);
    assert.equal(r.verified, true);
    assert.equal(r.evidence[0], 'HTTP 200 from www.example.com');
  });
  const unknown = [
    ['redirect to a sign-in address with a query', { [url]: { status: 302, headers: { location: 'https://login.example.com/?next=/x' } } }, /redirected to an address that is not fetched, because it has a query/, 1],
    ['redirect to a local address', { [url]: { status: 302, headers: { location: 'http://127.0.0.1:8080/' } } }, /not a remote http\(s\) page/, 1],
    ['too many redirects', { [url]: { status: 302, headers: { location: url } } }, /redirected more than 3 times/, 4],
    ['an error status', { [url]: { status: 403, body: '<title>Just a moment...</title>' } }, /answered HTTP 403/, 1],
    ['not HTML', { [url]: { headers: { 'content-type': 'application/pdf' }, body: '%PDF' } }, /not an HTML page \(application\/pdf\)/, 1],
    ['another character set', { [url]: { headers: { 'content-type': 'text/html; charset=windows-1255' }, body: '<title>x</title>' } }, /character set \(windows-1255\)/, 1],
    ['a title that is not UTF-8', { [url]: { body: '<title>��</title>' } }, /could not be decoded/, 1],
    ['no <title>', { [url]: { body: '<p>hi</p>' } }, /the page has no <title>/, 1],
    ['the fetch fails', {}, /fetching it failed \(ENOTFOUND\)/, 1],
  ];
  for (const [label, pages, why, calls] of unknown) {
    await t.test(label, async () => {
      const fetchFn = fakeFetch(pages);
      const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'would be wrong' } });
      const r = await show(url, { adapter, timeoutMs: 200, cwd: ROOT, fetchFn });
      assert.equal(fetchFn.calls.length, calls);
      assert.equal(r.opened, true);
      assert.equal(adapter.only('watchWindows').length, 0, 'no title, so no watcher');
      assert.equal(r.verified, null, JSON.stringify(r));
      assert.match(r.evidence[0], /^the page title could not be learned before opening: /);
      assert.match(r.evidence[0], why);
    });
  }
});

test('the title fetch fits the 10 s budget of a direct open, with a second left to start the watcher and the browser', async () => {
  const { REMOTE_TITLE_MS, DEFAULT_TIMEOUT_MS } = await import(lib('open.mjs'));
  assert.ok(REMOTE_TITLE_MS + DEFAULT_TIMEOUT_MS <= 9000, `${REMOTE_TITLE_MS} + ${DEFAULT_TIMEOUT_MS}`);
  // A fetch that never answers is cut off at the budget, and the open still happens.
  const hanging = async (url, { timeoutMs }) => { await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 50))); return { ok: false, error: 'timeout' }; };
  const calls = [];
  const r = await show('https://example.com/', { adapter: fakeAdapter(), timeoutMs: 200, cwd: ROOT, fetchFn: async (u, o) => { calls.push(o.timeoutMs); return hanging(u, o); } });
  assert.equal(r.opened, true);
  assert.ok(calls.length === 1 && calls[0] <= REMOTE_TITLE_MS && calls[0] > 0, JSON.stringify(calls));
  assert.equal(r.verified, null);
  assert.match(r.evidence[0], /fetching it failed \(timeout\)/);
});

test('no watcher reports a low-confidence match any more: a match is high confidence or it is not a match', () => {
  const sources = {
    'win/windows.ps1': path.join(ROOT, 'plugins', 'show-local', 'scripts', 'win', 'windows.ps1'),
    'lib/util.mjs': lib('util.mjs'),
    'lib/adapters/mac.mjs': lib('adapters/mac.mjs'),
    'lib/adapters/linux.mjs': lib('adapters/linux.mjs'),
    'lib/adapters/win.mjs': lib('adapters/win.mjs'),
  };
  for (const [name, file] of Object.entries(sources)) {
    const text = readFileSync(file.startsWith('file:') ? new URL(file) : file, 'utf8');
    assert.doesNotMatch(text, /confidence\s*[:=]\s*['"]low['"]/, name);
    for (const m of text.matchAll(/matched\s*[:=]\s*\$?true\b[^\n]*/g)) assert.match(m[0], /confidence\s*[:=]\s*['"]high['"]/, `${name}: ${m[0]}`);
  }
});

test('--no-verify: a plain remote URL is not fetched either', async () => {
  const fetchFn = fakeFetch({ 'https://example.com/': { body: '<title>Example Domain</title>' } });
  const adapter = fakeAdapter();
  const r = await show('https://example.com/', { adapter, verify: false, cwd: ROOT, fetchFn });
  assert.equal(r.opened, true);
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(r.verified, null);
});

test('file mode: a plain HTML file opens as file:// with its <title> as the token, without any HTTP probe', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = write(path.join(dir, 'report.html'), '<!doctype html><title>Quarterly &amp; more</title><p>x</p>');
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'Quarterly & more' } });
    const r = await show(file, { adapter, timeoutMs: 200, cwd: ROOT });
    assert.equal(r.mode, 'file');
    assert.equal(r.verified, true);
    assert.match(adapter.only('openUrl')[0].args[0], /^file:\/\//);
    assert.deepEqual(adapter.only('watchWindows')[0].args.tokens, ['Quarterly & more']);
    assert.ok(!r.evidence.some((e) => e.startsWith('HTTP')));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// App mode
// ---------------------------------------------------------------------------------------------

test('app mode: the full file name and the PDF /Title are the tokens; the app process filters windows', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const pdf = write(path.join(dir, 'index.pdf'), '%PDF-1.4\n1 0 obj << /Title (Quarterly report 2026) >> endobj\n');
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'index.pdf - Viewer' } });
    const r = await show(pdf, { adapter, timeoutMs: 200, cwd: ROOT });
    assert.equal(r.mode, 'app', JSON.stringify(r));
    assert.equal(r.verified, true);
    assert.equal(r.confidence, 'high');
    const [watch] = adapter.only('watchAppWindows');
    assert.deepEqual(watch.args.tokens, ['index.pdf', 'Quarterly report 2026']);
    assert.deepEqual(watch.args.processes, ['viewer']);
    assert.deepEqual(adapter.only('openApp')[0].args, [pdf, { name: 'Viewer', process: 'viewer' }]);
  } finally { cleanup(); }
});

test('app mode: an open failure cancels the watcher', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const pdf = write(path.join(dir, 'a.pdf'), '%PDF-1.4');
    const adapter = fakeAdapter({ win: 'pending', open: { ok: false, error: 'no association' } });
    const r = await show(pdf, { adapter, timeoutMs: 60000, cwd: ROOT });
    assert.equal(r.error, 'open-failed');
    assert.equal(adapter.watchers[0].cancelled, true);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// Folder mode and --select
// ---------------------------------------------------------------------------------------------

/** out/ (a.html newest, sub/deep.png), other/x.png next to it. */
function outputs() {
  const t = tempDir();
  const out = path.join(t.dir, 'out');
  write(path.join(out, 'a.html'), '<title>a</title>');
  write(path.join(out, 'sub', 'deep.png'), 'png');
  write(path.join(t.dir, 'other', 'x.png'), 'png');
  return { ...t, out };
}

test('folder: the default pick is selected; opener and watcher get the same canonical folder', async () => {
  const { out, cleanup } = outputs();
  try {
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', path: out } });
    const r = await show(out, { adapter, timeoutMs: 200, cwd: ROOT });
    assert.equal(r.mode, 'folder');
    const dir = canonical(out);
    const sel = path.join(dir, 'a.html');
    assert.deepEqual(adapter.only('openFolder')[0].args, [dir, sel]);
    assert.equal(adapter.only('watchFolder')[0].args.dir, dir);
    assert.equal(adapter.only('watchFolder')[0].args.select, sel);
    assert.equal(r.folder, dir);
    assert.equal(r.select, sel);
    assert.equal(r.verified, true);
  } finally { cleanup(); }
});

test('--select deeper inside: the watcher waits for the subfolder the file manager actually shows', async () => {
  const { out, cleanup } = outputs();
  try {
    const adapter = fakeAdapter();
    const r = await show(out, { adapter, select: path.join('sub', 'deep.png'), timeoutMs: 200, cwd: ROOT });
    const dir = canonical(path.join(out, 'sub'));
    assert.deepEqual(adapter.only('openFolder')[0].args, [dir, path.join(dir, 'deep.png')]);
    assert.equal(adapter.only('watchFolder')[0].args.dir, dir);
    assert.equal(r.folder, dir);
    assert.equal(r.notes, undefined);
  } finally { cleanup(); }
});

test('--select outside the folder, missing, or a network path: default pick plus a note', async (t) => {
  const { dir: base, out, cleanup } = outputs();
  try {
    const cases = [
      ['relative ../', path.join('..', 'other', 'x.png'), /outside the folder/, process.platform],
      ['absolute elsewhere', path.join(base, 'other', 'x.png'), /outside the folder/, process.platform],
      ['missing', 'nope.png', /was not found/, process.platform],
      ['UNC on Windows', '\\\\show-local-test.invalid\\share\\x.png', /network path/, 'win32'],
      ['//host on Windows', '//show-local-test.invalid/share/x.png', /network path/, 'win32'],
    ];
    for (const [label, select, why, platform] of cases) {
      await t.test(label, async () => {
        const adapter = fakeAdapter();
        const r = await show(out, { adapter, select, platform, timeoutMs: 200, cwd: ROOT });
        const dir = canonical(out);
        assert.deepEqual(adapter.only('openFolder')[0].args, [dir, path.join(dir, 'a.html')], JSON.stringify(r));
        assert.ok(r.notes?.some((n) => why.test(n)), JSON.stringify(r.notes));
      });
    }
  } finally { cleanup(); }
});

test('plan: --select is reported as resolved, with the folder that will be shown', async () => {
  const { out, cleanup } = outputs();
  try {
    const deep = await show(out, { planOnly: true, select: path.join('sub', 'deep.png'), cwd: ROOT });
    assert.equal(deep.select, path.join(out, 'sub', 'deep.png'));
    assert.equal(deep.folder, path.join(out, 'sub'));
    const outside = await show(out, { planOnly: true, select: path.join('..', 'other', 'x.png'), cwd: ROOT });
    assert.equal(outside.select, path.join(out, 'a.html'));
    assert.equal(outside.folder, out);
    assert.ok(outside.notes?.some((n) => /outside the folder/.test(n)));
  } finally { cleanup(); }
});

test('a symlinked file is revealed where it sits, never where it points', async (t) => {
  const { dir: base, out, cleanup } = outputs();
  try {
    const target = write(path.join(base, 'renders', 'clip.mp4'), 'mp4');
    const link = path.join(out, 'latest.mp4');
    try { symlinkSync(target, link, 'file'); } catch (e) { t.skip(`symlinks unavailable here (${e.code})`); return; }
    const dir = canonical(out);
    await t.test('--select latest.mp4', async () => {
      const adapter = fakeAdapter();
      const r = await show(out, { adapter, select: 'latest.mp4', timeoutMs: 200, cwd: ROOT });
      assert.deepEqual(adapter.only('openFolder')[0].args, [dir, path.join(dir, 'latest.mp4')]);
      assert.equal(adapter.only('watchFolder')[0].args.dir, dir);
      assert.equal(r.select, path.join(dir, 'latest.mp4'));
    });
    await t.test('--folder on the link itself', async () => {
      const adapter = fakeAdapter();
      await show(link, { adapter, asFolder: true, timeoutMs: 200, cwd: ROOT });
      assert.deepEqual(adapter.only('openFolder')[0].args, [dir, path.join(dir, 'latest.mp4')]);
    });
  } finally { cleanup(); }
});

test('--select through a symlinked subfolder that leads outside the folder falls back', async (t) => {
  const { dir: base, out, cleanup } = outputs();
  try {
    try { symlinkSync(path.join(base, 'other'), path.join(out, 'linked'), 'junction'); } catch (e) { t.skip(`links unavailable here (${e.code})`); return; }
    const adapter = fakeAdapter();
    const r = await show(out, { adapter, select: path.join('linked', 'x.png'), timeoutMs: 200, cwd: ROOT });
    const dir = canonical(out);
    assert.deepEqual(adapter.only('openFolder')[0].args, [dir, path.join(dir, 'a.html')]);
    assert.ok(r.notes?.some((n) => /leads outside the folder/.test(n)), JSON.stringify(r.notes));
  } finally { cleanup(); }
});

test('folder: open failure cancels the watcher; --no-verify creates none', async () => {
  const { out, cleanup } = outputs();
  try {
    const failing = fakeAdapter({ win: 'pending', open: { ok: false, error: 'explorer failed' } });
    const r = await show(out, { adapter: failing, timeoutMs: 60000, cwd: ROOT });
    assert.equal(r.error, 'open-failed');
    assert.equal(failing.watchers[0].cancelled, true);
    const quiet = fakeAdapter();
    const q = await show(out, { adapter: quiet, verify: false, cwd: ROOT });
    assert.equal(q.verified, null);
    assert.equal(quiet.only('watchFolder').length, 0);
    assert.equal(q.selected, null, 'nothing watched, so the selection could not be checked');
  } finally { cleanup(); }
});

test('folder: selected is true, false or null as the watcher saw it; not selected keeps verified but says so', async (t) => {
  const { out, cleanup } = outputs();
  try {
    const dir = canonical(out);
    const window = (extra) => ({ matched: true, confidence: 'high', path: dir, newWindow: true, ...extra });
    const cases = [
      ['selected', window({ selected: [path.join(dir, 'a.html')], selectedOk: true }), true, true],
      ['opened but not selected', window({ selected: [], selectedOk: false, reason: 'the folder opened but the expected file was not selected' }), true, false],
      ['selection unknown (macOS, Linux)', window({ selectedOk: null }), true, null],
      ['older watcher without selectedOk', window({}), true, null],
      ['no window at all', { matched: false, reason: 'no file manager window on the folder appeared within 200 ms' }, false, null],
      ['already open before', { matched: null, path: dir, selectedOk: true, reason: 'an Explorer window on this folder was already open before' }, null, null],
    ];
    for (const [label, win, verified, selected] of cases) {
      await t.test(label, async () => {
        const r = await show(out, { adapter: fakeAdapter({ win }), timeoutMs: 200, cwd: ROOT });
        assert.equal(r.verified, verified, JSON.stringify(r));
        assert.equal(r.selected, selected);
        if (selected === false) {
          assert.equal(r.evidence.length, 2, JSON.stringify(r.evidence));
          assert.equal(r.evidence[0], `file manager window on ${dir}`);
          assert.equal(r.evidence[1], 'the folder opened but a.html was not selected');
        } else {
          assert.ok(!r.evidence.some((e) => /was not selected/.test(e)), JSON.stringify(r.evidence));
        }
      });
    }
    await t.test('a folder open that asked to select nothing has no selected field', async () => {
      const empty = path.join(out, 'empty');
      mkdirSync(empty);
      const r = await show(empty, { adapter: fakeAdapter({ win: window({ path: canonical(empty) }) }), timeoutMs: 200, cwd: ROOT });
      assert.equal(r.select, null);
      assert.equal('selected' in r, false, JSON.stringify(r));
    });
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// A file whose file:/// URL is too long opens through its short path (d.openPath)
// ---------------------------------------------------------------------------------------------

test('file mode: openPath (the 8.3 short path) is what the browser gets; the target stays the real path', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const real = write(path.join(dir, 'a very long report name.html'), '<title>Long report</title>');
    const short = write(path.join(dir, 'AVERYL~1.HTM'), '<title>Long report</title>');
    const withShort = (title) => (target, o) => ({ ok: true, mode: 'file', path: real, title, openPath: short, shortPath: true, reasons: ['the path is too long for a file:/// URL, so its short path is opened'] });
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'Long report - Fake Browser' } });
    const r = await show(real, { adapter, timeoutMs: 200, cwd: ROOT, detectFn: withShort('Long report') });
    assert.equal(r.verified, true, JSON.stringify(r));
    assert.equal(r.target, real);
    assert.equal(r.shortPath, true);
    assert.equal(r.openPath, short);
    assert.equal(r.url, pathToFileURL(short).href);
    assert.equal(adapter.only('openUrl')[0].args[0], pathToFileURL(short).href);
    assert.deepEqual(adapter.only('watchWindows')[0].args.tokens, ['Long report'], "the page's own title, read from the real file");

    // No <title>: the browser shows the name at the end of the URL it was given.
    const bare = fakeAdapter();
    await show(real, { adapter: bare, timeoutMs: 200, cwd: ROOT, detectFn: withShort(null) });
    assert.deepEqual(bare.only('watchWindows')[0].args.tokens, ['AVERYL~1.HTM']);

    const plan = await show(real, { planOnly: true, cwd: ROOT, detectFn: withShort('Long report') });
    assert.equal(plan.url, pathToFileURL(short).href);
    assert.equal(plan.shortPath, true);
    assert.equal(plan.target, real);

    // Without openPath nothing changes.
    const plain = await show(real, { planOnly: true, cwd: ROOT, detectFn: () => ({ ok: true, mode: 'file', path: real, title: 'Long report' }) });
    assert.equal(plain.url, pathToFileURL(real).href);
    assert.equal('shortPath' in plain, false);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// Past MAX_PATH on Windows, app files and folders open through their 8.3 short path too
// ---------------------------------------------------------------------------------------------

/** A folder chain under base whose path is longer than `minLen` characters. */
function deepFolder(base, minLen) {
  let d = base;
  for (let i = 0; d.length <= minLen; i++) d = path.join(d, `level-${i}-${'d'.repeat(30)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** A shortPathFn stand-in: `table` maps a long path to its short one; every call is recorded. */
function fakeShortPath(table) {
  const calls = [];
  const fn = (p) => { calls.push(p); return table[p] ?? null; };
  fn.calls = calls;
  return fn;
}

const SHORT_DIR = 'C:\\Users\\me\\AppData\\Local\\Temp\\SL-OPE~1\\LEVEL-~1';

test('app mode past MAX_PATH (win32): the app gets the 8.3 short path, both names are window tokens, the target stays the real path', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const pdf = write(path.join(deepFolder(dir, 270), 'quarterly report.pdf'), '%PDF-1.4\n1 0 obj << /Title (Q3 numbers) >> endobj\n');
    const short = `${SHORT_DIR}\\QUARTE~1.PDF`;
    const shortPathFn = fakeShortPath({ [pdf]: short });
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'QUARTE~1.PDF - Viewer' } });
    const r = await show(pdf, { adapter, platform: 'win32', shortPathFn, timeoutMs: 200, cwd: ROOT });
    assert.equal(r.mode, 'app', JSON.stringify(r));
    assert.equal(r.verified, true);
    assert.equal(r.target, pdf, 'the reply names the real file');
    assert.equal(r.openPath, short);
    assert.equal(r.shortPath, true);
    assert.match(r.reasons[0], /opens through its 8\.3 short path/);
    assert.deepEqual(shortPathFn.calls, [pdf]);
    assert.deepEqual(adapter.only('openApp')[0].args, [short, { name: 'Viewer', process: 'viewer' }]);
    assert.deepEqual(adapter.only('appFor')[0].args, [pdf], 'the app is chosen by the real file');
    // The app may title its window with the name it was given, or the real one.
    assert.deepEqual(adapter.only('watchAppWindows')[0].args.tokens, ['quarterly report.pdf', 'QUARTE~1.PDF', 'Q3 numbers']);

    // No short path that fits: the real path, as before.
    const plain = fakeAdapter();
    const p = await show(pdf, { adapter: plain, platform: 'win32', shortPathFn: fakeShortPath({}), timeoutMs: 200, cwd: ROOT });
    assert.equal('openPath' in p, false, JSON.stringify(p));
    assert.deepEqual(plain.only('openApp')[0].args[0], pdf);
    assert.deepEqual(plain.only('watchAppWindows')[0].args.tokens, ['quarterly report.pdf', 'Q3 numbers']);
  } finally { cleanup(); }
});

test('folder past MAX_PATH (win32): the file manager gets the 8.3 short spelling, the watcher takes either, the result keeps the real path', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const deep = deepFolder(dir, 270);
    write(path.join(deep, 'final report.pdf'), '%PDF-1.4');
    const longDir = canonical(deep);
    const longSel = path.join(longDir, 'final report.pdf');
    const shortSel = `${SHORT_DIR}\\FINALR~1.PDF`;
    const shortPathFn = fakeShortPath({ [longSel]: shortSel });
    const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', path: SHORT_DIR, selected: [shortSel.toLowerCase()], selectedOk: true } });
    const r = await show(deep, { adapter, platform: 'win32', shortPathFn, timeoutMs: 200, cwd: ROOT });
    assert.equal(r.mode, 'folder', JSON.stringify(r));
    assert.equal(r.verified, true);
    assert.equal(r.selected, true);
    assert.equal(r.target, deep);
    assert.equal(r.folder, longDir);
    assert.equal(r.select, longSel);
    assert.equal(r.shortPath, true);
    assert.equal(r.openPath, SHORT_DIR);
    assert.equal(r.openSelect, shortSel);
    assert.match(r.reasons.at(-1), new RegExp(`^path is ${longSel.length} characters, .* 8\\.3 short path \\(${shortSel.length} characters\\)$`));
    assert.deepEqual(shortPathFn.calls, [longSel], 'one lookup: the selection\'s short path holds its folder\'s');
    assert.deepEqual(adapter.only('openFolder')[0].args, [SHORT_DIR, shortSel]);
    const [watch] = adapter.only('watchFolder');
    assert.deepEqual([watch.args.dir, watch.args.select, watch.args.altDir, watch.args.altSelect], [longDir, longSel, SHORT_DIR, shortSel]);
  } finally { cleanup(); }
});

test('folder past MAX_PATH (win32): an empty folder, a long --select in a short folder, and no short path at all', async () => {
  const { dir, cleanup } = tempDir();
  try {
    // An empty long folder: the folder itself is looked up.
    const empty = deepFolder(path.join(dir, 'empty'), 270);
    const emptyShort = fakeShortPath({ [canonical(empty)]: SHORT_DIR });
    const a = fakeAdapter({ win: { matched: true, confidence: 'high', path: SHORT_DIR } });
    const r = await show(empty, { adapter: a, platform: 'win32', shortPathFn: emptyShort, timeoutMs: 200, cwd: ROOT });
    assert.deepEqual(a.only('openFolder')[0].args, [SHORT_DIR, null]);
    assert.deepEqual([a.only('watchFolder')[0].args.dir, a.only('watchFolder')[0].args.altDir], [canonical(empty), SHORT_DIR]);
    assert.equal('altSelect' in a.only('watchFolder')[0].args, false);
    assert.equal(r.openPath, SHORT_DIR);
    assert.equal('openSelect' in r, false);
    assert.equal(r.folder, canonical(empty));

    // A folder that fits, with a --select whose path does not.
    const out = path.join(dir, 'out');
    const name = `${'a long file name '.repeat(14).trim()}.pdf`; // 241 characters: one name may hold 255
    write(path.join(out, name), '%PDF-1.4');
    const longSel = path.join(canonical(out), name);
    assert.ok(canonical(out).length <= 256 && longSel.length > 256, `${longSel.length} characters`);
    const shortSel = 'C:\\TEMP\\OUT\\ALONGF~1.PDF';
    const b = fakeAdapter({ win: { matched: true, confidence: 'high', path: 'C:\\TEMP\\OUT', selectedOk: true } });
    const s = await show(out, { adapter: b, select: name, platform: 'win32', shortPathFn: fakeShortPath({ [longSel]: shortSel }), timeoutMs: 200, cwd: ROOT });
    assert.deepEqual(b.only('openFolder')[0].args, ['C:\\TEMP\\OUT', shortSel]);
    assert.equal(s.select, longSel);
    assert.equal(s.openSelect, shortSel);

    // No short path that fits: opened by the long path as before, and the watcher gets no other spelling.
    const c = fakeAdapter();
    const n = await show(out, { adapter: c, select: name, platform: 'win32', shortPathFn: fakeShortPath({}), timeoutMs: 200, cwd: ROOT });
    assert.deepEqual(c.only('openFolder')[0].args, [canonical(out), longSel]);
    assert.equal('altDir' in c.only('watchFolder')[0].args, false);
    assert.equal('shortPath' in n, false, JSON.stringify(n));

    // Off Windows nothing is looked up.
    const never = fakeShortPath({ [longSel]: shortSel });
    const d = fakeAdapter();
    await show(out, { adapter: d, select: name, platform: 'linux', shortPathFn: never, timeoutMs: 200, cwd: ROOT });
    assert.deepEqual(never.calls, []);
    assert.deepEqual(d.only('openFolder')[0].args, [canonical(out), longSel]);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// Dev servers already running: ownership and port-busy (OS lookups faked for the host platform)
// ---------------------------------------------------------------------------------------------

// Windows is faked as Windows (netstat + PowerShell); everywhere else as macOS (lsof + ps),
// so the project's real temp path is a valid absolute path for the faked platform.
const HOST = process.platform === 'win32' ? 'win32' : 'darwin';
const winCommand = (argv) => argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');

/** runFn answering the listener and process lookups for `procs` ({pid, name, argv, cwd, parents}). */
function ownerRun(port, procs) {
  const byPid = (pid) => procs.find((p) => String(p.pid) === String(pid));
  if (HOST === 'win32') {
    const rows = procs.map((p) => `  TCP    [::1]:${port}          [::]:0                 LISTENING       ${p.pid}`).join('\r\n');
    return fakeRun([
      ['netstat', { stdout: `\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n${rows}\r\n` }],
      [(cmd) => cmd === 'powershell.exe', (cmd, args, opts) => {
        const p = byPid(opts.env?.SHOW_LOCAL_PID);
        const chain = p ? [p, ...(p.parents || [])].map((x) => ({ pid: x.pid, name: x.name, exe: '', commandLine: winCommand(x.argv) })) : [];
        return { stdout: `${JSON.stringify(chain)}\r\n` };
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

/** A dev project whose script names `port`. */
function devProject(port) {
  const t = tempDir();
  const root = path.join(t.dir, 'shop');
  write(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: `vite --port ${port}` } }));
  return { ...t, root };
}

const own = (root) => ({ pid: 4242, name: HOST === 'win32' ? 'node.exe' : 'node', argv: ['node', path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], cwd: root });

test("dev: the project's own server (already answering) is reused: plan says open, show opens it", async () => {
  await withHttp((q, s) => s.end('<title>Shop</title>'), async (port) => {
    const { root, cleanup } = devProject(port);
    try {
      const runFn = ownerRun(port, [own(root)]);
      const plan = await show(root, { planOnly: true, adapter: fakeAdapter(), runFn, platform: HOST, cwd: ROOT });
      assert.equal(plan.action, 'open', JSON.stringify(plan));
      assert.equal(plan.alreadyRunning, true);
      const adapter = fakeAdapter({ win: { matched: true, confidence: 'high', title: 'Shop' } });
      const r = await show(root, { adapter, runFn, platform: HOST, timeoutMs: 200, cwd: ROOT });
      assert.equal(r.verified, true, JSON.stringify(r));
      assert.equal(r.alreadyRunning, true);
      assert.equal(adapter.only('openUrl')[0].args[0], `http://localhost:${port}/`);
    } finally { cleanup(); }
  });
});

test('dev: a server answering "/" with 404 (a base path) still counts as running', async () => {
  await withHttp((q, s) => { s.writeHead(404); s.end('see /app/'); }, async (port) => {
    const { root, cleanup } = devProject(port);
    try {
      const r = await show(root, { planOnly: true, adapter: fakeAdapter(), runFn: ownerRun(port, [own(root)]), platform: HOST, cwd: ROOT });
      assert.equal(r.action, 'open', JSON.stringify(r));
      assert.equal(r.alreadyRunning, true);
      // Opening it still needs a page: an error answer is reported as such, and nothing opens.
      const adapter = fakeAdapter();
      const o = await show(root, { adapter, runFn: ownerRun(port, [own(root)]), platform: HOST, waitMs: 300, cwd: ROOT });
      assert.equal(o.error, 'server-not-responding', JSON.stringify(o));
      assert.match(o.detail, /only answered HTTP 404/);
      assert.equal(adapter.only('openUrl').length, 0);
    } finally { cleanup(); }
  });
});

test('dev: a server still compiling (listening, not answering yet) is not started a second time', async () => {
  await withHttp(() => { /* holds every request, like a first compile */ }, async (port) => {
    const { root, cleanup } = devProject(port);
    try {
      const r = await show(root, { planOnly: true, adapter: fakeAdapter(), runFn: ownerRun(port, [own(root)]), platform: HOST, cwd: ROOT });
      assert.equal(r.action, 'open', JSON.stringify(r));
      assert.equal(r.alreadyRunning, true);
      assert.equal(r.next, undefined, 'no start command');
    } finally { cleanup(); }
  });
});

/** A private state folder (registry, logs) for fn: the user's real servers are never seen. */
async function inState(fn) {
  const t = tempDir('show-local-open-state-');
  const vars = { TEMP: t.dir, TMP: t.dir, TMPDIR: t.dir, XDG_RUNTIME_DIR: '' };
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { t.cleanup(); } catch { /* a Windows handle may linger */ }
  }
}

test("dev: show-local's own dev-run for the project, still starting, is never started a second time", () => inState(async () => {
  const registry = await import(lib('registry.mjs'));
  const port = await freePort();
  const { root, cleanup } = devProject(port);
  try {
    // This process stands in for the dev-run: its entry names a live show-local process.
    registry.register({ kind: 'dev', runner: 'dev-run', pid: process.pid, childPid: process.pid, port, root, url: `http://localhost:${port}/` });
    const trap = fakeRun([[() => true, () => { throw new Error('no OS lookup is needed for our own dev-run'); }]]);
    const plan = await show(root, { planOnly: true, adapter: fakeAdapter(), runFn: trap, platform: HOST, cwd: ROOT });
    assert.equal(plan.action, 'open', JSON.stringify(plan));
    assert.equal(plan.alreadyRunning, true);
    assert.equal(plan.next, undefined);
    // Another project on that port is not ours: the usual checks run (and nothing listens here).
    const other = devProject(port);
    try {
      const o = await show(other.root, { planOnly: true, adapter: fakeAdapter(), runFn: ownerRun(port, []), platform: HOST, cwd: ROOT });
      assert.equal(o.action, 'start-server', JSON.stringify(o));
    } finally { other.cleanup(); }
  } finally { cleanup(); }
}));

test('--dev-root on a port that dev-run recorded keeps that entry (its pid holds the whole tree)', () => inState(async () => {
  const registry = await import(lib('registry.mjs'));
  await withHttp((q, s) => s.end('<title>Shop</title>'), async (port) => {
    const { root, cleanup } = devProject(port);
    try {
      const entry = { kind: 'dev', runner: 'dev-run', pid: process.pid, childPid: process.pid, port, root, url: `http://localhost:${port}/` };
      registry.register(entry);
      const trap = fakeRun([[() => true, () => { throw new Error('no OS lookup is needed for our own dev-run'); }]]);
      const r = await show(`http://127.0.0.1:${port}/`, { adapter: fakeAdapter(), devRoot: root, runFn: trap, platform: HOST, timeoutMs: 100, cwd: ROOT });
      assert.deepEqual(r.registered, { kind: 'dev', port, pid: process.pid, root, runner: 'dev-run' }, JSON.stringify(r));
      assert.deepEqual(registry.entryAt(port), entry, 'the entry is kept as dev-run wrote it');
      const elsewhere = path.join(path.dirname(root), 'elsewhere');
      mkdirSync(elsewhere);
      const o = await show(`http://127.0.0.1:${port}/`, { adapter: fakeAdapter(), devRoot: elsewhere, runFn: trap, platform: HOST, timeoutMs: 100, cwd: ROOT });
      assert.equal(o.registered, undefined);
      assert.ok(o.notes?.some((n) => /belongs to a show-local dev-run for another folder/.test(n)), JSON.stringify(o.notes));
      assert.deepEqual(registry.entryAt(port), entry);
    } finally { cleanup(); }
  });
}));

test("next.then --dev-root stops waiting as soon as the dev-run it waits for has ended (the runner failed)", () => inState(async () => {
  const registry = await import(lib('registry.mjs'));
  const { spawn } = await import('node:child_process');
  const port = await freePort();
  const { root, cleanup } = devProject(port);
  // Stands in for a dev-run whose runner fails: alive for a moment, then gone.
  const devRun = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], { stdio: 'ignore', windowsHide: true });
  try {
    registry.register({ kind: 'dev', runner: 'dev-run', pid: devRun.pid, childPid: devRun.pid, port, root, url: `http://localhost:${port}/` });
    const adapter = fakeAdapter();
    const t0 = Date.now();
    const r = await show(`http://localhost:${port}/`, { adapter, devRoot: root, waitMs: 30000, timeoutMs: 100, cwd: ROOT });
    assert.equal(r.error, 'server-not-responding', JSON.stringify(r));
    assert.match(r.detail, /did not answer \(last: the server process ended\)/);
    assert.ok(Date.now() - t0 < 10000, `gave up once dev-run was gone, not after 30 s (${Date.now() - t0} ms)`);
    assert.equal(adapter.only('openUrl').length, 0);
  } finally { devRun.kill(); cleanup(); }
}));

test('dev-port-unknown lists the ports in candidates when the dev script names several, and has none otherwise', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const several = path.join(dir, 'several');
    write(path.join(several, 'package.json'), JSON.stringify({ scripts: { dev: 'concurrently "vite --port 6124" "node api.js --port 6125"' } }));
    const r = await show(several, { planOnly: true, adapter: fakeAdapter(), cwd: dir });
    assert.equal(r.error, 'dev-port-unknown', JSON.stringify(r));
    assert.deepEqual(r.candidates, [6124, 6125]);
    const none = path.join(dir, 'none');
    write(path.join(none, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    const n = await show(none, { planOnly: true, adapter: fakeAdapter(), cwd: dir });
    assert.equal(n.error, 'dev-port-unknown', JSON.stringify(n));
    assert.equal('candidates' in n, false);
  } finally { cleanup(); }
});

test('dev: nothing listening gives the start plan', async () => {
  const port = await freePort();
  const { root, cleanup } = devProject(port);
  try {
    const r = await show(root, { planOnly: true, adapter: fakeAdapter(), runFn: ownerRun(port, []), platform: HOST, cwd: ROOT });
    assert.equal(r.action, 'start-server', JSON.stringify(r));
  } finally { cleanup(); }
});

test("dev: a sibling project's server (shop-v2 for shop) is port-busy, and nothing is opened", async () => {
  await withHttp((q, s) => s.end('<title>Other shop</title>'), async (port) => {
    const { root, cleanup } = devProject(port);
    try {
      const sibling = `${root}-v2`;
      const proc = { pid: 5151, name: 'node', argv: ['node', path.join(sibling, 'node_modules', 'vite', 'bin', 'vite.js')], cwd: sibling };
      const adapter = fakeAdapter();
      const r = await show(root, { adapter, runFn: ownerRun(port, [proc]), platform: HOST, cwd: ROOT });
      assert.equal(r.error, 'port-busy', JSON.stringify(r));
      assert.equal(adapter.only('openUrl').length, 0);
    } finally { cleanup(); }
  });
});

test('dev: every listener must be the project\'s; one stranger among them makes it port-busy', async () => {
  await withHttp((q, s) => s.end('x'), async (port) => {
    const { root, cleanup } = devProject(port);
    try {
      const stranger = { pid: 777, name: 'python', argv: ['python', path.join(os.tmpdir(), 'elsewhere', 'srv.py')], cwd: path.join(os.tmpdir(), 'elsewhere') };
      const r = await show(root, { planOnly: true, adapter: fakeAdapter(), runFn: ownerRun(port, [own(root), stranger]), platform: HOST, cwd: ROOT });
      assert.equal(r.error, 'port-busy', JSON.stringify(r));
      assert.equal(r.owner.pid, 777);
    } finally { cleanup(); }
  });
});

test('port-busy reports only the pid and the program name, never the command line (it can hold secrets)', async () => {
  await withHttp((q, s) => s.end('x'), async (port) => {
    const { root, cleanup } = devProject(port);
    try {
      const elsewhere = path.join(os.tmpdir(), 'elsewhere');
      const proc = { pid: 9090, name: 'node', argv: ['node', path.join(elsewhere, 'server.js'), '--api-key=sk-live-SECRET123'], cwd: elsewhere };
      const r = await show(root, { adapter: fakeAdapter(), runFn: ownerRun(port, [proc]), platform: HOST, cwd: ROOT });
      assert.equal(r.error, 'port-busy', JSON.stringify(r));
      assert.deepEqual(r.owner, { pid: 9090, name: 'node' });
      assert.ok(!JSON.stringify(r).includes('sk-live'), JSON.stringify(r));
    } finally { cleanup(); }
  });
});

// ---------------------------------------------------------------------------------------------
// portowner: listeners (netstat), process info, ownership
// ---------------------------------------------------------------------------------------------

// What `netstat -ano` prints on Windows (both families). `-p TCP` prints the IPv4 rows only.
const NETSTAT_IPV4 = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1308',
  '  TCP    127.0.0.1:4455         0.0.0.0:0              LISTENING       4242',
  '  TCP    127.0.0.1:5173         127.0.0.1:50912        ESTABLISHED     999',
  '  TCP    127.0.0.1:50912        127.0.0.1:5173         ESTABLISHED     888',
];
const NETSTAT_ALL = [
  ...NETSTAT_IPV4,
  '  TCP    [::]:3000              [::]:0                 LISTENING       3100',
  '  TCP    [::1]:5173             [::]:0                 LISTENING       77',
  '  TCP    [::1]:5173             [::1]:50913            ESTABLISHED     77',
  '  TCP    [fe80::1%7]:8080       [::]:0                 LISTENING       8080',
  '  UDP    0.0.0.0:5353           *:*                                    555',
  '  UDP    [::]:5353              *:*                                    556',
];
const netstatRun = (all = NETSTAT_ALL, ipv4 = NETSTAT_IPV4) => fakeRun([
  ['netstat -ano -p TCP', { stdout: ipv4.join('\r\n') }],
  ['netstat -ano', { stdout: all.join('\r\n') }],
]);

test('listeningPids (Windows): IPv6-only and dual-stack listeners are found; netstat runs without -p', () => {
  const runFn = netstatRun();
  assert.deepEqual(listeningPids(5173, { runFn, platform: 'win32' }), [77], 'Vite on [::1] only');
  assert.equal(listeningPid(5173, { runFn, platform: 'win32' }), 77);
  assert.deepEqual(listeningPids(3000, { runFn, platform: 'win32' }), [3100], 'Next on [::]');
  assert.deepEqual(listeningPids(4455, { runFn, platform: 'win32' }), [4242]);
  assert.deepEqual(listeningPids(8080, { runFn, platform: 'win32' }), [8080], 'scoped IPv6 address');
  assert.deepEqual(runFn.calls[0].args, ['-ano']);
});

test('listeningPids (Windows): connections and UDP sockets on the port are not listeners', () => {
  const runFn = netstatRun();
  assert.deepEqual(listeningPids(5353, { runFn, platform: 'win32' }), []);
  assert.equal(listeningPid(50912, { runFn, platform: 'win32' }), null);
  assert.equal(listeningPid(9999, { runFn, platform: 'win32' }), null);
});

test('listeningPids (Windows): the state column is not read, so localized netstat works', () => {
  const localized = [
    '',
    'Aktive Verbindungen',
    '',
    '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
    '  TCP    [::1]:5173             [::]:0                 ABHÖREN          77',
    '  TCP    127.0.0.1:3000         0.0.0.0:0              IN ASCOLTO       31',
    '  TCP    127.0.0.1:3000         127.0.0.1:50000        HERGESTELLT      31',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              ESCUCHANDO       32',
  ];
  const runFn = netstatRun(localized, localized.filter((l) => !l.includes('[')));
  assert.deepEqual(listeningPids(5173, { runFn, platform: 'win32' }), [77]);
  assert.deepEqual(listeningPids(3000, { runFn, platform: 'win32' }), [31, 32], 'every listener, once each');
});

test('listeningPids (macOS/Linux): lsof first, ss as the Linux fallback; bad ports never reach a command', () => {
  assert.deepEqual(listeningPids(3000, { runFn: fakeRun([['lsof', { stdout: '555\n556\n' }]]), platform: 'darwin' }), [555, 556]);
  const ss = fakeRun([['ss', { stdout: 'LISTEN 0 511 *:3000 *:* users:(("node",pid=321,fd=20))\n' }]]);
  assert.deepEqual(listeningPids(3000, { runFn: ss, platform: 'linux' }), [321]);
  const none = fakeRun([]);
  for (const bad of [0, 65536, 3.5, '80; rm -rf /', null]) assert.deepEqual(listeningPids(bad, { runFn: none, platform: 'win32' }), []);
  assert.equal(none.calls.length, 0);
});

test('processInfo (Windows): one PowerShell call, UTF-8 output, pid in the environment, JSON with the parent chain', () => {
  const chain = [
    { pid: 4242, name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', commandLine: 'C:\\Program Files\\nodejs\\node.exe C:\\Users\\משתמש\\shop\\node_modules\\vite\\bin\\vite.js --port 5173' },
    { pid: 4000, name: 'cmd.exe', exe: 'C:\\Windows\\system32\\cmd.exe', commandLine: 'C:\\Windows\\system32\\cmd.exe /d /s /c "vite --port 5173"' },
    { pid: 3900, name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" --prefix C:/Users/משתמש/shop run dev' },
  ];
  const runFn = fakeRun([['powershell.exe', { stdout: `${JSON.stringify(chain)}\r\n` }]]);
  const info = processInfo(4242, { runFn, platform: 'win32' });
  assert.equal(runFn.calls.length, 1);
  const call = runFn.calls[0];
  assert.equal(call.opts.env.SHOW_LOCAL_PID, '4242');
  const script = call.args.join(' ');
  assert.ok(!script.includes('4242'), 'pid never spliced into the command text');
  assert.match(script, /\[Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding/);
  assert.match(script, /ConvertTo-Json/);
  assert.equal(info.pid, 4242);
  assert.equal(info.name, 'node.exe');
  assert.equal(info.cwd, null);
  assert.deepEqual(info.argv, ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\משתמש\\shop\\node_modules\\vite\\bin\\vite.js', '--port', '5173']);
  assert.deepEqual(info.parents.map((p) => p.pid), [4000, 3900]);
  assert.deepEqual(info.parents[1].argv.slice(1, 4), ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', '--prefix', 'C:/Users/משתמש/shop']);
  assert.equal(belongsTo(info, 'C:\\Users\\משתמש\\shop', 'win32'), true);
});

test('processInfo (Windows): garbage, an empty chain or a different pid give null', () => {
  for (const stdout of ['not json', '[]', JSON.stringify([{ pid: 1, name: 'x', commandLine: 'x' }])]) {
    assert.equal(processInfo(4242, { runFn: fakeRun([['powershell.exe', { stdout }]]), platform: 'win32' }), null, stdout);
  }
  assert.equal(processInfo(4242, { runFn: fakeRun([['powershell.exe', { status: 1 }]]), platform: 'win32' }), null);
});

test('processInfo (Linux): argv from /proc/<pid>/cmdline, cwd from /proc/<pid>/cwd, name from comm', () => {
  const files = { '/proc/321/cmdline': 'node\0/home/u/shop/server.js\0--port\x003000\0', '/proc/321/comm': 'node\n' };
  const readFile = (p) => { if (p in files) return files[p]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const info = processInfo(321, { platform: 'linux', readFile, readLink: () => '/home/u/shop' });
  assert.deepEqual(info.argv, ['node', '/home/u/shop/server.js', '--port', '3000']);
  assert.equal(info.cwd, '/home/u/shop');
  assert.equal(info.name, 'node');
  assert.deepEqual(info.parents, []);
});

test('processInfo (macOS): ps for the command and name, lsof for the working folder', () => {
  const runFn = fakeRun([
    ['ps -o command=', { stdout: '/usr/local/bin/node /Users/u/shop/node_modules/.bin/vite\n' }],
    ['ps -o comm=', { stdout: '/usr/local/bin/node\n' }],
    ['lsof -a', { stdout: 'p55\nfcwd\nn/Users/u/shop\n' }],
  ]);
  const info = processInfo(55, { runFn, platform: 'darwin' });
  assert.equal(info.name, 'node');
  assert.equal(info.cwd, '/Users/u/shop');
  assert.equal(info.argv[1], '/Users/u/shop/node_modules/.bin/vite');
});

test('windowsArgv: an unquoted program path with spaces is settled by ExecutablePath', () => {
  assert.deepEqual(windowsArgv('C:\\Program Files\\nodejs\\node.exe C:\\a\\b.js', 'C:\\Program Files\\nodejs\\node.exe'), ['C:\\Program Files\\nodejs\\node.exe', 'C:\\a\\b.js']);
  assert.deepEqual(windowsArgv('"C:\\Program Files\\x.exe" "C:\\a b\\c.js" --x', ''), ['C:\\Program Files\\x.exe', 'C:\\a b\\c.js', '--x']);
  assert.deepEqual(windowsArgv('', 'C:\\x.exe'), []);
});

test('belongsTo: a sibling folder with the same prefix never belongs (command line or cwd)', () => {
  assert.equal(belongsTo({ cwd: null, commandLine: 'node C:\\code\\app-v2\\node_modules\\vite\\bin\\vite.js' }, 'C:\\code\\app', 'win32'), false);
  assert.equal(belongsTo({ cwd: null, commandLine: 'node C:\\work\\site2\\server.js' }, 'C:\\work\\site', 'win32'), false);
  assert.equal(belongsTo({ cwd: '/home/u/site-v2', commandLine: 'node /home/u/site-v2/node_modules/.bin/vite' }, '/home/u/site', 'linux'), false);
  assert.equal(belongsTo({ cwd: null, commandLine: 'node /work/site-other/node_modules/vite/bin/vite.js' }, '/work/site', 'linux'), false);
});

test('belongsTo: the project path appearing somewhere in the arguments is not ownership', () => {
  assert.equal(belongsTo({ cwd: 'C:/other', commandLine: 'node evil.js --config C:/Users/dana/proj/x' }, 'C:/Users/dana/proj', 'win32'), false);
  assert.equal(belongsTo({ cwd: '/srv', commandLine: 'node /srv/evil.js --root /home/u/proj/dist' }, '/home/u/proj', 'linux'), false);
  assert.equal(belongsTo({ cwd: null, commandLine: 'node C:\\tools\\other.js --prefix C:\\proj' }, 'C:\\proj', 'win32'), false, '--prefix counts only for a package manager');
  assert.equal(belongsTo({ cwd: null, commandLine: 'node C:\\work\\site\\..\\other\\evil.js' }, 'C:\\work\\site', 'win32'), false, '".." is folded before comparing');
});

test('belongsTo: program, script, working folder or package-manager folder inside the project do belong', () => {
  assert.equal(belongsTo({ cwd: '/home/u/site', commandLine: 'hugo server -p 1313' }, '/home/u/site', 'linux'), true);
  assert.equal(belongsTo({ cwd: '/home/u/site/packages/web', commandLine: 'node x' }, '/home/u/site', 'linux'), true);
  assert.equal(belongsTo({ cwd: '/home/u', commandLine: 'node site/server.js' }, '/home/u/site', 'linux'), true, 'relative script next to a known cwd');
  assert.equal(belongsTo({ cwd: null, commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\My Projects\\site\\node_modules\\vite\\bin\\vite.js"' }, 'C:\\My Projects\\site', 'win32'), true);
  assert.equal(belongsTo({ cwd: null, commandLine: 'node c:/work/SITE/server.mjs' }, 'C:\\work\\site', 'win32'), true, 'slashes and case do not matter on Windows');
  assert.equal(belongsTo({ cwd: null, commandLine: '\\\\?\\C:\\work\\site\\bin\\srv.exe --port 1' }, 'C:\\work\\site', 'win32'), true);
  assert.equal(belongsTo({ cwd: '/Users/U/Site', commandLine: 'node x' }, '/Users/u/site', 'darwin'), true);
  assert.equal(belongsTo({ cwd: null, argv: ['C:\\p\\node.exe', 'C:\\p\\npm-cli.js', '--prefix=C:\\work\\site', 'run', 'dev'] }, 'C:\\work\\site', 'win32'), true);
});

test('belongsTo (Windows): the parent chain counts, e.g. npx under `npm --prefix <project> run dev`', () => {
  const npxServer = {
    pid: 10, cwd: null,
    commandLine: 'node C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\http-server\\bin\\http-server -p 8080',
    parents: [
      { pid: 9, cwd: null, commandLine: 'C:\\Windows\\system32\\cmd.exe /d /s /c "http-server -p 8080"' },
      { pid: 8, cwd: null, commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" --prefix C:/work/site run dev' },
    ],
  };
  assert.equal(belongsTo(npxServer, 'C:\\work\\site', 'win32'), true);
  assert.equal(belongsTo({ ...npxServer, parents: npxServer.parents.slice(0, 1) }, 'C:\\work\\site', 'win32'), false);
  assert.equal(belongsTo(npxServer, 'C:\\work\\site-v2', 'win32'), false);
});

test('belongsTo: a file-system root as the project matches only an exact working folder', () => {
  assert.equal(belongsTo({ cwd: '/home/u', commandLine: 'node /anything.js' }, '/', 'linux'), false);
  assert.equal(belongsTo({ cwd: '/', commandLine: 'node x' }, '/', 'linux'), true);
  assert.equal(belongsTo({ cwd: null, commandLine: 'node C:\\anything.js' }, 'C:\\', 'win32'), false);
  assert.equal(belongsTo(null, '/x', 'linux'), false);
  assert.equal(belongsTo({ cwd: '/x' }, '', 'linux'), false);
});

test('belongsTo: a project reached through a symlink matches the real path the process reports', (t) => {
  const { dir, cleanup } = tempDir();
  try {
    const real = path.join(dir, 'real-site');
    mkdirSync(real);
    const link = path.join(dir, 'site-link');
    try { symlinkSync(real, link, 'junction'); } catch (e) { t.skip(`links unavailable here (${e.code})`); return; }
    const platform = process.platform;
    const realPath = canonical(real);
    const info = platform === 'win32'
      ? { cwd: null, commandLine: `node "${path.join(realPath, 'server.js')}"` }
      : { cwd: realPath, commandLine: 'node server.js' };
    assert.equal(belongsTo(info, link, platform), true);
  } finally { cleanup(); }
});
