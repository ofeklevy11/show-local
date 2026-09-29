// CLI behaviour (spawned as a real process) and repository/plugin metadata checks.
//
// Nothing here opens a window: the CLI is only run with --help/--version, usage errors,
// `plan`, `serve` (a loopback server in a child process), `servers`, `stop <our port>`,
// `stop all` and the read-only `doctor` (both against a private temp registry, see
// isolatedState). The one in-process call to show() uses a trap adapter that fails on any use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { freePort, lib, PLUGIN, ROOT, SCRIPTS, SHOW, tempDir } from './helpers.mjs';

const PORT_MIN = 4400;
const PORT_MAX = 4499;
const DEV_PORT = 5999;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const PLUGIN_JSON_FILE = path.join(PLUGIN, '.claude-plugin', 'plugin.json');
const MARKETPLACE_FILE = path.join(ROOT, '.claude-plugin', 'marketplace.json');
const PACKAGE_FILE = path.join(ROOT, 'package.json');
const SKILLS_DIR = path.join(PLUGIN, 'skills');
const { stateDir } = await import(lib('util.mjs'));
const REGISTRY_DIR = path.join(stateDir(), 'servers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Paths inside the pasteable `next.*` commands use forward slashes on Windows.
const shellForm = (p) => (process.platform === 'win32' ? String(p).replace(/\\/g, '/') : String(p));

// ---------------------------------------------------------------------------------------------
// helpers

/** process.env with `vars` set. Windows names are case-insensitive, so an inherited "Temp" must not shadow a new "TEMP". */
function withVars(vars) {
  const names = new Set(Object.keys(vars).map((k) => (process.platform === 'win32' ? k.toUpperCase() : k)));
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!names.has(process.platform === 'win32' ? k.toUpperCase() : k)) out[k] = v;
  }
  return { ...out, ...vars };
}

// The per-user state folder name inside the temp folder (see util.mjs stateDir).
const STATE_NAME = typeof process.getuid === 'function' ? `show-local-${process.getuid()}` : 'show-local';

/**
 * A private temp folder for show-local's state (server registry, logs), and the env vars that
 * point a CLI child at it. Tests that start, list or stop servers use it, so they never see or
 * touch the user's real servers.
 */
function isolatedState() {
  const t = tempDir('show-local-state-');
  const env = { TEMP: t.dir, TMP: t.dir, TMPDIR: t.dir, XDG_RUNTIME_DIR: '' };
  return { ...t, env, serversDir: path.join(t.dir, STATE_NAME, 'servers') };
}

/** Run show.mjs with arguments (and extra env vars); resolves with exit code, output and the parsed JSON (if any). */
function cli(args, { cwd = ROOT, timeoutMs = 30000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHOW, ...args], { cwd, env: env ? withVars(env) : process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`show.mjs ${args.join(' ')} did not exit within ${timeoutMs} ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not a single JSON document */ }
      resolve({ code, signal, stdout, stderr, json });
    });
  });
}

/** Parse the CLI output or fail with the raw output in the message. */
function jsonOf(r) {
  assert.ok(r.json && typeof r.json === 'object', `expected one JSON object on stdout, got:\n${r.stdout}\nstderr:\n${r.stderr}`);
  return r.json;
}

function canConnect(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function somethingListens(port) {
  return (await canConnect(port, '127.0.0.1')) || (await canConnect(port, '::1'));
}

function httpGet(url, { method = 'GET', timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** A free ephemeral port that is guaranteed to lie outside show-local's own range. */
async function portOutsideRange() {
  for (;;) {
    const p = await freePort();
    if (p < PORT_MIN || p > PORT_MAX) return p;
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function setMtime(file, secondsAgo) {
  const t = Date.now() / 1000 - secondsAgo;
  utimesSync(file, t, t);
}

/** Fields shared by every plan: it reports, it never opens. */
function assertNothingOpened(j) {
  assert.notEqual(j.opened, true, 'plan must never report opened: true');
  for (const key of ['openedWith', 'how', 'evidence', 'window', 'verified', 'confidence']) {
    assert.equal(key in j, false, `plan output must not contain "${key}" (that only exists after opening)`);
  }
  assert.equal(typeof j.ms, 'number');
}

function assertStaticPlan(j, { root, entryUrlPath = '' }) {
  assert.equal(j.ok, true);
  assert.equal(j.mode, 'serve');
  assert.equal(j.action, 'start-server');
  assert.equal(j.lifetime, 'session');
  assert.equal(j.opened, false);
  assert.ok(j.server, 'server block present');
  const s = j.server;
  assert.equal(s.kind, 'static');
  assert.ok(Number.isInteger(s.port) && s.port >= PORT_MIN && s.port <= PORT_MAX, `port ${s.port} in ${PORT_MIN}-${PORT_MAX}`);
  assert.ok(s.url.startsWith('http://127.0.0.1:'), `url ${s.url} is loopback`);
  assert.equal(s.url, `http://127.0.0.1:${s.port}/${entryUrlPath}`);
  assert.equal(s.root, root);
  assert.equal(s.command, 'node');
  assert.match(s.name, /^show-[a-z0-9-]+-[0-9a-f]{6}$/);
  assert.equal(path.basename(s.log), `server-${s.port}.log`);
  assert.deepEqual(s.args, [path.resolve(SHOW), 'serve', root, '--port', String(s.port), '--log', s.log]);
  assert.ok(j.next && typeof j.next.then === 'string', 'next.then present');
  assert.match(j.next.then, /--log/);
  assert.ok(j.next.then.startsWith('node '), j.next.then);
  assert.ok(j.next.then.includes(s.url), 'next.then opens the server url');
  assert.ok(j.next.then.includes(shellForm(s.log)), 'next.then passes the server log');
  // A server started a moment ago gets 10 s to answer (the served budget is 20 s); a direct open waits 4.5 s.
  assert.match(j.next.then, / --wait 10000 /, 'next.then passes the served wait explicitly');
  assert.ok(['first-free', 'launch.json', 'registry'].includes(s.portSource), `portSource ${s.portSource}`);
  // next.start / next.then are exact commands: POSIX single quotes, so nothing in a path expands.
  assert.ok(typeof j.next.start === 'string', 'next.start present');
  assert.ok(j.next.start.startsWith('node '), j.next.start);
  assert.ok(j.next.start.includes(`serve '${shellForm(root)}'`), `next.start serves the root in single quotes: ${j.next.start}`);
  assert.ok(j.next.start.includes(`--port ${s.port}`), 'flags are never quoted (the Bash tool rejects quoted flag names)');
  assert.ok(!/"--/.test(j.next.start) && !/'--/.test(j.next.start), 'no quoted flags');
  assert.ok(j.next.then.includes(`'${s.url}'`), 'next.then quotes the url with single quotes');
  assert.equal(j.next.desktop, undefined);
  assert.equal(j.next.terminal, undefined);
}

/** Minimal frontmatter reader for SKILL.md: `key: value` lines, quoted scalars, folded blocks. */
function frontmatter(text) {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const fields = {};
  const plain = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = lines[i].match(/^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/);
    if (!km) continue;
    let v = (km[2] ?? '').trim();
    let isPlain = false;
    if (v === '' || /^[>|][+-]?$/.test(v)) {
      const block = [];
      while (i + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[i + 1])) block.push(lines[++i].trim());
      v = block.join(v.startsWith('|') ? '\n' : ' ').trim();
    } else if (/^".*"$/.test(v)) {
      v = JSON.parse(v);
    } else if (/^'.*'$/.test(v)) {
      v = v.slice(1, -1).replace(/''/g, "'");
    } else {
      isPlain = true;
    }
    fields[km[1]] = v;
    plain[km[1]] = isPlain;
  }
  return { fields, plain };
}

const quotedPhrases = (s) => [...String(s).matchAll(/["“”]([^"“”]+)["“”]/g)].map((m) => m[1]);
const normPhrase = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function skillFolders() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

function walk(dir, ext) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p, ext));
    else if (d.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** Every module specifier in an ES module source: static import/export-from and import(). */
function importSpecifiers(src) {
  const statics = [];
  for (const re of [
    /^[ \t]*import\s+[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/gm,
    /^[ \t]*import\s*(['"])([^'"]+)\1/gm,
    /^[ \t]*export\s+[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/gm,
  ]) for (const m of src.matchAll(re)) statics.push(m[2]);
  const dynamics = [...src.matchAll(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map((m) => m[2]);
  return { statics, dynamics };
}

// ---------------------------------------------------------------------------------------------
// CLI: help, version, usage errors

test('cli: --help prints the usage text and exits 0', async () => {
  const r = await cli(['--help']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  const version = readJson(PLUGIN_JSON_FILE).version;
  assert.ok(r.stdout.startsWith(`show-local ${version} `), r.stdout.split('\n')[0]);
  for (const s of ['plan <path|url>', 'oneshot <path>', 'serve <folder>', 'dev-run <project>', 'servers', 'stop <port|all>', 'doctor',
    '--select', '--timeout', '--wait', '--log', '--desktop', '--headless', '--no-verify', '--port', '--cwd', '--dev-root',
    '--linger', '--no-parent-watch', 'Exit code']) {
    assert.ok(r.stdout.includes(s), `help mentions ${s}`);
  }
  const flat = r.stdout.replace(/\s+/g, ' ');
  // plan opens nothing, and --desktop is the one thing it writes: the launch.json entry.
  assert.match(flat, /plan <path\|url> report what would happen; opens nothing\. With --desktop it adds or updates the entry in \.claude\/launch\.json/);
  assert.match(flat, /--desktop plan: add or update the preview entry in \.claude\/launch\.json/);
  assert.match(flat, /a direct open finishes within 9\.6 s/);
  assert.match(flat, /--linger MS oneshot: how long to keep serving after the page opened \(default 3000\)/);
  assert.match(flat, /--no-parent-watch serve, dev-run: keep running when the process that started it ends/);
  assert.match(flat, /--cwd DIR .*Relative targets resolve against it/, '--cwd also resolves relative targets');
  assert.match(flat, /--timeout MS .*default 5000, or SHOW_LOCAL_TIMEOUT_MS/, 'the timeout variable is documented');
  assert.match(flat, /--wait MS .*default 4500.*passes 10000 for a static server/, 'the direct and served waits are documented');
  assert.match(flat, /first free port from 4400 to 4499/, 'the port rule is the plan\'s');
  assert.doesNotMatch(flat, /tends to/, 'no hedged port promise');
  assert.equal(r.json, null, 'help is text, not JSON');
});

test('cli: -h and the help command print the same usage text', async () => {
  const [a, b, c] = await Promise.all([cli(['--help']), cli(['-h']), cli(['help'])]);
  assert.equal(b.code, 0);
  assert.equal(c.code, 0);
  assert.equal(b.stdout, a.stdout);
  assert.equal(c.stdout, a.stdout);
});

test('cli: --help wins over a command and its target (nothing is planned or opened)', async () => {
  const r = await cli(['plan', 'https://example.com/', '--help']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.startsWith('show-local '));
  assert.equal(r.json, null);
});

test('cli: --version prints the plugin.json version as JSON and exits 0', async () => {
  const r = await cli(['--version']);
  assert.equal(r.code, 0, r.stderr);
  const j = jsonOf(r);
  assert.deepEqual(j, { ok: true, version: readJson(PLUGIN_JSON_FILE).version });
});

test('cli: the version command matches --version', async () => {
  const [a, b] = await Promise.all([cli(['--version']), cli(['version'])]);
  assert.equal(b.code, 0);
  assert.deepEqual(jsonOf(b), jsonOf(a));
});

test('cli: an unknown option exits 2 with a JSON usage error', async () => {
  const r = await cli(['--frobnicate']);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, '');
  const j = jsonOf(r);
  assert.equal(j.ok, false);
  assert.equal(j.error, 'usage');
  assert.match(j.detail, /unknown option --frobnicate/);
});

test('cli: an unknown option after a plan target still exits 2 before planning', async () => {
  const r = await cli(['plan', 'https://example.com/', '--bogus-flag']);
  assert.equal(r.code, 2);
  const j = jsonOf(r);
  assert.equal(j.error, 'usage');
  assert.match(j.detail, /--bogus-flag/);
  assert.equal('mode' in j, false, 'nothing was detected or planned');
});

test('cli: a value option without its value exits 2', async (t) => {
  for (const flag of ['--select', '--timeout', '--wait', '--log', '--port', '--cwd']) {
    await t.test(flag, async () => {
      const r = await cli(['plan', 'https://example.com/', flag]);
      assert.equal(r.code, 2);
      const j = jsonOf(r);
      assert.equal(j.error, 'usage');
      assert.equal(j.detail, `${flag} needs a value`);
    });
  }
});

test('cli: no target exits 2 with a JSON usage error', async () => {
  const r = await cli([]);
  assert.equal(r.code, 2);
  const j = jsonOf(r);
  assert.equal(j.ok, false);
  assert.equal(j.error, 'usage');
  assert.match(j.detail, /path or URL/);
});

test('cli: plan and open without a target exit 2', async () => {
  for (const cmd of ['plan', 'open']) {
    const r = await cli([cmd]);
    assert.equal(r.code, 2, cmd);
    assert.equal(jsonOf(r).error, 'usage', cmd);
  }
});

test('cli: stop without a port exits 2', async () => {
  const r = await cli(['stop']);
  assert.equal(r.code, 2);
  const j = jsonOf(r);
  assert.equal(j.error, 'usage');
  assert.match(j.detail, /stop <port\|all>/);
});

test('cli: every option documented in --help is accepted by the parser', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const help = (await cli(['--help'])).stdout;
    const documented = [...help.matchAll(/^\s+(--[a-z][a-z-]*)(\s+[A-Z]+)?\s{2,}/gm)].map((m) => ({ flag: m[1], value: !!m[2] }));
    assert.ok(documented.length >= 7, `found ${documented.length} documented options`);
    assert.ok(documented.some((o) => o.flag === '--cwd' && o.value), '--cwd DIR is documented');
    // Every documented option once. --cwd gets the temp folder, not a dummy value: the parser
    // keeps the last value of a repeated flag, and a dummy would move the check below elsewhere.
    const args = ['plan', 'https://example.com/'];
    for (const o of documented) args.push(o.flag, ...(o.value ? [o.flag === '--cwd' ? dir : '1'] : []));
    assert.equal(args.filter((a) => a === '--cwd').length, 1, 'no flag is given twice');
    const r = await cli(args, { cwd: dir });
    assert.equal(r.code, 0, `${args.join(' ')}\n${r.stdout}`);
    const j = jsonOf(r);
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'url');
    assert.equal(existsSync(path.join(dir, '.claude')), false, '--desktop on a URL writes no launch.json');
    assert.deepEqual(readdirSync(dir), [], 'plan wrote nothing at all into the working folder');
    assert.equal(existsSync(path.join(ROOT, '1')), false, 'nothing landed in a folder named after a dummy value');
  } finally { cleanup(); }
});

test('cli: a non-numeric --timeout or a negative --wait is a usage error (exit 2), not an internal one', async () => {
  for (const extra of [['--timeout', 'abc'], ['--wait', '-5']]) {
    const r = await cli(['plan', 'https://example.com/', ...extra]);
    const j = jsonOf(r);
    assert.equal(j.ok, false);
    assert.match(j.detail, new RegExp(`${extra[0]} must be a non-negative number`));
    assert.equal(j.error, 'usage', `${extra.join(' ')}: error label`);
    assert.equal(r.code, 2, `${extra.join(' ')}: exit code (header: "2 usage")`);
  }
});

test('cli: serve --port abc prints one JSON error object instead of crashing', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const r = await cli(['serve', dir, '--port', 'abc'], { timeoutMs: 15000 });
    assert.ok(r.json, `expected one JSON object on stdout; got stdout=${JSON.stringify(r.stdout)} stderr=${r.stderr.split('\n').slice(0, 4).join(' | ')}`);
    assert.equal(r.json.ok, false);
    assert.match(r.json.detail, /--port must be an integer from 1 to 65535/);
    assert.equal(r.code, 2, 'a bad --port value is a usage error');
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
  } finally { cleanup(); }
});

test('cli: serve on a missing folder or on a file fails with JSON and exit 1', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const missing = await cli(['serve', path.join(dir, 'nope')]);
    assert.equal(missing.code, 1);
    assert.equal(jsonOf(missing).error, 'not-found');
    const file = write(path.join(dir, 'a.txt'), 'x');
    const notDir = await cli(['serve', file]);
    assert.equal(notDir.code, 1);
    assert.equal(jsonOf(notDir).error, 'not-a-folder');
  } finally { cleanup(); }
});

test('cli: servers prints a JSON list and exits 0', async () => {
  const r = await cli(['servers']);
  assert.equal(r.code, 0, r.stderr);
  const j = jsonOf(r);
  assert.equal(j.ok, true);
  assert.ok(Array.isArray(j.servers));
  for (const s of j.servers) {
    assert.ok(Number.isInteger(s.port) && Number.isInteger(s.pid), JSON.stringify(s));
    assert.equal(typeof s.root, 'string');
  }
});

// ---------------------------------------------------------------------------------------------
// plan: every kind of target, never opening anything

test('plan: an https URL is opened as-is (no server, nothing opened)', async () => {
  const r = await cli(['plan', 'https://example.com/a/b?q=1#frag']);
  assert.equal(r.code, 0, r.stdout);
  const j = jsonOf(r);
  assert.equal(j.ok, true);
  assert.equal(j.mode, 'url');
  assert.equal(j.action, 'open');
  assert.equal(j.url, 'https://example.com/a/b?q=1#frag');
  assert.equal(j.target, j.url);
  assert.equal('server' in j, false);
  assertNothingOpened(j);
});

test('plan: a URL is normalised (scheme and host case)', async () => {
  const j = jsonOf(await cli(['plan', 'HTTPS://Example.COM']));
  assert.equal(j.mode, 'url');
  assert.equal(j.url, 'https://example.com/');
});

test('plan: a localhost URL is planned without contacting it', async () => {
  const port = await portOutsideRange();
  const start = Date.now();
  const r = await cli(['plan', `http://localhost:${port}/x`]);
  assert.equal(r.code, 0);
  const j = jsonOf(r);
  assert.equal(j.mode, 'url');
  assert.equal(j.url, `http://localhost:${port}/x`);
  assert.ok(Date.now() - start < 8000, 'did not wait for a server');
  assertNothingOpened(j);
});

test('plan: a bad URL and a missing path fail with exit 1', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const bad = await cli(['plan', 'http://']);
    assert.equal(bad.code, 1);
    assert.equal(jsonOf(bad).error, 'bad-url');
    const missing = await cli(['plan', path.join(dir, 'missing.html')]);
    assert.equal(missing.code, 1);
    const j = jsonOf(missing);
    assert.equal(j.ok, false);
    assert.equal(j.error, 'not-found');
  } finally { cleanup(); }
});

test('plan: a self-contained HTML file opens as file:/// in the browser', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = write(path.join(dir, 'report.html'), '<!doctype html><title>Report</title><h1>Hi</h1><script>document.title += "!"</script>');
    const r = await cli(['plan', file]);
    assert.equal(r.code, 0, r.stdout);
    const j = jsonOf(r);
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'file');
    assert.equal(j.action, 'open');
    assert.equal(j.target, file);
    assert.equal(j.url, pathToFileURL(file).href);
    assert.equal('server' in j, false);
    assertNothingOpened(j);
  } finally { cleanup(); }
});

test('plan: a file:// URL to an HTML file is treated as that file', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = write(path.join(dir, 'page.html'), '<title>P</title>');
    const j = jsonOf(await cli(['plan', pathToFileURL(file).href]));
    assert.equal(j.mode, 'file');
    assert.equal(j.target, file);
    assert.equal(j.url, pathToFileURL(file).href);
  } finally { cleanup(); }
});

test('plan: a path with a space split over two arguments is joined back', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = write(path.join(dir, 'my page.html'), '<title>Spaced</title>');
    const j = jsonOf(await cli(['plan', path.join(dir, 'my'), 'page.html']));
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'file');
    assert.equal(j.target, file);
  } finally { cleanup(); }
});

test('plan: a module HTML file needs a static server for its folder', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = write(path.join(dir, 'app.html'), '<!doctype html><title>App</title><script type="module" src="./main.js"></script>');
    write(path.join(dir, 'main.js'), 'export {};');
    const r = await cli(['plan', file]);
    assert.equal(r.code, 0, r.stdout);
    const j = jsonOf(r);
    assertStaticPlan(j, { root: dir, entryUrlPath: 'app.html' });
    assert.equal(j.target, file);
    assert.ok(j.reasons.includes('ES module script (blocked under file://)'), JSON.stringify(j.reasons));
    assert.equal(j.launchJson, null, 'no launch.json without --desktop');
  } finally { cleanup(); }
});

test('plan: an HTML file that calls fetch() is served too, and its name is URL-encoded', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = write(path.join(dir, 'my data.html'), '<title>D</title><script>fetch("./d.json").then(r => r.json())</script>');
    const j = jsonOf(await cli(['plan', file]));
    assertStaticPlan(j, { root: dir, entryUrlPath: 'my%20data.html' });
    assert.ok(j.reasons.includes('fetch() call'), JSON.stringify(j.reasons));
  } finally { cleanup(); }
});

test('plan: a folder with index.html gets a static server in 4400-4499 for the session', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const site = path.join(dir, 'site');
    write(path.join(site, 'index.html'), '<!doctype html><title>Site</title>');
    const r = await cli(['plan', site]);
    assert.equal(r.code, 0, r.stdout);
    const j = jsonOf(r);
    assertStaticPlan(j, { root: site });
    assert.equal(j.target, site);
    assert.deepEqual(j.reasons, ['folder with index.html']);
    assert.match(j.server.name, /^show-site-[0-9a-f]{6}$/);
    assert.equal(j.launchJson, null);
  } finally { cleanup(); }
});

test('plan: the same folder is planned on the same port twice in a row', async () => {
  const { dir, cleanup } = tempDir();
  try {
    write(path.join(dir, 'index.html'), '<title>S</title>');
    const a = jsonOf(await cli(['plan', dir]));
    const b = jsonOf(await cli(['plan', dir]));
    assert.equal(b.server.port, a.server.port);
    assert.equal(b.server.name, a.server.name);
  } finally { cleanup(); }
});

test('plan: a relative target resolves against --cwd', async () => {
  const { dir, cleanup } = tempDir();
  try {
    write(path.join(dir, 'site', 'index.html'), '<title>S</title>');
    const j = jsonOf(await cli(['plan', 'site', '--cwd', dir]));
    assertStaticPlan(j, { root: path.join(dir, 'site') });
  } finally { cleanup(); }
});

test('plan: a non-ASCII folder name still yields an ASCII launch entry name', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const site = path.join(dir, 'אתר');
    write(path.join(site, 'index.html'), '<title>אתר</title>');
    const j = jsonOf(await cli(['plan', site]));
    assertStaticPlan(j, { root: site });
    assert.match(j.server.name, /^show-site-[0-9a-f]{6}$/);
  } finally { cleanup(); }
});

test('plan: a folder of outputs opens in the file manager with the newest HTML selected', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const out = path.join(dir, 'renders');
    setMtime(write(path.join(out, 'old.html'), '<title>old</title>'), 300);
    const newest = write(path.join(out, 'new.html'), '<title>new</title>');
    setMtime(newest, 100);
    setMtime(write(path.join(out, 'frame.png'), 'png'), 10); // newer, but ranks below HTML
    setMtime(write(path.join(out, 'notes.txt'), 'txt'), 5);
    setMtime(write(path.join(out, '.hidden.html'), '<title>h</title>'), 1); // dotfiles are ignored
    const r = await cli(['plan', out]);
    assert.equal(r.code, 0, r.stdout);
    const j = jsonOf(r);
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'folder');
    assert.equal(j.action, 'open');
    assert.equal(j.target, out);
    assert.equal(j.select, newest);
    assert.equal('server' in j, false);
    assertNothingOpened(j);
  } finally { cleanup(); }
});

test('plan: an empty folder is a folder open with nothing to select', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const j = jsonOf(await cli(['plan', dir]));
    assert.equal(j.mode, 'folder');
    assert.equal(j.action, 'open');
    assert.equal(j.select ?? null, null);
  } finally { cleanup(); }
});

test('plan: a document, image, audio, video or text file opens in its default app', async () => {
  const { dir, cleanup } = tempDir();
  try {
    for (const name of ['data.csv', 'clip.mp4', 'doc.pdf']) {
      const file = write(path.join(dir, name), 'x');
      const r = await cli(['plan', file]);
      assert.equal(r.code, 0, `${name}: ${r.stdout}`);
      const j = jsonOf(r);
      assert.equal(j.ok, true);
      assert.equal(j.mode, 'app', name);
      assert.equal(j.action, 'open');
      assert.equal(j.target, file);
      assert.equal('url' in j, false, 'an app open has no URL');
      assert.equal('server' in j, false);
      assertNothingOpened(j);
    }
  } finally { cleanup(); }
});

test('plan: without --desktop nothing is written to the working folder', async () => {
  const { dir, cleanup } = tempDir();
  try {
    write(path.join(dir, 'site', 'index.html'), '<title>S</title>');
    const j = jsonOf(await cli(['plan', path.join(dir, 'site'), '--cwd', dir]));
    assert.equal(j.action, 'start-server');
    assert.equal(j.launchJson, null);
    assert.equal(existsSync(path.join(dir, '.claude')), false);
  } finally { cleanup(); }
});

test('plan --desktop writes <cwd>/.claude/launch.json once; a second run keeps port and file', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const site = path.join(dir, 'site');
    const proj = path.join(dir, 'project');
    mkdirSync(proj);
    write(path.join(site, 'index.html'), '<title>S</title>');
    const file = path.join(proj, '.claude', 'launch.json');

    const r1 = await cli(['plan', site, '--desktop', '--cwd', proj]);
    assert.equal(r1.code, 0, r1.stdout);
    const j1 = jsonOf(r1);
    assertStaticPlan(j1, { root: site });
    assert.deepEqual(j1.launchJson, { ok: true, file, action: 'created' });
    assert.ok(existsSync(file), 'launch.json written');

    const before = readFileSync(file);
    const mtimeBefore = statSync(file).mtimeMs;
    const launch = JSON.parse(before.toString('utf8'));
    assert.equal(launch.version, '0.0.1');
    assert.equal(launch.configurations.length, 1);
    const entry = launch.configurations[0];
    assert.equal(entry.name, j1.server.name);
    assert.equal(entry.runtimeExecutable, 'node');
    assert.ok(entry.runtimeArgs.includes('serve'));
    assert.deepEqual(entry.runtimeArgs, j1.server.args);
    assert.equal(entry.port, j1.server.port);
    assert.equal(existsSync(path.join(site, '.claude')), false, 'nothing written into the served folder');

    const r2 = await cli(['plan', site, '--desktop', '--cwd', proj]);
    assert.equal(r2.code, 0, r2.stdout);
    const j2 = jsonOf(r2);
    assert.equal(j2.server.port, j1.server.port, 'same port on the second run');
    assert.equal(j2.server.name, j1.server.name);
    assert.deepEqual(j2.launchJson, { ok: true, file, action: 'unchanged' });
    assert.ok(readFileSync(file).equals(before), 'launch.json bytes unchanged');
    assert.equal(statSync(file).mtimeMs, mtimeBefore, 'launch.json not rewritten');
  } finally { cleanup(); }
});

test('plan --desktop adds its entry to an existing launch.json, keeping the other entry verbatim', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const site = path.join(dir, 'site');
    write(path.join(site, 'index.html'), '<title>S</title>');
    const mine = {
      name: 'my-app', runtimeExecutable: 'npm', runtimeArgs: ['run', 'start'], port: 3000,
    };
    const original = `{\n    "version": "0.0.1",\n    "configurations": [\n        {\n            "name": "my-app",\n            "runtimeExecutable": "npm",\n            "runtimeArgs": ["run", "start"],\n            "port": 3000\n        }\n    ]\n}\n`;
    const file = write(path.join(dir, '.claude', 'launch.json'), original);
    const j = jsonOf(await cli(['plan', site, '--desktop', '--cwd', dir]));
    assert.deepEqual(j.launchJson, { ok: true, file, action: 'added' });
    const after = readFileSync(file, 'utf8');
    const lastEntryEnd = original.lastIndexOf('}', original.lastIndexOf(']')) + 1;
    assert.ok(after.startsWith(original.slice(0, lastEntryEnd)), 'everything up to the existing entry is byte-identical');
    const parsed = JSON.parse(after);
    assert.equal(parsed.configurations.length, 2);
    assert.deepEqual(parsed.configurations[0], mine);
    assert.equal(parsed.configurations[1].name, j.server.name);
  } finally { cleanup(); }
});

test('plan --desktop leaves a launch.json with comments untouched and reports invalid-json', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const site = path.join(dir, 'site');
    write(path.join(site, 'index.html'), '<title>S</title>');
    const original = '{\n  // my notes\n  "version": "0.0.1",\n  "configurations": []\n}\n';
    const file = write(path.join(dir, '.claude', 'launch.json'), original);
    const r = await cli(['plan', site, '--desktop', '--cwd', dir]);
    const j = jsonOf(r);
    assert.equal(j.action, 'start-server');
    assert.equal(j.launchJson.ok, false);
    assert.equal(j.launchJson.error, 'invalid-json');
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally { cleanup(); }
});

test('plan: a dev project with "--port 5999" plans its own dev server on 5999', async (t) => {
  if (await somethingListens(DEV_PORT)) { t.skip(`port ${DEV_PORT} is in use on this machine`); return; }
  const { dir, cleanup } = tempDir();
  try {
    const proj = path.join(dir, 'webapp');
    write(path.join(proj, 'package.json'), JSON.stringify({ name: 'webapp', scripts: { dev: `vite --port ${DEV_PORT}` } }));

    const devRunArgs = [path.resolve(SHOW), 'dev-run', proj, '--port', String(DEV_PORT)];

    await t.test('show-local dev-run starts `npm run dev` inside the project', async () => {
      const r = await cli(['plan', proj]);
      assert.equal(r.code, 0, r.stdout);
      const j = jsonOf(r);
      assert.equal(j.ok, true);
      assert.equal(j.mode, 'dev');
      assert.equal(j.action, 'start-server');
      assert.equal(j.lifetime, 'session');
      assert.equal(j.opened, false);
      assert.equal(j.server.kind, 'dev');
      assert.equal(j.server.port, DEV_PORT);
      assert.equal(j.server.portSource, 'script');
      assert.equal(j.server.url, `http://localhost:${DEV_PORT}/`);
      assert.equal(j.server.root, proj);
      assert.equal(j.server.runner, 'npm run dev');
      assert.equal(j.server.command, 'node');
      assert.deepEqual(j.server.args, devRunArgs);
      assert.match(j.server.name, /^show-dev-webapp-[0-9a-f]{6}$/);
      assert.equal(j.next.start, `node '${shellForm(path.resolve(SHOW))}' dev-run '${shellForm(proj)}' --port ${DEV_PORT}`);
      assert.ok(j.next.then.includes(j.server.url));
      assert.match(j.next.then, /--wait 60000/);
      // Opening the page names the project, so a server dev-run did not record is recorded then.
      assert.ok(j.next.then.endsWith(` --dev-root '${shellForm(proj)}'`), j.next.then);
      assert.equal(j.launchJson, null);
    });

    await t.test('from the project folder: the same command, the path is still one quoted argument', async () => {
      const j = jsonOf(await cli(['plan', proj, '--cwd', proj]));
      assert.deepEqual(j.server.args, devRunArgs);
    });

    await t.test('--desktop writes a node launch entry on 5999: the desktop app starts no npm and no cmd.exe', async () => {
      const j = jsonOf(await cli(['plan', proj, '--desktop', '--cwd', proj]));
      const file = path.join(proj, '.claude', 'launch.json');
      assert.deepEqual(j.launchJson, { ok: true, file, action: 'created' });
      const entry = readJson(file).configurations[0];
      assert.deepEqual(entry, { name: j.server.name, runtimeExecutable: 'node', runtimeArgs: devRunArgs, port: DEV_PORT });
    });

    await t.test('a pnpm lockfile switches the package manager dev-run starts', async () => {
      write(path.join(proj, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      const j = jsonOf(await cli(['plan', proj]));
      assert.equal(j.server.runner, 'pnpm run dev');
      assert.deepEqual(j.server.args, devRunArgs);
    });

    await t.test('--headless: next is one oneshot command and nothing else', async () => {
      const j = jsonOf(await cli(['plan', proj, '--headless', '--cwd', dir]));
      assert.equal(j.headless, true);
      assert.equal(j.lifetime, 'command');
      assert.deepEqual(Object.keys(j.next), ['oneshot']);
      assert.equal(j.next.oneshot, `node '${shellForm(path.resolve(SHOW))}' oneshot '${shellForm(proj)}' --cwd '${shellForm(dir)}'`);
    });
  } finally { cleanup(); }
});

test('plan: a dev script with no recognisable port fails with dev-port-unknown (exit 1)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    write(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    const r = await cli(['plan', dir]);
    assert.equal(r.code, 1);
    const j = jsonOf(r);
    assert.equal(j.ok, false);
    assert.equal(j.mode, 'dev');
    assert.equal(j.error, 'dev-port-unknown');
    assert.equal(j.opened, false);
  } finally { cleanup(); }
});

test('plan never touches the platform adapter, for every kind of target (in-process, trap adapter)', async (t) => {
  const { show } = await import(lib('open.mjs'));
  const used = [];
  const trap = new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return () => { used.push(prop); throw new Error(`plan used adapter.${prop}()`); };
    },
  });
  const { dir, cleanup } = tempDir();
  try {
    const plain = write(path.join(dir, 'plain', 'r.html'), '<title>R</title>');
    const mod = write(path.join(dir, 'mod', 'app.html'), '<script type="module">1</script>');
    const site = path.join(dir, 'site');
    write(path.join(site, 'index.html'), '<title>S</title>');
    const outputs = path.join(dir, 'outputs');
    write(path.join(outputs, 'a.png'), 'x');
    const app = write(path.join(dir, 'x.pdf'), '%PDF-1.4');
    const devNoPort = path.join(dir, 'dev0');
    write(path.join(devNoPort, 'package.json'), JSON.stringify({ scripts: { dev: 'node s.js' } }));
    const cases = [
      ['url', 'https://example.com/', 'url'],
      ['file', plain, 'file'],
      ['module html', mod, 'serve'],
      ['folder with index.html', site, 'serve'],
      ['folder of outputs', outputs, 'folder'],
      ['app file', app, 'app'],
      ['dev without a port', devNoPort, 'dev'],
    ];
    if (!(await somethingListens(DEV_PORT))) {
      const dev = path.join(dir, 'dev');
      write(path.join(dev, 'package.json'), JSON.stringify({ scripts: { dev: `vite --port ${DEV_PORT}` } }));
      cases.push(['dev on 5999', dev, 'dev']);
    }
    for (const [label, target, mode] of cases) {
      await t.test(label, async () => {
        used.length = 0;
        const r = await show(target, { planOnly: true, adapter: trap, cwd: dir, timeoutMs: 100, waitMs: 100 });
        assert.equal(r.mode, mode, JSON.stringify(r));
        assert.deepEqual(used, [], `adapter methods called during plan: ${used.join(', ')}`);
        assert.notEqual(r.opened, true);
      });
    }
    assert.equal(existsSync(path.join(dir, '.claude')), false, 'plan without desktop wrote nothing');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// lifecycle: serve → GET → servers → plan (already running) → stop

test('lifecycle: serve, GET, servers, plan alreadyRunning, stop', async (t) => {
  const { dir, cleanup } = tempDir();
  // Its own registry: the server, servers, plan and stop never see or touch the user's real ones.
  const st = isolatedState();
  const { env } = st;
  const site = path.join(dir, 'site');
  write(path.join(site, 'index.html'), '<!doctype html><title>Lifecycle</title><p>hello from show-local');
  write(path.join(site, 'app.html'), '<title>App</title><script type="module">1</script>');
  const other = path.join(dir, 'other');
  write(path.join(other, 'index.html'), '<title>Other</title>');
  const log = path.join(dir, 'access.log');
  const port = await portOutsideRange();

  let child = null;
  let stdout = '';
  let stderr = '';
  let exited = null;
  try {
    child = spawn(process.execPath, [SHOW, 'serve', site, '--port', String(port), '--log', log], {
      cwd: ROOT, env: withVars(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

    const firstLine = await withTimeout((async () => {
      while (!stdout.includes('\n')) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`serve exited early: ${stdout}${stderr}`);
        await sleep(50);
      }
      return stdout.slice(0, stdout.indexOf('\n'));
    })(), 15000, 'serve JSON line');

    await t.test('serve prints one JSON line describing the server', () => {
      const info = JSON.parse(firstLine);
      assert.deepEqual(info, {
        ok: true, serving: site, url: `http://127.0.0.1:${port}/`, port, log, pid: child.pid, parentWatch: true,
      });
    });

    await t.test('GET / returns 200 with the index page and the show-local header', async () => {
      const res = await httpGet(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
      assert.match(res.body, /hello from show-local/);
      assert.match(res.headers['content-type'], /^text\/html/);
      assert.ok(res.headers['x-show-local'], 'x-show-local header present');
      assert.equal(res.headers['cache-control'], 'no-store');
    });

    await t.test('the access log records the GET', async () => {
      // Bounded loop: an endless poll would keep the test file alive after a timeout.
      const text = await withTimeout((async () => {
        for (let i = 0; i < 120; i++) {
          const s = existsSync(log) ? readFileSync(log, 'utf8') : '';
          if (/ GET \/ 200 "[^"]*"$/m.test(s)) return s;
          await sleep(50);
        }
        return existsSync(log) ? readFileSync(log, 'utf8') : '';
      })(), 7000, 'log line');
      assert.match(text, /^\S+ GET \/ 200 "[^"]*"$/m);
    });

    await t.test('the server refuses foreign Host headers', async () => {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { host: `evil.example:${port}` } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 403);
    });

    await t.test('servers lists it with its pid, root, url and log', async () => {
      const r = await cli(['servers'], { env });
      assert.equal(r.code, 0);
      const entry = jsonOf(r).servers.find((s) => s.port === port);
      assert.ok(entry, `port ${port} listed in ${r.stdout}`);
      assert.equal(entry.pid, child.pid);
      assert.equal(entry.root, site);
      assert.equal(entry.url, `http://127.0.0.1:${port}/`);
      assert.equal(entry.log, log);
      assert.ok(!Number.isNaN(Date.parse(entry.started)));
    });

    await t.test('plan on the served folder now reports alreadyRunning (and opens nothing)', async () => {
      const r = await cli(['plan', site], { env });
      assert.equal(r.code, 0, r.stdout);
      const j = jsonOf(r);
      assert.equal(j.ok, true);
      assert.equal(j.mode, 'serve');
      assert.equal(j.alreadyRunning, true);
      assert.equal(j.action, 'open');
      assert.equal(j.url, `http://127.0.0.1:${port}/`);
      assert.equal('server' in j, false, 'no server to start');
      assertNothingOpened(j);
    });

    await t.test('plan on a module page inside the served folder reuses the server', async () => {
      const j = jsonOf(await cli(['plan', path.join(site, 'app.html')], { env }));
      assert.equal(j.alreadyRunning, true);
      assert.equal(j.url, `http://127.0.0.1:${port}/app.html`);
    });

    await t.test('a second serve of the same folder on that port reports it is already served and exits 0', async () => {
      const r = await cli(['serve', site, '--port', String(port), '--log', path.join(dir, 'dup.log')], { timeoutMs: 20000, env });
      assert.equal(r.code, 0, r.stdout);
      const j = jsonOf(r);
      assert.equal(j.ok, true);
      assert.match(j.detail, /Already serving/);
      const still = await httpGet(`http://127.0.0.1:${port}/`);
      assert.equal(still.status, 200, 'the original server still answers');
    });

    await t.test('a duplicate serve that finds the folder already served keeps the running server\'s access log', async () => {
      const res = await httpGet(`http://127.0.0.1:${port}/?before-duplicate`);
      assert.equal(res.status, 200);
      await sleep(100);
      assert.match(readFileSync(log, 'utf8'), /GET \/\?before-duplicate 200/);
      const r = await cli(['serve', site, '--port', String(port), '--log', log], { timeoutMs: 20000, env });
      assert.equal(r.code, 0, r.stdout);
      assert.match(jsonOf(r).detail, /Already serving/);
      assert.match(readFileSync(log, 'utf8'), /GET \/\?before-duplicate 200/,
        'a serve that did not start a server must not truncate the running server\'s log');
    });

    await t.test('serving another folder on the taken port fails with EADDRINUSE (exit 1)', async () => {
      const r = await cli(['serve', other, '--port', String(port), '--log', path.join(dir, 'other.log')], { timeoutMs: 20000, env });
      assert.equal(r.code, 1, r.stdout);
      const j = jsonOf(r);
      assert.equal(j.ok, false);
      assert.equal(j.error, 'EADDRINUSE');
      const still = await httpGet(`http://127.0.0.1:${port}/`);
      assert.match(still.body, /hello from show-local/, 'the original folder is still the one served');
    });

    await t.test('stop <port> stops it: the child exits and the port refuses connections', async () => {
      assert.ok(existsSync(path.join(st.serversDir, `${port}.json`)), 'registered in the isolated state folder');
      const r = await cli(['stop', String(port)], { env });
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(jsonOf(r), { ok: true, stopped: [{ port, root: site }], notFound: [] });
      await withTimeout(exited, 10000, 'serve child exit');
      assert.equal(await canConnect(port), false, 'port refuses connections');
      assert.equal(existsSync(path.join(st.serversDir, `${port}.json`)), false, 'registry entry removed');
      assert.equal(existsSync(path.join(REGISTRY_DIR, `${port}.json`)), false, 'the real registry never had it');
    });

    await t.test('after stop, servers no longer lists it and plan wants a server again', async () => {
      const list = jsonOf(await cli(['servers'], { env }));
      assert.equal(list.servers.some((s) => s.port === port), false);
      const j = jsonOf(await cli(['plan', site], { env }));
      assert.equal(j.action, 'start-server');
      assert.equal(j.alreadyRunning, undefined);
    });

    await t.test('stop on the same port again is not found (exit 1)', async () => {
      const r = await cli(['stop', String(port)], { env });
      assert.equal(r.code, 1);
      assert.deepEqual(jsonOf(r), { ok: false, stopped: [], notFound: [String(port)] });
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      try { await withTimeout(exited, 5000, 'child exit'); } catch { /* best effort */ }
    }
    try { cleanup(); } catch { /* a Windows handle may linger briefly */ }
    try { st.cleanup(); } catch { /* same */ }
  }
});

test('stop <unknown port> exits 1 and names the port', async () => {
  const port = await portOutsideRange();
  const r = await cli(['stop', String(port)]);
  assert.equal(r.code, 1);
  assert.deepEqual(jsonOf(r), { ok: false, stopped: [], notFound: [String(port)] });
});

test('cli: doctor prints one JSON report, reads launch.json in --cwd, and changes nothing', async () => {
  // A real run on this machine (read-only checks). The fakes in adapters.test.mjs pin each
  // platform's checks; this pins the command itself: dispatch, --cwd, JSON and exit code.
  const st = isolatedState();
  const { dir, cleanup } = tempDir();
  try {
    const lj = write(path.join(dir, '.claude', 'launch.json'), '{"version": "0.0.1", "configurations": []}\n');
    const before = readFileSync(lj, 'utf8');
    const r = await cli(['doctor', '--cwd', dir], { env: st.env, timeoutMs: 120000 });
    const j = jsonOf(r);
    assert.equal(r.code, j.ok ? 0 : 1, 'exit code follows ok');
    assert.equal(j.platform, process.platform);
    assert.ok(['ok', 'warn', 'fail'].includes(j.status), j.status);
    assert.equal(j.ok, j.status !== 'fail');
    for (const c of j.checks) {
      assert.equal(typeof c.id, 'string');
      assert.ok(['ok', 'warn', 'fail', 'info'].includes(c.status), JSON.stringify(c));
      assert.equal(typeof c.detail, 'string');
    }
    const ids = j.checks.map((c) => c.id);
    for (const id of ['node', 'browser', 'ports', 'servers', 'launch-json']) assert.ok(ids.includes(id), `${id} in ${ids.join(', ')}`);
    assert.equal(j.checks.find((c) => c.id === 'node').status, 'ok');
    assert.equal(j.checks.find((c) => c.id === 'launch-json').detail, `Desktop preview config present: ${lj}`);
    assert.equal(j.checks.find((c) => c.id === 'servers').detail, 'No show-local servers running.', 'the isolated registry is empty');
    assert.equal(readFileSync(lj, 'utf8'), before, 'launch.json untouched');
    assert.deepEqual(readdirSync(dir), ['.claude'], 'nothing written into --cwd');
  } finally {
    cleanup();
    try { st.cleanup(); } catch { /* a Windows handle on the helper DLL may linger briefly */ }
  }
});

test('stop all with no servers registered is ok and stops nothing', async () => {
  const st = isolatedState();
  try {
    const r = await cli(['stop', 'all'], { env: st.env });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(jsonOf(r), { ok: true, stopped: [], notFound: [] });
  } finally { st.cleanup(); }
});

/** A live process that does nothing: the pid a doctored registry entry points at. */
function idleProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, exited, alive: () => child.exitCode === null && child.signalCode === null };
}

/** Start `show.mjs serve <folder>` (no --port); resolves with its JSON line, or null if it could not start. */
async function startServe(folder, env) {
  const child = spawn(process.execPath, [SHOW, 'serve', folder], { cwd: ROOT, env: withVars(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  // Success is one JSON line and the process keeps running; a failure is a pretty-printed
  // (multi-line) JSON object followed by exit.
  const info = await withTimeout((async () => {
    for (;;) {
      const nl = out.indexOf('\n');
      if (nl !== -1) { try { return JSON.parse(out.slice(0, nl)); } catch { /* not a one-line object */ } }
      if (child.exitCode !== null) { try { return JSON.parse(out); } catch { return null; } }
      await sleep(50);
    }
  })(), 15000, 'serve JSON line');
  return { child, exited, info, out: () => out };
}

test('stop refuses an entry whose port belongs to another process; stop all stops only what it owns', async (t) => {
  const { rootTag } = await import(lib('server.mjs'));
  const { listeningPid } = await import(lib('portowner.mjs'));
  const st = isolatedState();
  const { dir, cleanup } = tempDir();
  const site = path.join(dir, 'site');
  const decoySite = path.join(dir, 'decoy-site');
  write(path.join(site, 'index.html'), '<title>Mine</title>');
  write(path.join(decoySite, 'index.html'), '<title>Decoy</title>');

  // An HTTP server in THIS process that answers exactly like a show-local server for decoySite,
  // and a registry entry for its port that names an unrelated live process as the server.
  // A stop that trusted the registry would kill that process; the port owner check must refuse.
  const port = await portOutsideRange();
  const impostor = http.createServer((q, r) => { r.writeHead(200, { 'X-Show-Local': rootTag(decoySite) }); r.end('impostor'); });
  await new Promise((resolve, reject) => { impostor.once('error', reject); impostor.listen(port, '127.0.0.1', resolve); });
  const bystander = idleProcess();
  let serve = null;
  try {
    const owner = listeningPid(port);
    if (owner === null) { t.skip('this machine cannot name the process that owns a port (no netstat, lsof or ss)'); return; }
    assert.equal(owner, process.pid, 'the impostor port is owned by the test process');
    mkdirSync(st.serversDir, { recursive: true, mode: 0o700 });
    const entry = { pid: bystander.child.pid, port, root: decoySite, url: `http://127.0.0.1:${port}/`, log: path.join(dir, 'x.log'), started: new Date().toISOString() };
    writeFileSync(path.join(st.serversDir, `${port}.json`), JSON.stringify(entry));
    const refusal = { port, pid: bystander.child.pid, owner: process.pid };
    // The detail is prose for the reader; the fields are the contract.
    const refusals = (j) => (j.refused || []).map(({ detail, ...rest }) => { assert.match(detail, /another process/); return rest; });

    await t.test('servers lists the doctored entry (it answers as show-local)', async () => {
      const j = jsonOf(await cli(['servers'], { env: st.env }));
      assert.deepEqual(j.servers.map((s) => s.port), [port]);
    });

    await t.test('stop <port> refuses, exits 1 and kills nothing', async () => {
      const r = await cli(['stop', String(port)], { env: st.env });
      assert.equal(r.code, 1, r.stdout);
      const j = jsonOf(r);
      assert.deepEqual({ ...j, refused: refusals(j) }, { ok: false, stopped: [], notFound: [], refused: [refusal] });
      await sleep(300);
      assert.ok(bystander.alive(), 'the process named in the registry is still running');
      assert.equal((await httpGet(`http://127.0.0.1:${port}/`)).body, 'impostor', 'the port owner still answers');
      assert.ok(existsSync(path.join(st.serversDir, `${port}.json`)), 'the entry is kept: nothing was stopped');
    });

    // A real server started without --port: it picks its own port in 4400-4499.
    serve = await startServe(site, st.env);
    if (!serve.info) { t.skip(`serve could not start: ${serve.out()}`); return; }
    if (!serve.info.ok) { t.skip(`no free port in ${PORT_MIN}-${PORT_MAX} on this machine`); return; }

    await t.test('serve without --port picks a port in 4400-4499 and registers itself', async () => {
      assert.equal(serve.info.serving, site);
      assert.ok(serve.info.port >= PORT_MIN && serve.info.port <= PORT_MAX, `port ${serve.info.port}`);
      assert.equal(serve.info.pid, serve.child.pid);
      assert.ok(existsSync(path.join(st.serversDir, `${serve.info.port}.json`)), 'registered in the isolated state folder');
      const j = jsonOf(await cli(['servers'], { env: st.env }));
      assert.deepEqual(j.servers.map((s) => s.port).sort((a, b) => a - b), [port, serve.info.port].sort((a, b) => a - b));
    });

    await t.test('stop all stops its own server, refuses the doctored entry, exits 1', async () => {
      const r = await cli(['stop', 'all'], { env: st.env });
      assert.equal(r.code, 1, r.stdout);
      const j = jsonOf(r);
      assert.deepEqual({ ...j, refused: refusals(j) }, { ok: false, stopped: [{ port: serve.info.port, root: site }], notFound: [], refused: [refusal] });
      await withTimeout(serve.exited, 10000, 'serve child exit');
      assert.equal(await canConnect(serve.info.port), false, 'its port refuses connections');
      assert.equal(existsSync(path.join(st.serversDir, `${serve.info.port}.json`)), false, 'its entry is removed');
      assert.ok(bystander.alive(), 'the process named in the doctored entry is still running');
      assert.equal((await httpGet(`http://127.0.0.1:${port}/`)).body, 'impostor');
    });
  } finally {
    if (serve && serve.child.exitCode === null && serve.child.signalCode === null) {
      serve.child.kill();
      try { await withTimeout(serve.exited, 5000, 'serve exit'); } catch { /* best effort */ }
    }
    if (bystander.alive()) bystander.child.kill();
    try { await withTimeout(bystander.exited, 5000, 'idle process exit'); } catch { /* best effort */ }
    await new Promise((resolve) => impostor.close(resolve));
    try { cleanup(); } catch { /* a Windows handle may linger briefly */ }
    try { st.cleanup(); } catch { /* same */ }
  }
});

// ---------------------------------------------------------------------------------------------
// meta: versions, dependencies, imports, skills, hooks

test('meta: plugin.json, marketplace.json and package.json carry the same semver version', () => {
  const plugin = readJson(PLUGIN_JSON_FILE);
  const market = readJson(MARKETPLACE_FILE);
  const pkg = readJson(PACKAGE_FILE);
  assert.match(plugin.version, SEMVER);
  assert.equal(market.metadata?.version, plugin.version, 'marketplace metadata.version');
  assert.ok(Array.isArray(market.plugins) && market.plugins.length >= 1, 'marketplace lists plugins');
  assert.equal(market.plugins[0].version, plugin.version, 'marketplace plugins[0].version');
  assert.equal(pkg.version, plugin.version, 'package.json version');
});

const CHANGELOGS = [path.join(ROOT, 'CHANGELOG.md'), path.join(PLUGIN, 'CHANGELOG.md')].filter((f) => existsSync(f));

test('meta: CHANGELOG.md starts with a release heading for the current version', { skip: CHANGELOGS.length ? false : 'no CHANGELOG.md' }, () => {
  const version = readJson(PLUGIN_JSON_FILE).version;
  for (const file of CHANGELOGS) {
    let first = null;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (!h || /unreleased/i.test(h[1])) continue;
      const v = h[1].match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
      if (v) { first = v[1]; break; }
    }
    assert.ok(first, `${file} has a release heading`);
    assert.equal(first, version, `${path.relative(ROOT, file)} first release heading`);
  }
});

test('meta: the marketplace entry points at this plugin', () => {
  const plugin = readJson(PLUGIN_JSON_FILE);
  const entry = readJson(MARKETPLACE_FILE).plugins[0];
  assert.equal(plugin.name, 'show-local');
  assert.equal(entry.name, plugin.name);
  assert.equal(path.resolve(ROOT, entry.source), PLUGIN);
  assert.ok(existsSync(path.join(path.resolve(ROOT, entry.source), '.claude-plugin', 'plugin.json')));
});

test('meta: package.json declares no dependencies of any kind', () => {
  const pkg = readJson(PACKAGE_FILE);
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    const v = pkg[key];
    const empty = v === undefined || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
    assert.ok(empty, `package.json ${key} must be absent or empty, found ${JSON.stringify(v)}`);
  }
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines?.node, '>=18.1', 'node --test (used by npm test) exists from Node 18.1');
});

test('meta: every import in scripts/**/*.mjs is node:* or a relative path that exists', () => {
  const files = walk(SCRIPTS, '.mjs');
  assert.ok(files.length >= 10, `found ${files.length} .mjs files`);
  let total = 0;
  const bad = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const { statics, dynamics } = importSpecifiers(src);
    const importLines = src.split(/\r?\n/).filter((l) => /^[ \t]*import[\s{*'"]/.test(l) && !/^[ \t]*import\s*\(/.test(l)).length;
    assert.equal(statics.length, importLines, `${path.relative(ROOT, file)}: every import statement was parsed`);
    for (const spec of [...statics, ...dynamics]) {
      total++;
      const rel = path.relative(ROOT, file);
      if (spec.startsWith('node:')) {
        if (!builtinModules.includes(spec.slice(5))) bad.push(`${rel}: ${spec} is not a Node built-in`);
      } else if (spec.startsWith('./') || spec.startsWith('../')) {
        if (!existsSync(path.resolve(path.dirname(file), spec))) bad.push(`${rel}: ${spec} does not exist`);
      } else {
        bad.push(`${rel}: ${spec} is neither node:* nor relative`);
      }
    }
    assert.doesNotMatch(src, /\bcreateRequire\b|\brequire\s*\(/, `${path.relative(ROOT, file)} must not require()`);
  }
  assert.ok(total >= 40, `parsed ${total} imports`);
  assert.deepEqual(bad, []);
});

test('meta: show.mjs is an executable node script', () => {
  assert.ok(readFileSync(SHOW, 'utf8').startsWith('#!/usr/bin/env node\n'), 'LF shebang on the first line');
});

const SKILLS = skillFolders();

test('meta: there is a skills folder with the show skill in it', () => {
  assert.ok(SKILLS.length >= 1);
  assert.ok(SKILLS.includes('show'), SKILLS.join(', '));
});

for (const folder of SKILLS) {
  test(`meta: skills/${folder}/SKILL.md frontmatter, description and length`, () => {
    const file = path.join(SKILLS_DIR, folder, 'SKILL.md');
    assert.ok(existsSync(file), `${folder} has a SKILL.md`);
    const text = readFileSync(file, 'utf8');
    const fm = frontmatter(text);
    assert.ok(fm, 'starts with a --- frontmatter block');
    assert.equal(fm.fields.name, folder, 'name equals the folder name');
    assert.match(fm.fields.name, /^[a-z0-9-]{1,64}$/, 'name is lowercase letters, digits and hyphens');
    const desc = fm.fields.description;
    assert.equal(typeof desc, 'string', 'has a description');
    assert.ok(desc.length > 0, 'description is not empty');
    assert.ok([...desc].length <= 1024, `description is ${[...desc].length} characters (max 1024)`);
    if (fm.plain.description) {
      // An unquoted YAML scalar breaks on ": " or " #" and must not start with an indicator.
      assert.doesNotMatch(desc, /:\s/, 'plain description contains ": "');
      assert.doesNotMatch(desc, /\s#/, 'plain description contains " #"');
      assert.doesNotMatch(desc, /^[-?:,[\]{}#&*!|>'"%@`]/, 'plain description starts with a YAML indicator');
    }
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    assert.ok(lines.length <= 250, `${lines.length} lines (max 250)`);
  });
}

test('meta: skills point at scripts/show.mjs, which exists at both documented locations', () => {
  for (const folder of SKILLS) {
    const text = readFileSync(path.join(SKILLS_DIR, folder, 'SKILL.md'), 'utf8');
    if (!text.includes('scripts/show.mjs')) continue;
    assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs'), `${folder} names \${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs`);
    assert.ok(existsSync(path.join(PLUGIN, 'scripts', 'show.mjs')));
    if (text.includes('<Base directory for this skill>/../../scripts/show.mjs')) {
      assert.ok(existsSync(path.resolve(SKILLS_DIR, folder, '../../scripts/show.mjs')), `${folder}: fallback path resolves`);
    }
  }
});

test('meta: every show.mjs command and flag the skills use is documented in --help', async () => {
  const help = (await cli(['--help'])).stdout;
  const helpFlags = new Set([...help.matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1]));
  const helpCommands = new Set([...help.matchAll(/node show\.mjs ([a-z][a-z-]*)/g)].map((m) => m[1]));
  const used = [];
  for (const folder of SKILLS) {
    for (const line of readFileSync(path.join(SKILLS_DIR, folder, 'SKILL.md'), 'utf8').split(/\r?\n/)) {
      const marker = "node '${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs'";
      const at = line.indexOf(marker);
      if (at === -1) continue;
      const rest = line.slice(at + marker.length).split('`')[0].split('#')[0];
      const cmd = rest.match(/^\s+([a-z][a-z-]*)(?![^\s])/);
      if (cmd) {
        used.push(cmd[1]);
        assert.ok(helpCommands.has(cmd[1]), `${folder}: command "${cmd[1]}" is documented in --help`);
      }
      for (const m of rest.matchAll(/(--[a-z][a-z-]*)/g)) {
        used.push(m[1]);
        assert.ok(helpFlags.has(m[1]), `${folder}: flag ${m[1]} is documented in --help`);
      }
    }
  }
  assert.ok(used.length >= 3, `found ${used.length} command/flag uses in the skills`);
});

test('meta: the show skill description carries the Hebrew and slash triggers', () => {
  const desc = frontmatter(readFileSync(path.join(SKILLS_DIR, 'show', 'SKILL.md'), 'utf8')).fields.description;
  for (const phrase of ['תציג לי', 'תפתח לי', 'תראה לי בדפדפן', 'תציג לוקאלית', 'תפתח את התיקייה', '/show-local']) {
    assert.ok(desc.includes(phrase), `show description contains "${phrase}"`);
  }
});

test('meta: no quoted trigger phrase appears in the descriptions of two different skills', () => {
  const owners = new Map();
  for (const folder of SKILLS) {
    const desc = frontmatter(readFileSync(path.join(SKILLS_DIR, folder, 'SKILL.md'), 'utf8')).fields.description;
    const phrases = quotedPhrases(desc);
    assert.ok(phrases.length >= 1, `${folder} has quoted trigger phrases`);
    for (const p of new Set(phrases.map(normPhrase))) {
      if (!owners.has(p)) owners.set(p, new Set());
      owners.get(p).add(folder);
    }
  }
  const shared = [...owners].filter(([, s]) => s.size > 1).map(([p, s]) => `"${p}" in ${[...s].join(' + ')}`);
  assert.deepEqual(shared, []);
});

test('meta: the plugin ships no hooks', () => {
  assert.equal(existsSync(path.join(PLUGIN, 'hooks')), false, 'no plugins/show-local/hooks directory');
  const plugin = readJson(PLUGIN_JSON_FILE);
  assert.equal('hooks' in plugin, false, 'no "hooks" key in plugin.json');
  for (const entry of readJson(MARKETPLACE_FILE).plugins) {
    assert.equal('hooks' in entry, false, `no "hooks" key in marketplace entry ${entry.name}`);
  }
});
