// The static server behind serve mode. Loopback only, confined to one folder, no listing.
import http from 'node:http';
import { appendFileSync, createReadStream, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { pathKey, sha1 } from './util.mjs';

export const SERVER_HEADER = 'X-Show-Local';

/** Opaque tag that identifies which folder a server is serving, without exposing the path. */
export const rootTag = (root) => sha1(pathKey(root)).slice(0, 16);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};
export const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

const within = (root, p) => {
  const rel = path.relative(root, p);
  if (rel === '') return true;
  // "..foo" is a legitimate name inside the root; only ".." itself or "../…" leaves it.
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../');
  return !escapes && !path.isAbsolute(rel);
};

// Dotfiles and dot-folders (.env, .git, .ssh…) are never served; .well-known is the one
// convention a site may rely on.
const hidden = (segment) => segment.startsWith('.') && segment !== '.well-known';

/**
 * The last word on a file about to be served, given its fully resolved path: symlinks
 * followed and, on Windows, 8.3 short names expanded (realpathSync.native turns ENV~1 into
 * .env and GIT~1 into .git). The request may look innocent; what it reaches on disk must
 * still be inside the folder and must not be, or sit inside, a dotfile. `expanded: false`
 * means short names could not be expanded (a few virtual drives cannot answer), so on
 * Windows anything that looks like one is refused instead.
 */
export function servableReal(rootReal, real, { platform = process.platform, expanded = true } = {}) {
  if (!within(rootReal, real)) return false;
  const parts = path.relative(rootReal, real).split(/[\\/]+/).filter(Boolean);
  if (parts.some(hidden)) return false;
  if (!expanded && platform === 'win32' && parts.some((s) => /~\d/.test(s))) return false;
  return true;
}

/** Split a request-target into path and query without URL parsing: "//host/x" stays a path. */
export function splitTarget(target) {
  const s = String(target || '/');
  const q = s.indexOf('?');
  const rawPath = q === -1 ? s : s.slice(0, q);
  return { rawPath: rawPath.startsWith('/') ? rawPath : `/${rawPath}`, search: q === -1 ? '' : s.slice(q) };
}

/**
 * Map a request path onto the served folder, or refuse. Never touches the disk.
 * @returns {{ok:true, file:string} | {ok:false, status:number}}
 */
export function resolveRequestPath(rootReal, rawPathname, platform = process.platform) {
  let decoded;
  try { decoded = decodeURIComponent(rawPathname); } catch { return { ok: false, status: 400 }; }
  if (decoded.includes('\0')) return { ok: false, status: 400 };
  // Backslash is a separator on Windows; treat it as one everywhere so "..\" cannot slip through.
  const parts = decoded.split(/[\\/]+/).filter(Boolean);
  if (parts.some((s) => s === '..' || s === '.')) return { ok: false, status: 403 };
  // A first cheap pass on the request; servableReal checks what it actually reaches on disk.
  if (parts.some(hidden)) return { ok: false, status: 403 };
  if (platform === 'win32' && parts.some((s) => s.includes(':'))) return { ok: false, status: 403 };
  const file = path.join(rootReal, ...parts);
  if (!within(rootReal, file)) return { ok: false, status: 403 };
  return { ok: true, file };
}

const allowedHost = (host, port) => {
  if (!host) return false;
  const h = host.toLowerCase();
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h)
    || new RegExp(`^[a-z0-9.-]+\\.localhost:${port}$`).test(h);
};

function parseRange(header, size) {
  const m = String(header).trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

/**
 * `echo` (default true): also write each access-log line to stdout, as `serve` does. A server
 * started inside another command (oneshot) turns it off, so stdout stays one JSON object.
 */
export function createStaticServer({ root, port, logFile, platform = process.platform, echo = true }) {
  const rootReal = realpathSync(root);
  // Every file is judged by its long, fully resolved path (see servableReal), measured
  // against the root spelled the same way.
  let rootLong = rootReal;
  let expanded = true;
  try { rootLong = realpathSync.native(root); } catch { expanded = false; }
  const realOf = expanded ? realpathSync.native : realpathSync;
  /** 0 when `p` may be served, else the status to refuse it with. */
  const refusal = (p) => {
    let real;
    try { real = realOf(p); } catch { return 404; }
    return servableReal(rootLong, real, { platform, expanded }) ? 0 : 403;
  };
  const tag = rootTag(root);
  const log = (req, status) => {
    // The user agent tells the browser's request apart from show-local's own readiness probe.
    const ua = String(req.headers['user-agent'] || '').replace(/["\r\n]/g, '').slice(0, 200);
    const line = `${new Date().toISOString()} ${req.method} ${req.url} ${status} "${ua}"`;
    if (echo) process.stdout.write(`${line}\n`);
    if (logFile) { try { appendFileSync(logFile, `${line}\n`); } catch { /* logging must never break serving */ } }
  };

  const handle = (req, res) => {
    const send = (status, body = '', headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', [SERVER_HEADER]: tag, 'Cache-Control': 'no-store', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
      log(req, status);
    };

    if (!allowedHost(req.headers.host, port)) return send(403, 'Forbidden host\n');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed\n', { Allow: 'GET, HEAD' });

    const { rawPath, search } = splitTarget(req.url);
    const mapped = resolveRequestPath(rootReal, rawPath, platform);
    if (!mapped.ok) return send(mapped.status, `${mapped.status}\n`);

    let file = mapped.file;
    let st;
    try { st = statSync(file); } catch { return send(404, 'Not found\n'); }
    // Judge what the request reaches on disk before anything answers, even a redirect:
    // /ENV~1 is .env, /GIT~1 is .git, and a link may lead out of the folder or to a dotfile.
    const early = refusal(file);
    if (early) return send(early, early === 404 ? 'Not found\n' : `${early}\n`);

    if (st.isDirectory()) {
      if (!rawPath.endsWith('/')) {
        // Rebuild the location from the checked segments: always one leading slash, so it can
        // never become a protocol-relative "//host" redirect.
        const rel = path.relative(rootReal, file).split(path.sep).filter(Boolean).map(encodeURIComponent);
        return send(301, '', { Location: `/${rel.length ? `${rel.join('/')}/` : ''}${search}` });
      }
      const index = ['index.html', 'index.htm'].map((n) => path.join(file, n)).find((f) => {
        try { return statSync(f).isFile(); } catch { return false; }
      });
      if (!index) return send(404, 'Not found\n');
      file = index;
      st = statSync(file);
      // The index may itself be a link: the same final check on what is actually served.
      const refused = refusal(file);
      if (refused) return send(refused, refused === 404 ? 'Not found\n' : `${refused}\n`);
    }
    if (!st.isFile()) return send(404, 'Not found\n');

    const headers = {
      'Content-Type': mimeOf(file),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      [SERVER_HEADER]: tag,
    };
    let status = 200;
    let range = null;
    if (req.headers.range) {
      range = parseRange(req.headers.range, st.size);
      if (range?.invalid) return send(416, '', { 'Content-Range': `bytes */${st.size}` });
      if (range) {
        status = 206;
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${st.size}`;
      }
    }
    headers['Content-Length'] = range ? range.end - range.start + 1 : st.size;
    res.writeHead(status, headers);
    log(req, status);
    if (req.method === 'HEAD' || st.size === 0) { res.end(); return; }
    // pipeline, not pipe: when the client goes away mid-file, pipe leaves the file open until
    // garbage collection (on Windows that blocks deleting it); pipeline closes both ends.
    pipeline(createReadStream(file, range ? { start: range.start, end: range.end } : {}), res, (err) => { if (err) res.destroy(); });
    return undefined;
  };

  return http.createServer((req, res) => {
    // One bad request must never take the server down.
    try { handle(req, res); } catch {
      try { if (!res.headersSent) { res.writeHead(400, { [SERVER_HEADER]: tag }); } res.end(); } catch { /* socket gone */ }
      log(req, 400);
    }
  });
}

/** Start listening on 127.0.0.1 only. Resolves with the listening server. */
export function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host }, () => { server.off('error', reject); resolve(server); });
  });
}

/**
 * User agents that are never the user's browser: show-local's own requests ("show-local…"), and
 * Electron apps such as Claude's own preview pane, which may load the same page while an open
 * is being verified. Electron puts "Electron/<version>" in its user agent; the Claude desktop
 * app replaces that with "Claude/<version>", so both are recognised.
 */
export const NOT_THE_BROWSER = /show-local|Electron\/|\bClaude\//i;

/**
 * Lines of the access log at or after `sinceMs`, optionally for one path. Requests whose user
 * agent matches NOT_THE_BROWSER are never counted: they prove nothing about the browser.
 */
export function logHits(text, { sinceMs = 0, pathname = null, method = 'GET' } = {}) {
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => {
    const m = line.match(/^(\S+) (\S+) (\S+) (\d{3})(?: "([^"]*)")?$/);
    if (!m) return null;
    return { line, time: Date.parse(m[1]), method: m[2], url: m[3], status: Number(m[4]), ua: m[5] ?? '' };
  }).filter((h) => h && h.time >= sinceMs && h.method === method && !NOT_THE_BROWSER.test(h.ua)
    && (!pathname || h.url.split('?')[0] === pathname));
}
