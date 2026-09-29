// Hardening: programs are revealed rather than run, dev projects are started only on request
// and never through a command line that could split or expand their path, commands quote paths
// so nothing in them expands, local URLs stay local, the served-mode proof counts only the
// browser, and the state folder and registry stay private. Nothing here opens a window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeRun, freePort, lib, PLUGIN, ROOT, SHOW, tempDir } from './helpers.mjs';

const { detect, RUNNABLE_EXT, devPort } = await import(lib('detect.mjs'));
const { show } = await import(lib('open.mjs'));
const { cmdPath, cmdScript, cmdUrl, httpRequest, isLocalHost, shQuote, stateDir, toPathArg } = await import(lib('util.mjs'));
const { listeningPid, processInfo, belongsTo } = await import(lib('portowner.mjs'));
const { logHits, createStaticServer, listen, rootTag } = await import(lib('server.mjs'));
const { register, listServers, serversDir, unregister } = await import(lib('registry.mjs'));

const write = (file, text = '') => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); return file; };

/** An adapter that fails the test if anything tries to open or watch. */
const trap = () => new Proxy({}, { get: (_, k) => () => { throw new Error(`adapter.${String(k)} must not be called`); } });

// ---- executables are revealed, never run -------------------------------------------------

test('runnable files (.exe .bat .cmd .ps1 .vbs .js .lnk .url .sh .command .appimage …) are shown in their folder, never opened', () => {
  const { dir, cleanup } = tempDir();
  try {
    for (const ext of ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.hta', '.lnk', '.url', '.msi', '.reg', '.sh', '.command', '.appimage', '.jar', '.scr']) {
      assert.ok(RUNNABLE_EXT.has(ext), ext);
      const f = write(path.join(dir, `tool${ext}`), 'x');
      const d = detect(f);
      assert.equal(d.mode, 'folder', ext);
      assert.equal(d.path, dir, ext);
      assert.equal(d.select, f, ext);
      assert.match(d.reasons[0], /run when opened/, ext);
    }
  } finally { cleanup(); }
});

test('a macOS .app bundle (a folder) is revealed, not launched', () => {
  const { dir, cleanup } = tempDir();
  try {
    const app = path.join(dir, 'Tool.app');
    mkdirSync(path.join(app, 'Contents'), { recursive: true });
    const d = detect(app);
    assert.equal(d.mode, 'folder');
    assert.equal(d.path, dir);
    assert.equal(d.select, app);
  } finally { cleanup(); }
});

test('--folder (asFolder) shows a project folder in the file manager instead of running npm run dev', () => {
  const { dir, cleanup } = tempDir();
  try {
    write(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    write(path.join(dir, 'index.html'), '<title>x</title>');
    assert.equal(detect(dir).mode, 'dev');
    const d = detect(dir, { asFolder: true });
    assert.equal(d.mode, 'folder');
    assert.equal(d.path, dir);
    const f = detect(path.join(dir, 'index.html'), { asFolder: true });
    assert.equal(f.mode, 'folder');
    assert.equal(f.select, path.join(dir, 'index.html'));
  } finally { cleanup(); }
});

// ---- network paths are refused ---------------------------------------------------------------

test('UNC paths and file://host URLs are refused on Windows (no SMB connection)', () => {
  for (const t of ['\\\\server\\share\\x.html', '//server/share/x.html', 'file://server/share/x.html']) {
    const d = detect(t, { platform: 'win32' });
    assert.equal(d.ok, false, t);
    assert.equal(d.error, 'remote-path', t);
  }
  assert.equal(detect('file://evil.example/x', { platform: 'linux' }).error, 'remote-path');
});

// ---- dev mode ---------------------------------------------------------------------------------

test('devPort: several ports in one script are ambiguous, never guessed', () => {
  const r = devPort('concurrently "vite --port 3000" "node api.js --port 4000"', {});
  assert.equal(r.port, null);
  assert.equal(r.source, 'ambiguous');
  assert.deepEqual(r.candidates, [3000, 4000]);
  assert.deepEqual(devPort('vite --port 3000 && echo --port 3000', {}), { port: 3000, source: 'script' });
});

test('dev plan carries a caution, and an unknown port gives a runnable start command (dev-run, without a port)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    write(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'my-server' } }));
    const r = await show(dir, { planOnly: true, adapter: trap(), cwd: ROOT });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'dev-port-unknown');
    assert.match(r.caution, /runs the project's own code/);
    assert.match(r.next.start, /^node '.+show\.mjs' dev-run '.+'$/);
    assert.equal(r.server.command, 'node');
    assert.equal(r.server.runner, 'npm run dev');
    assert.deepEqual(r.server.args, [path.resolve(SHOW), 'dev-run', dir]);
  } finally { cleanup(); }
});

test('a dev project in a folder named with & and %VAR% is never put on a cmd.exe command line', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const proj = path.join(dir, 'R&D %USERNAME% shop');
    write(path.join(proj, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --port 5998' } }));
    const r = await show(proj, { planOnly: true, adapter: trap(), cwd: dir, runFn: fakeRun([]), platform: process.platform === 'win32' ? 'win32' : 'darwin', desktop: true });
    assert.equal(r.action, 'start-server', JSON.stringify(r));
    // The desktop app starts node itself, with the path as one argument of its own.
    const entry = JSON.parse(readFileSync(path.join(dir, '.claude', 'launch.json'), 'utf8')).configurations[0];
    assert.deepEqual(entry, { name: r.server.name, runtimeExecutable: 'node', runtimeArgs: [path.resolve(SHOW), 'dev-run', proj, '--port', '5998'], port: 5998 });
    // The terminal gets the path as a percent-encoded file:/// URL (the Bash tool refuses & in a
    // command), which dev-run turns back into the path.
    const m = r.next.start.match(/ dev-run '(file:\/\/\/[^']+)' --port 5998$/);
    assert.ok(m, r.next.start);
    assert.doesNotMatch(m[1], /[&;|$'"`\s]/);
    assert.equal(toPathArg(m[1]), proj);
    assert.ok(!/npm|cmd/.test(JSON.stringify(entry)), 'neither npm nor cmd.exe is started by the desktop app');
    // dev-run starts the runner with the project as its working folder: the path is on no command line.
    const { runnerSpawn } = await import(lib('devrun.mjs'));
    const win = runnerSpawn('npm', 'win32', { SystemRoot: 'C:\\Windows' });
    assert.deepEqual(win, { cmd: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', '"npm run dev"'], options: { windowsVerbatimArguments: true } });
    assert.deepEqual(runnerSpawn('pnpm', 'linux'), { cmd: 'pnpm', args: ['run', 'dev'], options: {} });
    assert.throws(() => runnerSpawn('npm & calc', 'win32'), /unknown package manager/);
  } finally { cleanup(); }
});

test('a port that already answers but belongs to another program is port-busy: nothing is opened', async () => {
  const { dir, cleanup } = tempDir();
  const port = await freePort();
  const srv = http.createServer((q, r) => r.end('<title>somebody else</title>'));
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  try {
    write(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: `vite --port ${port}` } }));
    const runFn = fakeRun([[() => true, { status: 1 }]]); // the OS cannot name the owner
    const r = await show(dir, { adapter: trap(), cwd: ROOT, runFn });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'port-busy');
    assert.equal(r.opened, false);
  } finally { srv.close(); cleanup(); }
});

test('belongsTo: the working folder or the command line must name the project', () => {
  const root = process.platform === 'win32' ? 'C:\\work\\site' : '/work/site';
  assert.equal(belongsTo({ cwd: root, commandLine: 'node x' }, root), true);
  assert.equal(belongsTo({ cwd: null, commandLine: `node ${root}${path.sep}node_modules${path.sep}vite${path.sep}bin${path.sep}vite.js` }, root), true);
  assert.equal(belongsTo({ cwd: `${root}-other`, commandLine: 'node other' }, root), false);
  assert.equal(belongsTo(null, root), false);
});

// What `netstat -ano` really prints: IPv4 and IPv6 rows together, connections and UDP mixed in.
const NETSTAT_ANO = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:4455         0.0.0.0:0              LISTENING       4242',
  '  TCP    127.0.0.1:50123        127.0.0.1:4455         ESTABLISHED     9001',
  '  TCP    [::1]:5173             [::]:0                 LISTENING       77',
  '  UDP    0.0.0.0:9999           *:*                                    31',
  '',
].join('\r\n');

test('listeningPid parses netstat on Windows and lsof elsewhere; bad ports are never queried', () => {
  const win = fakeRun([[(c, a) => c === 'netstat' && a.join(' ') === '-ano', { stdout: NETSTAT_ANO }]]);
  assert.equal(listeningPid(4455, { runFn: win, platform: 'win32' }), 4242, 'the listener, not the client connected to it');
  assert.equal(listeningPid(5173, { runFn: win, platform: 'win32' }), 77, 'an IPv6-only listener ([::1]) is found');
  assert.equal(listeningPid(9999, { runFn: win, platform: 'win32' }), null, 'UDP is not a TCP listener');
  assert.ok(win.calls.every((c) => c.cmd === 'netstat' && c.args.join(' ') === '-ano'), 'netstat -ano, never -p TCP (IPv4 only)');
  const nix = fakeRun([['lsof', { stdout: '555\n' }]]);
  assert.equal(listeningPid(3000, { runFn: nix, platform: 'darwin' }), 555);
  const none = fakeRun([]);
  assert.equal(listeningPid(0, { runFn: none, platform: 'linux' }), null);
  assert.equal(listeningPid('80; rm -rf /', { runFn: none, platform: 'linux' }), null);
  assert.equal(none.calls.length, 0);
});

test('processInfo on Windows passes the pid through an environment variable only', () => {
  // PowerShell answers with the process chain as JSON (the process first, then its parents).
  const chain = [{ pid: 4242, name: 'node.exe', exe: '', commandLine: 'node vite.js' }];
  const runFn = fakeRun([['powershell.exe', { stdout: `${JSON.stringify(chain)}\r\n` }]]);
  const info = processInfo(4242, { runFn, platform: 'win32' });
  assert.ok(info, 'the JSON chain is read');
  assert.equal(info.pid, 4242);
  assert.equal(info.commandLine, 'node vite.js');
  assert.equal(runFn.calls.length, 1);
  const call = runFn.calls[0];
  assert.equal(call.opts.env.SHOW_LOCAL_PID, '4242');
  assert.ok(!call.args.join(' ').includes('4242'), 'pid never spliced into the command text');
});

// ---- quoting ----------------------------------------------------------------------------------

test('shQuote: nothing inside expands in a POSIX shell, quotes survive', (t) => {
  const nasty = "a b'$(touch x)`id`$HOME\"; & | *";
  const quoted = shQuote(nasty);
  const r = spawnSync('sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
  // A skip, not a pass: nothing was checked. The format unit below still runs everywhere.
  if (r.error) { t.skip('no POSIX sh on this machine'); return; }
  assert.equal(r.stdout, nasty);
});

test('shQuote format: single quotes, embedded single quote closed and escaped', () => {
  assert.equal(shQuote('plain'), "'plain'");
  assert.equal(shQuote("it's"), "'it'\\''s'");
});

test('cmdPath: a plain path stays a quoted path; one with a character the Bash tool refuses becomes a file URL without it', () => {
  assert.equal(cmdPath('C:\\Users\\me\\דוח בדיקה (1).html', 'win32'), "'C:/Users/me/דוח בדיקה (1).html'");
  assert.equal(cmdPath('/home/me/a b.html', 'linux'), "'/home/me/a b.html'");
  for (const [p, platform] of [["C:\\work\\R&D\\Mom's report;1 $x `y` | z %25 #3.html", 'win32'], ["/home/me/R&D/Mom's \\ \"q\" %.html", 'linux']]) {
    const arg = cmdPath(p, platform);
    assert.match(arg, /^'file:\/\/\//, arg);
    const inner = arg.slice(1, -1);
    assert.doesNotMatch(inner, /['"`$;&|\\\s]/, `no refused or expanding character in ${arg}`);
    if (process.platform === platform) assert.equal(toPathArg(inner), p, 'show.mjs gets the same path back');
  }
});

test('cmdUrl and cmdScript: URLs stay equivalent without quote or shell characters; the script path stays a path', () => {
  assert.equal(cmdUrl('http://127.0.0.1:4400/'), "'http://127.0.0.1:4400/'");
  assert.equal(cmdUrl("http://127.0.0.1:4400/it's%20(1)!.html"), "'http://127.0.0.1:4400/it%27s%20%281%29%21.html'");
  assert.equal(new URL(cmdUrl("http://h/it's").slice(1, -1)).pathname, new URL("http://h/it's").pathname.replace("'", '%27'));
  assert.equal(cmdScript('C:\\Program Files\\show.mjs', 'win32'), "'C:/Program Files/show.mjs'");
  assert.equal(cmdScript("/home/o'brien/show.mjs", 'linux'), "'/home/o'\\''brien/show.mjs'");
  assert.equal(toPathArg('https://example.com/'), 'https://example.com/', 'only file URLs are turned into paths');
  assert.equal(toPathArg('plain/path'), 'plain/path');
});

test('the CLI takes a file:/// URL for every path it reads: serve root, --cwd, --select', { skip: process.platform !== 'win32' && process.platform !== 'linux' && 'checked on Windows and Linux' }, () => {
  const { dir, cleanup } = tempDir();
  try {
    const odd = path.join(dir, "R&D 'x' $1;%y");
    write(path.join(odd, 'index.html'), '<title>odd</title><script type="module">1</script>');
    const url = pathToFileURL(odd).href.replace(/['$;&]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const r = spawnSync(process.execPath, [SHOW, 'plan', url, '--cwd', pathToFileURL(dir).href], { encoding: 'utf8' });
    const j = JSON.parse(r.stdout);
    assert.equal(j.mode, 'serve', r.stdout);
    assert.equal(path.resolve(j.target), path.resolve(odd));
    assert.doesNotMatch(j.next.start, /[;&|]|'\\''/, j.next.start);
    assert.match(j.next.start, / serve 'file:\/\/\//);
  } finally { cleanup(); }
});

test('served-mode commands quote a folder with $ and backticks so it cannot expand', async (t) => {
  const { dir, cleanup } = tempDir();
  try {
    const site = path.join(dir, 'a$(echo pwned)`id`');
    let ok = true;
    try { write(path.join(site, 'index.html'), '<title>t</title>'); } catch { ok = false; }
    if (!ok) { t.skip('this file system refuses such folder names'); return; }
    const r = await show(site, { planOnly: true, adapter: trap(), cwd: ROOT });
    assert.equal(r.action, 'start-server');
    // $ and backticks never reach the command: the folder travels as a percent-encoded file URL.
    const m = r.next.start.match(/ serve '(file:\/\/\/[^']+)' /);
    assert.ok(m, r.next.start);
    assert.doesNotMatch(m[1], /[$`()'"]/);
    assert.equal(toPathArg(m[1]), site);
    assert.ok(!/"[^"]*\$\(/.test(r.next.start), 'never inside double quotes');
  } finally { cleanup(); }
});

// ---- local URLs ---------------------------------------------------------------------------------

test('isLocalHost: all of 127.0.0.0/8, 0.0.0.0, ::1, localhost and *.localhost', () => {
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '::1', '[::1]', 'app.localhost', 'A.B.LOCALHOST']) assert.equal(isLocalHost(h), true, h);
  for (const h of ['example.com', '128.0.0.1', 'localhost.evil.com', '10.0.0.1']) assert.equal(isLocalHost(h), false, h);
});

test('httpRequest: *.localhost resolves to loopback even when the OS resolver does not', async () => {
  const port = await freePort();
  const srv = http.createServer((q, r) => r.end(`host=${q.headers.host}`));
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  try {
    const r = await httpRequest(`http://my-app.localhost:${port}/`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.body, `host=my-app.localhost:${port}`);
  } finally { srv.close(); }
});

// A slow trickle never reaches the byte cap, so this checks the deadline only; the cap has
// its own test (core-edge-cases.test.mjs).
test('httpRequest: an endless slow body cannot hang it (overall deadline)', async () => {
  const port = await freePort();
  const srv = http.createServer((q, r) => {
    r.writeHead(200);
    const t = setInterval(() => r.write('x'.repeat(10)), 20);
    r.on('close', () => clearInterval(t));
  });
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  try {
    const t0 = Date.now();
    const r = await httpRequest(`http://127.0.0.1:${port}/`, { timeoutMs: 800 });
    assert.ok(Date.now() - t0 < 2500, `returned after ${Date.now() - t0} ms`);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'timeout');
  } finally { srv.close(); }
});

test('httpRequest identifies itself as show-local, so its GETs are not proof of a browser', async () => {
  const port = await freePort();
  let ua = null;
  const srv = http.createServer((q, r) => { ua = q.headers['user-agent']; r.end('ok'); });
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  try {
    await httpRequest(`http://127.0.0.1:${port}/`);
    assert.equal(ua, 'show-local');
  } finally { srv.close(); }
});

test('the served-mode proof only counts the browser: probe GETs, other paths and errors do not', () => {
  const lines = [
    '2026-01-01T00:00:01.000Z GET / 200 "show-local"',
    '2026-01-01T00:00:02.000Z GET /other.html 200 "Mozilla/5.0"',
    '2026-01-01T00:00:03.000Z GET / 404 "Mozilla/5.0"',
    '2026-01-01T00:00:04.000Z GET / 200 "Mozilla/5.0"',
  ].join('\n');
  const hits = logHits(lines, { pathname: '/' }).filter((h) => h.status < 400);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].time, Date.parse('2026-01-01T00:00:04.000Z'));
});

// ---- state folder and registry --------------------------------------------------------------------

test('state folder: private to this user on POSIX', { skip: typeof process.getuid !== 'function' }, () => {
  const d = stateDir();
  const st = statSync(d);
  assert.equal(st.uid, process.getuid());
  assert.equal(st.mode & 0o077, 0, `mode ${(st.mode & 0o777).toString(8)}`);
});

/**
 * Run fn with os.tmpdir(), and so show-local's state folder, moved to a private temp folder:
 * registry tests must never read, write or prune the user's real server registry.
 */
async function withState(fn) {
  const t = tempDir('show-local-state-');
  const vars = { TEMP: t.dir, TMP: t.dir, TMPDIR: t.dir, XDG_RUNTIME_DIR: '' };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn(t.dir);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    t.cleanup();
  }
}

/** A live loopback server that answers exactly like a show-local server for `root`. */
async function taggedServer(root) {
  const port = await freePort();
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'X-Show-Local': rootTag(root) }); r.end(); });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', resolve); });
  return { port, close: () => new Promise((resolve) => srv.close(resolve)) };
}

test('registry: entries with a non-integer port, a mismatched file name or no pid are ignored and never used as paths', async () => {
  await withState(async (tmp) => {
    const dir = serversDir();
    assert.ok(dir.startsWith(tmp), `registry is in the private temp folder, not the real one: ${dir}`);
    // What unregister('../../evil') would delete if a port were ever used as a file name unchecked.
    const sentinel = path.join(dir, '..', '..', 'evil.json');
    writeFileSync(sentinel, 'must survive');
    // Two servers that really answer as show-local for ROOT, so a bad entry pointing at one of
    // them WOULD be listed if the file-name and port checks were missing.
    const a = await taggedServer(ROOT);
    const b = await taggedServer(ROOT);
    try {
      const spare = [9002, 9003, 9004].find((p) => p !== a.port && p !== b.port);
      const entries = [
        [`${a.port}.json`, { port: String(a.port), pid: process.pid, root: ROOT }], // port as a string
        [`${b.port}.json`, { port: b.port, pid: process.pid, root: ROOT }], // the one valid entry
        [`${spare}.json`, { port: b.port, pid: process.pid, root: ROOT }], // file name ≠ its port
        ['9001.json', { port: '../../evil', pid: process.pid, root: ROOT }],
        ['9005.json', { port: 9005, root: ROOT }], // no pid
        ['x.json', { port: a.port, pid: process.pid, root: ROOT }], // not <port>.json
      ];
      for (const [f, e] of entries) writeFileSync(path.join(dir, f), JSON.stringify(e));

      const live = await listServers();
      assert.deepEqual(live.map((e) => e.port), [b.port], 'only the valid entry is listed, once');
      assert.equal(typeof live[0].port, 'number');
      assert.ok(existsSync(sentinel), 'listServers never removed a file outside the registry');

      unregister('../../evil');
      unregister(`${a.port}/../../../evil`);
      assert.ok(existsSync(sentinel), 'unregister never turns a non-integer port into a path');
      register({ port: 'nope', pid: 1, root: ROOT });
      register({ port: '../../planted', pid: 1, root: ROOT });
      assert.ok(!readdirSync(dir).includes('nope.json'));
      assert.ok(!existsSync(path.join(dir, '..', '..', 'planted.json')), 'register never writes outside the registry');
    } finally {
      await a.close();
      await b.close();
    }
  });
});

// ---- the static server ---------------------------------------------------------------------------

test('the static server survives request-targets the URL parser rejects', async () => {
  const { dir, cleanup } = tempDir();
  const port = await freePort();
  write(path.join(dir, 'index.html'), '<title>root</title>');
  const server = createStaticServer({ root: dir, port, echo: false });
  await listen(server, port);
  try {
    const net = await import('node:net');
    for (const target of ['//[', 'http://[', '//%zz', '/\u0000']) {
      const answer = await new Promise((resolve) => {
        let got = '';
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
        s.setEncoding('latin1');
        s.on('data', (d) => { got += d; });
        s.on('close', () => resolve(got));
        s.on('error', () => resolve(got));
      });
      // An answer, and a refusal: never a dropped connection, never the page.
      assert.match(answer.split('\r\n')[0], /^HTTP\/1\.[01] 4\d\d /, `${JSON.stringify(target)} -> ${JSON.stringify(answer.slice(0, 40))}`);
      assert.ok(!answer.includes('<title>root</title>'), JSON.stringify(target));
    }
    const ok = await httpRequest(`http://127.0.0.1:${port}/`);
    assert.equal(ok.status, 200, 'still serving');
  } finally { server.close(); cleanup(); }
});

// ---- repository hygiene ---------------------------------------------------------------------------

test('every text file in the repository uses LF line endings (except .ps1)', () => {
  const skip = new Set(['.git', 'node_modules', '.plan', 'out']);
  const bad = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); continue; }
      if (!/\.(mjs|js|cjs|md|json|sh|yml|yaml|html)$/.test(e.name)) continue;
      if (readFileSync(p, 'utf8').includes('\r\n')) bad.push(path.relative(ROOT, p));
    }
  })(ROOT);
  assert.deepEqual(bad, []);
});

test('the comments and test names in this file say what they guard, not which pass of work added them', () => {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const said = text.split('\n').filter((l) => /^\s*(\/\/|\*|test\()/.test(l));
  assert.ok(said.length > 50, 'comments and test names were found');
  assert.deepEqual(said.filter((l) => /\b(round|review|audit|R\d+)\b/i.test(l)), []);
});

test('the skills never tell the agent to use double quotes around paths', () => {
  for (const s of ['show', 'show-serve', 'show-doctor']) {
    const text = readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
    assert.ok(!/node "\$\{?CLAUDE_PLUGIN_ROOT/.test(text), `${s}: script path in double quotes`);
    assert.ok(!text.includes('$SHOW'), `${s}: stale $SHOW placeholder`);
  }
  assert.ok(SHOW.endsWith('show.mjs'));
});

// ---- nested pages keep their URL, https dev servers stay https, macOS packages are revealed --

test('a page nested in its site is served with a per-segment URL (slashes kept)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    write(path.join(dir, 'index.html'), '<title>home</title>');
    const page = write(path.join(dir, 'blog', 'my post.html'), '<title>p</title><script type="module">1</script>');
    const r = await show(page, { planOnly: true, adapter: trap(), cwd: ROOT });
    assert.equal(r.action, 'start-server');
    assert.match(r.server.url, /\/blog\/my%20post\.html$/, r.server.url);
  } finally { cleanup(); }
});

test('a dev script started with --https is probed and opened over https', async () => {
  const { dir, cleanup } = tempDir();
  try {
    write(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --https --port 5998' } }));
    const r = await show(dir, { planOnly: true, adapter: trap(), cwd: ROOT });
    assert.equal(r.server.url, 'https://localhost:5998/');
  } finally { cleanup(); }
});

test('mac: a package folder (.prefPane, .workflow…) is revealed with open -R, never opened', async () => {
  const { createMacAdapter } = await import(lib('adapters/mac.mjs'));
  const runFn = fakeRun([['open', {}]]);
  const a = createMacAdapter({ runFn, env: {} });
  await a.openFolder('/Users/u/Library/PreferencePanes/Tool.prefPane', null);
  await a.openFolder('/Users/u/out', null);
  assert.deepEqual(runFn.calls.map((c) => c.args), [['-R', '/Users/u/Library/PreferencePanes/Tool.prefPane'], ['/Users/u/out']]);
});
