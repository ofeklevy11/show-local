// dev-run: a project's own dev server (npm|pnpm|yarn|bun run dev), started in the project's
// folder as a child of show-local, so it ends with whatever started it.
//
// The project path never appears on a command line. The runner starts with the project as its
// working folder, and on Windows through `cmd.exe /d /s /c "<runner> run dev"` (the npm, pnpm
// and yarn shims are .cmd files, which need cmd.exe). A folder named R&D or %USERNAME%
// therefore reaches nothing that could split or expand it.
//
// The process tree: dev-run (or oneshot) → guard (this file, run with --guard) → runner → the
// dev server. The guard checks its parent every second. Once the parent is gone, however it
// ended (also killed outright, which on Windows runs no handler at all), the guard ends the
// runner's whole tree and then itself. Ending the guard's tree ends everything: Windows
// `taskkill /PID <guard> /T /F`; on POSIX the guard leads its own process group, and the
// runner and everything it starts live in that group. The guard is started detached, so it
// outlives a parent that was killed (see startDevRun).
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processInfo } from './portowner.mjs';
import { entryAt, pidAlive, unregister } from './registry.mjs';
import { run, sleep, systemRoot } from './util.mjs';

export const DEVRUN_FILE = fileURLToPath(import.meta.url);
/** How often a server, dev-run or the guard checks that its parent still runs. */
export const PARENT_POLL_MS = 1000;
/** How long a tree gets to end after SIGTERM before SIGKILL (POSIX). */
export const KILL_GRACE_MS = 2000;
export const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** A program in Windows' own System32 folder, by absolute path: never one planted in a working folder. */
export function system32(name, env = process.env) {
  return path.win32.join(systemRoot(env), 'System32', name);
}

/**
 * How to start `<pm> run dev` in the current working folder: { cmd, args, options }. The
 * project path is not in it; the caller sets the working folder.
 */
export function runnerSpawn(pm, platform = process.platform, env = process.env) {
  if (!RUNNERS.has(pm)) throw new Error(`unknown package manager "${pm}"`);
  if (platform === 'win32') {
    // /d: no AutoRun commands. /s /c "…": cmd.exe strips exactly the outer quotes.
    return { cmd: system32('cmd.exe', env), args: ['/d', '/s', '/c', `"${pm} run dev"`], options: { windowsVerbatimArguments: true } };
  }
  return { cmd: pm, args: ['run', 'dev'], options: {} };
}

/**
 * Call onGone once, when the parent process has ended: every intervalMs, kill(ppid, 0), and on
 * POSIX also a changed process.ppid (an orphan is adopted by another process at once). The
 * timer never keeps the process alive by itself. Returns { stop }.
 */
export function watchParent(onGone, { ppid = process.ppid, intervalMs = PARENT_POLL_MS, alive = pidAlive, currentPpid = () => process.ppid } = {}) {
  const watched = Number(ppid);
  // Already adopted by init (or no parent to speak of): there is nothing to follow.
  if (!Number.isInteger(watched) || watched <= 1) return { stop() {} };
  const ownParent = watched === currentPpid();
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    if (alive(watched) && (!ownParent || currentPpid() === watched)) return;
    done = true;
    clearInterval(timer);
    onGone();
  }, intervalMs);
  timer.unref?.();
  return { stop() { done = true; clearInterval(timer); } };
}

/**
 * The Claude Code process this one runs under, when it is not the direct parent: the nearest
 * ancestor named claude (claude.exe on Windows). The Bash tool puts shells in between
 * (node ← bash ← bash ← claude), and a shell can outlive the session that started it.
 * Windows only (processInfo reads the ancestor chain there); null elsewhere or when unknown.
 */
export function sessionHostPid({ info, platform = process.platform, ppid = process.ppid, infoFn = processInfo } = {}) {
  if (platform !== 'win32') return null;
  // Deeper than processInfo's default: the Bash tool's chain is node, three shells, then claude.
  const chain = info === undefined ? infoFn(process.pid, { depth: 8 }) : info;
  const host = chain?.parents?.find((p) => /^claude(\.exe)?$/i.test(String(p.name || '')));
  return host && Number.isInteger(host.pid) && host.pid !== ppid ? host.pid : null;
}

/**
 * watchParent for the direct parent, plus the session host (sessionHostPid) once it is known.
 * The host is looked up after the caller's own start-up, off the critical path. onGone runs at
 * most once. Returns { stop, hostPid() }.
 */
export function watchSession(onGone, { infoFn = processInfo, platform = process.platform, intervalMs = PARENT_POLL_MS, alive = pidAlive } = {}) {
  let fired = false;
  const once = () => { if (!fired) { fired = true; onGone(); } };
  const parent = watchParent(once, { intervalMs, alive });
  let host = null;
  let hostWatch = { stop() {} };
  const lookup = setTimeout(() => {
    try { host = sessionHostPid({ platform, infoFn }); } catch { host = null; }
    if (host && !fired) hostWatch = watchParent(once, { ppid: host, intervalMs, alive, currentPpid: () => -1 });
  }, 0);
  lookup.unref?.();
  return { stop() { fired = true; clearTimeout(lookup); parent.stop(); hostWatch.stop(); }, hostPid: () => host };
}

/**
 * End a process and everything it started. Windows: taskkill /T /F, by its absolute path.
 * POSIX: `signal` to the process group that `pid` leads (the guard is started as a group
 * leader). Returns whether the signal or taskkill went through. Never pid 1 (on POSIX
 * kill(-1) signals every process of the user) and never this process.
 */
export function killTree(pid, { platform = process.platform, runFn = run, signal = 'SIGTERM' } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  if (platform === 'win32') return runFn(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { timeout: 15000 }).status === 0;
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

/**
 * Is a dev-run registry entry still exactly what wrote it? Asked of the OS before `stop` ends
 * anything, and tied to this entry, so that pids reused by something else (another project's
 * dev-run included) are never ended:
 * - e.pid runs show.mjs dev-run or oneshot, and names no --port other than this entry's;
 * - e.childPid is its guard: devrun.mjs --guard for exactly this port and this parent pid (on
 *   Windows its parent process is e.pid too).
 * Returns { ours: true, guard } (guard: the pid whose tree may be ended, or null when it could
 * not be looked up and the process names this port itself), { stale: why } when the OS shows
 * the pids belong to something else now, or { unknown: why } when it could not tell.
 */
export function devRunIdentity(e, { infoFn = processInfo, platform = process.platform } = {}) {
  const info = infoFn(e.pid);
  if (!info) return { unknown: 'the recorded process could not be identified as show-local\'s dev-run' };
  const argv = (info.argv || []).map(String);
  const script = argv.findIndex((a) => path.basename(a) === 'show.mjs');
  const rest = script === -1 ? [] : argv.slice(script + 1);
  if (!rest.includes('dev-run') && !rest.includes('oneshot')) return { stale: 'the recorded process is no longer show-local\'s dev-run' };
  const flag = rest.indexOf('--port');
  const namedPort = flag === -1 ? null : rest[flag + 1];
  if (namedPort != null && namedPort !== String(e.port)) return { stale: `the recorded process is show-local's dev-run for port ${namedPort}, not ${e.port}` };
  const g = Number.isInteger(e.childPid) && e.childPid > 1 ? infoFn(e.childPid) : null;
  if (!g) {
    return namedPort === String(e.port) ? { ours: true, guard: null } : { unknown: 'the recorded guard could not be identified as this dev-run\'s' };
  }
  const gArgv = (g.argv || []).map(String);
  const at = gArgv.indexOf('--guard');
  // The guard's own command line: [node, devrun.mjs, --guard, <pm>, <port>, <parent pid>].
  const isGuard = at > 0 && path.basename(gArgv[at - 1]) === path.basename(DEVRUN_FILE)
    && gArgv[at + 2] === String(e.port) && gArgv[at + 3] === String(e.pid)
    && (platform !== 'win32' || g.parents?.[0]?.pid === e.pid);
  return isGuard ? { ours: true, guard: e.childPid } : { stale: 'the recorded guard is not this dev-run\'s' };
}

const settles = (p, ms) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

/**
 * Start the guard, which starts `<pm> run dev` with `root` as its working folder, and watches
 * this process. Returns { child, pid, exited, gone(), stop(), stopSync() }. `stdio` is the
 * guard's, and so the runner's, output: inherited by dev-run, piped by oneshot. stdin is never
 * handed on: a dev server must not compete with a terminal for input.
 */
export function startDevRun({ root, pm, port = null, stdio = ['ignore', 'inherit', 'inherit'], platform = process.platform, spawnFn = spawn } = {}) {
  runnerSpawn(pm, platform); // refuses an unknown package manager before anything starts
  // Detached everywhere. POSIX: the guard leads a process group of its own. Windows: Node puts
  // every child that is not detached in a job object that kills it the moment its parent dies,
  // which would take the guard down before it could end the runner's tree (whose processes
  // are not in that job and would live on).
  const child = spawnFn(process.execPath, [DEVRUN_FILE, '--guard', pm, String(port || 0), String(process.pid)], {
    cwd: root, stdio, windowsHide: true, detached: true,
  });
  let info = null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => { info = info || { code, signal }; resolve(info); });
    child.once('error', (e) => { info = info || { code: null, signal: null, error: e.message }; resolve(info); });
  });
  const gone = () => info !== null;
  return {
    child,
    pid: child.pid,
    exited,
    gone,
    /** End the whole tree; resolves true once the guard has exited. */
    async stop({ graceMs = KILL_GRACE_MS + 1000 } = {}) {
      if (gone()) return true;
      killTree(child.pid, { platform });
      if (await settles(exited, graceMs)) return true;
      if (platform !== 'win32') killTree(child.pid, { platform, signal: 'SIGKILL' });
      return settles(exited, 1000);
    },
    /** For an exit handler, which cannot wait: start ending the tree. */
    stopSync() { if (!gone()) killTree(child.pid, { platform }); },
  };
}

/** The guard: `node devrun.mjs --guard <pm> <port|0> <parent pid>`, working folder = the project. */
async function guardMain([pm, portArg, parentArg]) {
  const posix = process.platform !== 'win32';
  const parentPid = Number(parentArg);
  const port = Number(portArg) || null;
  let spec;
  try { spec = runnerSpawn(pm); } catch (e) { process.stderr.write(`show-local dev-run: ${e.message}\n`); process.exit(2); }
  let runner;
  try {
    runner = spawn(spec.cmd, spec.args, { ...spec.options, cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  } catch (e) {
    process.stderr.write(`show-local dev-run: could not start ${pm}: ${e.message}\n`);
    process.exit(1);
  }
  let runnerDone = false;
  const runnerExited = new Promise((resolve) => runner.once('exit', () => { runnerDone = true; resolve(); }));
  runner.once('error', (e) => { process.stderr.write(`show-local dev-run: could not start ${pm}: ${e.message}\n`); process.exit(1); });

  let ending = false;
  const endAll = async () => {
    if (ending) return;
    ending = true;
    // POSIX: the whole group, this guard included (its handlers ignore that signal from now on).
    if (posix) { try { process.kill(-process.pid, 'SIGTERM'); } catch { /* group already gone */ } } else if (!runnerDone) killTree(runner.pid);
    await Promise.race([runnerExited, sleep(KILL_GRACE_MS)]);
    if (posix) { try { process.kill(-process.pid, 'SIGKILL'); } catch { /* gone */ } }
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { endAll(); });
  runner.once('exit', (code, signal) => {
    if (ending) return;
    ending = true;
    // The runner ended by itself: on POSIX, end whatever it left behind in the group too.
    if (posix) { try { process.kill(-process.pid, 'SIGTERM'); } catch { /* nothing left */ } }
    process.exit(code ?? (signal ? 1 : 0));
  });
  watchParent(() => {
    // show-local's own process is gone (on Windows possibly killed outright, with no chance to
    // clean up): its registry entry goes with it, then the whole tree.
    const e = port ? entryAt(port) : null;
    if (e && e.pid === parentPid) unregister(port);
    endAll();
  }, { ppid: parentPid });
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(DEVRUN_FILE); } catch { return false; }
}

if (process.argv[2] === '--guard' && invokedDirectly()) guardMain(process.argv.slice(3));
