#!/usr/bin/env node
// show-local — open a result on the user's own computer and prove it opened.
//
//   node show.mjs <path|url> [--select FILE] [--timeout MS] [--wait MS] [--log FILE] [--desktop] [--no-verify] [--dev-root DIR]
//   node show.mjs plan <path|url> [--desktop] [--headless]   what would happen; opens nothing (--desktop writes the launch.json entry)
//   node show.mjs oneshot <path> [--cwd DIR] [--port N] [--linger MS]   headless: start, open, verify, linger, stop everything
//   node show.mjs serve <folder> [--port N] [--log FILE] [--no-parent-watch]   static server, 127.0.0.1 only (foreground)
//   node show.mjs dev-run <project> [--port N] [--no-parent-watch]   the project's dev script in its own folder (foreground)
//   node show.mjs servers                          running show-local servers (static, and dev servers it recorded)
//   node show.mjs stop <port|all>                  stop show-local servers
//   node show.mjs doctor                           check the environment
//
// Every command prints one JSON object (serve and dev-run: one JSON line, then their servers'
// own output). Exit code: 0 ok, 1 failed or not verified, 2 usage. A failure carries
// verified:false and its detail as the evidence.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { show, devUrl, DEFAULT_TIMEOUT_MS, DEFAULT_WAIT_MS, DIRECT_BUDGET_MS, SERVED_WAIT_MS, TIMEOUT_ENV } from './lib/open.mjs';
import { oneshot, DEFAULT_LINGER_MS, MAX_LINGER_MS } from './lib/oneshot.mjs';
import { devRunIdentity, killTree, startDevRun, watchSession } from './lib/devrun.mjs';
import { packageManager } from './lib/detect.mjs';
import { createStaticServer, listen } from './lib/server.mjs';
import { answers, entryAlive, entryAt, isDevRun, kindOf, listServers, logFileFor, pidAlive, register, unregister } from './lib/registry.mjs';
import { claimedPorts, pickPort, rememberedPorts } from './lib/ports.mjs';
import { doctor } from './lib/doctor.mjs';
import { listeningPid, listeningPids } from './lib/portowner.mjs';
import { sleep, slugFor, toPathArg } from './lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { return 'dev'; }
})();

const COMMANDS = new Set(['open', 'plan', 'oneshot', 'serve', 'dev-run', 'servers', 'stop', 'doctor', 'help', 'version']);
const VALUE_FLAGS = new Set(['--select', '--timeout', '--wait', '--log', '--port', '--cwd', '--dev-root', '--linger']);
const PATH_FLAGS = ['cwd', 'dev-root', 'select', 'log'];
const BOOL_FLAGS = new Set(['--desktop', '--no-verify', '--folder', '--headless', '--no-parent-watch', '--help', '-h', '--version']);
/** What serve and dev-run add to their JSON line when their registry entry could not be written. */
const UNLISTED = { registered: false, note: 'the server registry could not be written, so servers and stop do not list this server; it still ends with the process that started it' };
/** A package.json larger than this is not read: a link to /dev/zero or a huge file would never finish. */
const MAX_PACKAGE_JSON = 1024 * 1024;

function parse(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) return { error: `${a} needs a value` };
      flags[a.slice(2)] = argv[++i];
    } else if (BOOL_FLAGS.has(a)) {
      flags[a.replace(/^-+/, '')] = true;
    } else if (a.startsWith('--')) {
      return { error: `unknown option ${a}` };
    } else {
      pos.push(a);
    }
  }
  let cmd = 'open';
  if (pos.length && COMMANDS.has(pos[0])) cmd = pos.shift();
  // A path may arrive as a file:/// URL: the form the printed next.* commands use for a path with
  // characters the Bash tool refuses (see cmdPath). URLs to open stay URLs: open and plan read
  // their target through detect, which handles file:// itself.
  for (const k of PATH_FLAGS) if (typeof flags[k] === 'string') flags[k] = toPathArg(flags[k]);
  if (['serve', 'dev-run'].includes(cmd) && pos.length) pos[0] = toPathArg(pos[0]);
  if (flags.help || flags.h) cmd = 'help';
  if (flags.version) cmd = 'version';
  return { cmd, pos, flags };
}

class UsageError extends Error {}

const num = (v, name, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (String(v).trim() === '' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    const range = max === Number.MAX_SAFE_INTEGER ? (min === 0 ? 'non-negative ' : `>= ${min} `) : '';
    const bounds = max === Number.MAX_SAFE_INTEGER ? '' : ` from ${min} to ${max}`;
    throw new UsageError(`${name} must be a ${range}${integer ? 'integer' : 'number'}${bounds}, got "${v}"`.replace('a integer', 'an integer'));
  }
  return n;
};

/**
 * Print one JSON object. A failure that names its cause (ok:false with a detail) always carries
 * verified:false and that detail as the evidence, like every other result that opened nothing.
 */
function out(obj, code = 0) {
  let o = obj;
  if (o && o.ok === false && typeof o.detail === 'string') {
    o = { ...o, verified: false, evidence: Array.isArray(o.evidence) && o.evidence.length ? o.evidence : [o.detail] };
  }
  process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
  process.exitCode = code;
}

const HELP = `show-local ${VERSION} — open a result on this computer and verify it opened.

  node show.mjs <path|url>            open it (browser, file manager or default app) and verify;
                                      a direct open finishes within ${DIRECT_BUDGET_MS / 1000} s
  node show.mjs plan <path|url>       report what would happen; opens nothing. With --desktop it
                                      adds or updates the entry in .claude/launch.json
  node show.mjs oneshot <path>        for headless sessions: start the server, open and verify,
                                      keep serving for --linger, then stop everything (foreground)
  node show.mjs serve <folder>        static server on 127.0.0.1 (first free port from 4400 to 4499), foreground
  node show.mjs dev-run <project>     run the project's dev script (npm, pnpm, yarn or bun run dev)
                                      inside the project folder, foreground; ends its whole process tree
  node show.mjs servers               list running show-local servers (static, and dev servers it recorded)
  node show.mjs stop <port|all>       stop show-local servers
  node show.mjs doctor                check browser, file types, window titles, ports

  --folder         show the folder itself (or the file inside its folder), never run a project
  --select FILE    folder mode: the file to select (default: HTML, then video, PDF, images; newest first)
  --timeout MS     how long to wait for the window (default ${DEFAULT_TIMEOUT_MS}, or ${TIMEOUT_ENV} when it is set)
  --wait MS        how long to wait for a local server to answer (default ${DEFAULT_WAIT_MS}; a plan's
                   next.then passes ${SERVED_WAIT_MS} for a static server it starts, 60000 for a dev server)
  --log FILE       server access log, for a second proof in served mode
  --desktop        plan: add or update the preview entry in .claude/launch.json in the working
                   folder (Claude desktop app). It is the one thing plan writes
  --headless       plan: give the headless form (next.oneshot, one foreground command), as a
                   subagent or workflow step needs; claude -p and SDK sessions get it by themselves
  --cwd DIR        the working folder (default: the current folder). Relative targets resolve
                   against it, and --desktop writes its .claude/launch.json
  --dev-root DIR   the project whose dev server answers the URL: once the page opens, that server
                   is recorded, so servers lists it and stop ends it (a dev plan's next.then passes it)
  --no-verify      open without verifying
  --port N         serve and oneshot: port to serve on (default: the folder's own port from its
                   launch.json or registry entry when that is free, else the first free port from
                   4400 to 4499 that no other launch.json entry claims). dev-run and oneshot on a
                   project: the port its dev server uses
  --linger MS      oneshot: how long to keep serving after the page opened (default ${DEFAULT_LINGER_MS})
  --no-parent-watch  serve, dev-run: keep running when the process that started it ends
                   (by default they end with it, checked every second)

Output is one JSON object. Exit code 0 = opened, 1 = failed or not verified, 2 = usage.
`;

async function cmdServe(pos, flags) {
  const root = path.resolve(flags.cwd || process.cwd(), pos[0] || '.');
  let st;
  try { st = statSync(root); } catch { return out({ ok: false, error: 'not-found', detail: `No such folder: ${root}` }, 1); }
  if (!st.isDirectory()) return out({ ok: false, error: 'not-a-folder', detail: `${root} is not a folder` }, 1);
  // Without --port: the folder's own port when it is free, else the first free one from 4400
  // that no other entry in the working folder's launch.json claims.
  const at = { cwd: flags.cwd || process.cwd(), name: `show-${slugFor(root)}` };
  const choose = () => pickPort({ prefer: rememberedPorts(root, at).map((r) => r.port), taken: claimedPorts(at.cwd, at) });
  const port = flags.port !== undefined ? num(flags.port, '--port', { min: 1, max: 65535, integer: true }) : await choose();
  if (!port) return out({ ok: false, error: 'no-free-port', detail: 'Ports 4400-4499 are all busy or claimed by other entries in .claude/launch.json.' }, 1);
  const log = flags.log ? path.resolve(flags.log) : logFileFor(port);

  const server = createStaticServer({ root, port, logFile: log });
  try {
    await listen(server, port);
  } catch (e) {
    const same = e.code === 'EADDRINUSE' && await answers(port, root);
    return out({ ok: same, error: e.code || 'listen-failed', detail: same ? `Already serving ${root} on port ${port}.` : `Port ${port}: ${e.message}` }, same ? 0 : 1);
  }
  // Start a fresh log only once this process owns the port, so a duplicate `serve` that
  // finds the folder already served never wipes the running server's log.
  try { writeFileSync(log, ''); } catch { /* the server still runs without a log file */ }
  const info = { kind: 'static', pid: process.pid, port, root, url: `http://127.0.0.1:${port}/`, log, started: new Date().toISOString() };
  const bye = () => { unregister(port); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('SIGHUP', bye);
  process.on('exit', () => unregister(port));
  // The server lives with whatever started it (the session's shell, the desktop app) and, on
  // Windows, with the Claude Code process above that shell.
  const parentWatch = !flags['no-parent-watch'];
  if (parentWatch) watchSession(bye);
  // Recorded only once its cleanup and parent watch are in place.
  const registered = register(info);
  process.stdout.write(`${JSON.stringify({ ok: true, serving: root, url: info.url, port, log, pid: process.pid, parentWatch, ...(registered ? {} : UNLISTED) })}\n`);
}

/**
 * The project's dev script, or null: package.json (a UTF-8 BOM is fine) with scripts.dev. Only
 * a regular file of at most MAX_PACKAGE_JSON is read: a link to a device or a pipe never is.
 */
function devScriptOf(root) {
  try {
    const file = path.join(root, 'package.json');
    const st = statSync(file); // follows a link, to whatever it names
    if (!st.isFile() || st.size > MAX_PACKAGE_JSON) return null;
    const pkg = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const script = pkg?.scripts?.dev;
    return typeof script === 'string' && script.trim() ? script : null;
  } catch { return null; }
}

/**
 * dev-run <project> [--port N] [--no-parent-watch]: run `<pm> run dev` with the project as the
 * working folder (the path is never on a command line), record it under its port, and end the
 * whole process tree on SIGINT, SIGTERM, the parent's death or exit. Foreground: prints one JSON
 * line, then the dev server's own output.
 */
async function cmdDevRun(pos, flags) {
  const root = path.resolve(flags.cwd || process.cwd(), pos[0] || '.');
  let st;
  try { st = statSync(root); } catch { return out({ ok: false, error: 'not-found', detail: `No such folder: ${root}` }, 1); }
  if (!st.isDirectory()) return out({ ok: false, error: 'not-a-folder', detail: `${root} is not a folder` }, 1);
  const script = devScriptOf(root);
  if (!script) return out({ ok: false, error: 'no-dev-script', detail: `${root} has no package.json with a "dev" script` }, 1);
  const port = flags.port !== undefined ? num(flags.port, '--port', { min: 1, max: 65535, integer: true }) : null;
  const held = port ? entryAt(port) : null;
  if (held && entryAlive(held)) {
    return out({ ok: false, error: 'port-busy', detail: `Port ${port} is registered to another show-local server (pid ${held.pid}, ${held.root}); nothing was started.` }, 1);
  }
  const pm = packageManager(root);
  const url = port ? devUrl(script, port) : null;
  const parentWatch = !flags['no-parent-watch'];
  const devRun = startDevRun({ root, pm, port });
  const forget = () => { if (port && entryAt(port)?.pid === process.pid) unregister(port); };
  let ending = false;
  const finish = async (code) => {
    if (ending) return;
    ending = true;
    await devRun.stop();
    forget();
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { finish(0); });
  process.on('exit', () => { devRun.stopSync(); forget(); });
  devRun.exited.then(({ code, signal, error }) => {
    if (ending) return;
    ending = true;
    if (error) process.stderr.write(`show-local dev-run: ${error}\n`);
    forget();
    process.exit(code ?? (signal || error ? 1 : 0));
  });
  if (parentWatch) watchSession(() => { finish(0); });
  // Recorded only once its cleanup and parent watch are in place. Then the JSON line, and after
  // it whatever the dev server prints: the guard has yet to start node and then the runner.
  const registered = port ? register({ kind: 'dev', runner: 'dev-run', pid: process.pid, childPid: devRun.pid, port, root, url, started: new Date().toISOString() }) : true;
  process.stdout.write(`${JSON.stringify({ ok: true, running: root, command: `${pm} run dev`, port, url, pid: process.pid, parentWatch, ...(registered ? {} : UNLISTED) })}\n`);
  return undefined;
}

/**
 * Stop a dev server that dev-run (or oneshot) started. Its entry names show-local's own process
 * and its guard, and the OS must still show exactly those (devRunIdentity). An entry whose pids
 * now belong to something else, another project's dev-run included, is removed and nothing is
 * ended: { removed }. Otherwise that process ends by itself, never with its tree (oneshot
 * opened the user's browser as its own child), and so does the tree of its verified guard,
 * which holds the runner and the dev server: Windows TerminateProcess and taskkill /T /F; POSIX
 * SIGTERM to it and to the guard's process group, then SIGKILL. The port must come free.
 */
async function stopDevRun(s) {
  const id = devRunIdentity(s);
  if (id.stale) {
    const e = entryAt(s.port);
    if (e?.pid === s.pid && e.childPid === s.childPid) unregister(s.port);
    return { removed: { port: s.port, pid: s.pid, kind: 'dev', detail: `${id.stale}; the entry was stale, so it was removed and nothing was stopped` } };
  }
  if (!id.ours) return { refused: { port: s.port, pid: s.pid, kind: 'dev', detail: `${id.unknown}; nothing was stopped` } };
  // An unverified guard is left alone: it ends the runner's tree itself once its parent is gone.
  const tree = id.guard;
  try { process.kill(s.pid, 'SIGTERM'); } catch { /* already gone */ }
  if (tree) killTree(tree);
  const held = () => pidAlive(s.pid) || listeningPids(s.port).length > 0;
  const waitWhileHeld = async (ms) => { const end = Date.now() + ms; while (held() && Date.now() < end) await sleep(150); };
  await waitWhileHeld(5000);
  if (held() && process.platform !== 'win32') {
    try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone meanwhile */ }
    if (tree) killTree(tree, { signal: 'SIGKILL' });
    await waitWhileHeld(2000);
  }
  if (pidAlive(s.pid)) return { refused: { port: s.port, pid: s.pid, kind: 'dev', detail: 'dev-run was told to stop but is still running' } };
  if (entryAt(s.port)?.pid === s.pid) unregister(s.port);
  const again = listeningPids(s.port);
  return { stopped: { port: s.port, root: s.root, kind: 'dev', ...(again.length ? { note: `port ${s.port} is still in use (pid ${again.join(', ')}); that process was not stopped` } : {}) } };
}

/**
 * Stop a recorded dev server. It sends no show-local header, so the only proof that the entry
 * still describes it is the OS: its pid must be listening on the port right now. Returns
 * { stopped } or { refused }.
 */
async function stopDev(s) {
  const owners = listeningPids(s.port);
  if (!owners.includes(s.pid)) {
    return { refused: { port: s.port, pid: s.pid, owner: owners[0] ?? null, kind: 'dev', detail: 'the recorded dev server no longer owns the port; nothing was stopped' } };
  }
  try { process.kill(s.pid); } catch { /* already gone */ }
  const holds = () => pidAlive(s.pid) && listeningPids(s.port).includes(s.pid);
  const waitWhileHeld = async (ms) => { const end = Date.now() + ms; while (holds() && Date.now() < end) await sleep(100); };
  await waitWhileHeld(3000);
  // On Windows the first signal already terminates; elsewhere a server that ignored SIGTERM gets SIGKILL.
  if (holds() && process.platform !== 'win32') {
    try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone meanwhile */ }
    await waitWhileHeld(1000);
  }
  if (holds()) {
    return { refused: { port: s.port, pid: s.pid, owner: s.pid, kind: 'dev', detail: 'the dev server was told to stop but still holds the port' } };
  }
  unregister(s.port);
  // A dev tool that restarts its server in a new process would take the port again: say so.
  const again = listeningPids(s.port);
  return { stopped: { port: s.port, root: s.root, kind: 'dev', ...(again.length ? { note: `port ${s.port} is in use again (pid ${again.join(', ')}); that process was not stopped` } : {}) } };
}

async function cmdStop(pos) {
  const which = pos[0];
  if (!which) return out({ ok: false, error: 'usage', detail: 'stop <port|all>' }, 2);
  const servers = await listServers();
  const targets = which === 'all' ? servers : servers.filter((s) => String(s.port) === String(which));
  const stopped = [];
  const refused = [];
  const removed = [];
  for (const s of targets) {
    if (kindOf(s) === 'dev') {
      const r = isDevRun(s) ? await stopDevRun(s) : await stopDev(s);
      if (r.stopped) stopped.push(r.stopped); else if (r.removed) removed.push(r.removed); else refused.push(r.refused);
      continue;
    }
    // Only end the process that actually owns the port (when the OS can tell us), so a
    // reused pid or a doctored registry entry can never make stop kill something else.
    const owner = listeningPid(s.port);
    if (owner !== null && owner !== s.pid) {
      refused.push({ port: s.port, pid: s.pid, owner, detail: 'the port belongs to another process; nothing was stopped' });
      continue;
    }
    // A server that did not answer has no tag to vouch for it: stop it only on positive proof
    // that its pid owns the port.
    if (s.responding === false && owner !== s.pid) {
      refused.push({ port: s.port, pid: s.pid, owner, detail: 'the server is not answering and the OS could not confirm its pid owns the port; nothing was stopped' });
      continue;
    }
    try { process.kill(s.pid); } catch { /* already gone */ }
    for (let i = 0; i < 20 && await answers(s.port, s.root); i++) await sleep(100);
    unregister(s.port);
    stopped.push({ port: s.port, root: s.root });
  }
  // An entry that turned out stale had no server behind it: like a pruned one, it is not found.
  const found = targets.filter((s) => !removed.some((r) => r.port === s.port));
  const notFound = which !== 'all' && !found.length ? [which] : [];
  const ok = notFound.length === 0 && refused.length === 0;
  out({ ok, stopped, notFound, ...(refused.length ? { refused } : {}), ...(removed.length ? { removed } : {}) }, ok ? 0 : 1);
}

/**
 * oneshot <target> [--cwd DIR] [--port N] [--linger MS]: the whole served open in one foreground
 * command (see lib/oneshot.mjs). Prints the open result plus server { stopped, port, lingerMs }.
 */
async function cmdOneshot(pos, flags, t0) {
  if (!pos.length) return out({ ok: false, error: 'usage', detail: 'oneshot <path>: pass the page, folder or project to open. See --help.' }, 2);
  try {
    const r = await oneshot(pos.join(' '), {
      t0,
      cwd: flags.cwd || process.cwd(),
      port: flags.port !== undefined ? num(flags.port, '--port', { min: 1, max: 65535, integer: true }) : undefined,
      lingerMs: flags.linger !== undefined ? num(flags.linger, '--linger', { max: MAX_LINGER_MS, integer: true }) : undefined,
      timeoutMs: num(flags.timeout, '--timeout'),
      verify: !flags['no-verify'],
    });
    const failed = !r.ok || r.verified === false;
    out(r, failed ? 1 : 0);
  } finally {
    // Everything was stopped; should any handle still linger, also after a failure, it must
    // not hold the session.
    setTimeout(() => process.exit(), 3000).unref();
  }
  return undefined;
}

async function main() {
  // A direct open's budget counts from the moment this process started, not from here.
  const t0 = Math.round(performance.timeOrigin) || Date.now();
  const p = parse(process.argv.slice(2));
  if (p.error) return out({ ok: false, error: 'usage', detail: p.error }, 2);
  const { cmd, pos, flags } = p;
  try {
    switch (cmd) {
      case 'help': process.stdout.write(HELP); return undefined;
      case 'version': return out({ ok: true, version: VERSION });
      case 'serve': return await cmdServe(pos, flags);
      case 'dev-run': return await cmdDevRun(pos, flags);
      case 'oneshot': return await cmdOneshot(pos, flags, t0);
      case 'servers': return out({ ok: true, servers: await listServers() });
      case 'stop': return await cmdStop(pos);
      case 'doctor': { const r = await doctor({ cwd: flags.cwd || process.cwd() }); return out(r, r.ok ? 0 : 1); }
      case 'open':
      case 'plan': {
        if (!pos.length) return out({ ok: false, error: 'usage', detail: 'Pass a path or URL. See --help.' }, 2);
        const r = await show(pos.join(' '), {
          t0,
          cwd: flags.cwd || process.cwd(),
          desktop: !!flags.desktop,
          select: flags.select,
          logFile: flags.log,
          timeoutMs: num(flags.timeout, '--timeout'),
          waitMs: num(flags.wait, '--wait'),
          verify: !flags['no-verify'],
          asFolder: !!flags.folder,
          planOnly: cmd === 'plan',
          devRoot: flags['dev-root'],
          headless: !!flags.headless,
        });
        const failed = !r.ok || r.verified === false;
        return out(r, failed ? 1 : 0);
      }
      default: return out({ ok: false, error: 'usage', detail: `unknown command ${cmd}` }, 2);
    }
  } catch (e) {
    if (e instanceof UsageError) return out({ ok: false, error: 'usage', detail: e.message }, 2);
    return out({ ok: false, error: 'internal', detail: e.message }, 1);
  }
}

main();
