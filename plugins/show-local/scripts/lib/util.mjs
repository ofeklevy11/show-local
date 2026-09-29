// Small shared helpers. Built-in modules only: the plugin has no dependencies.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run a program synchronously with an argument array (never a shell string). */
export function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout ?? 10000,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    cwd: opts.cwd,
    input: opts.input,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

/** Case-insensitive path key on Windows and macOS, exact elsewhere. */
export function pathKey(p, platform = process.platform) {
  const abs = path.resolve(p);
  return platform === 'win32' || platform === 'darwin' ? abs.toLowerCase() : abs;
}

/**
 * A path Windows would reach over the network (and authenticate to). Checked on the spelling
 * alone, before anything touches the disk.
 */
export const isNetworkPath = (p, platform = process.platform) => platform === 'win32'
  && (/^(\\\\|\/\/)/.test(String(p)) || path.resolve(String(p)).startsWith('\\\\'));

/** ASCII slug for launch.json entry names; stable per folder thanks to the hash suffix. */
export function slugFor(dir, platform = process.platform) {
  const base = path.basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${base || 'site'}-${sha1(pathKey(dir, platform)).slice(0, 6)}`;
}

/**
 * Is `dir` (created if missing) a real folder that only this user can use? lstat, not stat:
 * in a shared /tmp another user can plant a symlink to a folder of ours, and following it
 * would pass every check below. A folder of ours that others can read but not write (an
 * older version, a manual mkdir) is closed with chmod; one others can write is never used,
 * because they may already have planted links inside it.
 */
function privateDir(dir, uid) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let st = lstatSync(dir);
    if (!st.isDirectory()) return false;
    if (uid === null) return true;
    if (st.uid !== uid || (st.mode & 0o022) !== 0) return false;
    if ((st.mode & 0o077) !== 0) { chmodSync(dir, 0o700); st = lstatSync(dir); }
    return st.isDirectory() && st.uid === uid && (st.mode & 0o077) === 0;
  } catch {
    // Not creatable (an inherited XDG_RUNTIME_DIR of another user, a file in the way).
    return false;
  }
}

const lastResort = new Map();

// os.homedir() throws when $HOME is unset and the uid has no passwd entry (some containers).
const homeOrNull = () => { try { return os.homedir() || null; } catch { return null; } };

/**
 * Per-user state folder (server registry, access logs, the Windows helper DLL).
 * Windows and macOS temp folders are already per-user. On Linux /tmp is shared, so use
 * $XDG_RUNTIME_DIR when there is one, and in any case a folder only this user can enter.
 * The first candidate that passes privateDir wins; when none does, a fresh mkdtemp folder
 * (0700, nobody can have planted it) keeps show-local working, for this process at least.
 * The options exist for tests; callers use the defaults.
 */
export function stateDir({
  platform = process.platform, env = process.env, tmpdir = os.tmpdir(), home = homeOrNull(),
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const name = uid === null ? 'show-local' : `show-local-${uid}`;
  const candidates = [];
  // The spec requires an absolute path; a relative one would land in whatever the cwd is.
  if (platform === 'linux' && env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR)) {
    candidates.push(path.join(env.XDG_RUNTIME_DIR, name));
  }
  candidates.push(path.join(tmpdir, name));
  if (home) candidates.push(path.join(home, '.cache', 'show-local'));
  for (const dir of candidates) if (privateDir(dir, uid)) return dir;
  const known = lastResort.get(tmpdir);
  if (known && privateDir(known, uid)) return known;
  const dir = mkdtempSync(path.join(tmpdir, 'show-local-'));
  lastResort.set(tmpdir, dir);
  return dir;
}

// The named entities that realistically appear in page titles. Anything else is left as is.
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', para: '¶', sect: '§',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', check: '✓',
  shy: '­', thinsp: ' ', ensp: ' ', emsp: ' ', zwj: '‍', zwnj: '‌', lrm: '‎', rlm: '‏',
};
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Browsers render invalid references (out of range, surrogates, NUL) as U+FFFD.
      if (!Number.isFinite(code)) return m;
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The page title as a browser would show it: entities decoded, whitespace collapsed. */
export function titleFromHtml(html) {
  // A linear scan, not a regex: a page with many unclosed <title tags made the lazy regex
  // retry from every one of them (seconds on a 2 MB file).
  const s = String(html);
  // ASCII only, as HTML reads tag names: toLowerCase() turns "İ" into two code units, and the
  // offsets found in `lower` must index `s`.
  const lower = s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  let at = lower.indexOf('<title');
  while (at !== -1 && /[a-z0-9-]/.test(lower[at + 6] || '')) at = lower.indexOf('<title', at + 6); // <titlebar> is not <title>
  if (at === -1) return null;
  const open = lower.indexOf('>', at);
  if (open === -1) return null;
  const close = lower.indexOf('</title', open + 1);
  if (close === -1) return null;
  const t = decodeEntities(s.slice(open + 1, close)).replace(/\s+/g, ' ').trim();
  return t || null;
}

export const normTitle = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Watch a list of window titles (macOS and Linux; Windows has windows.ps1) for the target.
 * `source()` returns { titles } or { titles: null, reason } when titles cannot be read, and
 * `matches(title)` says whether a title shows the target. Same result contract as windows.ps1.
 *
 * These lists carry titles only, no window identity, so matching titles are counted: proof is
 * one more matching title than the before-snapshot had (a new window, or one whose title
 * changed to the target). Nothing weaker counts. A matching title that was already there
 * before gives matched:null (the open cannot be told apart from it), and a title that merely
 * changed from one matching spelling to another (an unread counter in the page's own window)
 * adds nothing. `miss()` gives the verdict when no matching title was seen at all.
 */
export function pollTitles(source, matches, timeoutMs, { miss, intervalMs = 300 } = {}) {
  let cancelled = false;
  const before = source();
  const tally = (titles) => {
    const counts = new Map();
    let total = 0;
    for (const t of titles) if (matches(t)) { counts.set(t, (counts.get(t) || 0) + 1); total += 1; }
    return { counts, total };
  };
  const result = (async () => {
    if (before.titles === null) return { matched: null, reason: before.reason };
    // No look after the open at all: "not seen" would prove nothing.
    if (timeoutMs <= 0) return { matched: null, reason: `the window timeout is ${timeoutMs} ms, so no window was looked for after the open` };
    const pre = tally(before.titles);
    const seen = pre.total ? [...pre.counts.keys()][0] : null;
    const start = Date.now();
    while (Date.now() - start < timeoutMs && !cancelled) {
      // Never pause past the deadline: the last look happens at the timeout, not an interval after.
      await sleep(Math.max(0, Math.min(intervalMs, timeoutMs - (Date.now() - start))));
      if (cancelled) break;
      const now = source();
      if (now.titles === null) return { matched: null, reason: now.reason };
      const cur = tally(now.titles);
      if (cur.total > pre.total) {
        // One more matching title than before, so at least one title's count grew: that one.
        const [title] = [...cur.counts].find(([t, n]) => n > (pre.counts.get(t) || 0));
        return { matched: true, confidence: 'high', title, elapsedMs: Date.now() - start };
      }
    }
    if (cancelled) return { matched: null, reason: 'cancelled' };
    if (seen) {
      return { matched: null, title: seen, reason: `a window with this title was already open before, and no new one appeared within ${timeoutMs} ms, so this open cannot be told apart from it` };
    }
    return miss ? miss() : { matched: false, reason: `no new window matching the target appeared within ${timeoutMs} ms` };
  })();
  return { ready: Promise.resolve(), result, cancel() { cancelled = true; } };
}

/**
 * A folder watcher whose file manager's selection cannot be read (Finder and Linux file
 * managers expose window titles or paths, not the selected item): every result it gives says
 * selectedOk:null, "could not be checked", so it is never taken for a yes or a no.
 */
export const selectionUnchecked = (watcher) => ({ ...watcher, result: watcher.result.then((r) => ({ ...r, selectedOk: null })) });

/** Every request show-local makes identifies itself, so servers can tell it from the browser. */
export const USER_AGENT = 'show-local';
/**
 * The Accept header a browser sends when it loads a page. An SPA dev server's history fallback
 * (webpack-dev-server, CRA, Vue CLI) serves index.html for a deep link only to a request that
 * accepts text/html; without it the route answers 404, although the browser would get the app.
 */
export const PAGE_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

// Browsers resolve *.localhost to loopback by themselves (RFC 6761); the OS resolver often does not.
const loopbackLookup = (hostname, opts, cb) => {
  const done = typeof opts === 'function' ? opts : cb;
  const o = typeof opts === 'object' && opts ? opts : {};
  if (o.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
  else done(null, '127.0.0.1', 4);
};

export const isLocalHost = (hostname) => {
  const h = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost')
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
};

/**
 * Request options for a parsed URL. A local https dev server (vite --https, next dev
 * --experimental-https, mkcert) presents a certificate Node does not trust, and this request
 * only asks whether the server is up; the browser makes its own TLS decision. So loopback
 * skips certificate checks, and every other host keeps Node's full verification.
 */
export function requestOptions(u, { method = 'GET', timeoutMs = 3000 } = {}) {
  const options = { method, timeout: timeoutMs, headers: { 'user-agent': USER_AGENT, accept: PAGE_ACCEPT } };
  if (u.hostname.toLowerCase().endsWith('.localhost')) options.lookup = loopbackLookup;
  if (u.protocol === 'https:' && isLocalHost(u.hostname)) options.rejectUnauthorized = false;
  return options;
}

/**
 * GET/HEAD with an overall deadline (not just an idle timeout), http or https, no
 * dependencies. Reads at most `maxBytes` of the body. Resolves, never rejects.
 */
export function httpRequest(url, { method = 'GET', timeoutMs = 3000, maxBytes = 262144 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ ok: false, error: 'bad-url' }); return; }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) { resolve({ ok: false, error: 'unsupported-protocol' }); return; }
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(v); } };
    const options = requestOptions(u, { method, timeoutMs });
    let req;
    try {
      req = lib.request(u, options, (res) => {
        const chunks = [];
        let size = 0;
        const complete = () => finish({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.on('data', (c) => {
          chunks.push(c);
          size += c.length;
          if (size >= maxBytes) { complete(); res.destroy(); }
        });
        res.on('end', complete);
        res.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
      });
    } catch (e) { resolve({ ok: false, error: e.code || e.message }); return; }
    const deadline = setTimeout(() => { req.destroy(); finish({ ok: false, error: 'timeout' }); }, timeoutMs);
    req.on('timeout', () => { req.destroy(); finish({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    req.end();
  });
}

/** Quote for a POSIX shell (bash, zsh, Git Bash): nothing inside single quotes expands. */
export const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Characters that make Claude Code's Bash tool refuse a command even inside single quotes
 * (measured 2026-09: `;`, `&` or `|` in an argument; the '\'' idiom as "consecutive quote
 * characters"; $'…' with a backslash), and the ones that end or expand a quoted word: `'`, `"`,
 * `$`, a backtick, a backslash (a separator only on Windows, where it is turned into `/` first)
 * and line breaks.
 */
const UNSAFE_IN_COMMAND = /['"`$;&|\\\n\r]/;
const pct = (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * One path, as a single-quoted argument for a command the Bash tool runs. A plain path stays a
 * path (forward slashes on Windows). A path with a character from UNSAFE_IN_COMMAND becomes a
 * file:/// URL in which that character, and everything else URL syntax needs, is percent-
 * encoded, so the command holds none of them; show.mjs turns it back into the path (toPathArg).
 * Never for the path of a script node runs: node takes a path there, not a URL (see cmdScript).
 */
export function cmdPath(p, platform = process.platform) {
  const s = platform === 'win32' ? String(p).replace(/\\/g, '/') : String(p);
  if (!UNSAFE_IN_COMMAND.test(s)) return `'${s}'`;
  const href = platform === 'win32' ? pathToFileURLWin(String(p)) : pathToFileURL(String(p)).href;
  // pathToFileURL leaves some of these as they are (', ;, &, $, |, !, ( ) *); encode them too.
  return `'${href.replace(/['"`$;&|!()*]/g, pct)}'`;
}

/** A URL (http, or a file URL) as a single-quoted argument: characters a URL may keep raw but a command must not hold are percent-encoded, which leaves the URL equivalent. */
export const cmdUrl = (u) => `'${String(u).replace(/['"`$;&|!()*\\\s]/g, pct)}'`;

/**
 * The path of a script for `node <script>`, single-quoted. node needs a real path there, so an
 * apostrophe in it is written the POSIX way ('\''); Claude Code then asks the user to approve
 * the command instead of running it on its own. Only the install path of the plugin gets here.
 */
export const cmdScript = (p, platform = process.platform) => shQuote(platform === 'win32' ? String(p).replace(/\\/g, '/') : String(p));

// pathToFileURL follows the running platform; a Windows path given on another OS (tests) is built by hand.
function pathToFileURLWin(p) {
  if (process.platform === 'win32') return pathToFileURL(p).href;
  const segs = p.replace(/\\/g, '/').split('/');
  const drive = /^[A-Za-z]:$/.test(segs[0]) ? segs.shift() : null;
  return `file:///${drive ? `${drive}/` : ''}${segs.map((x) => encodeURIComponent(x)).join('/')}`;
}

/** A path argument given as a file:/// URL (see cmdPath) back to the path; anything else unchanged. */
export function toPathArg(v) {
  if (typeof v !== 'string' || !/^file:\/\//i.test(v)) return v;
  try { return fileURLToPath(v); } catch { return v; }
}

/** Split a Windows command line into argv, honouring double quotes (CommandLineToArgvW rules, simplified). */
export function splitWindowsCommand(cmd) {
  const out = [];
  let cur = '';
  let quoted = false;
  let started = false;
  const s = String(cmd).trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      let n = 0;
      while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) { cur += '"'; } else { quoted = !quoted; }
        started = true;
      } else {
        cur += '\\'.repeat(n);
        i--;
        started = true;
      }
      continue;
    }
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}
