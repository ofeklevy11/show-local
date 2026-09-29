// Which process listens on a TCP port, and what it is. Used to make sure `stop` only ends
// the server it started, and that a dev server already on a port belongs to this project.
// Every lookup degrades to null (or []) when the OS tool is missing; callers treat that as unknown.
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { MAC_PROGRAMS, run, splitWindowsCommand, winProgram } from './util.mjs';

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

// A listening socket has no remote end. Matching that instead of the state word keeps the
// parser independent of the display language ("LISTENING", "ABHÖREN", "IN ASCOLTO"…).
const WILDCARD_REMOTE = new Set(['0.0.0.0:0', '[::]:0', '*:*']);

/** Every PID listening on TCP <port>, on any local address, IPv4 and IPv6. */
export function listeningPids(port, { runFn = run, platform = process.platform } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  const pids = [];
  const add = (n) => { if (Number.isInteger(n) && n > 0 && !pids.includes(n)) pids.push(n); };
  if (platform === 'win32') {
    // No "-p TCP": that lists IPv4 only, and dev servers bound to localhost often listen on [::1] alone.
    const r = runFn(winProgram('netstat'), ['-ano']);
    if (r.status !== 0) return [];
    for (const line of String(r.stdout).split(/\r?\n/)) {
      // Proto, local, remote, [state: zero or more words], pid.
      const f = line.trim().split(/\s+/);
      if (f.length < 4 || !/^TCP$/i.test(f[0]) || !WILDCARD_REMOTE.has(f[2]) || !/^\d+$/.test(f[f.length - 1])) continue;
      const m = f[1].match(/:(\d+)$/);
      if (m && Number(m[1]) === port) add(Number(f[f.length - 1]));
    }
    return pids;
  }
  const lsof = runFn(platform === 'darwin' ? MAC_PROGRAMS.lsof : 'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (lsof.status === 0) for (const t of String(lsof.stdout).split(/\s+/)) if (/^\d+$/.test(t)) add(Number(t));
  if (!pids.length && platform === 'linux') {
    const ss = runFn('ss', ['-ltnpH', `sport = :${port}`]);
    for (const m of String(ss.stdout).matchAll(/pid=(\d+)/g)) add(Number(m[1]));
  }
  return pids;
}

/** The first PID listening on TCP <port>, or null when unknown. */
export function listeningPid(port, opts) {
  return listeningPids(port, opts)[0] ?? null;
}

// Windows: the process and up to 3 ancestors in one PowerShell call (one process snapshot:
// each extra CIM query costs about half a second). UTF-8 output so a path like C:\פרויקטים\site
// survives any console code page; the pid travels in an env var only.
const WINDOWS_CHAIN = [
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$all = @{}',
  'foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate)) { $all[[int]$p.ProcessId] = $p }',
  '$out = @(); $child = $null; $id = [int]$env:SHOW_LOCAL_PID; $depth = [int]$env:SHOW_LOCAL_DEPTH',
  'while ($out.Count -lt $depth -and $id -gt 0 -and $all.ContainsKey($id)) {',
  '  $p = $all[$id]; $all.Remove($id)',
  // A parent pid outlives its process and can be reused: a "parent" younger than its child is someone else.
  '  if ($child -and $p.CreationDate -and $child.CreationDate -and $p.CreationDate -gt $child.CreationDate) { break }',
  '  $out += [pscustomobject]@{ pid = [int]$p.ProcessId; name = [string]$p.Name; exe = [string]$p.ExecutablePath; commandLine = [string]$p.CommandLine }',
  '  $child = $p; $id = [int]$p.ParentProcessId',
  '}',
  'ConvertTo-Json -InputObject @($out) -Compress',
].join('\n');

const baseName = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() || null : null);

/** argv of a Windows command line. An unquoted program path may contain spaces: ExecutablePath settles it. */
export function windowsArgv(commandLine, exe) {
  const s = String(commandLine || '').trim();
  if (!s) return [];
  const e = String(exe || '');
  if (e && !s.startsWith('"') && s.toLowerCase().startsWith(e.toLowerCase()) && (s.length === e.length || /\s/.test(s[e.length]))) {
    return [e, ...splitWindowsCommand(s.slice(e.length))];
  }
  return splitWindowsCommand(s);
}

/**
 * What the OS reveals about a process: { pid, name, exe, argv, commandLine, cwd, parents }.
 * Windows gives no working folder, so it gives the parent chain (up to 3) instead.
 */
export function processInfo(pid, { runFn = run, platform = process.platform, readFile = readFileSync, readLink = readlinkSync, depth = 4 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    const r = runFn(winProgram('powershell'), [...PS, WINDOWS_CHAIN], { env: { SHOW_LOCAL_PID: String(pid), SHOW_LOCAL_DEPTH: String(Math.max(1, Math.min(16, Math.trunc(depth) || 4))) }, timeout: 15000 });
    if (r.status !== 0) return null;
    const line = String(r.stdout).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('[') || l.startsWith('{')).pop();
    let list;
    try { list = JSON.parse(line); } catch { return null; }
    const procs = (Array.isArray(list) ? list : [list]).filter((p) => p && Number.isInteger(p.pid)).map((p) => ({
      pid: p.pid,
      name: p.name || null,
      exe: p.exe || null,
      argv: windowsArgv(p.commandLine, p.exe),
      commandLine: p.commandLine || null,
      cwd: null,
    }));
    if (!procs.length || procs[0].pid !== pid) return null;
    return { ...procs[0], parents: procs.slice(1) };
  }
  if (platform === 'linux') {
    let argv = null;
    let cwd = null;
    let name = null;
    try {
      argv = String(readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      while (argv.length && argv[argv.length - 1] === '') argv.pop();
    } catch { /* not ours to read */ }
    try { cwd = readLink(`/proc/${pid}/cwd`); } catch { /* not ours to read */ }
    try { name = String(readFile(`/proc/${pid}/comm`, 'utf8')).trim() || null; } catch { /* not ours to read */ }
    return { pid, name: name || baseName(argv?.[0]), exe: null, argv, commandLine: argv?.length ? argv.join(' ') : null, cwd, parents: [] };
  }
  // macOS (and the BSDs, which take this branch too): SIP-guarded paths on macOS.
  const psBin = platform === 'darwin' ? MAC_PROGRAMS.ps : 'ps';
  const ps = runFn(psBin, ['-o', 'command=', '-p', String(pid)]);
  const comm = runFn(psBin, ['-o', 'comm=', '-p', String(pid)]);
  const cwdOut = runFn(platform === 'darwin' ? MAC_PROGRAMS.lsof : 'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const cwd = (String(cwdOut.stdout).split('\n').find((l) => l.startsWith('n')) || '').slice(1) || null;
  const commandLine = String(ps.stdout).trim() || null;
  // `ps` joins argv with spaces, so a path with a space splits: it then simply names nothing.
  const argv = commandLine ? commandLine.split(/\s+/) : null;
  return { pid, name: baseName(String(comm.stdout).trim()) || baseName(argv?.[0]), exe: null, argv, commandLine, cwd, parents: [] };
}

/**
 * Comparable spelling of an absolute path, or null. Relative, drive-less and network paths
 * never identify a project. Case-insensitive where the file system usually is.
 */
function pathKey(p, platform) {
  if (typeof p !== 'string' || !p) return null;
  const P = platform === 'win32' ? path.win32 : path.posix;
  let s = p;
  if (platform === 'win32') {
    s = s.replace(/\//g, '\\').replace(/^\\\\\?\\(?=[a-z]:)/i, '');
    if (!/^[a-z]:\\/i.test(s)) return null;
  } else if (!s.startsWith('/')) return null;
  // normalize() folds "..", so "<root>\..\other\x.js" is not inside <root>.
  s = P.normalize(s);
  if (s.length > P.parse(s).root.length) s = s.replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;
}

// Package managers and the flag that names the project folder in the commands show-local
// itself prints (npm --prefix, pnpm --dir / -C, yarn and bun --cwd).
const PACKAGE_MANAGER = /^(npm|npx|pnpm|pnpx|yarn|yarnpkg|bun|bunx)(\.exe|\.cmd)?$|^(npm-cli|npx-cli|pnpm|yarn)\.c?js$/i;
const DIR_FLAGS = ['--prefix', '--dir', '--cwd', '-C'];

function projectDirArgs(argv) {
  if (!PACKAGE_MANAGER.test(baseName(argv[0]) || '') && !PACKAGE_MANAGER.test(baseName(argv[1]) || '')) return [];
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (DIR_FLAGS.includes(a)) out.push(argv[i + 1]);
    else {
      const flag = DIR_FLAGS.find((f) => f.startsWith('--') && a.startsWith(`${f}=`));
      if (flag) out.push(a.slice(flag.length + 1));
    }
  }
  return out;
}

/**
 * Does the process serve `root`? Only when its working folder is the project (or inside it),
 * or when its program, its script (argv[1]) or its package manager's project flag is a path
 * inside the project. On Windows its parent chain counts too. A path that merely appears
 * somewhere in the command line, or a sibling folder with the same prefix, never does.
 */
export function belongsTo(info, root, platform = process.platform) {
  if (!info || !root) return false;
  const P = platform === 'win32' ? path.win32 : path.posix;
  let real = null;
  try { real = realpathSync.native(root); } catch { /* the given spelling is all there is */ }
  const roots = [...new Set([root, real].map((r) => pathKey(r, platform)).filter(Boolean))];
  if (!roots.length) return false;
  const sep = platform === 'win32' ? '\\' : '/';
  // A drive or file-system root keeps its trailing separator, so nothing counts as under it.
  const under = (k) => roots.some((r) => k === r || (!r.endsWith(sep) && k.startsWith(`${r}${sep}`)));

  const namesRoot = (p) => {
    if (!p) return false;
    const cwdKey = pathKey(p.cwd, platform);
    if (cwdKey && under(cwdKey)) return true;
    const argv = Array.isArray(p.argv) ? p.argv
      : platform === 'win32' ? windowsArgv(p.commandLine, p.exe)
        : String(p.commandLine || '').trim().split(/\s+/).filter(Boolean);
    const candidates = [p.exe, argv[0]];
    if (argv[1] && !argv[1].startsWith('-')) candidates.push(argv[1]);
    candidates.push(...projectDirArgs(argv));
    return candidates.some((c) => {
      if (typeof c !== 'string' || !c) return false;
      // A relative path means something only next to a known working folder.
      const k = pathKey(c, platform) ?? (cwdKey && !c.startsWith('-') ? pathKey(P.resolve(p.cwd, c), platform) : null);
      return !!k && under(k);
    });
  };
  return [info, ...(Array.isArray(info.parents) ? info.parents : [])].some(namesRoot);
}
