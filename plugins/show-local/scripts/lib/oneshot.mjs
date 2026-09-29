// oneshot: one foreground command for headless sessions (claude -p, Agent SDK programs,
// subagents, workflow steps), where a server left running in the background keeps the session
// from ending. It starts the server (a static server inside this process, or dev-run for a dev
// project), opens and verifies exactly like a plan's next.then, keeps serving for a short
// linger so the page can finish loading, then stops everything and reports that it did.
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { detect } from './detect.mjs';
import { startDevRun } from './devrun.mjs';
import {
  DEFAULT_TIMEOUT_MS, DEFAULT_WAIT_MS, DEV_WAIT_MS, SERVED_WAIT_MS, WATCH_REPORT_MS, WATCH_STARTUP_MS,
  devUrl, entryUrl, show, staticName,
} from './open.mjs';
import { claimedPorts, pickPort, rememberedPorts } from './ports.mjs';
import { entryAlive, entryAt, findServerFor, logFileFor, register, unregister } from './registry.mjs';
import { createStaticServer, listen } from './server.mjs';
import { sleep } from './util.mjs';

/** How long the server keeps serving after the page opened. */
export const DEFAULT_LINGER_MS = 3000;
export const MAX_LINGER_MS = 600000;
/** The whole open of a static site, counted from the command's start. */
export const ONESHOT_STATIC_BUDGET_MS = 20000;
/** The whole open of a dev project, counted from the command's start: its first build is in it. */
export const ONESHOT_DEV_BUDGET_MS = DEV_WAIT_MS;
/** How long stopping may take before the port is reported as still held. */
const RELEASE_MS = 5000;
/** How much of a dev server's own output is kept for the report when it fails. */
const TAIL_CHARS = 600;
/** The note when the server could not be recorded (register() returned false). */
const UNLISTED_NOTE = 'the server registry could not be written, so servers and stop did not list this server while it ran';

function canConnect(port, host) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Resolves true once nothing accepts connections on the port (IPv4 and IPv6 loopback). */
async function released(port, ms = RELEASE_MS) {
  const end = Date.now() + ms;
  for (;;) {
    if (!(await canConnect(port, '127.0.0.1')) && !(await canConnect(port, '::1'))) return true;
    if (Date.now() >= end) return false;
    await sleep(200);
  }
}

/** Remove the registry entry for the port only when this process wrote it. */
function unregisterOurs(port) {
  if (entryAt(port)?.pid === process.pid) unregister(port);
}

/** Close a server and every connection it still holds (a browser keeps them alive). */
function closeServer(server, sockets) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    for (const s of sockets) s.destroy();
    server.closeAllConnections?.();
  });
}

const failure = (base, error, detail, t0) => ({ ok: false, ...base, opened: false, error, detail, ms: Date.now() - t0 });

/**
 * Start, open, verify, linger, stop. opts: { cwd, port, lingerMs, t0, platform, env, timeoutMs,
 * verify, adapter, runFn, fetchFn, isFree, detectFn } (adapter and the rest: as for show()).
 * Resolves with show()'s result for the page plus
 *   server: { kind, stopped, port, lingerMs, root, url }
 * where stopped means the server is gone and its port is free again. A target that needs no
 * server is opened directly, and nothing is started.
 */
export async function oneshot(target, opts = {}) {
  const t0 = opts.t0 ?? Date.now();
  const cwd = opts.cwd || process.cwd();
  const platform = opts.platform || process.platform;
  const lingerMs = opts.lingerMs ?? DEFAULT_LINGER_MS;
  const common = {
    t0, cwd, platform, env: opts.env, timeoutMs: opts.timeoutMs, verify: opts.verify,
    adapter: opts.adapter, runFn: opts.runFn, fetchFn: opts.fetchFn, detectFn: opts.detectFn,
  };
  const d = (opts.detectFn || detect)(target, { cwd, platform });
  if (!d.ok || (d.mode !== 'serve' && d.mode !== 'dev')) {
    const r = await show(target, common);
    return d.ok ? { ...r, notes: [...(r.notes || []), 'nothing here needs a server, so it was opened directly and nothing was started'] } : r;
  }
  return d.mode === 'serve'
    ? oneshotStatic(d, { ...common, lingerMs, port: opts.port, isFree: opts.isFree })
    : oneshotDev(d, { ...common, lingerMs, port: opts.port });
}

async function oneshotStatic(d, { lingerMs, port: wanted, isFree, ...common }) {
  const { t0, cwd, platform } = common;
  const base = { mode: 'serve', target: d.path, ...(d.reasons?.length ? { reasons: d.reasons } : {}) };

  // A show-local server already serves this folder: use it, and leave it as it was.
  const running = await findServerFor(d.root);
  if (running) {
    const url = entryUrl(running.port, d.entry);
    const r = await show(url, { ...common, logFile: running.log, waitMs: DEFAULT_WAIT_MS });
    return { ...r, ...base, url, alreadyRunning: true, server: { kind: 'static', stopped: false, port: running.port, lingerMs: 0, root: d.root, note: 'a show-local server was already serving this folder; it was used and left running' } };
  }

  const at = { cwd, name: staticName(d.root), platform };
  const port = wanted ?? await pickPort({ prefer: rememberedPorts(d.root, at).map((r) => r.port), taken: claimedPorts(cwd, at), isFree });
  if (!port) return failure(base, 'no-free-port', 'Ports 4400-4499 are all busy or claimed by other entries in .claude/launch.json.', t0);
  const log = logFileFor(port);
  const server = createStaticServer({ root: d.root, port, logFile: log, platform, echo: false });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  try {
    await listen(server, port);
  } catch (e) {
    return failure(base, e.code || 'listen-failed', `Port ${port}: ${e.message}; nothing was started or opened.`, t0);
  }
  try { writeFileSync(log, ''); } catch { /* the server still runs without a log file */ }
  const url = entryUrl(port, d.entry);
  let r;
  let lingered = 0;
  let registered = false;
  // Everything after listen is inside the try: whatever fails, the server closes.
  try {
    registered = register({ kind: 'static', pid: process.pid, port, root: d.root, url: `http://127.0.0.1:${port}/`, log, started: new Date().toISOString(), oneshot: true });
    r = await show(url, { ...common, logFile: log, waitMs: SERVED_WAIT_MS, budgetMs: ONESHOT_STATIC_BUDGET_MS });
    if (r.ok && r.opened) { await sleep(lingerMs); lingered = lingerMs; }
  } finally {
    await closeServer(server, sockets);
    unregisterOurs(port);
  }
  const stopped = await released(port);
  return {
    ...r, ...base, url,
    ...(registered ? {} : { notes: [...(r.notes || []), UNLISTED_NOTE] }),
    server: { kind: 'static', stopped, port, lingerMs: lingered, root: d.root, url: `http://127.0.0.1:${port}/` },
    totalMs: Date.now() - t0,
  };
}

async function oneshotDev(d, { lingerMs, port: wanted, ...common }) {
  const { t0 } = common;
  const base = { mode: 'dev', target: d.root, ...(d.reasons?.length ? { reasons: d.reasons } : {}) };
  const port = wanted ?? d.port;
  if (!port) {
    const f = failure(base, 'dev-port-unknown', `Could not tell which port "${d.script}" listens on; pass --port with the port it prints. Nothing was started.${d.portNote ? ` ${d.portNote}.` : ''}`, t0);
    return d.candidates?.length ? { ...f, candidates: d.candidates } : f;
  }
  if (wanted == null) {
    // The project's server may already be up: open that one and leave it running, it is not ours.
    const pre = await show(d.root, { ...common, planOnly: true });
    if (pre.ok === false) return pre;
    if (pre.alreadyRunning) {
      const r = await show(d.root, common);
      return { ...r, server: { kind: 'dev', stopped: false, port, lingerMs: 0, root: d.root, note: "the project's dev server was already running; it was used and left running" } };
    }
  }
  const held = entryAt(port);
  if (held && held.pid !== process.pid && entryAlive(held)) {
    return failure(base, 'port-busy', `Port ${port} is registered to another show-local server (pid ${held.pid}); nothing was started.`, t0);
  }

  const url = devUrl(d.script, port);
  let tail = '';
  const keep = (chunk) => { tail = `${tail}${chunk}`.slice(-TAIL_CHARS); };
  let devRun = null;
  let r;
  let lingered = 0;
  let registered = false;
  // From the start of the tree on, everything is inside the try: whatever fails, the tree ends.
  try {
    devRun = startDevRun({ root: d.root, pm: d.packageManager, port, stdio: ['ignore', 'pipe', 'pipe'], platform: common.platform });
    for (const s of [devRun.child.stdout, devRun.child.stderr]) { s?.setEncoding('utf8'); s?.on('data', keep); }
    registered = register({ kind: 'dev', runner: 'dev-run', pid: process.pid, childPid: devRun.pid, port, root: d.root, url, started: new Date().toISOString(), oneshot: true });
    // The page gets what the dev budget leaves once the window watch after it is set aside.
    const waitMs = Math.max(1000, t0 + ONESHOT_DEV_BUDGET_MS - Date.now() - DEFAULT_TIMEOUT_MS - WATCH_STARTUP_MS - WATCH_REPORT_MS);
    r = await show(url, { ...common, waitMs, budgetMs: ONESHOT_DEV_BUDGET_MS, serverAlive: () => !devRun.gone() });
    if (r.ok && r.opened) { await sleep(lingerMs); lingered = lingerMs; }
  } finally {
    await devRun?.stop();
    unregisterOurs(port);
  }
  const notes = [...(r.notes || [])];
  // Nothing opened: what the dev server said last is the likeliest explanation.
  if (!r.opened && tail.trim()) notes.push(`the dev server's last output: ${tail.trim()}`);
  if (!registered) notes.push(UNLISTED_NOTE);
  const stopped = devRun.gone() && await released(port);
  return {
    ...r, ...base, url,
    caution: `It ran the project's own code ("${d.script}").`,
    ...(notes.length ? { notes } : {}),
    server: { kind: 'dev', stopped, port, lingerMs: lingered, root: d.root, url },
    totalMs: Date.now() - t0,
  };
}
