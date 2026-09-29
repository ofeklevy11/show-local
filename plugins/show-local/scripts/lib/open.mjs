// Orchestration: detect → (plan a server) → open → verify → one JSON result.
import { existsSync, readFileSync, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detect, entryHref, fittingShortPath, WINDOWS_LONG_PATH } from './detect.mjs';
import { writeLaunchEntry } from './launchjson.mjs';
import { claimedPorts, pickPort, rememberedPorts } from './ports.mjs';
import { devRunAt, devRunLive, entryAt, findServerFor, isDevRun, kindOf, logFileFor, pidAlive, register } from './registry.mjs';
import { logHits } from './server.mjs';
import { belongsTo, listeningPids, processInfo } from './portowner.mjs';
import {
  cmdPath, cmdScript, cmdUrl, httpRequest, isLocalHost, isNetworkPath, NOT_PUBLIC, outputText, pathKey, sleep, slugFor, titleFromHtml,
} from './util.mjs';
import { createWindowsAdapter } from './adapters/win.mjs';
import { createMacAdapter } from './adapters/mac.mjs';
import { createLinuxAdapter } from './adapters/linux.mjs';

export const SHOW_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'show.mjs');
/** How long to watch for the window, unless --timeout or SHOW_LOCAL_TIMEOUT_MS says otherwise. */
export const DEFAULT_TIMEOUT_MS = 5000;
/** The environment variable that sets the default window timeout, and the largest value it may hold. */
export const TIMEOUT_ENV = 'SHOW_LOCAL_TIMEOUT_MS';
export const MAX_ENV_TIMEOUT_MS = 600000;
/**
 * How long a direct open waits for a local server to answer. With the window watch after it,
 * a file, folder or URL stays within its budget (DIRECT_BUDGET_MS) even when the server is down.
 */
export const DEFAULT_WAIT_MS = 4500;
/** A static server that was just started: the plan's next.then passes this wait explicitly. */
export const SERVED_WAIT_MS = 10000;
export const DEV_WAIT_MS = 60000;
/** How long the "is the project's dev server already up?" probe waits for any answer. */
export const DEV_PROBE_MS = 2000;
/**
 * How long fetching a plain remote page for its title may take, redirects included. With the
 * window watch after it, a remote URL stays within its budget.
 */
export const REMOTE_TITLE_MS = 3000;
const MAX_REDIRECTS = 3;
/** How many redirects the readiness check of a local page follows before it gives up. */
export const MAX_HTTP_REDIRECTS = 5;
/**
 * A direct open (url, file, folder, app) finishes within this many ms of its start, measured end
 * to end: the CLI counts from the moment its process started. The window watch gets whatever
 * the budget has left, never more than its own timeout and never less than WATCH_FLOOR_MS.
 * A SHOW_LOCAL_TIMEOUT_MS above DEFAULT_TIMEOUT_MS moves every budget by the difference.
 */
export const DIRECT_BUDGET_MS = 9600;
/** An explicit --wait moves the budget: the wait plus what a direct open allows after its wait. */
export const BUDGET_AFTER_WAIT_MS = DIRECT_BUDGET_MS - DEFAULT_WAIT_MS;
/** Set aside for the watcher's start-up before its watch begins (measured about 0.7 s on Windows). */
export const WATCH_STARTUP_MS = 700;
/** Set aside for the watcher to report and the command to print its result. */
export const WATCH_REPORT_MS = 200;
/** The shortest window watch the budget ever leaves. */
export const WATCH_FLOOR_MS = 1000;
/** Statuses of an access-log line that show the browser got the page. */
const PAGE_STATUSES = new Set([200, 206, 304]);
/** Set by Claude Code for its Bash tool: how the session was started. */
export const ENTRYPOINT_ENV = 'CLAUDE_CODE_ENTRYPOINT';
/** What a UTF-8 decoder puts in place of bytes that are not UTF-8. */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
/** How much of a watcher's reason, and of a host name from a redirect, reaches the result (see outputText). */
const REASON_MAX = 600;
const HOST_MAX = 80;
const WHERE_MAX = 200;
/** A path segment longer than this makes a remote address "not plain": it is never fetched. */
export const PLAIN_SEGMENT_MAX = 32;

export function adapterFor(platform = process.platform, deps = {}) {
  if (platform === 'win32') return createWindowsAdapter(deps);
  if (platform === 'darwin') return createMacAdapter(deps);
  return createLinuxAdapter(deps);
}

/**
 * The default window timeout: SHOW_LOCAL_TIMEOUT_MS when it holds a whole number of
 * milliseconds from 0 to MAX_ENV_TIMEOUT_MS, else DEFAULT_TIMEOUT_MS. An unusable value falls
 * back to the default and comes with a note saying so.
 */
export function timeoutFromEnv(env = process.env) {
  const raw = env?.[TIMEOUT_ENV];
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!s) return { ms: DEFAULT_TIMEOUT_MS, note: null };
  if (/^\d+$/.test(s) && Number(s) <= MAX_ENV_TIMEOUT_MS) return { ms: Number(s), note: null };
  const shown = s.length > 40 ? `${s.slice(0, 40)}…` : s;
  return {
    ms: DEFAULT_TIMEOUT_MS,
    note: `${TIMEOUT_ENV}="${shown}" is not a whole number of milliseconds from 0 to ${MAX_ENV_TIMEOUT_MS}, so the default ${DEFAULT_TIMEOUT_MS} ms was used`,
  };
}

/**
 * Is this a headless Claude Code run, where nobody answers after the final reply? `claude -p`
 * sets CLAUDE_CODE_ENTRYPOINT to "sdk-cli" (measured in its Bash tool), and Agent SDK programs
 * to other "sdk-" values; the interactive terminal ("cli") and the desktop app
 * ("claude-desktop") do not start with "sdk". Such a session cannot exit while a server it
 * started in the background still runs, so its plan offers one foreground `oneshot` command.
 * Subagents and workflow steps inherit the desktop app's entrypoint: they pass plan --headless.
 */
export function isHeadless(env = process.env) {
  const v = env?.[ENTRYPOINT_ENV];
  return typeof v === 'string' && v.trim().toLowerCase().startsWith('sdk');
}

// Paths in commands meant for the Bash tool: single-quoted, forward slashes on Windows (every
// Windows program accepts them), and a percent-encoded file:/// URL for a path with a character
// the Bash tool refuses (cmdPath); show.mjs reads either form. PowerShell needs its own quoting
// (single quotes with any apostrophe doubled).
const q = (p) => cmdPath(p);
const qs = (p) => cmdScript(p);
const qu = (u) => cmdUrl(u);

/** Long, canonical spelling of an existing path (expands 8.3 names, resolves /tmp → /private/tmp). */
function canonical(p) {
  if (!p) return p;
  try { return realpathSync.native(p); } catch { return p; }
}

/** Is `child` strictly inside `parent` (any depth)? Case-insensitive where the file system usually is. */
function inside(parent, child, platform, { orEqual = false } = {}) {
  const key = (p) => (platform === 'win32' || platform === 'darwin' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(key(parent), key(child));
  if (!rel) return orEqual;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The file to highlight in folder mode. --select must name something inside the folder (any
 * depth): a network path, a path outside it or a missing file falls back to the default pick.
 */
function chooseSelection(d, requested, platform) {
  if (!requested) return { select: d.select || null, notes: [] };
  let why = null;
  let p = null;
  if (isNetworkPath(requested, platform)) why = 'is a network path';
  else {
    p = path.resolve(d.path, requested);
    if (!inside(d.path, p, platform)) why = 'is outside the folder';
    else if (!existsSync(p)) why = 'was not found';
    // A symlinked subfolder can still lead elsewhere; judge where it really is.
    else if (!inside(canonical(d.path), canonical(path.dirname(p)), platform, { orEqual: true })) why = 'leads outside the folder';
  }
  if (!why) return { select: p, notes: [] };
  return { select: d.select || null, notes: [`--select ${why}, so ${d.select ? 'the default file' : 'nothing'} is selected instead`] };
}

/**
 * The folder the file manager will show and the item to select in it. Only the folder is
 * canonicalised (8.3 names, /tmp → /private/tmp): the file keeps its own name, so a symlinked
 * file is revealed where it sits, never where it points.
 */
function revealTarget(folder, select) {
  if (!select) return { dir: canonical(folder), sel: null };
  const dir = canonical(path.dirname(select));
  return { dir, sel: path.join(dir, path.basename(select)) };
}

/**
 * On Windows, the 8.3 short spelling of the folder to reveal and of the file to select in it,
 * when the longer of the two is past WINDOWS_LONG_PATH and has a short path that fits
 * (see fittingShortPath): { dir, sel }, sel null without a selection. Otherwise null. One
 * lookup: the selection's short path holds its folder's.
 */
function shortReveal(dir, sel, { platform, shortPathFn }) {
  const target = sel || dir;
  if (platform !== 'win32' || target.length <= WINDOWS_LONG_PATH) return null;
  const short = fittingShortPath(target, { platform, shortPathFn });
  if (!short) return null;
  return sel ? { dir: path.win32.dirname(short), sel: short } : { dir: short, sel: null };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Follow one address's redirects, as a browser would, up to MAX_HTTP_REDIRECTS. Resolves with
 * the last answer: { ok, status, body, headers, finalUrl, hops }, plus `why` when it stopped
 * following (too many redirects, not a URL, not http, or a remote address that must not be
 * fetched because of unfetchableReason), or { ok: false, error, finalUrl, hops } when an
 * address did not answer. `remote: true` says the last address asked was not local.
 * `left()` is the time that remains for the whole wait.
 *
 * Only the address show-local was given, and redirects that stay on local hosts, may reach this
 * computer. An address that is not a local host by its spelling (isLocalHost) is fetched
 * public-only, and so is everything after it: a remote site cannot send show-local on to this
 * computer or the local network, not by a name that resolves there, not by an IPv4-mapped IPv6
 * literal, not by a redirect back to localhost. Such a redirect is not followed (`final`, as
 * for a one-time link), and the page opens anyway.
 */
async function followRedirects(url, { left, fetchFn }) {
  let current = new URL(url);
  let hops = 0;
  let publicOnly = false;
  let led = null; // the redirect answer that led to `current`
  for (;;) {
    if (!isLocalHost(current.hostname)) publicOnly = true;
    const r = await fetchFn(current.href, { timeoutMs: Math.max(300, Math.min(1500, left())), ...(publicOnly ? { publicOnly } : {}) });
    const at = { finalUrl: current.href, hops, ...(isLocalHost(current.hostname) ? {} : { remote: true }) };
    if (r?.error === NOT_PUBLIC && led) {
      return { ...led, why: `it redirected to ${outputText(current.host, HOST_MAX)}, which leads to ${outputText(r.address || 'an address', HOST_MAX)} on this computer or a private network; show-local fetches such an address only when it is a local host by name (localhost, 127.x.x.x, [::1]) that it was given, or that such a host redirected to`, final: true, notPublic: true };
    }
    if (!r?.ok) return { ok: false, error: r?.error || 'no answer', ...at };
    const answer = { ok: true, status: r.status, body: r.body, headers: r.headers, ...at };
    const loc = r.headers?.location;
    if (r.status < 300 || r.status > 399 || !loc) return answer;
    if (hops >= MAX_HTTP_REDIRECTS) return { ...answer, why: `it redirected more than ${MAX_HTTP_REDIRECTS} times` };
    let next;
    try { next = new URL(Array.isArray(loc) ? loc[0] : loc, current); } catch { return { ...answer, why: 'it redirected to an address that is not a URL' }; }
    if (!/^https?:$/.test(next.protocol)) return { ...answer, why: `it redirected to a ${outputText(next.protocol, 40)} address` };
    if (!isLocalHost(next.hostname)) {
      const why = unfetchableReason(next);
      if (why) return { ...answer, why: `it redirected to ${outputText(next.host, HOST_MAX)}, which is not fetched because ${why}`, final: true };
    }
    led = answer;
    current = next;
    hops += 1;
  }
}

/**
 * Poll a URL until it is ready: it answers 200 once its redirects are followed (at most
 * MAX_HTTP_REDIRECTS; a final address that is not local needs any 2xx). With `anyStatus`, any
 * HTTP answer at all counts and nothing is followed. Tries 127.0.0.1 and ::1 when "localhost"
 * refuses. Resolves with { ok, status, finalUrl, hops, ms }, plus body and headers when ready,
 * and error or why when not. Two stops come at once, because waiting cannot change them:
 * `final` (a redirect to a remote address that must not be fetched) and `remote` (a remote
 * address that was fetched, once, and is not ready: it is never polled). `alive()` (optional)
 * is asked between tries: once it says false (the server process ended), the wait stops early.
 */
export async function waitForHttp(url, waitMs = DEFAULT_WAIT_MS, { anyStatus = false, fetchFn = httpRequest, alive = null } = {}) {
  const start = Date.now();
  const u = new URL(url);
  const variants = [url];
  if (u.hostname === 'localhost') {
    for (const h of ['127.0.0.1', '[::1]']) { const v = new URL(url); v.hostname = h; variants.push(v.href); }
  }
  const left = () => waitMs - (Date.now() - start);
  const ready = (r) => {
    if (anyStatus) return true;
    let local = true;
    try { local = isLocalHost(new URL(r.finalUrl).hostname); } catch { /* keep the strict rule */ }
    return local ? r.status === 200 : r.status >= 200 && r.status <= 299;
  };
  const shape = (r, ok) => ({
    ok, status: r?.status ?? null, finalUrl: r?.finalUrl ?? url, hops: r?.hops ?? 0,
    ...(ok ? { body: r.body, headers: r.headers } : {
      error: r?.error ?? null, ...(r?.why ? { why: r.why } : {}), ...(r?.final ? { final: true } : {}), ...(r?.notPublic ? { notPublic: true } : {}), ...(r?.remote ? { remote: true } : {}),
    }),
    ms: Date.now() - start,
  });
  let last = null;
  let answered = null; // an HTTP status says more than a refused fallback address tried after it
  do {
    for (const v of variants) {
      last = anyStatus
        ? { ...(await fetchFn(v, { timeoutMs: Math.max(300, Math.min(1500, left())) })), finalUrl: v, hops: 0 }
        : await followRedirects(v, { left, fetchFn });
      if (last.ok && ready(last) && !last.why) return shape(last, true);
      if (last.ok) {
        answered = last;
        // A policy stop (a remote address that must not be fetched) cannot change by waiting.
        if (last.final) return shape(last, false);
      }
      // Nor can a remote address the redirects led to: another try would only fetch it again.
      if (last.remote) return shape(answered || last, false);
    }
    if (alive && !alive()) return { ...shape(answered || last, false), error: 'the server process ended' };
    await sleep(250);
  } while (Date.now() - start < waitMs);
  return shape(answered || last, false);
}

/**
 * The browser's own GET of exactly this page, logged at or after `sinceMs`: a 200, 206 or 304
 * for `pathname` (the final path, once redirects are followed), from a user agent that is not
 * show-local's or an Electron app's (see logHits).
 */
async function waitForLogHit(logFile, sinceMs, pathname, timeoutMs) {
  const start = Date.now();
  do {
    let text = '';
    try { text = readFileSync(logFile, 'utf8'); } catch { /* not written yet */ }
    // Strictly after the open: the log has millisecond times, and a GET in the very millisecond the
    // open began was made before it (a browser takes far longer than 1 ms to start and ask).
    const hit = logHits(text, { sinceMs: sinceMs + 1 }).find((h) => PAGE_STATUSES.has(h.status) && safeDecode(h.url.split('?')[0]) === pathname);
    if (hit) return hit;
    await sleep(200);
  } while (Date.now() - start < timeoutMs);
  return null;
}
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/**
 * The window watch's timeout: the requested one (--timeout, SHOW_LOCAL_TIMEOUT_MS or the
 * default), cut to what the budget has left once the watcher's start-up and report are set
 * aside, but never below WATCH_FLOOR_MS. An explicit --timeout is the caller's choice and is
 * used as given.
 */
export function watchTimeoutFor(timing, now = Date.now()) {
  if (timing.explicit) return timing.timeoutMs;
  const left = timing.deadline - now - WATCH_STARTUP_MS - WATCH_REPORT_MS;
  return Math.min(timing.timeoutMs, Math.max(WATCH_FLOOR_MS, left));
}

/**
 * The watcher's verdict. When its start-up ran so long that its watch would end past the
 * budget, the watch is stopped at the budget instead (never before WATCH_FLOOR_MS of watching)
 * and the verdict is null: nothing was seen, and nothing can be said.
 */
async function settleWatch(watcher, timing, watchMs, readyAt) {
  if (timing.explicit) return watcher.result;
  const natural = readyAt + watchMs + WATCH_REPORT_MS;
  const cutAt = Math.max(timing.deadline, readyAt + WATCH_FLOOR_MS);
  if (natural <= cutAt) return watcher.result;
  let timer;
  const cut = new Promise((resolve) => {
    timer = setTimeout(() => {
      watcher.cancel?.();
      resolve({ matched: null, reason: `the window watch was stopped at the ${timing.budgetMs} ms budget before it saw the window (the watcher took ${readyAt - timing.watchCalledAt} ms to start)` });
    }, Math.max(0, cutAt - Date.now()));
  });
  try { return await Promise.race([watcher.result, cut]); } finally { clearTimeout(timer); }
}

/**
 * Start a watcher with the budgeted timeout and wait until it is ready: { watcher, watchMs,
 * readyAt }. `start(ms)` starts it; null means nothing is watched. A 0 ms watch would take no
 * look after the open, so its "not seen" would prove nothing: no watcher is started, and the
 * verdict is null with that reason.
 */
async function startWatch(start, timing) {
  const watchMs = watchTimeoutFor(timing);
  // The budget moved with a long SHOW_LOCAL_TIMEOUT_MS, but a long server wait can still eat into it.
  if (start && timing.extraMs && watchMs < timing.timeoutMs) {
    timing.notes?.push(`the window watch was cut from the ${timing.timeoutMs} ms that ${TIMEOUT_ENV} asks for to ${watchMs} ms, what the open's time budget had left; --timeout is never cut`);
  }
  timing.watchCalledAt = Date.now();
  const watcher = !start ? null : watchMs > 0 ? start(watchMs) : {
    ready: Promise.resolve(),
    result: Promise.resolve({ matched: null, reason: `the window timeout is ${watchMs} ms, so no window was looked for after the open` }),
    cancel() {},
  };
  if (watcher) await watcher.ready;
  return { watcher, watchMs, readyAt: Date.now() };
}

function pdfTitle(file) {
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const m = buf.subarray(0, n).toString('latin1').match(/\/Title\s*\(([^)]{1,200})\)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// Shapes of a secret in a path segment: a UUID, a long hex run (hashes, keys, ids), a JWT, a
// padded base64 run, or a long run of letters and digits with no separator (base64/base64url).
const UUID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const LONG_HEX = /[0-9a-f]{16,}/i;
const JWT = /eyJ[A-Za-z0-9_-]{6,}/;
const PADDED_BASE64 = /[A-Za-z0-9+/_-]{8,}={1,2}$/;
const tokenLike = (seg) => UUID.test(seg) || LONG_HEX.test(seg) || JWT.test(seg) || PADDED_BASE64.test(seg)
  || (seg.match(/[A-Za-z0-9]{16,}/g) || []).some((run) => (/\d/.test(run) && /[A-Za-z]/.test(run))
    || (run.length >= 24 && /[a-z]/.test(run) && /[A-Z]/.test(run)));

/**
 * Why a remote address must not be fetched before it opens, or null when it is "plain": no
 * user name or password, no query, no fragment, and no path segment longer than
 * PLAIN_SEGMENT_MAX characters or shaped like a token. One-time links (sign-in, password reset,
 * invitations, magic links) carry their secret in exactly those places, and a fetch of our own
 * would spend it before the browser gets there.
 */
export function unfetchableReason(url) {
  let u;
  try { u = url instanceof URL ? url : new URL(url); } catch { return 'it is not a valid URL'; }
  if (u.username || u.password) return 'it carries a user name or password';
  // A "?" or "#" can only appear in href as the start of a query or fragment (even an empty one).
  if (u.href.includes('?')) return 'it has a query';
  if (u.href.includes('#')) return 'it has a fragment';
  for (const raw of u.pathname.split('/')) {
    if (!raw) continue;
    const seg = safeDecode(raw);
    if ([...seg].length > PLAIN_SEGMENT_MAX) return `a path segment is longer than ${PLAIN_SEGMENT_MAX} characters`;
    if (tokenLike(seg)) return 'a path segment looks like a token';
  }
  return null;
}

/**
 * The title of a plain remote page, fetched once before it opens: { title, status, host }, or
 * { why } when there is none to be had. Redirects are followed only to other plain remote
 * addresses, and everything together stays within `budgetMs`. Every request is public-only
 * (httpRequest): nothing reaches this computer or the local network, whatever the name, the
 * literal or the redirect says, and such a page opens with no title learned.
 */
async function remoteTitle(url, { fetchFn, budgetMs }) {
  const start = Date.now();
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const left = budgetMs - (Date.now() - start);
    if (left <= 0) return { why: `fetching it took longer than ${budgetMs} ms` };
    const r = await fetchFn(current.href, { timeoutMs: left, publicOnly: true });
    if (r?.error === NOT_PUBLIC) {
      const where = `${outputText(current.host, HOST_MAX)} leads to ${outputText(r.address || 'an address', HOST_MAX)} on this computer or a private network, and show-local fetches only public addresses for a title`;
      return { why: hop ? `it redirected to an address that is not fetched: ${where}` : `it was not fetched: ${where}` };
    }
    if (!r?.ok) return { why: `fetching it failed (${outputText(r?.error || 'no answer', 60)})` };
    const loc = r.headers?.location;
    if (r.status >= 300 && r.status < 400 && loc) {
      let next;
      try { next = new URL(Array.isArray(loc) ? loc[0] : loc, current); } catch { return { why: 'it redirected to an address that is not a URL' }; }
      if (!/^https?:$/.test(next.protocol) || isLocalHost(next.hostname)) return { why: 'it redirected to an address that is not a remote http(s) page' };
      const why = unfetchableReason(next);
      if (why) return { why: `it redirected to an address that is not fetched, because ${why}` };
      current = next;
      continue;
    }
    if (r.status < 200 || r.status > 299) return { why: `fetching it answered HTTP ${r.status}` };
    const type = String(r.headers?.['content-type'] || '');
    const mime = type.split(';')[0].trim().toLowerCase();
    if (mime && mime !== 'text/html' && mime !== 'application/xhtml+xml') return { why: `it is not an HTML page (${outputText(mime, 60)})` };
    const charset = (type.match(/charset\s*=\s*["']?([^"';\s]+)/i) || [])[1];
    if (charset && !/^(utf-?8|us-ascii)$/i.test(charset)) return { why: `its character set (${outputText(charset, 40)}) is not read` };
    const title = titleFromHtml(r.body || '');
    if (!title) return { why: 'the page has no <title>' };
    if (title.includes(REPLACEMENT_CHAR)) return { why: 'its title could not be decoded as UTF-8' };
    return { title, status: r.status, host: current.host };
  }
  return { why: `it redirected more than ${MAX_REDIRECTS} times` };
}

/**
 * Is a watcher result proof that the target showed up? Only a match the watcher itself calls
 * high confidence: a new or changed window showing the expected title, or a file manager window
 * on the folder. A match without that (as older watchers reported) is not.
 */
const isProof = (r) => r?.matched === true && r.confidence === 'high';

/** One line of evidence for a watcher result. `withReason: false` leaves out a proof's own reason. */
const describe = (r, { withReason = true } = {}) => {
  if (!isProof(r)) {
    const why = outputText(r.reason || (r.matched === true ? 'the window watcher reported a match without confidence, which is not proof' : 'the window watcher gave no reason'), REASON_MAX);
    return r.title ? `${why} (window "${outputText(r.title)}")` : why;
  }
  if (r.title) return `window "${outputText(r.title)}"${r.process ? ` (${outputText(r.process, 60)})` : ''}`;
  const sel = r.selected?.length ? `, selected: ${r.selected.map((s) => path.basename(s)).join(', ')}` : '';
  const reused = r.reusedWindow ? ' (a window already on this folder, which now has the file selected)' : '';
  return `file manager window on ${r.path}${sel}${reused}${withReason && r.reason ? ` — ${outputText(r.reason, REASON_MAX)}` : ''}`;
};

/**
 * A watcher result as it appears in show-local's output: its title and process name are the
 * page's or the app's own text, and its reason may quote them, so all three pass through
 * outputText (matching used the full text).
 */
const forOutput = (r) => (r && typeof r === 'object'
  ? {
    ...r,
    ...(r.title != null ? { title: outputText(r.title) } : {}),
    ...(r.process != null ? { process: outputText(r.process, 60) } : {}),
    ...(r.reason != null ? { reason: outputText(r.reason, REASON_MAX) } : {}),
  }
  : r);

/**
 * Whether the file the folder open asked to select is selected: true or false as the watcher
 * saw it on the window that proves the open (its selectedOk), else null (it could not be checked).
 */
const selectionOf = (win) => (isProof(win) && typeof win.selectedOk === 'boolean' ? win.selectedOk : null);

/**
 * verified:true only on real proof: the browser's own GET of this page in show-local's server
 * log (after the open), or a watcher match, which is a new or changed window showing the
 * expected title, or a file manager window on the folder. Nothing weaker counts: every other
 * outcome is null (cannot tell) or false (the watcher looked and it did not appear). The
 * confidence field stays for compatibility and is "high" whenever verified is true.
 */
function verdict(windowResult, logHit) {
  if (logHit || isProof(windowResult)) return { verified: true, confidence: 'high' };
  if (windowResult?.matched === false) return { verified: false, confidence: null };
  return { verified: null, confidence: null };
}

/**
 * The browser as a result reports it: { exe, name }. After an open, the program the adapter
 * launched (exe is null when the system chose the handler: Start-Process, xdg-open, macOS
 * `open`). After a failed open, the browser that was tried.
 */
const browserField = (opened, resolved) => (opened
  ? { exe: opened.exe ?? null, name: opened.with ?? null }
  : { exe: resolved?.exe ?? null, name: resolved?.name ?? null });

/**
 * Open a URL (http or file) in the default browser and verify it. The window watcher needs the
 * page's title: a file's own, a local page's (read from the server), or a plain remote page's
 * (fetched once, see unfetchableReason). Without a title there is nothing to recognise the
 * window by, so no watcher runs and the verdict is null, unless the server log proves it.
 */
async function openInBrowser(url, { adapter, timing, waitMs, logFile, verify, expectTitle, base, notes: early = [], fetchFn = httpRequest, serverAlive = null }) {
  const { t0 } = timing;
  const u = new URL(url);
  const evidence = [];
  const notes = [...early];
  const tokens = [];
  if (expectTitle) tokens.push(expectTitle);
  let noTitle = null; // why no window can be recognised, when there is no title to look for
  // The path the browser ends on, once it has followed the redirects: the log proof is for it.
  let pagePath = safeDecode(u.pathname);
  // The readiness check followed redirects without the browser's cookies (see the verdict below).
  let redirected = false;

  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (isLocalHost(u.hostname)) {
      const up = await waitForHttp(url, waitMs, { alive: serverAlive, fetchFn });
      const final = new URL(up.finalUrl || url);
      // Where the redirects ended: a remote site's redirect can make it long, so it is cut (the url field stays whole).
      const where = outputText(final.origin === u.origin ? `${final.pathname}${final.search}` : final.href, WHERE_MAX);
      const via = up.hops ? ` after ${plural(up.hops, 'redirect')}, at ${where}` : '';
      if (!up.ok && up.final) {
        // The server answered, with a redirect show-local must not follow: to a remote address
        // that could be a one-time link (a hosted sign-in carries one-time state), or on to this
        // computer or a private network after leaving the local host. The browser follows it;
        // show-local does not, so the page opens with no title to recognise it by.
        evidence.push(`HTTP ${up.status} from ${u.host}${via}`);
        notes.push(up.notPublic
          ? `the address the page redirects to was not fetched before opening: ${up.why}`
          : `the remote address the page redirects to was not fetched before opening: ${up.why}; a fetch could spend a one-time link`);
        noTitle = `the page title is not known: ${up.why}, so no window can be recognised as this page`;
      } else if (!up.ok) {
        // A server answering with an error (a base path answers "/" with 404) or a redirect it
        // does not finish is up but not a page: only a 200 opens anything. A remote address it
        // redirects to is asked once, so that stop comes at once, not after the whole wait.
        const what = up.status ? `only answered HTTP ${up.status}${via}${up.why ? ` (${up.why})` : ''}` : `did not answer${via} (last: ${up.error})`;
        return { ...base, ok: false, opened: false, error: 'server-not-responding', detail: `${url} ${what}${up.remote ? '' : ` within ${waitMs} ms`}; nothing was opened.`, ms: Date.now() - t0 };
      } else {
        evidence.push(`HTTP ${up.status} from ${u.host}${via}`);
        pagePath = safeDecode(final.pathname);
        // show-local's own static server (the one with a log) never redirects by cookie.
        redirected = up.hops > 0 && !logFile;
        const t = titleFromHtml(up.body || '');
        if (t) tokens.push(t);
        else noTitle = 'the page has no <title>, so no window can be recognised as this page';
      }
    } else if (verify) {
      // Only a plain address is fetched: one-time links (sign-in, reset, invites) must stay unspent.
      const why = unfetchableReason(u);
      if (why) {
        notes.push(`remote page not fetched before opening, because ${why}; a fetch could spend a one-time link`);
        noTitle = `the page title is not known: the address was not fetched before opening, because ${why}, so no window can be recognised as this page`;
      } else {
        const got = await remoteTitle(url, { fetchFn, budgetMs: REMOTE_TITLE_MS });
        if (got.title) {
          tokens.push(got.title);
          evidence.push(`HTTP ${got.status} from ${outputText(got.host, HOST_MAX)}`);
          notes.push(`remote page fetched once before opening, for its title "${outputText(got.title)}" (a plain address: no query, fragment or token)`);
        } else {
          noTitle = `the page title could not be learned before opening: ${got.why}, so no window can be recognised as this page`;
        }
      }
    }
  }

  const browser = adapter.resolveBrowser();
  const uniq = [...new Set(tokens.filter(Boolean))];
  const { watcher, watchMs, readyAt } = await startWatch(verify && uniq.length
    ? (ms) => adapter.watchWindows({ tokens: uniq, processes: browser?.process ? [browser.process] : [], timeoutMs: ms })
    : null, timing);
  const openedAt = Date.now();
  const opened = await adapter.openUrl(url, browser);
  if (!opened.ok) {
    watcher?.cancel?.();
    return { ...base, ok: false, opened: false, error: 'open-failed', detail: opened.error, browser: browserField(null, browser), ms: Date.now() - t0 };
  }
  const used = browserField(opened, browser);
  if (!verify) {
    return { ...base, ok: true, opened: true, openedWith: opened.with, how: opened.how, browser: used, verified: null, confidence: null, evidence: ['verification skipped (--no-verify)'], ...(notes.length ? { notes } : {}), ms: Date.now() - t0 };
  }
  // The log is read for as long as the window is watched, and never past the budget.
  const logMs = timing.explicit ? watchMs : Math.min(watchMs, Math.max(WATCH_FLOOR_MS, timing.deadline - Date.now() - WATCH_REPORT_MS));
  const [seen, hit] = await Promise.all([
    watcher ? settleWatch(watcher, timing, watchMs, readyAt) : Promise.resolve({ matched: null, reason: noTitle || 'the page title is not known, so no window can be recognised as this page' }),
    // Only a GET logged at or after the moment of opening counts.
    logFile ? waitForLogHit(logFile, openedAt, pagePath, logMs) : Promise.resolve(null),
  ]);
  // The title came from where the redirects led a request without cookies. The browser sends
  // its own (a signed-in app shows its dashboard, not the sign-in page), so a window missing
  // that title proves nothing; a window showing it still does.
  const win = redirected && seen.matched === false
    ? { ...seen, matched: null, reason: `${seen.reason || 'no window showed the page title'}; the page redirected when show-local fetched it without the browser's cookies, so the browser may show another page, and a missing window is not proof that it did not open` }
    : seen;
  evidence.push(describe(win));
  if (logFile) evidence.push(hit ? `server log: ${outputText(hit.line, 300)}` : 'server log: no GET of this page from the browser after opening');
  const v = verdict(win, hit);
  return { ...base, ok: true, opened: true, openedWith: opened.with, how: opened.how, browser: used, ...v, evidence, ...(notes.length ? { notes } : {}), window: forOutput(win), ms: Date.now() - t0 };
}

/** The address of a static server's entry page. */
export function entryUrl(port, entry) {
  // Encode each segment, keep the slashes: a page nested in its site ("blog/post.html") must
  // resolve its relative links against its own folder.
  const p = entry && entry !== 'index.html' ? entryHref(entry) : '';
  return `http://127.0.0.1:${port}/${p}`;
}

/** The launch.json entry name of a folder's static server. */
export const staticName = (root) => `show-${slugFor(root)}`;

// A dev server started with https (vite --https, next dev --experimental-https) speaks TLS.
const devScheme = (script) => (/(^|\s)--(https|experimental-https)\b/.test(String(script || '')) ? 'https' : 'http');

/** The address a project's dev server answers on, from its dev script and port. */
export const devUrl = (script, port) => `${devScheme(script)}://localhost:${port}/`;

/**
 * The one foreground command a headless session runs instead of start/then/stop: it starts the
 * server, opens and verifies, lingers, and stops everything (see oneshot.mjs).
 */
const oneshotCommand = (target, cwd) => `node ${qs(SHOW_SCRIPT)} oneshot ${q(target)} --cwd ${q(cwd)}`;

/**
 * Everything the caller needs to start a server for serve/dev mode, plus the follow-up commands.
 * `remembered`: the static folder's own ports (rememberedPorts), read before anything pruned the registry.
 * `headless` (isHeadless, or plan --headless): a session that cannot wait for a background task.
 * Its plan's next is { oneshot } only, one foreground command that starts, opens, verifies and
 * stops everything; otherwise next is { start, then }.
 */
async function planServer(d, { cwd, desktop, waitMs, isFree, remembered = [], headless = false, platform = process.platform }) {
  const flag = headless ? { headless: true } : {};
  const lifetime = headless ? 'command' : 'session';
  const nextOf = (start, then) => (headless ? { oneshot: oneshotCommand(d.path, cwd) } : { start, then });
  if (d.mode === 'serve') {
    const name = staticName(d.root);
    // The folder's own port when it is free (its live registry entry, its launch.json entry),
    // else the first free port counting up from 4400 that no other launch.json entry claims.
    const taken = claimedPorts(cwd, { name, platform });
    const port = await pickPort({ prefer: remembered.map((r) => r.port), taken, isFree });
    if (!port) return { ok: false, error: 'no-free-port', detail: 'Ports 4400-4499 are all busy or claimed by other entries in .claude/launch.json.' };
    const portSource = remembered.find((r) => r.port === port)?.source ?? 'first-free';
    const log = logFileFor(port);
    const url = entryUrl(port, d.entry);
    const args = [SHOW_SCRIPT, 'serve', d.root, '--port', String(port), '--log', log];
    const launchJson = desktop ? writeLaunchEntry(cwd, { name, runtimeExecutable: 'node', runtimeArgs: args, port }) : null;
    const start = `node ${qs(SHOW_SCRIPT)} serve ${q(d.root)} --port ${port} --log ${q(log)}`;
    // A server started a moment ago gets longer than a direct open to answer (served budget: 20 s).
    const then = `node ${qs(SHOW_SCRIPT)} ${qu(url)} --wait ${SERVED_WAIT_MS} --log ${q(log)}`;
    return {
      ok: true, action: 'start-server', lifetime, ...flag,
      server: { kind: 'static', name, port, portSource, url, root: d.root, log, command: 'node', args },
      launchJson,
      next: nextOf(start, then),
    };
  }

  // dev: show-local's dev-run starts the project's runner with the project as its working
  // folder, so the path is never on a command line that cmd.exe could split (&) or expand
  // (%VAR%), and the whole tree ends with whatever started dev-run. It records the server under
  // its port, so servers lists it and stop ends it.
  const pm = d.packageManager;
  const runner = `${pm} run dev`;
  const args = (port) => [SHOW_SCRIPT, 'dev-run', d.root, ...(port ? ['--port', String(port)] : [])];
  const start = (port) => `node ${qs(SHOW_SCRIPT)} dev-run ${q(d.root)}${port ? ` --port ${port}` : ''}`;
  // The dev script is the project's text: whole in server.script, cut in the sentences around it.
  const script = outputText(d.script, 200);
  const caution = `Starting it runs the project's own code ("${script}"). Only do that when the user wants the site or app running.`;
  if (!d.port) {
    return {
      ok: false, error: 'dev-port-unknown', caution,
      // The ports the dev script names, when it names several.
      ...(d.candidates?.length ? { candidates: d.candidates } : {}),
      detail: (d.portSource === 'ambiguous'
        ? `"${script}" names several ports (${d.candidates.join(', ')}), so the page's port is unclear.`
        : `Could not tell which port "${script}" listens on.`) + (d.portNote ? ` ${d.portNote}.`.replace(/\.\.$/, '.') : ''),
      server: { kind: 'dev', root: d.root, script: d.script, runner, command: 'node', args: args(null) },
      next: { start: start(null), then: `start it, read the address it prints, then run: node ${qs(SHOW_SCRIPT)} '<that address>' --wait ${DEV_WAIT_MS} --dev-root ${q(d.root)}` },
    };
  }
  const url = devUrl(d.script, d.port);
  const name = `show-dev-${slugFor(d.root)}`;
  // The desktop app starts node itself: nothing goes through cmd.exe or npm.cmd from there.
  const launchJson = desktop ? writeLaunchEntry(cwd, { name, runtimeExecutable: 'node', runtimeArgs: args(d.port), port: d.port }) : null;
  const then = `node ${qs(SHOW_SCRIPT)} ${qu(url)} --wait ${Math.max(waitMs, DEV_WAIT_MS)} --dev-root ${q(d.root)}`;
  return {
    ok: true, action: 'start-server', lifetime, ...flag, caution,
    server: { kind: 'dev', name, port: d.port, portSource: d.portSource, url, root: d.root, runner, command: 'node', args: args(d.port) },
    launchJson,
    next: nextOf(start(d.port), then),
  };
}

/**
 * After a page opened on a dev server (`--dev-root`, which the dev plan's next.then passes),
 * record that server so `servers` lists it and `stop <port>` can end it, even when the
 * session that started it was killed. The pid is the process listening on the URL's port, and
 * only a process that can be tied to the project folder is recorded: `stop` must never end a
 * stranger. Returns the fields to add to the result ({ registered } or { notes }).
 */
function recordDevServer(result, devRoot, { cwd, platform, lookup }) {
  if (!result.ok || !result.opened) return {};
  const skip = (why) => ({ notes: [`${why}, so the dev server was not recorded; stop it the way it was started`] });
  let u;
  try { u = new URL(result.url); } catch { return skip('the opened address is not a URL'); }
  if (!/^https?:$/.test(u.protocol) || !isLocalHost(u.hostname)) return skip('--dev-root applies only to a local http(s) address');
  const root = path.resolve(cwd, devRoot);
  if (isNetworkPath(devRoot, platform) || isNetworkPath(root, platform)) return skip('--dev-root is a network path');
  let folder = false;
  try { folder = statSync(root).isDirectory(); } catch { /* missing */ }
  if (!folder) return skip(`--dev-root ${root} is not a folder`);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const held = entryAt(port);
  if (held && kindOf(held) === 'static' && pidAlive(held.pid)) return skip(`port ${port} belongs to a show-local static server`);
  // Started through dev-run: that show-local process already recorded it, and holds its tree.
  if (held && isDevRun(held) && devRunLive(held)) {
    if (pathKey(held.root) !== pathKey(root)) return skip(`port ${port} belongs to a show-local dev-run for another folder`);
    return { registered: { kind: 'dev', port, pid: held.pid, root, runner: 'dev-run' } };
  }
  const pids = listeningPids(port, lookup);
  if (!pids.length) return skip(`the process listening on port ${port} could not be identified`);
  const pid = pids.find((p) => belongsTo(processInfo(p, lookup), root, platform));
  if (!pid) return skip(`no process listening on port ${port} could be tied to ${root}`);
  if (!register({ kind: 'dev', pid, port, root, url: result.url, started: new Date().toISOString() })) {
    return { notes: ['the server registry could not be written, so the dev server was not recorded; stop it the way it was started'] };
  }
  return { registered: { kind: 'dev', port, pid, root } };
}

/**
 * The single entry point behind `show.mjs <target>`.
 * opts: { cwd, desktop, timeoutMs, waitMs, logFile, select, verify, planOnly, asFolder, devRoot,
 *         headless, budgetMs, t0, adapter, platform, runFn, env, isFree, fetchFn, detectFn,
 *         shortPathFn, serverAlive }
 * fetchFn (tests): stands in for httpRequest in the requests made before opening: a local
 *   server's readiness check (and the redirects it follows) and a plain remote page's title.
 * detectFn (tests): stands in for detect.
 * shortPathFn (tests): stands in for lib/shortpath.mjs's 8.3 lookup, in detect and for a folder.
 * env (default process.env): read for SHOW_LOCAL_TIMEOUT_MS and for isHeadless.
 * headless: force the headless plan (plan --headless), whatever the environment says.
 * budgetMs: the whole open's budget from t0. Default: DIRECT_BUDGET_MS, or with an explicit
 *   waitMs, that wait plus BUDGET_AFTER_WAIT_MS. A SHOW_LOCAL_TIMEOUT_MS above
 *   DEFAULT_TIMEOUT_MS adds the difference, so the longer watch it asks for is not cut back.
 * serverAlive: asked while waiting for a local server; false ends the wait early.
 * Every result that failed (ok:false) carries verified:false and its detail as the evidence.
 */
export async function show(target, opts = {}) {
  const t0 = opts.t0 ?? Date.now();
  const notes = [];
  let timeoutMs = opts.timeoutMs;
  const explicit = timeoutMs !== undefined && timeoutMs !== null;
  if (!explicit) {
    const t = timeoutFromEnv(opts.env || process.env);
    timeoutMs = t.ms;
    if (t.note) notes.push(t.note);
  }
  // A slow machine's longer SHOW_LOCAL_TIMEOUT_MS moves the budget by as much, as --timeout does.
  const extraMs = explicit ? 0 : Math.max(0, timeoutMs - DEFAULT_TIMEOUT_MS);
  const budgetMs = (opts.budgetMs ?? (opts.waitMs != null ? opts.waitMs + BUDGET_AFTER_WAIT_MS : DIRECT_BUDGET_MS)) + extraMs;
  // notes: startWatch says there when it had to cut a SHOW_LOCAL_TIMEOUT_MS watch anyway.
  const timing = { t0, timeoutMs, explicit, budgetMs, extraMs, deadline: t0 + budgetMs, notes };
  const r = await showTarget(target, { ...opts, t0, timeoutMs, timing });
  if (opts.devRoot != null && r.mode && r.mode !== 'url') notes.push('--dev-root applies only when opening a local http(s) address, so it was ignored');
  let out = notes.length ? { ...r, notes: [...(r.notes || []), ...notes] } : r;
  if (out.ok === false) {
    // A failure is a verdict too: nothing was verified, and the detail is the evidence.
    out = { ...out, verified: false, evidence: Array.isArray(out.evidence) && out.evidence.length ? out.evidence : [out.detail ?? out.error] };
  }
  return out;
}

async function showTarget(target, opts) {
  const { t0, timing } = opts;
  const cwd = opts.cwd || process.cwd();
  const platform = opts.platform || process.platform;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const verify = opts.verify !== false;
  const d = (opts.detectFn || detect)(target, { cwd, platform, asFolder: !!opts.asFolder, shortPathFn: opts.shortPathFn });
  if (!d.ok) return { ok: false, opened: false, ...d, ms: Date.now() - t0 };

  const base = { mode: d.mode, target: d.url || d.path };
  if (d.reasons?.length) base.reasons = d.reasons;
  // A page or app file whose path is too long for Windows opens through its 8.3 short path.
  // The target stays the real path; openPath is what the browser or the app is given.
  if (d.shortPath && d.openPath) Object.assign(base, { shortPath: true, openPath: d.openPath });
  const adapter = opts.adapter || adapterFor(platform);
  const lookup = { runFn: opts.runFn, platform };
  const serverAlive = opts.serverAlive || null;

  // The folder's own ports, read before findServerFor prunes the registry: an entry whose
  // process is alive keeps its claim to its port even when nothing listens there right now.
  const remembered = d.mode === 'serve' ? rememberedPorts(d.root, { cwd, name: staticName(d.root), platform }) : [];
  if (d.mode === 'serve') {
    const running = await findServerFor(d.root);
    if (running) {
      const url = entryUrl(running.port, d.entry);
      if (opts.planOnly) return { ok: true, ...base, action: 'open', url, alreadyRunning: true, ms: Date.now() - t0 };
      return openInBrowser(url, { adapter, timing, waitMs, logFile: running.log, verify, serverAlive, base: { ...base, url, alreadyRunning: true } });
    }
  }
  if (d.mode === 'dev' && d.port) {
    const url = devUrl(d.script, d.port);
    // show-local's own dev-run for this project, still starting or already up: never a second one.
    const devRun = devRunAt(d.port, d.root);
    // Any HTTP status means something is there (a base path answers "/" with 404). A server
    // still compiling its first page answers nothing yet, but the OS already lists its socket.
    const up = devRun ? { ok: false } : await waitForHttp(url, DEV_PROBE_MS, { anyStatus: true });
    const pids = devRun ? [] : listeningPids(d.port, lookup);
    if (devRun || up.ok || pids.length) {
      // Every listener must be this project's: the probe cannot tell which one it reached.
      const stranger = devRun ? null : pids.length
        ? pids.map((pid) => ({ pid, info: processInfo(pid, lookup) })).find((o) => !belongsTo(o.info, d.root, platform))
        : { pid: null, info: null };
      if (stranger) {
        // Nothing ties it to this project: do not open a stranger's site. Report only the pid
        // and program name; a full command line can carry another tool's secrets.
        return {
          ok: false, ...base, opened: false, error: 'port-busy', url,
          owner: { pid: stranger.pid, name: stranger.info?.name ? outputText(stranger.info.name, 60) : null },
          detail: `Port ${d.port} is already in use, but that process could not be tied to ${d.root}. If it is this project's dev server, open ${url} directly; otherwise stop it first.`,
          ms: Date.now() - t0,
        };
      }
      if (opts.planOnly) return { ok: true, ...base, action: 'open', url, alreadyRunning: true, ms: Date.now() - t0 };
      // Listening but silent: its first build is still running, and build time is not part of
      // the open's budget, so it gets the dev wait (unless --wait says otherwise).
      const wait = opts.waitMs ?? (up.ok ? DEFAULT_WAIT_MS : DEV_WAIT_MS);
      const devTiming = { ...timing, deadline: Math.max(timing.deadline, Date.now() + wait + BUDGET_AFTER_WAIT_MS + timing.extraMs) };
      return openInBrowser(url, { adapter, timing: devTiming, waitMs: wait, verify, serverAlive, base: { ...base, url, alreadyRunning: true } });
    }
  }
  if (d.mode === 'serve' || d.mode === 'dev') {
    const headless = !!opts.headless || isHeadless(opts.env || process.env);
    const plan = await planServer(d, { cwd, desktop: !!opts.desktop, waitMs, isFree: opts.isFree, remembered, headless, platform });
    return { ...base, ...plan, opened: false, ms: Date.now() - t0 };
  }

  // Folder: which file to highlight. The file manager shows the selected item's own folder,
  // which is a subfolder when --select names a file deeper inside.
  const { select, notes } = d.mode === 'folder' ? chooseSelection(d, opts.select, platform) : { select: null, notes: [] };
  const folderInfo = d.mode === 'folder' ? { folder: select ? path.dirname(select) : d.path } : {};
  // What the browser is given for a file: its short path when the long one is too long.
  const filePath = d.openPath || d.path;

  if (opts.planOnly) {
    const url = d.mode === 'file' ? pathToFileURL(filePath).href : d.url;
    return { ok: true, ...base, action: 'open', ...(url ? { url } : {}), ...folderInfo, ...(select ? { select } : {}), ...(notes.length ? { notes } : {}), ms: Date.now() - t0 };
  }

  if (d.mode === 'url') {
    // Honoured even before the file exists: a server started a moment ago creates it once it listens.
    let logFile = opts.logFile || null;
    const early = [];
    if (logFile && isNetworkPath(logFile, platform)) { logFile = null; early.push('--log is a network path, so it was not read'); }
    // A dev plan's next.then (--dev-root) while dev-run is starting the server: should dev-run
    // end first (the runner failed), there is nothing left to wait for.
    let alive = serverAlive;
    if (!alive && opts.devRoot != null && !isNetworkPath(String(opts.devRoot), platform)) {
      const u = new URL(d.url);
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      const root = path.resolve(cwd, String(opts.devRoot));
      if (isLocalHost(u.hostname) && devRunAt(port, root)) alive = () => devRunAt(port, root) !== null;
    }
    const r = await openInBrowser(d.url, { adapter, timing, waitMs, logFile, verify, notes: early, fetchFn: opts.fetchFn, serverAlive: alive, base: { ...base, url: new URL(d.url).href } });
    if (opts.devRoot == null) return r;
    const { registered, notes: devNotes } = recordDevServer(r, String(opts.devRoot), { cwd, platform, lookup });
    return {
      ...r,
      ...(registered ? { registered } : {}),
      ...(devNotes?.length ? { notes: [...(r.notes || []), ...devNotes] } : {}),
      ms: Date.now() - t0,
    };
  }

  if (d.mode === 'file') {
    const url = pathToFileURL(filePath).href;
    // The title is the page's own, read from the real file; without one the browser shows the
    // name at the end of the URL it was given.
    return openInBrowser(url, { adapter, timing, waitMs, verify, expectTitle: d.title || path.basename(filePath), base: { ...base, url } });
  }

  if (d.mode === 'folder') {
    // The watcher waits for the very folder the opener shows.
    const { dir, sel } = revealTarget(d.path, select);
    // Past MAX_PATH the file manager is handed the 8.3 short spelling, and the watcher takes a
    // window on either spelling: Explorer may show the one it was given or the long one.
    const short = shortReveal(dir, sel, { platform, shortPathFn: opts.shortPathFn });
    if (short) {
      Object.assign(base, { shortPath: true, openPath: short.dir, ...(short.sel ? { openSelect: short.sel } : {}) });
      base.reasons = [...(base.reasons || []), `path is ${(sel || dir).length} characters, past what Windows opens reliably (MAX_PATH), so the file manager is given its 8.3 short path (${(short.sel || short.dir).length} characters)`];
    }
    const alt = short ? { altDir: short.dir, ...(short.sel ? { altSelect: short.sel } : {}) } : {};
    const extra = notes.length ? { notes } : {};
    const { watcher, watchMs, readyAt } = await startWatch(verify ? (ms) => adapter.watchFolder({ dir, select: sel, ...alt, timeoutMs: ms }) : null, timing);
    const opened = await adapter.openFolder(short?.dir ?? dir, short?.sel ?? sel);
    if (!opened.ok) { watcher?.cancel?.(); return { ...base, ok: false, opened: false, error: 'open-failed', detail: opened.error, ...extra, ms: Date.now() - t0 }; }
    const win = watcher ? await settleWatch(watcher, timing, watchMs, readyAt) : { matched: null, reason: 'verification skipped (--no-verify)' };
    // Asked to select a file: say whether it is selected (true/false), or null when that could not be checked.
    const selected = sel ? selectionOf(win) : undefined;
    const evidence = selected === false
      ? [describe(win, { withReason: false }), `the folder opened but ${path.basename(sel)} was not selected`]
      : [describe(win)];
    return {
      ...base, ok: true, opened: true, openedWith: opened.with, how: opened.how, folder: dir, select: sel || null,
      ...(sel ? { selected } : {}), ...verdict(win, null), evidence, ...extra, window: forOutput(win), ms: Date.now() - t0,
    };
  }

  // app: only the full file name identifies the window; a bare stem ("index") is too generic.
  // A file opened through its 8.3 short path (openPath) may show that name in its window instead.
  const app = adapter.appFor(d.path);
  const tokens = [...new Set([path.basename(d.path), ...(d.openPath ? [path.win32.basename(d.openPath)] : [])])];
  if (d.ext === '.pdf') { const t = pdfTitle(d.path); if (t) tokens.push(t); }
  const { watcher, watchMs, readyAt } = await startWatch(verify
    ? (ms) => adapter.watchAppWindows({ tokens, processes: app?.process ? [app.process] : [], timeoutMs: ms })
    : null, timing);
  const opened = await adapter.openApp(d.openPath || d.path, app);
  if (!opened.ok) { watcher?.cancel?.(); return { ...base, ok: false, opened: false, error: 'open-failed', detail: opened.error, ms: Date.now() - t0 }; }
  const win = watcher ? await settleWatch(watcher, timing, watchMs, readyAt) : { matched: null, reason: 'verification skipped (--no-verify)' };
  return { ...base, ok: true, opened: true, openedWith: opened.with, how: opened.how, ...verdict(win, null), evidence: [describe(win)], window: forOutput(win), ms: Date.now() - t0 };
}
