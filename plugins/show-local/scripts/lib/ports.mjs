// Port choice for static servers: the first free port counting up from 4400 (to 4499), past
// the ports other configurations in the working folder's .claude/launch.json claim. A folder
// that already has a port keeps it while that port is free: the port of its live registry
// entry, or of its show-<slug> entry in that launch.json.
import net from 'node:net';
import { readLaunchConfigs, readLaunchEntry } from './launchjson.mjs';
import { liveEntriesFor } from './registry.mjs';
import { isNetworkPath } from './util.mjs';

export const PORT_MIN = 4400;
export const PORT_MAX = 4499;

/** Is p a port of show-local's static range? */
export const inRange = (p) => Number.isInteger(p) && p >= PORT_MIN && p <= PORT_MAX;

function canConnect(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function canListen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** Free means nobody answers on it and we can bind it (Windows lets a second socket bind a shared port). */
export async function isPortFree(port) {
  if (await canConnect(port)) return false;
  return canListen(port);
}

/**
 * The ports a folder already has, most current first, each as { port, source }: its live
 * registry entries (source "registry": the server process is still alive), then its entry
 * `name` in <cwd>/.claude/launch.json (source "launch.json"). Only ports inside the range, each
 * once. Reads files only: no port is probed, nothing is written, and a working folder on a
 * network path is not read (Windows would connect to it).
 */
export function rememberedPorts(root, { cwd, name, platform = process.platform } = {}) {
  const found = [];
  const add = (port, source) => { if (inRange(port) && !found.some((f) => f.port === port)) found.push({ port, source }); };
  for (const e of liveEntriesFor(root)) add(e.port, 'registry');
  if (cwd && name && !isNetworkPath(cwd, platform)) add(readLaunchEntry(cwd, name)?.port, 'launch.json');
  return found;
}

/**
 * The ports the other configurations in <cwd>/.claude/launch.json claim: the integer `port`
 * of every entry but the folder's own (`name`), the user's own entries and other folders'
 * show-local entries alike. A Set; empty without cwd, and a working folder on a network path
 * is not read (Windows would connect to it). Reads the file only.
 */
export function claimedPorts(cwd, { name, platform = process.platform } = {}) {
  const claimed = new Set();
  if (!cwd || isNetworkPath(cwd, platform)) return claimed;
  const own = (c) => typeof name === 'string' && name !== '' && c.name === name;
  for (const c of readLaunchConfigs(cwd)) if (!own(c) && Number.isInteger(c.port)) claimed.add(c.port);
  return claimed;
}

/**
 * The port for a new static server. The ports in `prefer` (the folder's own, see
 * rememberedPorts) are tried first, in order, and the first one that is free wins, even one
 * another configuration also names. Otherwise the first free port counting up from 4400 that
 * is not in `taken` (see claimedPorts): a new entry never shares its port with another
 * configuration. Every port is probed at most once, and a taken one only as the folder's own;
 * null when none of 4400–4499 is left. `isFree` is injectable for tests.
 */
export async function pickPort({ prefer = [], taken = [], isFree = isPortFree } = {}) {
  const tried = new Set();
  const skip = new Set(taken ?? []);
  const wanted = (Array.isArray(prefer) ? prefer : [prefer]).filter(inRange);
  for (const port of wanted) {
    if (tried.has(port)) continue;
    tried.add(port);
    if (await isFree(port)) return port;
  }
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (tried.has(port) || skip.has(port)) continue;
    tried.add(port);
    if (await isFree(port)) return port;
  }
  return null;
}
