// Registry of the servers show-local knows: one JSON file per port in the temp dir.
// A static server (kind "static", or no kind in older entries) writes its entry on start and
// removes it on exit. A dev server (kind "dev") is the project's own process: show-local
// records it once a page has opened on it, so `servers` can list it and `stop` can end it.
// A dev server started through `dev-run` (or `oneshot`) is recorded by that show-local process
// itself (runner "dev-run", its own pid, and childPid: the guard that holds the project's
// process tree), because the pid that listens is a grandchild it cannot know in advance.
// Entries whose process died without cleanup (killed, crashed) are pruned on read; a dev-run
// entry needs both its pids alive (see devRunLive).
// Writing the registry is best effort, like a server's log: a server that could not be recorded
// still runs, and ends with whatever started it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { httpRequest, pathKey, stateDir } from './util.mjs';
import { rootTag } from './server.mjs';
import { listeningPids } from './portowner.mjs';

const HEADER = 'x-show-local';
const KINDS = new Set(['static', 'dev']);

/** The kind of an entry: entries written before kinds existed are static servers. */
export const kindOf = (e) => (e?.kind === undefined ? 'static' : e.kind);

/** A dev server that a show-local dev-run (or oneshot) process started and recorded itself. */
export const isDevRun = (e) => kindOf(e) === 'dev' && e?.runner === 'dev-run';

export function serversDir() {
  const dir = path.join(stateDir(), 'servers');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const logFileFor = (port) => path.join(stateDir(), `server-${port}.log`);

/**
 * Record a server. Returns false when its entry could not be written (disk full, a state folder
 * that cannot be written, a file named `servers` in the way): the caller reports that `servers`
 * and `stop` will not list it, and keeps its cleanup and parent watch as usual.
 */
export function register(info) {
  if (!validPort(info.port)) return false;
  try {
    writeFileSync(path.join(serversDir(), `${info.port}.json`), JSON.stringify(info, null, 2));
    return true;
  } catch { return false; }
}

const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

export function unregister(port) {
  // The port becomes a file name: only ever a plain integer.
  if (!validPort(port)) return;
  // Runs in exit and signal handlers: a registry that cannot be written must not stop the exit.
  try { rmSync(path.join(serversDir(), `${port}.json`), { force: true }); } catch { /* nothing to remove */ }
}

export function pidAlive(pid, { platform = process.platform, readFile = readFileSync, psFn = psState } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  // kill(pid, 0) also succeeds for a zombie: a process that has ended but whose parent has not
  // collected it yet (a parent busy in a synchronous call, for one). It runs nothing and holds
  // no port, so it counts as gone.
  return !isZombie(pid, { platform, readFile, psFn });
}

function isZombie(pid, { platform, readFile, psFn }) {
  if (platform === 'linux') {
    try {
      // /proc/<pid>/stat: "pid (comm) S …"; comm may itself contain ") ", so read after the last one.
      const stat = String(readFile(`/proc/${pid}/stat`, 'utf8'));
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
    } catch { return false; }
  }
  if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') return /^Z/.test(psFn(pid));
  return false; // Windows has no zombies: an ended process is gone
}

function psState(pid) {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

/**
 * Who is on this port? 'ours': a show-local server for exactly this root (any root when none
 * is given). 'silent': the connection was taken but no answer came in time, which is what a
 * live server on a loaded or just-woken machine looks like. 'other': nothing listens, or
 * something else answers, so the port is provably not ours.
 */
export async function probe(port, root) {
  const r = await httpRequest(`http://127.0.0.1:${port}/`, { method: 'HEAD', timeoutMs: 800 });
  if (!r.ok) return r.error === 'timeout' ? 'silent' : 'other';
  const tag = r.headers?.[HEADER];
  if (!tag) return 'other';
  return !root || tag === rootTag(root) ? 'ours' : 'other';
}

/** Is a show-local server for exactly this root answering on this port? */
export async function answers(port, root) {
  return (await probe(port, root)) === 'ours';
}

function readEntries() {
  let files = [];
  try { files = readdirSync(serversDir()).filter((f) => /^\d{1,5}\.json$/.test(f)); } catch { return []; }
  return files.map((f) => {
    try {
      const e = JSON.parse(readFileSync(path.join(serversDir(), f), 'utf8'));
      // An entry must describe the port its file is named after, with a real pid and folder,
      // and a kind this version knows.
      if (!e || !validPort(e.port) || `${e.port}.json` !== f || !Number.isInteger(e.pid) || typeof e.root !== 'string') return null;
      if (e.kind !== undefined && !KINDS.has(e.kind)) return null;
      return e;
    } catch { return null; }
  }).filter(Boolean);
}

/** The entry registered for this port, as written (no liveness check), or null. */
export function entryAt(port) {
  if (!validPort(port)) return null;
  return readEntries().find((e) => e.port === port) || null;
}

/**
 * Is this dev-run entry's show-local process still there? Both of its pids must be alive: its
 * own and its guard's (childPid). dev-run ends as soon as its guard does, and a tree kill or a
 * reboot ends both at once with no cleanup, so a single live pid is most likely a reused one.
 * No process lookup (it is polled): stop proves the identity before it ends anything.
 */
export function devRunLive(e) {
  return isDevRun(e) && Number.isInteger(e.childPid) && e.childPid > 1 && pidAlive(e.pid) && pidAlive(e.childPid);
}

/** Does this entry's server still run? A dev-run entry by devRunLive, any other by its pid. */
export const entryAlive = (e) => !!e && (isDevRun(e) ? devRunLive(e) : pidAlive(e.pid));

/**
 * The live dev-run entry on this port for exactly this project folder, or null. Read from disk
 * only: its show-local process and its guard are alive, which means the project's process tree
 * it holds is too (dev-run ends as soon as that tree ends).
 */
export function devRunAt(port, root) {
  const e = entryAt(port);
  if (!e || !devRunLive(e)) return null;
  return pathKey(e.root) === pathKey(root) ? e : null;
}

/**
 * Static-server entries for this folder whose process is still alive, read from disk only:
 * no port is probed. pickPort uses them to give a folder back the port it already has.
 */
export function liveEntriesFor(root) {
  const key = pathKey(root);
  return readEntries()
    .filter((e) => kindOf(e) === 'static' && pathKey(e.root) === key && pidAlive(e.pid))
    .sort((a, b) => a.port - b.port);
}

/**
 * Registered servers, sorted by port. An entry is removed only when it is provably stale.
 * A static server: its process is gone, or its port refuses or answers as something else. A
 * live process that is only slow to answer keeps its entry (a server registers once, so a
 * removed entry never comes back) and is listed with responding:false, so `servers` and
 * `stop` still see it. A dev server sends no show-local header, so it is live only while its
 * process is alive and still listens on the port (`owners` is injectable for tests). A dev-run
 * entry names show-local's own process and its guard, not the listener: it is live while both
 * are (devRunLive).
 */
export async function listServers({ owners = listeningPids } = {}) {
  const live = [];
  for (const e of readEntries()) {
    if (!pidAlive(e.pid)) { unregister(e.port); continue; }
    if (isDevRun(e)) {
      if (devRunLive(e)) { live.push(e); continue; }
      // Only this very entry: a new dev-run may have taken the port since it was read.
      const now = entryAt(e.port);
      if (now?.pid === e.pid && now.childPid === e.childPid) unregister(e.port);
      continue;
    }
    if (kindOf(e) === 'dev') {
      if (owners(e.port).includes(e.pid)) live.push(e);
      else unregister(e.port);
      continue;
    }
    const who = await probe(e.port, e.root);
    if (who === 'ours') live.push(e);
    else if (who === 'silent') live.push({ ...e, responding: false });
    else unregister(e.port);
  }
  return live.sort((a, b) => a.port - b.port);
}

/**
 * A static server for this folder that answers right now: one that does not would open a
 * page that never loads. A dev server is never reused as a static one.
 */
export async function findServerFor(root) {
  const key = pathKey(root);
  return (await listServers()).find((e) => kindOf(e) === 'static' && e.responding !== false && pathKey(e.root) === key) || null;
}
