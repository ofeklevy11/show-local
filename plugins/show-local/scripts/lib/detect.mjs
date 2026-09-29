// Decide what kind of thing we were asked to show, without side effects (reads only; on
// Windows a page or app file past MAX_PATH also runs one read-only 8.3 short-path lookup).
//
// Modes:
//   url    — http(s) address, opened in the default browser
//   file   — a self-contained HTML file, opened in the default browser as file:/// (on Windows,
//            a path past MAX_PATH through its 8.3 short form: `openPath`, `shortPath: true`)
//   serve  — HTML that needs http (modules, fetch, local data files; in the page or in a local
//            script it loads) or a folder with index.html
//   dev    — a project whose package.json has a "dev" script
//   folder — a folder of outputs, opened in the file manager with the main file selected;
//            also any file that is not a known viewable type, revealed there instead of opened
//   app    — a document, image, audio, video or text file, opened with its default application
//            (on Windows, past MAX_PATH through its 8.3 short form, as a file is)
import {
  closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortPath as shortPathOf } from './shortpath.mjs';
import { MAC_PROGRAMS, outputText, run, titleFromHtml } from './util.mjs';

export const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);

// Media types by kind. All of them are viewable, and a folder of outputs ranks them (pickMainFile).
// Never .ts (TypeScript far more often than an MPEG transport stream) or .mod (Go's go.mod):
// both would open source code in a video player.
const VIDEO_EXT = [
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.mpg', '.mpeg', '.flv', '.3gp', '.3g2', '.mts', '.m2ts', '.ogv',
  '.mxf', '.vob', '.f4v', '.dv', '.divx', '.asf', '.m2v',
];
// Camera RAW files (DNG, Canon, Nikon, Sony, Olympus, Panasonic, Fujifilm) are photos too.
const IMAGE_EXT = [
  '.png', '.jpg', '.jpeg', '.jpe', '.jfif', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff', '.ico', '.heic', '.heif',
  '.jxl', '.svg', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf',
];
const AUDIO_EXT = [
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.oga', '.aac', '.opus', '.wma', '.aiff', '.aif', '.aifc', '.weba', '.amr',
  '.mid', '.midi', '.mka',
];

// The only files handed to their default app: types whose app displays them. Whatever handles
// any other type (scripts, programs, installers, shortcuts, disk images, unknown types, no
// extension at all) may run it, so those are revealed in their folder instead.
export const VIEWABLE_EXT = new Set([
  '.pdf',
  ...IMAGE_EXT,
  ...VIDEO_EXT,
  ...AUDIO_EXT,
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.log', '.srt', '.vtt',
  '.docx', '.xlsx', '.pptx', '.epub', '.xps',
]);

// Documents that can carry macros (the old binary Office formats, the macro-enabled Office
// formats, OpenDocument), and RTF, which can embed objects that Office loads as the file opens.
// Office and LibreOffice block macros by default; show-local does not rely on that, and shows
// these in their folder instead. The macro-free .docx, .xlsx and .pptx still open.
export const MACRO_EXT = new Set([
  '.doc', '.dot', '.docm', '.dotm', '.xls', '.xlt', '.xla', '.xlsm', '.xltm', '.xlsb', '.xlam',
  '.ppt', '.pot', '.pps', '.ppa', '.pptm', '.potm', '.ppsm', '.ppam', '.sldm',
  '.odt', '.ott', '.ods', '.ots', '.odp', '.otp', '.odg', '.otg', '.odb', '.fodt', '.fods', '.fodp', '.fodg',
  '.rtf',
]);

/** The characters cmd.exe treats specially even inside quotes (or that end a quoted argument). */
const CMD_SPECIAL = /[&%^|<>!"]/;

/**
 * A Windows path that cmd.exe would mangle on a command line: & | < > end or redirect the
 * command, % and ! expand variables, ^ escapes, and " ends the quoting. Callers use it to
 * warn; nothing here refuses such a path.
 */
export const cmdUnsafe = (p) => CMD_SPECIAL.test(String(p ?? ''));

// Files known to run when opened (programs, scripts, shortcuts, installers, launchers). Kept
// for callers and for a precise reason; VIEWABLE_EXT alone decides what may be opened.
export const RUNNABLE_EXT = new Set([
  '.exe', '.com', '.msi', '.msp', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.hta', '.scr', '.pif', '.cpl', '.lnk', '.url', '.reg', '.jar', '.appref-ms', '.application', '.gadget',
  '.msc', '.inf', '.sh', '.command', '.tool', '.app', '.pkg', '.dmg', '.appimage', '.run', '.desktop', '.deb', '.rpm',
  '.py', '.pyw', '.pyz', '.pyzw', '.mjs', '.cjs', '.pl', '.rb', '.php', '.ahk', '.au3', '.wsc', '.sct', '.scf',
  '.xll', '.chm', '.jnlp', '.settingcontent-ms', '.diagcab', '.appx', '.appxbundle', '.msix', '.msixbundle',
  '.appinstaller', '.terminal', '.workflow', '.fileloc', '.mpkg',
]);

const MAX_HTML_SCAN = 2 * 1024 * 1024;

/**
 * Longest path Chrome opened as file:/// on Windows 11 in a measurement: 256 characters opened,
 * 260 did not (MAX_PATH). A longer path opens through its 8.3 short form when that fits, and
 * is served only when there is none.
 */
export const WINDOWS_LONG_PATH = 256;

/** How far above a served page's folder to look for the site's index.html. */
export const MAX_SITE_LEVELS = 3;

// Constructs that fail or behave differently under file://, with the reason we report. The
// third field marks what can also sit in a separate script file the page loads. A tag's
// attributes are [^<>]*: a tag that never closes ends at the next "<", so a page of unclosed
// tags is scanned once instead of once per "<" (2 MB of "<script " took minutes).
const NEEDS_HTTP = [
  [/<script\b[^<>]*\btype\s*=\s*["']?module\b/i, 'ES module script (blocked under file://)', false],
  [/\bimport\s*\(\s*["'`]/, 'dynamic import()', true],
  [/\bfetch\s*\(/, 'fetch() call', true],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest', true],
  [/\bnew\s+(Shared)?Worker\s*\(/, 'Web Worker', true],
  [/\bserviceWorker\b/, 'service worker', true],
  [/<link\b[^<>]*\brel\s*=\s*["']?manifest\b/i, 'web app manifest', false],
  [/<script\b[^<>]*\btype\s*=\s*["']?importmap\b/i, 'import map', false],
];

/** At most this many local script files are read per page, and at most this much of each. */
export const MAX_LOCAL_SCRIPTS = 10;
export const MAX_SCRIPT_SCAN = 512 * 1024;

// Windows device names: "con.js" in any folder can name the console, not a file.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

const attrOf = (attrs, name) => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};

/**
 * The page's classic scripts that are local files in its own folder or below: <script src>
 * with a relative address, in page order, each once, at most MAX_LOCAL_SCRIPTS. Addresses with
 * a scheme, "//host" or "/root" forms, ".." segments or drive letters are skipped, and so is
 * every script when the page sets a <base href> (it changes what relative addresses mean).
 * Pure: the disk is not touched.
 */
export function localScripts(html, dir, platform = process.platform) {
  const text = String(html ?? '');
  if (/<base\b[^<>]*\bhref\s*=/i.test(text)) return [];
  const out = [];
  for (const m of text.matchAll(/<script\b([^<>]*)>/gi)) {
    if (out.length >= MAX_LOCAL_SCRIPTS) break;
    const attrs = m[1];
    const type = attrOf(attrs, 'type');
    if (type !== null && type.trim() && !/^(module|(text|application)\/(x-)?(java|ecma)script)$/i.test(type.trim())) continue;
    let src = attrOf(attrs, 'src');
    if (src === null) continue;
    src = src.trim().replace(/&amp;/gi, '&').replace(/[?#].*$/s, '');
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || /^[\\/]/.test(src)) continue;
    try { src = decodeURIComponent(src); } catch { continue; }
    const parts = src.split(/[\\/]+/).filter((s) => s && s !== '.');
    if (!parts.length || parts.some((s) => s === '..' || s.includes('\0'))) continue;
    if (platform === 'win32' && parts.some((s) => s.includes(':') || WINDOWS_DEVICE.test(s))) continue;
    const file = path.join(dir, ...parts);
    if (!inside(dir, file) || out.includes(file)) continue;
    out.push(file);
  }
  return out;
}

/**
 * The first `cap` bytes of a regular local file, or null (missing, not a file, behind a network
 * link). A folder, a FIFO or a device (a link to /dev/zero) is never opened: one would block,
 * the other never ends.
 */
function readHead(file, platform, cap) {
  try {
    if (platform === 'win32' && networkLinkOn(file)) return null;
    const st = statSync(file);
    if (!st.isFile()) return null;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, cap));
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n);
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** The first MAX_SCRIPT_SCAN bytes of a regular local file as text, or null (see readHead). */
function readScript(file, platform) {
  const buf = readHead(file, platform, MAX_SCRIPT_SCAN);
  return buf === null ? null : buf.toString('utf8');
}

// ---------------------------------------------------------------------------------------------
// Local data a page loads through a library or its own code (d3.csv, $.getJSON, a glTF loader,
// <model-viewer src>): under file:// the browser refuses those requests.

/** Data file types a page loads at run time rather than displays. */
export const DATA_EXT = ['json', 'csv', 'tsv', 'xml', 'geojson', 'topojson', 'txt', 'wasm', 'glb', 'gltf'];
const DATA_FILE = new RegExp(`\\.(?:${DATA_EXT.join('|')})$`, 'i');
const DATA_HINT = new RegExp(`\\.(?:${DATA_EXT.join('|')})`, 'i');
// A quoted string that is nothing but the address of a data file, query and fragment allowed.
const QUOTED_DATA = new RegExp(`(["'\`])([^"'\`\\r\\n<>]{1,260}?\\.(?:${DATA_EXT.join('|')})(?:[?#][^"'\`\\r\\n]{0,500})?)\\1`, 'gi');
// Library calls that request their first string argument (after an optional first string such
// as d3.dsv's delimiter or vegaEmbed's selector): d3, jQuery, axios, and any loader's .load().
const DATA_CALL = new RegExp([
  '(?:\\bd3\\s*\\.\\s*(?:json|csv|tsv|dsv|xml|text|html|buffer|blob)',
  '|(?:\\$|\\bjQuery)\\s*\\.\\s*(?:getJSON|getScript|get|post|ajax)',
  '|\\baxios(?:\\s*\\.\\s*(?:get|post|request))?',
  '|\\bvegaEmbed',
  '|\\.\\s*load(?:Async)?)',
  '\\s*\\(\\s*(?:(["\'`])[^"\'`\\r\\n]{0,200}\\1\\s*,\\s*)?(["\'`])([^"\'`\\r\\n]{1,300})\\2',
].join(''), 'g');

/** Attributes through which the browser itself loads or links a file (it manages under file://). */
const NATIVE_URL_ATTR = new Set([
  'href', 'src', 'srcset', 'data', 'poster', 'action', 'formaction', 'cite', 'background', 'longdesc',
  'manifest', 'codebase', 'archive', 'usemap', 'ping', 'xlink:href', 'imagesrcset',
]);
const JS_TYPE = /^(module|(text|application)\/(x-)?(java|ecma)script|text\/(babel|jsx))$/i;

/** At most this many data addresses are looked up on disk per page (its scripts included). */
export const MAX_DATA_CHECKS = 64;

/**
 * A page split into its markup (comments and the bodies of <script> and <style> left out)
 * and its scripts ([attributes of the opening tag, body]). indexOf only, so a page full of
 * unclosed tags or comments costs one pass, never a rescan per "<".
 */
function splitPage(html) {
  const text = String(html ?? '');
  // ASCII only, as HTML compares tag names: toLowerCase() turns "İ" into two code units, and
  // every index below must mean the same place in `text` and in `lower`.
  const lower = text.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  const markup = [];
  const scripts = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { markup.push(text.slice(i)); break; }
    markup.push(text.slice(i, lt));
    if (lower.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) break; // an unclosed comment hides the rest of the page
      i = end + 3;
      continue;
    }
    const raw = /^<(script|style)(?=[\s/>])/.exec(lower.slice(lt, lt + 8));
    if (!raw) { markup.push('<'); i = lt + 1; continue; }
    const gt = text.indexOf('>', lt);
    if (gt < 0) { markup.push(text.slice(lt)); break; }
    markup.push(text.slice(lt, gt + 1));
    const close = lower.indexOf(`</${raw[1]}`, gt + 1);
    if (raw[1] === 'script') scripts.push([text.slice(lt + 7, gt), text.slice(gt + 1, close < 0 ? text.length : close)]);
    if (close < 0) break;
    const closeEnd = text.indexOf('>', close);
    i = closeEnd < 0 ? text.length : closeEnd + 1;
  }
  return { markup: markup.join(''), scripts };
}

// HTML's own whitespace (tab, LF, FF, CR, space), by char code.
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/** The name="value" pairs of a tag's attribute text, names lower-cased; a hand-written scan, linear. */
function attributes(s) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(s.charCodeAt(i)) || s.charCodeAt(i) === 47)) i += 1; // and "/"
    const start = i;
    while (i < n && !isSpace(s.charCodeAt(i)) && s.charCodeAt(i) !== 61 && s.charCodeAt(i) !== 47) i += 1; // "=", "/"
    const name = s.slice(start, i);
    if (!name) { i += 1; continue; }
    while (i < n && isSpace(s.charCodeAt(i))) i += 1;
    if (s[i] !== '=') continue;
    i += 1;
    while (i < n && isSpace(s.charCodeAt(i))) i += 1;
    let value;
    if (s[i] === '"' || s[i] === "'") {
      const end = s.indexOf(s[i], i + 1);
      value = s.slice(i + 1, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
    } else {
      const from = i;
      while (i < n && !isSpace(s.charCodeAt(i))) i += 1;
      value = s.slice(from, i);
    }
    out.push([name.toLowerCase(), value]);
  }
  return out;
}

/**
 * Where a page can name the data it loads: `code` (inline scripts and on* handlers) and
 * `values` (attribute values the browser does not load by itself: data-*, a custom element's
 * src such as <model-viewer src="scene.glb">, <option value="2020.csv">). A link, an image or
 * an iframe works under file://, so href/src/data on a standard element do not count.
 */
function pageParts(html) {
  const { markup, scripts } = splitPage(html);
  const code = [];
  const values = [];
  for (const [attrs, body] of scripts) {
    const type = attrOf(attrs, 'type');
    if (type === null || !type.trim() || JS_TYPE.test(type.trim())) code.push(body);
  }
  // [^<>]: a tag that never closes ends at the next "<". The lookahead keeps the name from
  // giving characters back to the attributes, which would retry every split of a long name
  // ("<eyJ…" and a token) and cost the square of its length. So the scan stays linear.
  for (const m of markup.matchAll(/<([a-z][\w:.-]*)(?![\w:.-])([^<>]*)>/gi)) {
    const custom = m[1].includes('-');
    for (const [name, raw] of attributes(m[2])) {
      const value = raw.replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
      if (name.startsWith('on')) code.push(value);
      else if (custom || !NATIVE_URL_ATTR.has(name)) values.push(value);
    }
  }
  return { code, values };
}

/** The segments of a relative address ("./data/a b.json?v=2" → ["data", "a b.json"]), or null. */
function relativeParts(ref, platform) {
  let r = String(ref ?? '').trim().replace(/&amp;/gi, '&').replace(/[?#].*$/s, '');
  // Schemes (http:, data:, blob:), "//host", "/root" and template placeholders are not local files.
  if (!r || /^[a-z][a-z0-9+.-]*:/i.test(r) || /^[\\/]/.test(r) || r.includes('${')) return null;
  try { r = decodeURIComponent(r); } catch { return null; }
  const parts = r.split(/[\\/]+/).filter((s) => s && s !== '.');
  if (!parts.length || parts.some((s) => s.includes('\0'))) return null;
  if (platform === 'win32' && parts.some((s) => s.includes(':') || WINDOWS_DEVICE.test(s))) return null;
  return parts;
}

// Folders where macOS and Linux mount network shares on first access.
const AUTOMOUNT = /^\/(?:System\/Volumes\/Data\/)?(?:net|network|automount|misc|smb|nfs)(?:\/|$)/i;

/**
 * Does p, or a link on the way to it, lead into an automounted network folder? Each link is
 * read (never followed) and each spelling is checked before anything looks it up, since a
 * lookup inside such a folder is what makes the machine connect.
 */
function leadsIntoAutomount(p) {
  let { root } = path.parse(p);
  let parts = p.slice(root.length).split('/').filter(Boolean);
  let cur = root;
  let hops = 0;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(cur, parts[i]);
    if (AUTOMOUNT.test(next)) return true;
    let st;
    try { st = lstatSync(next); } catch { return false; }
    if (!st.isSymbolicLink()) { cur = next; continue; }
    if (++hops > 32) return true;
    let target;
    try { target = readlinkSync(next); } catch { return true; }
    const resolved = path.resolve(cur, target);
    if (AUTOMOUNT.test(resolved)) return true;
    root = path.parse(resolved).root;
    parts = [...resolved.slice(root.length).split('/').filter(Boolean), ...parts.slice(i + 1)];
    cur = root;
    i = -1;
  }
  return false;
}

/** file is at most MAX_SITE_LEVELS folders above dir's level (the farthest a site root is looked for). */
function withinSiteReach(dir, file) {
  const rel = path.relative(dir, file).split(/[\\/]+/);
  let up = 0;
  while (rel[up] === '..') up++;
  return up <= MAX_SITE_LEVELS && !path.isAbsolute(path.relative(dir, file));
}

/** The address a library call requests, when it is a relative path ("data/x.csv", "part.html"). */
function dataCalls(js) {
  const out = [];
  for (const m of String(js).matchAll(DATA_CALL)) {
    // Nothing is looked up on disk here, so no platform rules apply.
    const parts = relativeParts(m[3], 'linux');
    // A path has a folder or an extension: '12px Roboto' (document.fonts.load) is not one.
    if (parts && (parts.length > 1 || /\.[a-z0-9]{1,8}$/i.test(parts[0]))) out.push(parts.join('/'));
  }
  return out;
}

const quotedData = (s) => [...String(s).matchAll(QUOTED_DATA)].map((m) => m[2]);

/**
 * The local data a piece of a page loads, as it names it: every library call on a relative
 * path, and every quoted relative address of a data file (DATA_EXT) that exists, resolved
 * against the page's folder the way the browser resolves it. Without `dir` nothing is looked
 * up on disk, so only library calls count. `seen` spans the page and its scripts, and `budget`
 * caps the lookups.
 */
function dataNames({ code, values }, { dir, platform, seen, budget }) {
  const out = [];
  const add = (name) => { if (!seen.has(name)) { seen.add(name); out.push(name); } };
  for (const js of code) for (const name of dataCalls(js)) add(name);
  if (!dir) return out;
  const refs = [
    ...values.filter((v) => DATA_HINT.test(v)).flatMap((v) => [v, ...quotedData(v)]),
    ...code.flatMap(quotedData),
  ];
  for (const ref of refs) {
    const parts = relativeParts(ref, platform);
    if (!parts || !DATA_FILE.test(parts[parts.length - 1])) continue;
    const name = parts.join('/');
    if (seen.has(name)) continue;
    if (budget.left-- <= 0) break;
    const file = path.resolve(dir, ...parts);
    // A ref that climbs past where a site root could be, or into an automounted network folder
    // (/net and friends on macOS and Linux), is not looked at: a stat there can reach another machine.
    if (!withinSiteReach(dir, file) || (platform !== 'win32' && leadsIntoAutomount(file))) continue;
    try {
      if (platform === 'win32' && networkLinkOn(file)) continue;
      if (statSync(file).isFile()) add(name);
    } catch { /* missing: nothing to load */ }
  }
  return out;
}

// Names read out of a page are the page's text: each is cut short and cleaned (outputText).
const listNames = (names) => {
  const shown = names.slice(0, 3).map((n) => outputText(n, 80));
  return names.length <= 3 ? shown.join(', ') : `${shown.join(', ')} and ${names.length - 3} more`;
};
const dataReason = (names, script) => `loads local data (${listNames(names)})${script ? ` in ${script}` : ''} — file:// would block it`;

/**
 * Why a page needs http. The page's own text is always checked. With `dir` (the page's
 * folder), the local script files it loads are read as well (see localScripts), so a page
 * whose app.js calls fetch() is served too, and quoted addresses of data files next to the
 * page are looked up (see dataNames). Each reason is reported once, the first place it is
 * found.
 */
export function needsServer(html, { dir = null, platform = process.platform } = {}) {
  const reasons = [];
  for (const [re, why] of NEEDS_HTTP) if (re.test(html)) reasons.push(why);
  const seen = new Set();
  const budget = { left: MAX_DATA_CHECKS };
  const pageData = dataNames(pageParts(html), { dir, platform, seen, budget });
  if (pageData.length) reasons.push(dataReason(pageData));
  if (dir) {
    const found = new Set(reasons);
    for (const file of localScripts(html, dir, platform)) {
      const js = readScript(file, platform);
      if (js === null) continue;
      const name = path.relative(dir, file).split(path.sep).join('/');
      for (const [re, why, inJs] of NEEDS_HTTP) {
        if (!inJs || found.has(why) || !re.test(js)) continue;
        found.add(why);
        reasons.push(`${why} in ${name}`);
      }
      const data = dataNames({ code: [js], values: [] }, { dir, platform, seen, budget });
      if (data.length) reasons.push(dataReason(data, name));
    }
  }
  return { needed: reasons.length > 0, reasons };
}

const MEDIA_RANK = [[...HTML_EXT], VIDEO_EXT, ['.pdf'], IMAGE_EXT, AUDIO_EXT];
const rankOf = (name) => {
  const ext = path.extname(name).toLowerCase();
  const i = MEDIA_RANK.findIndex((group) => group.includes(ext));
  return i === -1 ? MEDIA_RANK.length : i;
};

/** The file to select in a folder of outputs: newest, preferring viewable types. */
export function pickMainFile(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith('.') && !/^(thumbs\.db|desktop\.ini)$/i.test(d.name));
  } catch { return null; }
  if (!entries.length) return null;
  const scored = entries.map((d) => {
    let mtime = 0;
    try { mtime = statSync(path.join(dir, d.name)).mtimeMs; } catch { /* unreadable: rank last */ }
    return { name: d.name, rank: rankOf(d.name), mtime };
  });
  scored.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime || a.name.localeCompare(b.name));
  return path.join(dir, scored[0].name);
}

// [package name, the command it installs, default dev port]. Order matters for dependencies
// only: meta-frameworks come before the tools they are built on (SvelteKit before Vite).
const FRAMEWORKS = [
  ['next', 'next', 3000], ['nuxt', 'nuxt', 3000], ['nuxt', 'nuxi', 3000], ['astro', 'astro', 4321],
  ['@sveltejs/kit', 'svelte-kit', 5173], ['vite', 'vite', 5173], ['gatsby', 'gatsby', 8000], ['parcel', 'parcel', 1234],
  ['webpack-dev-server', 'webpack-dev-server', 8080], ['webpack-dev-server', 'webpack', 8080],
  ['@11ty/eleventy', 'eleventy', 8080], ['@11ty/eleventy', '@11ty/eleventy', 8080], ['react-scripts', 'react-scripts', 3000],
  ['@angular/cli', 'ng', 4200],
];

// Commands whose subcommand changes the port, recognised in the script only (never from a
// dependency): [package name, command and subcommand, port, the object of the config file its
// port sits in, when not PORT_CONFIG's]. `vite preview` serves the build on Vite's preview port
// and reads preview.port, never server.port; `remix vite:dev` is Vite's own dev server.
const SUBCOMMANDS = [
  ['vite', 'vite preview', 4173, 'preview'],
  ['vite', 'remix vite:dev', 5173, null],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/@]/g, (c) => `\\${c}`);

/** The framework a dev script runs: the command in the script first, else a dependency. */
function runnerOf(s, pkg) {
  // The command the script actually runs wins over whatever else is installed. A `build`
  // serves nothing, so in `vite build && vite preview` the preview decides.
  let first = null;
  const find = (word, runner) => {
    const re = `(^|[\\s/&;|(])${escapeRe(word).replace(/ /g, '\\s+')}(?=\\s|$|[;&|)])(?!\\s+build(?:\\s|$|[;&|)]))`;
    const m = s.match(new RegExp(re));
    if (m && (first === null || m.index < first.index)) first = { index: m.index, runner };
  };
  // Subcommands first: on the same word ("vite" in "vite preview") the more specific one wins.
  for (const [name, cmd, port, where] of SUBCOMMANDS) find(cmd, { name, port, ...(where ? { in: where } : {}) });
  for (const [name, cmd, port] of FRAMEWORKS) {
    // The command it installs ("svelte-kit", "nuxi") or the package name itself ("npx @11ty/eleventy").
    for (const word of new Set([cmd, name].filter(Boolean))) find(word, { name, port });
  }
  if (first) return first.runner;
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  for (const [name, , port] of FRAMEWORKS) {
    if (deps[name]) return { name, port };
  }
  return null;
}

// The config file each framework reads its dev port from (the first that exists, in the
// framework's own lookup order), and where in it: `in` is the object the port sits in
// directly (server: { port }), `under` an object anywhere above it (angular.json's serve target).
const VITE_CONFIG = { files: ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts'], in: 'server' };
const PORT_CONFIG = {
  vite: VITE_CONFIG,
  '@sveltejs/kit': VITE_CONFIG,
  astro: { files: ['astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'astro.config.mts', 'astro.config.cjs', 'astro.config.cts'], in: 'server' },
  nuxt: { files: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts', 'nuxt.config.cjs', 'nuxt.config.cts'], in: 'devServer' },
  'webpack-dev-server': { files: ['webpack.config.js', 'webpack.config.cjs', 'webpack.config.mjs', 'webpack.config.ts'], in: 'devServer' },
  '@angular/cli': { files: ['angular.json'], under: 'serve' },
};

// Where a runner that takes its port from the environment looks: `keys`, the variables it
// reads (the first with a value wins), and `files`, the .env files it loads, most specific
// first. A variable the runner inherits beats every file, and the first file that sets a
// variable decides it, even to nothing: dotenv never overrides a variable that is set.
//   react-scripts: PORT, from the four files Create React App loads in development.
//   nuxi: NUXT_PORT, then NITRO_PORT, then PORT, from .env only (c12's default file).
//   next dev: PORT from what it inherits; it loads its .env files after it has its port.
// A runner show-local does not know (a custom server with dotenv) is read like react-scripts.
// Vite, Astro, SvelteKit and the rest take their port from their flag or config only, so a
// PORT meant for the project's API server must not move their address.
const ENV_FILES = ['.env.development.local', '.env.local', '.env.development', '.env'];
const ENV_PORT = {
  'react-scripts': { keys: ['PORT'], files: ENV_FILES },
  nuxt: { keys: ['NUXT_PORT', 'NITRO_PORT', 'PORT'], files: ['.env'] },
  next: { keys: ['PORT'], files: [] },
};
const UNKNOWN_RUNNER_ENV = { keys: ['PORT'], files: ENV_FILES };

const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * JavaScript, TypeScript or JSON reduced to the tokens that matter for finding properties:
 * comments dropped, strings and template literals kept as { t: 'str', v }, regular
 * expressions as { t: 're' }. A scan, not a parser; config files are what it is for.
 */
function jsTokens(code) {
  const s = String(code);
  const out = [];
  const ID = /[A-Za-z_$][\w$]*/y;
  const NUM = /(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+)n?/iy;
  const PUNCT = /=>|\.\.\.|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|[^\s\w$]/y;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let v = '';
      while (j < s.length && s[j] !== c && (c === '`' || s[j] !== '\n')) {
        if (s[j] === '\\') { v += s[j + 1] ?? ''; j += 2; } else { v += s[j]; j += 1; }
      }
      out.push({ t: 'str', v, q: c });
      i = j + 1;
      continue;
    }
    if (c === '/') {
      const p = out[out.length - 1];
      const startsRegex = !p || (p.t === 'punct' && !/^[)\]}]$/.test(p.v))
        || (p.t === 'id' && /^(return|typeof|case|in|of|new|delete|void|throw|yield|await|else)$/.test(p.v));
      if (startsRegex) {
        let j = i + 1;
        let cls = false;
        while (j < s.length && s[j] !== '\n' && (cls || s[j] !== '/')) {
          if (s[j] === '\\') j += 1;
          else if (s[j] === '[') cls = true;
          else if (s[j] === ']') cls = false;
          j += 1;
        }
        j += 1;
        while (j < s.length && /[a-z]/i.test(s[j])) j += 1;
        out.push({ t: 're' });
        i = j;
        continue;
      }
    }
    const before = i;
    for (const [re, t] of [[ID, 'id'], [NUM, 'num'], [PUNCT, 'punct']]) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (m) { out.push({ t, v: m[0] }); i += m[0].length; break; }
    }
    if (i === before) i += 1; // never stall on a character none of them takes
  }
  return out;
}

const tokenText = (tk) => (tk.t === 'str' ? `${tk.q}${tk.v}${tk.q}` : tk.t === 're' ? '/…/' : tk.v);

/** Objects nested deeper than this are not read (real configs nest about ten deep). */
export const MAX_CONFIG_DEPTH = 64;

/**
 * Every `port` property in a config file, with the names of the objects around it, innermost
 * last: `server: { port: 3000 }` → { path: ['server'], port: 3000 }. An object is named after
 * the property whose value it is, through calls, arrow functions and `return`
 * (`server: () => ({ port })`), or at top level after the variable it is assigned to
 * (`const server = { … }`, not `const server = f({ … })`); an anonymous one is null. `port` is
 * the literal number, or null with the expression in `text` (process.env.PORT, a variable, a
 * ternary). `aliases` maps a property to the variable it is set to, with the path of the
 * object it is in (`server: serverOptions` → ['server', 'serverOptions', [null]]). Past
 * MAX_CONFIG_DEPTH it stops and says `tooDeep`: each path is a copy of the nesting, so an
 * unbounded one costs depth × ports.
 */
export function portProperties(code) {
  const tk = jsTokens(code);
  const root = { root: true, key: null };
  const stack = [root];
  const ports = [];
  const aliases = [];
  const names = () => stack.slice(1).map((f) => f.name);
  // A property of object frame f ends at token i: record it when it is `port` (or an alias).
  // Only a single-token value is looked at, so nested objects are never sliced again.
  const endProp = (f, i) => {
    const one = f.key !== null && i - f.valStart === 1 ? tk[f.valStart] : null;
    if (f.key === 'port') {
      const lit = one?.t === 'num' && /^\d+$/.test(one.v) ? Number(one.v) : null;
      const text = clip(tk.slice(f.valStart, Math.min(i, f.valStart + 30)).map(tokenText).join(' '));
      ports.push({ path: names(), port: validPort(lit) ? lit : null, text });
    } else if (one?.t === 'id') {
      aliases.push([f.key, one.v, names()]);
    } else if (f.key === null && i - f.propStart === 1 && tk[f.propStart].t === 'id' && tk[f.propStart].v === 'port') {
      ports.push({ path: names(), port: null, text: 'port' }); // shorthand { port }
    }
  };
  for (let i = 0; i < tk.length; i++) {
    const { t, v } = tk[i];
    const top = stack[stack.length - 1];
    if (t === 'punct' && v === '{') {
      if (stack.length > MAX_CONFIG_DEPTH) return { ports: [], aliases: [], tooDeep: true };
      const prev = tk[i - 1];
      // At top level only `x = {` names the object: in `x = f({`, it is what f is given.
      let name = top.root && !(prev?.t === 'punct' && prev.v === '=') ? null : top.key;
      if (prev?.t === 'id' && prev.v === 'return') name = top.root ? null : top.name;
      stack.push({ name: name ?? null, key: null, valStart: -1, propStart: i + 1, nest: 0 });
    } else if (t === 'punct' && v === '}') {
      if (top.root) continue;
      endProp(top, i);
      stack.pop();
    } else if (top.root) {
      // Top level: `const server = {…}` names the object after the variable.
      if (t === 'punct' && v === '=' && tk[i - 1]?.t === 'id') top.key = tk[i - 1].v;
      else if ((t === 'punct' && v === ';') || (t === 'id' && /^(export|const|let|var|function|return|import|module)$/.test(v))) top.key = null;
    } else if (t === 'punct' && (v === '(' || v === '[')) {
      top.nest += 1;
    } else if (t === 'punct' && (v === ')' || v === ']')) {
      if (top.nest > 0) top.nest -= 1;
    } else if (top.nest === 0 && t === 'punct' && v === ',') {
      endProp(top, i);
      top.key = null;
      top.valStart = -1;
      top.propStart = i + 1;
    } else if (top.nest === 0 && top.key === null && t === 'punct' && v === ':') {
      const k = tk[i - 1];
      top.key = i - top.propStart === 1 && ['id', 'str', 'num'].includes(k.t) ? k.v : '';
      top.valStart = i + 1;
    }
  }
  return { ports, aliases };
}

/** An expression's tokens as code is written: "Number ( process . env . PORT )" → Number(process.env.PORT). */
const tidyExpr = (text) => String(text)
  .replace(/\s*(\?\.|\.)\s*/g, '$1')
  .replace(/([\w$])\s+\(/g, '$1(')
  .replace(/\(\s+/g, '(')
  .replace(/\s+\)/g, ')');

/**
 * What a config file says about the dev port: null when it names none, { port } when it
 * names one literal port, { note } when it names a port that is not a literal number (or
 * several different ones): then the port is unknown, never the framework default.
 */
function configPort(code, where) {
  const { ports, aliases, tooDeep } = portProperties(code);
  if (tooDeep) return { note: `nests objects more than ${MAX_CONFIG_DEPTH} deep, too deep to read` };
  let mine;
  if (where.in) {
    // Only the config's own `server` (or devServer): a property of a top-level object, with no
    // named object in between, so a plugin's options (`plugins: [p({ server })]`) and another
    // tool's settings (`vite: { server }`) do not count. Or a top-level variable the config
    // names there (`server: serverOptions`).
    const own = (names) => names.every((n) => n === null);
    const vars = new Set(aliases.filter(([k, , at]) => k === where.in && own(at.slice(1))).map(([, v]) => v));
    mine = ports.filter(({ path: at }) => (at[at.length - 1] === where.in && own(at.slice(1, -1)))
      || (at.length === 1 && vars.has(at[0])));
  } else {
    mine = ports.filter((p) => p.path.includes(where.under));
  }
  if (!mine.length) return null;
  const expr = mine.find((p) => p.port === null);
  if (expr) return { note: `sets the port to ${tidyExpr(expr.text)}, not a literal number` };
  const distinct = [...new Set(mine.map((p) => p.port))];
  if (distinct.length > 1) return { note: `names several ports (${distinct.join(', ')})` };
  return { port: distinct[0] };
}

/** A .env value as dotenv reads it: the quotes taken off, or unquoted up to a " #" comment. */
function dotenvValue(raw) {
  const value = raw.trim();
  const quoted = /^(["'`])(.*?)\1/.exec(value);
  if (quoted) return quoted[2];
  // A search, not .replace(/\s+#.*$/): that retried from every space of a long run of them.
  const hash = value.search(/\s#/);
  return (hash < 0 ? value : value.slice(0, hash)).trim();
}

/** A port variable's value: { port, source, key, file } for a literal port, else { note }. */
function portValue(key, value, file) {
  const n = /^\d+$/.test(value) ? Number(value) : null;
  if (validPort(n)) return { port: n, source: file ? `env:${file}` : `env:${key}`, key, file };
  return { note: file ? `${file} sets ${key} to "${clip(value)}", not a literal number` : `${key} in the environment is "${clip(value)}", not a literal number` };
}

/**
 * What a runner's environment says about its port (spec: see ENV_PORT). Each variable is what
 * the runner inherits (`env`), else what the first of its .env files in `dir` that sets it
 * says. `any` is the first variable with a value, `inherited` the first one it inherits with
 * a value; each is a portValue or null. An empty value is no port: the runner then uses its
 * config or its default, and an empty PORT= still hides the less specific files.
 */
function envPort(dir, platform, { keys, files }, env) {
  const values = new Map(); // each variable's { value, file }
  for (const key of keys) if (typeof env?.[key] === 'string') values.set(key, { value: env[key].trim() });
  for (const file of dir ? files : []) {
    if (values.size === keys.length) break;
    const text = readScript(path.join(dir, file), platform);
    if (text === null) continue;
    const set = new Map();
    for (const line of text.split(/\r\n?|\n/)) {
      const m = /^\s*(?:export\s+)?([\w.-]+)\s*=(.*)$/.exec(line);
      if (m && keys.includes(m[1])) set.set(m[1], m[2]); // the last assignment in a file wins, as in dotenv
    }
    for (const [key, raw] of set) if (!values.has(key)) values.set(key, { value: dotenvValue(raw), file });
  }
  const first = (from) => {
    const key = keys.find((k) => values.get(k)?.value && from(values.get(k)));
    return key ? portValue(key, values.get(key).value, values.get(key).file) : null;
  };
  return { any: first(() => true), inherited: first((v) => !v.file) };
}

/** What the runner's config file says about the port (PORT_CONFIG): { port, source, file }, { note }, or null. */
function configFilePort(dir, runner, platform) {
  const spec = runner && PORT_CONFIG[runner.name];
  if (!spec) return null;
  // A subcommand reads another object of the same file (`vite preview`: preview.port).
  const where = runner.in ? { ...spec, in: runner.in } : spec;
  const file = where.files.find((f) => { try { return statSync(path.join(dir, f)).isFile(); } catch { return false; } });
  if (!file) return null;
  const code = readScript(path.join(dir, file), platform);
  const c = code === null ? null : configPort(code.replace(/^\uFEFF/, ''), where);
  if (!c) return null;
  return c.note ? { note: `${file} ${c.note}` } : { port: c.port, source: `config:${file}`, file };
}

/**
 * The port the project's own settings give its runner, before any framework default: the
 * environment it inherits and its .env files, for the runners that read them (ENV_PORT), and
 * its config file (PORT_CONFIG, with `dir`). An inherited variable beats the config file. A
 * .env value counts only when nothing inherited and no config says otherwise: nuxi 3.15 took
 * its .env over both, later versions read .env only for the default, so then it is unknown.
 */
function projectPort(dir, runner, platform, env) {
  const unknown = (note) => ({ port: null, source: 'unknown', note });
  const spec = runner ? ENV_PORT[runner.name] : UNKNOWN_RUNNER_ENV;
  const { any: e = null, inherited = null } = spec ? envPort(dir, platform, spec, env) : {};
  if (e?.note) return unknown(e.note);
  if (e && !e.file) return { port: e.port, source: e.source };
  const other = inherited ?? (dir ? configFilePort(dir, runner, platform) : null);
  if (other?.note) return unknown(other.note);
  if (!e) return other && { port: other.port, source: other.source };
  if (!other || other.port === e.port) return { port: e.port, source: e.source };
  const says = other.file ? `${other.file} sets the port to ${other.port}` : `${other.key} in the environment is ${other.port}`;
  return unknown(`${e.file} sets ${e.key} to ${e.port} but ${says}, and versions of ${runner?.name ?? 'the runner'} differ on which wins`);
}

// A port flag or PORT= in the script whose value is a variable: `--port $PORT`,
// `-p ${PORT:-3000}`, `--port=%PORT%`. The runner gets what the environment holds.
const SCRIPT_PORT_VAR = /(?:--port[=\s]+|(?:^|\s)-p\s+|\bPORT=)["']?(?:\$\{(\w+)(?:(:?)-(\d+))?\}|\$(\w+)|%(\w+)%)/g;

/** The port a variable in the script gives, from `env` (a ${NAME:-N} default included), or { note }. */
function scriptVarPort(m, env) {
  const key = m[1] ?? m[4] ?? m[5];
  let value = typeof env?.[key] === 'string' ? env[key].trim() : undefined;
  if (m[3] !== undefined && (value === undefined || (m[2] === ':' && value === ''))) value = m[3];
  if (!value) return { note: `the script takes the port from ${key}, which is ${value === '' ? 'empty' : 'not set'}` };
  const r = portValue(key, value, null);
  return r.note ? { note: `the script takes the port from ${key}, which is "${clip(value)}", not a literal number` } : r;
}

/**
 * Port of a dev script: an explicit flag or PORT= in the script (a variable there is read
 * from `env`, the environment the runner will inherit); else what the project's own settings
 * give its runner (see projectPort; with `dir`, the project folder); else the default of the
 * framework it runs. `source` says which: 'script', 'env:<VARIABLE>', 'env:<file>',
 * 'config:<file>', 'framework:<name>', 'ambiguous' (several ports in the script, with
 * `candidates`) or 'unknown' (with a `note` when the port is set to something that is not a
 * literal number, or two settings disagree).
 */
export function devPort(script, pkg, { dir = null, platform = process.platform, env = process.env } = {}) {
  const s = String(script || '');
  const vars = [...s.matchAll(SCRIPT_PORT_VAR)].map((m) => scriptVarPort(m, env));
  const unset = vars.find((v) => v.note);
  if (unset) return { port: null, source: 'unknown', note: unset.note };
  const found = [...[...s.matchAll(/(?:--port[=\s]+|(?:^|\s)-p\s+|\bPORT=)(\d{2,5})\b/g)].map((m) => ({ port: Number(m[1]), source: 'script' })), ...vars];
  const ports = [...new Set(found.map((f) => f.port))];
  // Several ports (e.g. `concurrently "vite --port 3000" "api --port 4000"`): do not guess.
  if (ports.length > 1) return { port: null, source: 'ambiguous', candidates: ports };
  if (ports.length === 1) return { port: ports[0], source: found[0].source };
  const runner = runnerOf(s, pkg);
  const own = projectPort(dir, runner, platform, env);
  if (own) return own;
  if (runner) return { port: runner.port, source: `framework:${runner.name}` };
  return { port: null, source: 'unknown' };
}

export function packageManager(dir) {
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** A package.json larger than this is not read (real ones are a few KB). */
export const MAX_PACKAGE_JSON = 1024 * 1024;

/**
 * A folder's package.json, parsed, or null: missing, malformed, larger than MAX_PACKAGE_JSON,
 * or not a regular file (see readHead), so a link to /dev/zero or a FIFO cannot hang the caller.
 */
export function readPackageJson(dir, platform = process.platform) {
  const buf = readHead(path.join(dir, 'package.json'), platform, MAX_PACKAGE_JSON + 1);
  if (buf === null || buf.length > MAX_PACKAGE_JSON) return null;
  // Windows editors often save a UTF-8 BOM, which JSON.parse rejects.
  try { return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/**
 * What a Windows path that starts with two slashes points at. \\?\C:\… is the local long-path
 * spelling (returned without the prefix); \\wsl.localhost\… and \\wsl$\… are served by the local
 * WSL VM; anything else (\\host\share, \\?\UNC\…, devices) may reach another machine.
 * @returns {{kind:'plain'|'local'|'wsl'|'remote', path:string}}
 */
export function windowsPathKind(p) {
  const s = String(p ?? '');
  if (!/^[\\/]{2}/.test(s)) return { kind: 'plain', path: s };
  const long = s.match(/^[\\/]{2}\?[\\/]([a-z]:)(?:[\\/](.*))?$/is);
  if (long) return { kind: 'local', path: `${long[1]}\\${long[2] ?? ''}` };
  if (/^[\\/]{2}wsl(?:\.localhost|\$)(?:[\\/]|$)/i.test(s)) return { kind: 'wsl', path: s };
  return { kind: 'remote', path: s };
}

const WSL_HOST = /^wsl(?:\.localhost|\$)$/i;

/**
 * The network target of a symlink on the way to p, or null. Windows follows a local link to a
 * UNC share on first access, so this reads each link (never its target) before anything else
 * touches the path.
 */
function networkLinkOn(p) {
  let { root } = path.parse(p);
  let parts = p.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let cur = root;
  let hops = 0;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(cur, parts[i]);
    let st;
    try { st = lstatSync(next); } catch { return null; } // missing: reported as not-found later
    if (!st.isSymbolicLink()) { cur = next; continue; }
    if (++hops > 32) return null; // a loop: the later existsSync fails on its own
    let target;
    try { target = readlinkSync(next); } catch { return null; }
    const kind = windowsPathKind(target);
    if (kind.kind === 'remote') return target;
    // Continue along the link's target, then the rest of the original path.
    const resolved = path.resolve(cur, kind.path);
    root = path.parse(resolved).root;
    parts = [...resolved.slice(root.length).split(/[\\/]+/).filter(Boolean), ...parts.slice(i + 1)];
    cur = root;
    i = -1;
  }
  return null;
}

/** The fully resolved spelling of an existing path (links, 8.3 names), or p itself. */
function realOrSelf(p) {
  try { return realpathSync.native(p); } catch { /* try the JS resolver */ }
  try { return realpathSync(p); } catch { return p; }
}

const extOf = (p) => {
  const ext = path.extname(p).toLowerCase();
  return ext === '.' ? '' : ext;
};

/**
 * The Finder flags of a file (the com.apple.FinderInfo attribute, read by /usr/bin/xattr), or
 * null when it has none or they cannot be read. macOS only.
 */
export function finderFlags(p, runFn = run) {
  const r = runFn(MAC_PROGRAMS.xattr, ['-px', 'com.apple.FinderInfo', p], { timeout: 3000 });
  if (r.status !== 0) return null;
  const hex = String(r.stdout).replace(/[^0-9a-f]/gi, '');
  return hex.length >= 20 ? parseInt(hex.slice(16, 20), 16) : null;
}
const IS_ALIAS = 0x8000; // kIsAlias in the Finder flags

/**
 * A Finder alias file: `open` follows it to its original, which may be an app. A modern alias
 * is bookmark data ("book" … "mark") in the file itself; an older one keeps its data in the
 * resource fork, with an empty file, and is known by the alias bit of its Finder flags, which
 * modern aliases carry too.
 */
function isFinderAlias(p, flagsFn = finderFlags) {
  try {
    const fd = openSync(p, 'r');
    try {
      const b = Buffer.alloc(16);
      const n = readSync(fd, b, 0, b.length, 0);
      if (n >= 12 && b.toString('latin1', 0, 4) === 'book' && b.toString('latin1', 8, 12) === 'mark') return true;
    } finally { closeSync(fd); }
  } catch { /* unreadable: the flags still say */ }
  const flags = flagsFn(p);
  return flags !== null && (flags & IS_ALIAS) !== 0;
}

/** How much of a document is read for signs of Office content (below). */
const CONTENT_SCAN_MAX = 1024 * 1024;
const OLE_MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex');

/**
 * The first CONTENT_SCAN_MAX bytes of a file as lower-case text: UTF-16 (by its byte order mark
 * or its "<" pattern) decoded as such, anything else read byte for byte. { text, bytes, size }.
 */
function contentHead(p) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(CONTENT_SCAN_MAX);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got <= 0) break;
      n += got;
      if (n >= buf.length) break;
    }
    const bytes = buf.subarray(0, n);
    const le = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0x00);
    const be = (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0x00 && bytes[1] === 0x3c);
    let text;
    if (le) text = bytes.subarray(0, n - (n % 2)).toString('utf16le');
    else if (be) text = Buffer.from(bytes.subarray(0, n - (n % 2))).swap16().toString('utf16le');
    else text = bytes.toString('latin1');
    return { text: text.toLowerCase(), bytes, size: fstatSync(fd).size };
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}

// Documents whose app is Office, which decides by content, not by name.
const OFFICE_BY_CONTENT = new Set(['.xml', '.docx', '.xlsx', '.pptx', '.csv', '.tsv', '.txt']);

/**
 * Why a document's content must be revealed whatever its extension says, or null. Office opens
 * files by what they hold: an old binary Office document (an OLE compound file) or RTF renamed
 * to .docx, .csv or .pdf is still opened as what it is, macros and embedded objects included.
 * An .xml file with an `<?mso-application?>` line goes to Word, Excel or PowerPoint through
 * Office's XML handler. One rule, no parsing: that line anywhere in the first megabyte counts,
 * and an Office-bound file too big to read that far is revealed rather than guessed about.
 */
function contentRevealReason(p, ext) {
  const head = contentHead(p);
  if (!head) return null;
  if (head.bytes.length >= 8 && head.bytes.subarray(0, 8).equals(OLE_MAGIC)) {
    return 'its content is an old binary Office document, which can carry macros, whatever its name says, so it is shown in its folder instead';
  }
  if (/^\s*\{\\rtf/.test(head.text.replace(/^\ufeff|^ï»¿/, ''))) {
    return 'its content is RTF, which can embed objects that load as it opens, whatever its name says, so it is shown in its folder instead';
  }
  if (OFFICE_BY_CONTENT.has(ext)) {
    if (head.text.includes('<?mso-')) return 'it is an Office document saved as XML, which can carry macros that run as it opens, so it is shown in its folder instead';
    if (ext === '.xml' && head.size > CONTENT_SCAN_MAX) return 'it is an XML file too large to check for Office content, so it is shown in its folder instead';
  }
  return null;
}

// Said of a type that is not on the list, which is all that is known about it: never that a
// video is not a video.
const NOT_LISTED = "not on show-local's list of types it opens directly (documents, images, audio, video, text)";

/** Why a non-HTML file must be revealed rather than opened, or null when its app only displays it. */
function revealReason(p, ext, platform, flagsFn) {
  if (RUNNABLE_EXT.has(ext)) return `${ext} files run when opened, so it is shown in its folder instead`;
  if (MACRO_EXT.has(ext)) return `${ext} documents can carry macros or embedded objects that run as they open, so it is shown in its folder instead`;
  if (!ext) return 'it has no file extension, so it may be a program: shown in its folder instead';
  if (!VIEWABLE_EXT.has(ext)) return `${ext} is ${NOT_LISTED}; shown in its folder instead`;
  // "x.txt:run.pdf" names a hidden stream of another file; its extension says nothing.
  if (platform === 'win32' && p.slice(path.parse(p).root.length).includes(':')) {
    return 'it names an alternate data stream, so it is shown in its folder instead';
  }
  // A link (or an 8.3 short name) is opened as what it really is.
  const real = realOrSelf(p);
  if (!VIEWABLE_EXT.has(extOf(real))) {
    return `it leads to ${path.basename(real)}, whose type is ${NOT_LISTED}; shown in its folder instead`;
  }
  if (platform === 'darwin' && isFinderAlias(p, flagsFn)) {
    return 'it is a Finder alias, which opens its original (possibly a program), so it is shown in its folder instead';
  }
  return contentRevealReason(real, extOf(real));
}

/**
 * Why an HTML file must be revealed rather than opened, or null. The browser is handed the page
 * itself, but where no browser could be named, the system opens it by type: a link named
 * page.html that leads to a script, or a Finder alias named so, would then run. So an HTML page
 * must really be HTML, as an app file must really be of its type.
 */
function htmlRevealReason(p, platform, flagsFn) {
  // "tool.cmd:page.html" names a hidden stream of another file; its extension says nothing.
  if (platform === 'win32' && p.slice(path.parse(p).root.length).includes(':')) {
    return 'it names an alternate data stream, so it is shown in its folder instead';
  }
  const real = realOrSelf(p);
  if (!HTML_EXT.has(extOf(real))) return `it leads to ${path.basename(real)}, which is not an HTML page, so it is shown in its folder instead`;
  if (platform === 'darwin' && isFinderAlias(p, flagsFn)) {
    return 'it is a Finder alias, which opens its original (possibly a program), so it is shown in its folder instead';
  }
  return null;
}

/**
 * Only a macOS application bundle launches when "opened": a folder named *.app, or a link to one.
 * Any other folder is a folder here: it is served, run or opened as one. The macOS adapter
 * never hands a folder whose name has a dot to `open` either (other packages: .pkg, .prefPane,
 * .workflow…): with nothing to select, it reveals it in its parent (`open -R`).
 */
const isAppBundle = (dir) => extOf(dir) === '.app' || extOf(realOrSelf(dir)) === '.app';

const hasIndex = (dir) => ['index.html', 'index.htm'].some((name) => {
  // lstat: a link named index.html counts without following it anywhere.
  try { return !lstatSync(path.join(dir, name)).isDirectory(); } catch { return false; }
});

/** child is strictly inside parent (both absolute). */
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The site a nested page belongs to: when the page's own folder has no index.html, the nearest
 * folder at most MAX_SITE_LEVELS above it that has one, so "/assets/…" and "../" links resolve.
 * Never the home folder or anything above it, never a filesystem root, never across a
 * dot-folder (the server refuses those segments) or a link that leads out of that folder.
 */
function siteRootFor(file, { home, platform }) {
  let dir = path.dirname(file);
  if (hasIndex(dir)) return null;
  const key = (p) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  const underHome = !!home && inside(key(path.resolve(home)), key(file));
  for (let level = 1; level <= MAX_SITE_LEVELS; level++) {
    if (path.basename(dir).startsWith('.')) return null;
    const up = path.dirname(dir);
    if (up === dir || path.parse(up).root === up) return null;
    if (underHome && !inside(key(path.resolve(home)), key(up))) return null;
    if (hasIndex(up)) {
      // The server confines requests to the real path of its root, so the page must be in it.
      let realRoot; let realFile;
      try { realRoot = realpathSync(up); realFile = realpathSync(file); } catch { return null; }
      if (!inside(realRoot, realFile)) return null;
      return { root: up, entry: path.relative(up, file).split(path.sep).join('/'), level };
    }
    dir = up;
  }
  return null;
}

/**
 * titleFromHtml, called only when a "</title" follows the first "<title". Without one there
 * is no title, and titleFromHtml's regex would rescan the page from every "<title" (2 MB of
 * unclosed title tags did not finish in 20 s); with one, its first attempt already matches.
 */
function pageTitle(html) {
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase()); // ASCII only: same length, offsets stay aligned
  const open = lower.indexOf('<title');
  return open >= 0 && lower.lastIndexOf('</title') > open ? titleFromHtml(html) : null;
}

/**
 * The 8.3 short path of a long Windows path when there is one of WINDOWS_LONG_PATH characters
 * or fewer, else null (lib/shortpath.mjs: one PowerShell run). A failing lookup is null too.
 */
export function fittingShortPath(p, { platform = process.platform, shortPathFn = shortPathOf } = {}) {
  let short;
  try { short = shortPathFn(p, { platform }); } catch { return null; }
  return typeof short === 'string' && short && short.length <= WINDOWS_LONG_PATH ? short : null;
}

/** The URL path of a serve-mode entry ("blog/my post.html" → "blog/my%20post.html"). */
export const entryHref = (entry) => String(entry ?? '').split('/').map(encodeURIComponent).join('/');

/**
 * Classify a target. Pure apart from reading the target itself (and, for a served page, the
 * folders above it; for a dev project, its config and .env files). One exception on Windows:
 * an HTML page or an app file whose path is past WINDOWS_LONG_PATH asks `shortPathFn`
 * (lib/shortpath.mjs, one PowerShell run) for its 8.3 short path, which then opens as the
 * file (`openPath`). A folder's short path is looked up when it opens (lib/open.mjs).
 * `env` is the environment a dev project's runner will inherit (see devPort).
 * @returns {{ok:true, mode:string, ...} | {ok:false, error:string, detail:string}}
 */
export function detect(target, {
  platform = process.platform, cwd = process.cwd(), asFolder = false, home = os.homedir(), shortPathFn = shortPathOf,
  env = process.env, finderFlagsFn = finderFlags,
} = {}) {
  const raw = String(target ?? '').trim();
  if (!raw) return { ok: false, error: 'no-target', detail: 'Nothing to show: pass a path or a URL.' };

  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { return { ok: false, error: 'bad-url', detail: `Not a valid URL: ${raw}` }; }
    return { ok: true, mode: 'url', url: url.href };
  }

  // Network paths would make Windows connect (and authenticate) to another machine. WSL and the
  // \\?\ long-path prefix are local.
  const remote = { ok: false, error: 'remote-path', detail: `Network paths are not opened by show-local: ${raw}` };
  let p = raw;
  if (platform === 'win32') {
    const kind = windowsPathKind(raw);
    if (kind.kind === 'remote') return remote;
    p = kind.path;
  }
  if (/^file:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch { return { ok: false, error: 'bad-url', detail: `Not a valid file URL: ${raw}` }; }
    const host = u.hostname.toLowerCase();
    if (host && host !== 'localhost' && !(platform === 'win32' && WSL_HOST.test(host))) return remote;
    try { p = fileURLToPath(raw); } catch { return { ok: false, error: 'bad-url', detail: `Not a valid file URL: ${raw}` }; }
  }
  p = path.resolve(cwd, p);
  if (platform === 'win32') {
    const kind = windowsPathKind(p);
    if (kind.kind === 'remote') return remote;
    p = path.resolve(kind.path);
    const link = networkLinkOn(p);
    if (link) return { ...remote, detail: `Network paths are not opened by show-local: ${raw} leads through a link to ${link}` };
  }
  if (!existsSync(p)) return { ok: false, error: 'not-found', detail: `No such file or folder: ${p}` };

  const st = statSync(p);
  // A pipe, socket or device is never read (reading a pipe with no writer never returns) nor opened.
  if (!st.isDirectory() && !st.isFile()) {
    return { ok: true, mode: 'folder', path: path.dirname(p), select: p, reasons: ['it is not a regular file (a pipe, a socket or a device), so it is shown in its folder instead'] };
  }
  if (st.isDirectory()) {
    // `open` would launch a bundle, even with --folder: reveal it in its parent instead.
    if (isAppBundle(p)) {
      return { ok: true, mode: 'folder', path: path.dirname(p), select: p, reasons: ['an application bundle: revealed, not launched'] };
    }
    if (asFolder) return { ok: true, mode: 'folder', path: p, select: pickMainFile(p), reasons: ['opened as a folder (--folder)'] };
    const pkg = readPackageJson(p, platform);
    if (pkg?.scripts?.dev) {
      const { port, source, candidates, note } = devPort(pkg.scripts.dev, pkg, { dir: p, platform, env });
      return {
        ok: true, mode: 'dev', path: p, root: p, script: pkg.scripts.dev, port, portSource: source,
        ...(candidates ? { candidates } : {}), ...(note ? { portNote: note } : {}), packageManager: packageManager(p),
      };
    }
    for (const index of ['index.html', 'index.htm']) {
      if (existsSync(path.join(p, index))) {
        return { ok: true, mode: 'serve', path: p, root: p, entry: index, reasons: ['folder with index.html'] };
      }
    }
    return { ok: true, mode: 'folder', path: p, select: pickMainFile(p) };
  }

  const ext = extOf(p);
  if (asFolder) {
    return { ok: true, mode: 'folder', path: path.dirname(p), select: p, reasons: ['shown in its folder (--folder)'] };
  }
  if (HTML_EXT.has(ext)) {
    const notHtml = htmlRevealReason(p, platform, finderFlagsFn);
    if (notHtml) return { ok: true, mode: 'folder', path: path.dirname(p), select: p, reasons: [notHtml] };
    let html = '';
    try {
      // Only the first 2 MB matter for the title and for spotting module/fetch usage.
      const fd = openSync(p, 'r');
      const buf = Buffer.alloc(Math.min(st.size, MAX_HTML_SCAN));
      const n = readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      html = buf.subarray(0, n).toString('utf8');
    } catch { /* unreadable: treat as plain */ }
    // The page's own local scripts count too: a classic app.js that fetches data breaks under file://.
    const need = needsServer(html, { dir: path.dirname(p), platform });
    const reasons = [...need.reasons];
    const title = pageTitle(html);
    const long = platform === 'win32' && p.length > WINDOWS_LONG_PATH;
    if (!need.needed && !long) return { ok: true, mode: 'file', path: p, title };
    // The server never serves dotfiles, so a hidden page could only ever answer 403.
    const hidden = path.basename(p).startsWith('.');
    // Past MAX_PATH, a page that stays a file opens through its 8.3 short path when it has one
    // that fits. The result keeps the real path in `path`; `openPath` is what the URL uses.
    const short = long && (!need.needed || hidden) ? fittingShortPath(p, { platform, shortPathFn }) : null;
    const viaShort = short ? { openPath: short, shortPath: true } : {};
    if (short) {
      reasons.push(`path is ${p.length} characters, past what Windows opens as file:///, so it opens through its 8.3 short path (${short.length} characters)`);
    } else if (long && !need.needed && !hidden) {
      reasons.push(`path is ${p.length} characters; file:/// may fail past Windows MAX_PATH and it has no 8.3 short path of ${WINDOWS_LONG_PATH} characters or fewer, so it is served: the link works only while this session is open`);
    } else if (long) {
      reasons.push(`path is ${p.length} characters; file:/// may fail past Windows MAX_PATH`);
    }
    if (!need.needed && short) return { ok: true, mode: 'file', path: p, ...viaShort, title, reasons };
    if (hidden) {
      reasons.push('its name starts with "." and the local server never serves hidden files, so it opens as file:/// (what needs http may not work)');
      return { ok: true, mode: 'file', path: p, ...viaShort, title, reasons };
    }
    const site = siteRootFor(p, { home, platform });
    if (site) {
      reasons.push(`served from ${site.root}, the site folder ${site.level === 1 ? 'one level' : `${site.level} levels`} up with index.html, so links from the site root resolve`);
      return { ok: true, mode: 'serve', path: p, root: site.root, entry: site.entry, reasons, title };
    }
    return { ok: true, mode: 'serve', path: p, root: path.dirname(p), entry: path.basename(p), reasons, title };
  }
  const why = revealReason(p, ext, platform, finderFlagsFn);
  if (why) return { ok: true, mode: 'folder', path: path.dirname(p), select: p, reasons: [why] };
  // Past MAX_PATH, the app is handed the 8.3 short path, as a page is; `path` stays the real one.
  if (platform === 'win32' && p.length > WINDOWS_LONG_PATH) {
    const short = fittingShortPath(p, { platform, shortPathFn });
    if (short) {
      const reasons = [`path is ${p.length} characters, past what Windows opens reliably (MAX_PATH), so it opens through its 8.3 short path (${short.length} characters)`];
      return { ok: true, mode: 'app', path: p, ext, openPath: short, shortPath: true, reasons };
    }
    return { ok: true, mode: 'app', path: p, ext, reasons: [`path is ${p.length} characters; opening it may fail past Windows MAX_PATH, and it has no 8.3 short path of ${WINDOWS_LONG_PATH} characters or fewer`] };
  }
  return { ok: true, mode: 'app', path: p, ext };
}
