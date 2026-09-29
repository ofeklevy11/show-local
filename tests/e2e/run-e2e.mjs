// End-to-end: real Claude, real plugin, real windows. Windows only for now.
//
// Each case asks a headless Claude Code session (`claude -p`, the terminal path) to show
// something, with only this plugin loaded. It then checks, from the session's own
// transcript, that the skill was used, which mode the first show.mjs call chose, what
// show.mjs finally reported, how many tool calls and how much script time it took, and
// what the final reply said. Results: tests/e2e/out/results.json and results.md.
//
//   node tests/e2e/run-e2e.mjs [case-id ...] [--model <alias>]
//
// A case id picks that case. A prefix picks the cases it starts, as long as a digit does not
// follow it: "9" runs 9a and 9b, "1" runs only 1-url (not 10 to 14).
//
// Budgets, enforced for every case (the skill's work calls after the Skill call; ToolSearch
// schema loads are counted over the whole transcript and reported separately):
//   direct (url, file, folder, app): 1 work call and at most 10 s of script time
//   served (static or dev server):   at most 4 work calls and 20 s of script time, summed
//                                    over every show.mjs call of the case
//
// Checks beyond the result JSON:
//   every case      the reply judged is the session's FINAL `result`. A further turn after the
//                   first reply (the harness answering a background-task notice) fails the case,
//                   and so does any Bash call with run_in_background
//   Edge            url, file and folder cases (.html is associated with Edge on the test
//                   machine): every msedge.exe process (pid, parent pid, command line, from
//                   Win32_Process) is listed before and after the case. No new Edge browser
//                   process (one without --type=) may appear, no msedge command line may name
//                   the fixture, and no Edge window may show the page's title. New child
//                   processes (--type=) of an Edge that was already running are Edge's own
//                   background work: counted and reported, not failed
//   file cases      once `claude -p` has exited, the page's browser window must still be there
//                   (survivesSession; required for 2-file)
//   1-url           the proof window's title contains the page's title ("Example Domain")
//   served cases    headless, so the plan offers `next.oneshot` only, and the skill's Bash work
//                   is exactly that plan call and the oneshot call, in the foreground. oneshot
//                   must report server.stopped, the port must be free once the session has
//                   exited, the session must exit by itself, and the reply must say that the
//                   server was stopped
//   9a / 9b / 14    the fixture builder asserts the lengths: 9a-path250 is exactly 250
//                   characters (opens as file:///), 9b-path270 exactly 270, 14-session-temp over
//                   256. For 9b and 14 the runner measures the 8.3 short path itself
//                   (GetShortPathNameW): when one exists and fits, the case expects file mode
//                   through it (shortPath); only without one does it expect the served fallback
//   12-english      an English prompt must get an English reply
//   13-badname      a file and a folder whose names hold ' $ & ; ` % and spaces
//   14-session-temp the fixture sits in $SHOW_LOCAL_E2E_SESSION_DIR (the calling session's
//                   scratchpad) when that is set, else in a folder shaped like one under
//                   <tmp>/claude
//
// Case 10 asks for a server that does not exist: nothing may open. Case 11 opens a real
// file with SHOW_LOCAL_TIMEOUT_MS=1 in that session's environment only, so verification must
// fail: the reply has to say it tried and could not verify, never that it opened, and never
// guess ("probably", "כנראה", "סיכוי", …).
//
// It opens real browser tabs, Explorer, the PDF viewer, the video player and the image
// viewer on this machine. After each case it closes what it can close safely: Explorer
// windows on a fixture folder (matched by their folder, never by title), programs whose
// command line runs from the fixtures, and app windows whose title contains one of this
// run's fixture file names (each carries the run's tag). Browser tabs stay open. Every row
// keeps its own run timestamp and cleanup record: a subset run merges its rows into the
// previous results, and the other rows keep theirs.
//
// Importing this file runs nothing: the functions that judge a transcript are exported.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detect, WINDOWS_LONG_PATH } from '../../plugins/show-local/scripts/lib/detect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'show-local');
const OUT = path.join(HERE, 'out');
const FX = path.join(OUT, 'fixtures');
const argv = process.argv.slice(2);
const modelAt = argv.indexOf('--model');
const MODEL = modelAt > -1 ? argv[modelAt + 1] : null;
const ONLY = argv.filter((a, i) => !a.startsWith('--') && (modelAt === -1 || i !== modelAt + 1));

export const BUDGETS = {
  direct: { calls: 1, ms: 10000 },
  served: { calls: 4, ms: 20000 },
};

/** Does a case id answer a selector from the command line? The id itself, or a prefix not followed by a digit. Pure. */
export function selects(id, selector) {
  const s = String(selector ?? '');
  return !!s && (id === s || (id.startsWith(s) && !/^\d/.test(id.slice(s.length))));
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ---------- fixtures ----------
function pdfBytes(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 20 70 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const page = (title, body = '', extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${extra}</head><body><h1>${title}</h1>${body}</body></html>\n`;

// Each run's fixtures carry a tag of their own. The watcher proves an open only by a window that
// did not show the page's title before, and browser tabs from an earlier run stay open: with the
// same titles, the last page of that run would still be showing, and this run could not prove it.
// Cleanup closes app windows by these tagged file names only.
export const RUN_TAG = new Date().toISOString().replace(/\D/g, '').slice(2, 14);

/** The <title> of each HTML fixture: written into the file, and looked for in window titles. */
export const TITLES = {
  plain: `show-local e2e plain ${RUN_TAG}`,
  unverified: `show-local e2e unverified ${RUN_TAG}`,
  module: `show-local e2e module ${RUN_TAG}`,
  site: `show-local e2e site ${RUN_TAG}`,
  siteAbout: `show-local e2e about ${RUN_TAG}`,
  devApp: `show-local e2e dev app ${RUN_TAG}`,
  report: `show-local e2e report ${RUN_TAG}`,
  hebrew: `show-local e2e דוח בעברית ${RUN_TAG}`,
  path250: `show-local e2e path 250 ${RUN_TAG}`,
  path270: `show-local e2e path 270 ${RUN_TAG}`,
  english: `show-local e2e english report ${RUN_TAG}`,
  badname: `show-local e2e odd name ${RUN_TAG}`,
  session: `show-local e2e session temp ${RUN_TAG}`,
};

// The long-path fixtures, measured the way show.mjs measures (the absolute path, in characters):
// 9a-path250 is under the limit and opens as file:///, 9b-path270 is over it.
export const LONG_FILE_CHARS = 250;
export const OVER_LIMIT_CHARS = 270;

// The characters 13-badname puts in both its folder name and its file name.
export const ODD_CHARS = "' $ & ; ` %";

/** The variable that points 14-session-temp at a real session folder (the lead's scratchpad). */
export const SESSION_ENV = 'SHOW_LOCAL_E2E_SESSION_DIR';

/**
 * Where 14-session-temp's fixture lives. `root` is the only folder the runner ever clears or
 * cleans up there: a show-local-e2e folder of its own inside the given session folder (never
 * the session folder itself), or, without one, a folder under <tmp>/claude shaped like a
 * session scratchpad (<tmp>/claude/<project>/<session id>/scratchpad). Pure.
 */
export function sessionFixtureRoot(env = process.env) {
  const given = String(env?.[SESSION_ENV] ?? '').trim();
  if (given) {
    const root = path.join(path.resolve(given), 'show-local-e2e');
    return { root, base: root, from: SESSION_ENV };
  }
  const root = path.join(os.tmpdir(), 'claude', 'show-local-e2e-session');
  return { root, base: path.join(root, '00000000-0000-4000-8000-0000000e2e14', 'scratchpad'), from: 'tmpdir' };
}

/**
 * A file path of exactly `want` characters: <base>/<seg>/…/<pad>/<file>, where the last folder
 * pads it to the exact length. Null when <base>/<x>/<file> is already longer. Pure.
 */
export function pathOfLength(base, file, want, seg = 'long-segment-for-show-local-e2e') {
  const len = (dir) => path.join(dir, file).length;
  // Each step keeps room for one separator and a pad folder of at least one character.
  if (len(base) + 2 > want) return null;
  let dir = base;
  while (len(path.join(dir, seg)) + 2 <= want) dir = path.join(dir, seg);
  const padLen = want - len(dir) - 1;
  return path.join(dir, 'pad-to-exact-length-'.repeat(3).slice(0, padLen), file);
}

/** Why the long-path fixtures cannot test what 9a, 9b and 14 claim to test (empty when fine). Pure. */
export function longPathProblems(f, limit = WINDOWS_LONG_PATH) {
  const out = [];
  const n250 = f.path250 ? f.path250.length : null;
  if (n250 !== LONG_FILE_CHARS) out.push(`9a-path250 is ${n250 ?? 'missing (no path of that length fits under the fixtures folder)'} characters; it must be exactly ${LONG_FILE_CHARS}`);
  else if (n250 > limit) out.push(`9a-path250 is ${n250} characters, over the ${limit}-character limit, so it cannot test a file:/// open`);
  const n270 = f.path270 ? f.path270.length : null;
  if (n270 !== OVER_LIMIT_CHARS) out.push(`9b-path270 is ${n270 ?? 'missing (no path of that length fits under the fixtures folder)'} characters; it must be exactly ${OVER_LIMIT_CHARS}`);
  else if (!(n270 > limit)) out.push(`9b-path270 is ${n270} characters; it must be over ${limit}`);
  const ns = f.session ? f.session.length : null;
  if (ns === null || !(ns > limit)) out.push(`14-session-temp is ${ns ?? 'missing'} characters; it must be over ${limit}`);
  return out;
}

/** Where every fixture lives. Pure: nothing is written. */
export function fixturePaths(env = process.env) {
  const at = (...rel) => path.join(FX, ...rel);
  const f = {
    plain: at('plain', `show-local-e2e-plain-${RUN_TAG}.html`),
    unverified: at('unverified', `show-local-e2e-unverified-${RUN_TAG}.html`),
    moduleHtml: at('module-app', `show-local-e2e-module-${RUN_TAG}.html`),
    site: at('site'),
    outputs: at('outputs'),
    // An app names its window after the file, so these names carry the run's tag too.
    pdf: at('apps', `show-local-e2e-doc-${RUN_TAG}.pdf`),
    png: at('apps', `show-local-e2e-image-${RUN_TAG}.png`),
    mp4: at('apps', `show-local-e2e-clip-${RUN_TAG}.mp4`),
    devApp: at('dev-app'),
    hebrew: at('עברית', `דוח בדיקה ${RUN_TAG}.html`),
    english: at('english', `show-local-e2e-english-report-${RUN_TAG}.html`),
    badname: at(`odd ${ODD_CHARS} folder`, `show-local-e2e odd ${ODD_CHARS} name ${RUN_TAG}.html`),
  };
  f.outputsReport = path.join(f.outputs, `show-local-e2e-report-${RUN_TAG}.html`);
  f.path250 = pathOfLength(at('long'), `show-local-e2e-path250-${RUN_TAG}.html`, LONG_FILE_CHARS);
  f.path270 = pathOfLength(at('longer'), `show-local-e2e-path270-${RUN_TAG}.html`, OVER_LIMIT_CHARS);
  const s = sessionFixtureRoot(env);
  f.sessionRoot = s.root;
  f.sessionFrom = s.from;
  const sessionFile = `show-local-e2e-session-${RUN_TAG}.html`;
  // Over the limit however long the session folder's own path is.
  f.session = pathOfLength(s.base, sessionFile, Math.max(OVER_LIMIT_CHARS, path.join(s.base, sessionFile).length + 2));
  return f;
}

/** This run's fixture FILE names, the only words cleanup looks for in a window title. Pure. */
export function cleanupTokens(f) {
  const files = [f.plain, f.unverified, f.moduleHtml, f.outputsReport, f.pdf, f.png, f.mp4, f.hebrew, f.english, f.badname, f.path250, f.path270, f.session];
  return [...new Set(files.filter(Boolean).map((p) => path.basename(p)).filter((n) => n.includes(RUN_TAG)))];
}

// The 8.3 short path of an existing file, measured by the runner itself (not by show-local's own
// lib/shortpath.mjs), through GetShortPathNameW with the \\?\ prefix, which also works past
// MAX_PATH. The path travels in an environment variable, never on a command line.
const SHORT_PATH_PS = String.raw`$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
try {
  Add-Type -Namespace E2E -Name ShortPath -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetShortPathNameW(string l, System.Text.StringBuilder s, uint n);'
  $sb = New-Object System.Text.StringBuilder 32768
  $n = [E2E.ShortPath]::GetShortPathNameW("\\?\" + $env:E2E_P, $sb, 32768)
  if ($n -eq 0) { throw ("GetShortPathNameW failed with error " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  $s = $sb.ToString()
  if ($s.StartsWith("\\?\")) { $s = $s.Substring(4) }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $true; short = $s } -Compress))
} catch { [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Compress)) }`;

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
const lastJson = (stdout) => {
  try { return JSON.parse(String(stdout || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()); } catch { return null; }
};

/** The 8.3 short path of an existing file: { ok, short } or { ok: false, error }. Windows only. */
export function shortPathOf(file) {
  const r = spawnSync('powershell.exe', [...PS, '-EncodedCommand', encoded(SHORT_PATH_PS)], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, E2E_P: file },
  });
  return lastJson(r.stdout) || { ok: false, error: String(r.stderr || r.error || 'no output').trim() };
}

/**
 * What a case over the limit has to do, from the runner's own 8.3 measurement: file mode through
 * the short path when there is one and it fits, the served fallback only when there is none. Pure.
 */
export function overLimitPlan(file, measured, limit = WINDOWS_LONG_PATH) {
  const short = measured?.ok === true ? String(measured.short || '') : '';
  if (short && short.length < file.length && short.length <= limit) return { mode: 'file', short, why: `its 8.3 short path is ${short.length} characters` };
  let why;
  if (measured?.ok !== true) why = `no 8.3 short path could be read (${measured?.error || 'not measured'})`;
  else if (!short || short.length >= file.length) why = 'the path has no 8.3 short names (they are turned off here)';
  else why = `its 8.3 short path is still ${short.length} characters`;
  return { mode: 'serve', short: null, why };
}

/** Write every fixture (clearing the fixture folders first) and measure what 9b and 14 must do. Opens nothing. Windows only. */
export function buildFixtures() {
  const f = fixturePaths();
  // A long-path case that is not really long (or not short enough) would pass without testing
  // anything: refuse to run rather than report it.
  const wrong = longPathProblems(f);
  if (wrong.length) throw new Error(`long-path fixtures: ${wrong.join('; ')}`);
  for (const dir of [FX, f.sessionRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (e) {
      throw new Error(`cannot clear ${dir} (${e.code}): a program still holds a fixture open, probably a window from an earlier run. Close it and run again.`);
    }
  }
  mkdirSync(FX, { recursive: true });
  const w = (file, content) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };

  w(f.plain, page(TITLES.plain));
  w(f.unverified, page(TITLES.unverified));
  w(f.moduleHtml, page(TITLES.module, '<p id="m"></p>', '<script type="module">document.getElementById("m").textContent = "module ran";</script>'));
  w(path.join(f.site, 'index.html'), page(TITLES.site, '<p><a href="about.html">about</a></p>'));
  w(path.join(f.site, 'about.html'), page(TITLES.siteAbout));
  w(path.join(f.outputs, 'frame.png'), PNG_1PX);
  w(f.outputsReport, page(TITLES.report));
  w(path.join(f.outputs, 'notes.txt'), 'notes\n');
  w(f.pdf, pdfBytes('show-local e2e pdf'));
  w(f.png, PNG_1PX);
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2f7cf6:s=320x180:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-pix_fmt', 'yuv420p', f.mp4], { encoding: 'utf8' });
  if (ff.status !== 0) f.mp4 = null;
  w(path.join(f.devApp, 'package.json'), `${JSON.stringify({ name: 'e2e-dev-app', private: true, scripts: { dev: 'node server.cjs --port 5199' } }, null, 2)}\n`);
  w(path.join(f.devApp, 'page.html'), `<!doctype html><title>${TITLES.devApp}</title><h1>dev app</h1>`);
  w(path.join(f.devApp, 'server.cjs'), [
    "const fs = require('fs');",
    "const http = require('http');",
    "const path = require('path');",
    "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
    "const page = fs.readFileSync(path.join(__dirname, 'page.html'));",
    "http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(page); })",
    "  .listen(port, '127.0.0.1', () => console.log('dev app ready at http://localhost:' + port + '/'));",
  ].join('\n'));
  w(f.hebrew, page(TITLES.hebrew));
  w(f.english, page(TITLES.english));
  w(f.badname, page(TITLES.badname));
  w(f.path250, page(TITLES.path250));
  w(f.path270, page(TITLES.path270));
  w(f.session, page(TITLES.session));
  // 9a is under the limit: show.mjs itself must plan it as a file.
  const d = detect(f.path250, { platform: 'win32', cwd: FX });
  if (d.mode !== 'file') throw new Error(`long-path fixtures: 9a-path250 (${f.path250.length} characters) plans as ${d.mode || d.error}, expected file`);
  // 9b and 14 are over it: what they must do follows from the runner's own 8.3 measurement.
  f.overLimit = {
    '9b-path270': overLimitPlan(f.path270, shortPathOf(f.path270)),
    '14-session-temp': overLimitPlan(f.session, shortPathOf(f.session)),
  };
  return f;
}

// ---------- cases ----------
// `mode`: what the FIRST show.mjs call must choose. `target`: what the reply must name in full
// (a served case names the http URL show.mjs opened, known only at run time). `title`: the
// page's title, looked for in window titles. `lang`: the language the reply must be in ('he'
// unless given). `env` is added to that case's session only. `edgeNeedles`: what an msedge
// command line must not contain (default: the target's file name; a served case adds the
// server's host:port once it is known).
// `expect.opened` defaults to true. `expect.titleIncludes`: text the verified window's title
// must contain. `expect.notInEdge`: the Edge accounting must be clean (url, file and folder
// cases). `expect.survivesSession`: the page's window is still there after the session exited.
// `expect.served`: a server case, run headless through `next.oneshot`. `expect.shortPath`: file
// mode through the 8.3 short path. `expect.servedReason`: the served fallback's reason says the
// link only lives as long as the session. `expect.pathLength`: { exact, over } rule for the
// fixture path's length (`pathLength`, as show.mjs measures it).
const fwd = (p) => String(p ?? '').replace(/\\/g, '/');
export function cases(f) {
  const over = f.overLimit || {};
  // 9b and 14: file mode through the 8.3 short path, or served only when there is none.
  const overLimit = (id, file, title, prompt, pathRule) => {
    const plan = over[id] || { mode: 'file', why: 'expected by default: the fixtures were not measured in this process' };
    const common = { id, title, fixture: file, pathLength: file?.length ?? null, planWhy: plan.why, prompt };
    return plan.mode === 'file'
      ? { ...common, mode: 'file', target: file, expect: { verified: true, notInEdge: true, shortPath: true, pathLength: pathRule } }
      : { ...common, mode: 'serve', expect: { verified: true, served: true, notInEdge: true, servedReason: true, pathLength: pathRule } };
  };
  return [
    { id: '1-url', mode: 'url', target: 'https://example.com', title: 'Example Domain', edgeNeedles: ['example.com'], prompt: 'תפתח לי בדפדפן את https://example.com', expect: { verified: true, titleIncludes: 'Example Domain', notInEdge: true } },
    { id: '2-file', mode: 'file', target: f.plain, title: TITLES.plain, prompt: `תציג לי את הדוח ${fwd(f.plain)}`, expect: { verified: true, notInEdge: true, survivesSession: true } },
    { id: '3-module', mode: 'serve', title: TITLES.module, fixture: f.moduleHtml, prompt: `תציג לי לוקאלית את ${fwd(f.moduleHtml)}`, expect: { verified: true, served: true } },
    { id: '4-site', mode: 'serve', title: TITLES.site, prompt: `תפתח לי את האתר שבתיקייה ${fwd(f.site)}`, expect: { verified: true, served: true } },
    { id: '5-folder', mode: 'folder', target: f.outputs, edgeNeedles: [path.basename(f.outputsReport), f.outputs], prompt: `תפתח את התיקייה ${fwd(f.outputs)}`, expect: { verified: true, notInEdge: true } },
    { id: '6a-pdf', mode: 'app', target: f.pdf, prompt: `תפתח לי את ${fwd(f.pdf)}`, expect: { verified: true } },
    ...(f.mp4 ? [{ id: '6b-mp4', mode: 'app', target: f.mp4, prompt: `תראה לי את הסרטון ${fwd(f.mp4)}`, expect: { verified: true } }] : []),
    { id: '6c-png', mode: 'app', target: f.png, prompt: `תציג לי את התמונה ${fwd(f.png)}`, expect: { verified: true } },
    { id: '7-dev', mode: 'dev', title: TITLES.devApp, prompt: `תריץ את הפרויקט ${fwd(f.devApp)} ותפתח לי אותו בדפדפן`, expect: { verified: true, served: true } },
    { id: '8-hebrew', mode: 'file', target: f.hebrew, title: TITLES.hebrew, prompt: `תציג לי את ${fwd(f.hebrew)}`, expect: { verified: true, notInEdge: true } },
    { id: '9a-path250', mode: 'file', target: f.path250, title: TITLES.path250, pathLength: f.path250?.length ?? null, prompt: `תציג לי את ${fwd(f.path250)}`, expect: { verified: true, notInEdge: true, pathLength: { exact: LONG_FILE_CHARS, atMost: WINDOWS_LONG_PATH } } },
    overLimit('9b-path270', f.path270, TITLES.path270, `תציג לי את ${fwd(f.path270)}`, { exact: OVER_LIMIT_CHARS, over: WINDOWS_LONG_PATH }),
    { id: '10-fail', mode: 'url', edgeNeedles: ['127.0.0.1:4499'], prompt: 'תפתח לי בדפדפן את http://127.0.0.1:4499/', expect: { opened: false, notInEdge: true } },
    // The file really opens, but a 1 ms window watch cannot see it: opened true, verified false.
    // Its own page, so no window from case 2 already shows that title (that would be "cannot tell").
    { id: '11-unverified', mode: 'file', target: f.unverified, title: TITLES.unverified, prompt: `תציג לי את הדוח ${fwd(f.unverified)}`, env: { SHOW_LOCAL_TIMEOUT_MS: '1' }, expect: { opened: true, verified: false, notInEdge: true } },
    { id: '12-english', mode: 'file', target: f.english, title: TITLES.english, lang: 'en', prompt: `open the report ${fwd(f.english)} in my browser`, expect: { verified: true, notInEdge: true } },
    { id: '13-badname', mode: 'file', target: f.badname, title: TITLES.badname, prompt: `תציג לי את הדוח ${fwd(f.badname)}`, expect: { verified: true, notInEdge: true } },
    overLimit('14-session-temp', f.session, TITLES.session, `תציג לי את הדוח ${fwd(f.session)}`, { over: WINDOWS_LONG_PATH }),
  ];
}

// ---------- the desktop, before and after a case ----------
// Every msedge.exe process with its parent and command line, as JSON. Nothing is spliced in;
// -EncodedCommand needs no quoting.
const EDGE_PROCESSES = String.raw`$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
try {
  $l = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; cmd = [string]$_.CommandLine } })
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $true; processes = $l } -Compress -Depth 4))
} catch { [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Compress)) }`;

const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const normTitle = (s) => String(s ?? '').replace(BIDI, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Every msedge.exe process: { ok, processes: [{ pid, ppid, cmd }] } or { ok: false, error }. Reads only. Windows only. */
export function edgeProcesses() {
  const r = spawnSync('powershell.exe', [...PS, '-EncodedCommand', encoded(EDGE_PROCESSES)], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return lastJson(r.stdout) || { ok: false, error: String(r.stderr || r.error || 'no output').trim() };
}

/**
 * One look at the desktop: every visible top-level window (windows.ps1 snapshot mode, which
 * enumerates them with EnumWindows) and every msedge.exe process. Windows only.
 */
async function desktopLook() {
  const { createWindowsAdapter } = await import(pathToFileURL(path.join(PLUGIN, 'scripts', 'lib', 'adapters', 'win.mjs')).href);
  let windows;
  try { windows = createWindowsAdapter().snapshot(); } catch (e) { windows = { ok: false, error: e.message }; }
  return { at: new Date().toISOString(), windows, edge: edgeProcesses() };
}

const isEdgeChild = (cmd) => /(?:^|\s)--type=/.test(cmd);

/**
 * What two looks at the desktop (before and after a case) say about Edge and this case's page:
 * how many msedge processes there were, which ones are new, whether a new one is a browser
 * process (no --type=) or a child of an Edge that was already running, how many msedge command
 * lines name the fixture (`needles`), and which Edge windows show the page's `title`. Pure.
 */
export function edgeCheck(before, after, { title = null, needles = [] } = {}) {
  const wantTitle = normTitle(title);
  const want = asList(needles).map((n) => normRef(n)).filter(Boolean);
  const names = (cmd) => want.length > 0 && want.some((n) => normRef(cmd).includes(n));
  const procs = (look) => (look?.edge?.ok === true
    ? asList(look.edge.processes).map((p) => ({ pid: Number(p?.pid), ppid: Number(p?.ppid), cmd: String(p?.cmd ?? '') }))
    : null);
  const one = (look) => {
    const listed = look?.windows?.ok === true;
    const all = listed ? asList(look.windows.windows) : [];
    const edge = all.filter((w) => String(w?.process ?? '').toLowerCase() === 'msedge');
    const ps = procs(look);
    const withFixture = ps ? ps.filter((p) => names(p.cmd)).length : null;
    return {
      windowsSeen: listed ? all.length : null,
      edgeWindows: listed ? edge.length : null,
      matching: listed ? edge.map((w) => String(w.title ?? '')).filter((t) => wantTitle && normTitle(t).includes(wantTitle)) : null,
      edgeProcesses: ps ? ps.length : null,
      withFixture,
      // The name older results used for the same count.
      cmdlineHits: withFixture,
    };
  };
  const b = one(before);
  const a = one(after);
  const pb = procs(before);
  const pa = procs(after);
  const cmdChecked = !!pb && !!pa;
  // A pid that now runs another command line is a new process too.
  const key = (p) => `${p.pid}|${p.cmd}`;
  const known = new Set((pb || []).map(key));
  const knownPids = new Set((pb || []).map((p) => p.pid));
  const fresh = cmdChecked ? pa.filter((p) => !known.has(key(p))) : [];
  const newBrowser = fresh.filter((p) => !isEdgeChild(p.cmd));
  const newChild = fresh.filter((p) => isEdgeChild(p.cmd));
  const listed = b.matching !== null && a.matching !== null;
  const titleHit = listed && !!wantTitle && (a.matching.length > 0 || b.matching.length > 0);
  const found = titleHit || (cmdChecked && (newBrowser.length > 0 || a.withFixture > 0 || b.withFixture > 0));
  return {
    title,
    needles: asList(needles).map((n) => tidy(n)),
    method: 'msedge.exe processes from Win32_Process (pid, parent pid, command line) and visible top-level windows (EnumWindows), before and after the case',
    listed,
    cmdChecked,
    before: b,
    after: a,
    newBrowserProcesses: cmdChecked ? newBrowser.length : null,
    withFixture: cmdChecked ? a.withFixture : null,
    newChildProcesses: cmdChecked ? newChild.length : null,
    // Children whose parent was already running before the case: Edge's own background work.
    newChildrenOfRunningEdge: cmdChecked ? newChild.filter((p) => knownPids.has(p.ppid)).length : null,
    newBrowser: newBrowser.map((p) => ({ pid: p.pid, ppid: p.ppid, cmd: tidy(p.cmd).slice(0, 240) })),
    ok: found ? false : cmdChecked && (listed || !wantTitle) ? true : null,
  };
}

/** The process whose window proved the open ("chrome"), or null. Pure. */
export function proofProcess(j) {
  if (typeof j?.window?.process === 'string' && j.window.process) return j.window.process.toLowerCase();
  for (const e of asList(j?.evidence)) {
    const m = String(e).match(/^window ".*" \(([^)]+)\)/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Is the page still showing once the session has exited? A window of the process that proved
 * the open (any process but Edge when none did) whose title contains the page's title. Null when
 * the windows could not be listed or the page has no title. Pure.
 */
export function survives(look, { title, process: proc = null } = {}) {
  if (look?.windows?.ok !== true || !title) return null;
  const want = normTitle(title);
  return asList(look.windows.windows).some((w) => {
    const p = String(w?.process ?? '').toLowerCase();
    return (proc ? p === proc : p !== 'msedge') && normTitle(w?.title).includes(want);
  });
}

/** Is nothing listening on this port any more (127.0.0.1 refuses, ::1 does not answer)? Null when it cannot tell. */
async function portFree(port) {
  const probe = (host) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1500, () => done('timeout'));
    s.once('connect', () => done('open'));
    s.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : e.code || 'error'));
  });
  const [v4, v6] = await Promise.all([probe('127.0.0.1'), probe('::1')]);
  if (v4 === 'open' || v6 === 'open') return false;
  return v4 === 'refused' ? true : null;
}

// ---------- running one case ----------
// A clean environment: when this runs inside a Claude session, variables such as
// ANTHROPIC_BASE_URL point at that host's own proxy, and the child's login is rejected there.
const KEEP = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'USERNAME', 'LANG']);
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.has(k.toUpperCase())));
const CLAUDE = process.env.CLAUDE_BIN || 'claude';

function runClaude(prompt, cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    // Only this plugin: project settings only (no user hooks or other plugins), no MCP servers.
    const args = ['-p', prompt, '--plugin-dir', PLUGIN, '--setting-sources', 'project', '--strict-mcp-config',
      '--output-format', 'stream-json', '--verbose', '--max-turns', '30',
      '--allowedTools', 'Skill,Bash(node:*),Bash(npm:*),Read', '--no-session-persistence'];
    args.push('--model', MODEL || 'sonnet');
    const t0 = Date.now();
    // stdin must be closed: `claude -p` reads piped stdin and would wait for it forever.
    const child = spawn(CLAUDE, args, { cwd, env: { ...cleanEnv(), ...extraEnv }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let endTimer = null;
    // Who ended the session: the session itself, or this runner (see below).
    let endedBy = 'itself';
    // `claude -p` does not exit while a background task it started is alive. A session that
    // left one behind must not hang the run: once a turn has ended (a `result` event), it gets
    // 4 s to exit, then this runner ends its process tree, and the row records that. A notice
    // that a background task ended starts one more turn: that turn gets a minute to begin, so
    // the transcript shows it (the judge fails the case for it).
    const killTree = (why) => { endedBy = why; spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); };
    const arm = (ms) => { if (endTimer) clearTimeout(endTimer); endTimer = setTimeout(() => killTree('runner-after-reply'), ms); };
    const disarm = () => { if (endTimer) { clearTimeout(endTimer); endTimer = null; } };
    const onLine = (line) => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      if (e.type === 'result') arm(4000);
      else if (endTimer && isTaskNotice(e)) arm(60000);
      else if (e.type === 'assistant') disarm();
    };
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      pending += d;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr.on('data', (d) => { err += d; });
    const guard = setTimeout(() => killTree('runner-guard'), 8 * 60 * 1000);
    child.on('close', (code) => { clearTimeout(guard); disarm(); resolve({ code, out, err, ms: Date.now() - t0, endedBy }); });
    child.on('error', (e) => { clearTimeout(guard); disarm(); resolve({ code: -1, out, err: String(e), ms: Date.now() - t0, endedBy: 'did-not-start' }); });
  });
}

const SHOW_COMMANDS = new Set(['open', 'plan', 'serve', 'servers', 'stop', 'doctor', 'help', 'version', 'oneshot', 'dev-run']);
/** The show.mjs subcommand a shell command runs ("open" when it passes a target directly). */
export function showSubcommand(command) {
  const m = String(command ?? '').match(/show\.mjs['"]?\s+([a-z][a-z-]*)\b/);
  return m && SHOW_COMMANDS.has(m[1]) ? m[1] : 'open';
}
/** The arguments of every `show.mjs stop <port|all>` in a shell command. */
export function stopArgs(command) {
  return [...String(command ?? '').matchAll(/show\.mjs['"]?\s+stop\s+['"]?(\d+|all)\b/g)].map((m) => m[1]);
}
/** The port of an http(s) URL, or null. */
export function portOf(url) {
  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) return null;
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch { return null; }
}

/**
 * Does this stream-json event only report that a background task ended? A `system` event of
 * subtype task_notification, or a user message whose text is nothing but <task-notification>
 * blocks (how the harness phrases the same notice to the model). Pure.
 */
export function isTaskNotice(e) {
  if (e?.type === 'system') return e.subtype === 'task_notification';
  if (e?.type !== 'user') return false;
  const c = e.message?.content;
  const texts = typeof c === 'string' ? [c]
    : Array.isArray(c) && c.length && c.every((b) => b?.type === 'text') ? c.map((b) => b.text) : null;
  return !!texts && texts.every((t) => onlyTaskNotifications(String(t ?? '')));
}

/** One or more <task-notification>…</task-notification> blocks and whitespace, nothing else (a linear scan). */
function onlyTaskNotifications(text) {
  const OPEN = '<task-notification>';
  const CLOSE = '</task-notification>';
  let at = 0;
  let blocks = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    if (at === text.length) return blocks > 0;
    if (!text.startsWith(OPEN, at)) return false;
    const end = text.indexOf(CLOSE, at + OPEN.length);
    if (end === -1) return false;
    at = end + CLOSE.length;
    blocks++;
  }
}

/**
 * Did show.mjs open this file through its 8.3 short path? `shortPath: true` in its JSON, or, in
 * file mode, a reason that says so. Pure.
 */
export function usedShortPath(j) {
  if (!j) return false;
  if (j.shortPath === true) return true;
  return j.mode === 'file' && asList(j.reasons).some((r) => /\b8\.3\b|short path/i.test(String(r)));
}

/** Read one session transcript (stream-json lines) into what the judge needs. */
export function analyse(raw) {
  const events = raw.out.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const toolUses = [];
  const results = new Map();
  // The reply judged is the session's FINAL `result`: what the caller of `claude -p` gets. Every
  // turn ends with a `result`; a turn that starts after the first one (the harness answering a
  // background-task notice) is a follow-up, which the judge fails.
  const turnReplies = [];
  let lastText = '';
  let firstReplyAt = -1;
  let lastTextAt = -1;
  let turnOpen = false;
  let followUpTurns = 0;
  let noticeSinceReply = false;
  let followUpAfterNotice = false;
  let taskNotices = 0;
  events.forEach((e, ei) => {
    if (isTaskNotice(e)) { taskNotices++; if (turnReplies.length) noticeSinceReply = true; }
    const content = e.message?.content;
    if (e.type === 'assistant' && Array.isArray(content)) {
      if (!turnOpen && turnReplies.length) {
        followUpTurns++;
        if (noticeSinceReply) followUpAfterNotice = true;
      }
      turnOpen = true;
      content.forEach((b, bi) => { if (b.type === 'tool_use') toolUses.push({ id: b.id, name: b.name, input: b.input, at: ei + bi / 1000 }); });
      const texts = content.map((b, bi) => ({ b, bi })).filter(({ b }) => b.type === 'text' && String(b.text).trim());
      if (texts.length) {
        lastText = texts.map(({ b }) => b.text).join('\n').trim();
        lastTextAt = ei + texts[texts.length - 1].bi / 1000;
      }
    }
    if (e.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'tool_result') {
          const text = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : String(b.content ?? '');
          results.set(b.tool_use_id, text);
        }
      }
    }
    if (e.type === 'result') {
      turnReplies.push(String(e.result ?? ''));
      if (firstReplyAt < 0) firstReplyAt = ei;
      turnOpen = false;
      noticeSinceReply = false;
    }
  });
  // Without a `result` (the session was ended early), the last assistant text is the reply.
  const reply = (turnReplies.length && turnReplies[turnReplies.length - 1].trim()) || lastText;
  const replyAt = firstReplyAt > -1 ? firstReplyAt : lastTextAt;
  const skillCalls = toolUses.filter((t) => t.name === 'Skill');
  const skillIdx = toolUses.findIndex((t) => t.name === 'Skill');
  const afterAll = skillIdx === -1 ? toolUses : toolUses.slice(skillIdx + 1);
  // Budgets count the skill's work. ToolSearch only loads a deferred tool's schema (a harness
  // detail that depends on the client, not on the skill): every one in the transcript, before
  // the Skill call or after it, is counted and reported apart.
  const toolSearches = toolUses.filter((t) => t.name === 'ToolSearch').length;
  const toolSearchesAfterSkill = afterAll.filter((t) => t.name === 'ToolSearch').length;
  const afterSkill = afterAll.filter((t) => t.name !== 'ToolSearch');
  // Every show.mjs call in order, with the JSON it printed (a background call prints none).
  const showCalls = toolUses.filter((t) => t.name === 'Bash' && /show\.mjs/.test(t.input?.command || '')).map((t) => {
    const text = results.get(t.id) || '';
    const start = text.indexOf('{');
    let json = null;
    if (start > -1) { try { json = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)); } catch { /* not a single JSON object */ } }
    const command = String(t.input.command);
    return { id: t.id, at: t.at, command, sub: showSubcommand(command), stops: stopArgs(command), background: !!t.input?.run_in_background, json };
  });
  // The opening result: a plan, stop, servers or doctor call prints JSON without an open.
  const jsons = showCalls.filter((c) => c.json);
  const final = [...jsons].reverse().find((c) => 'opened' in c.json && (c.json.opened || c.json.error));
  const timed = jsons.filter((c) => Number.isFinite(c.json.ms));
  const pluginRootLiteral = showCalls.some((c) => c.command.includes('${CLAUDE_PLUGIN_ROOT}'));
  // What the first show.mjs call planned. A headless served case must get next.oneshot only.
  const firstJson = showCalls[0]?.json || null;
  const plan = firstJson ? {
    sub: showCalls[0].sub,
    mode: firstJson.mode ?? null,
    action: firstJson.action ?? null,
    headless: firstJson.headless === true,
    oneshot: typeof firstJson.next?.oneshot === 'string',
    nextKeys: firstJson.next && typeof firstJson.next === 'object' ? Object.keys(firstJson.next) : [],
    shortPath: usedShortPath(firstJson),
    reasons: asList(firstJson.reasons).map(String),
  } : null;
  // The oneshot call: it serves, opens, verifies, lingers and stops, then reports server.stopped.
  const oneshotCalls = showCalls.filter((c) => c.sub === 'oneshot');
  const lastOneshot = oneshotCalls[oneshotCalls.length - 1];
  const srv = lastOneshot?.json?.server;
  const oneshot = {
    calls: oneshotCalls.length,
    stopped: srv && typeof srv === 'object' ? srv.stopped === true : null,
    port: srv && Number.isFinite(Number(srv.port)) && srv.port !== null ? Number(srv.port) : null,
    lingerMs: srv && Number.isFinite(srv.lingerMs) ? srv.lingerMs : null,
    background: oneshotCalls.some((c) => c.background),
  };
  // `show.mjs stop` calls: what they asked for, what they stopped, and whether they came before
  // the first reply. The headless flow has none (oneshot stops its own server).
  const stopCalls = showCalls.filter((c) => c.stops.length);
  const stopIds = new Set(stopCalls.map((c) => c.id));
  const ports = (list) => asList(list).map((s) => Number(s?.port ?? s)).filter(Number.isFinite);
  const beforeReply = stopCalls.filter((c) => replyAt < 0 || c.at < replyAt);
  const stop = {
    calls: stopCalls.length,
    beforeReply: beforeReply.length,
    args: stopCalls.flatMap((c) => c.stops),
    // A call whose result could not be read stopped nothing that can be shown.
    stoppedPorts: [...new Set(beforeReply.flatMap((c) => ports(c.json?.stopped)))],
    refusedPorts: [...new Set(stopCalls.flatMap((c) => ports(c.json?.refused)))],
    notFound: [...new Set(stopCalls.flatMap((c) => asList(c.json?.notFound).map(String)))],
    unreadable: stopCalls.filter((c) => !c.json).length,
  };
  // The skill's work calls, in order: which show.mjs subcommand each Bash call ran.
  const work = afterSkill.map((t) => {
    const command = String(t.input?.command ?? '');
    const show = t.name === 'Bash' && /show\.mjs/.test(command);
    return { name: t.name, show, sub: show ? showSubcommand(command) : null, background: !!t.input?.run_in_background, command };
  });
  return {
    skills: skillCalls.map((s) => s.input?.skill),
    toolCallsAfterSkill: afterSkill.length,
    toolSearches,
    toolSearchesAfterSkill,
    stopCalls: afterSkill.filter((t) => stopIds.has(t.id)).length,
    rejectedCalls: afterSkill.filter((t) => /rejected|contains quoted characters|permission|denied/i.test(results.get(t.id) || '')).length,
    toolSequence: work.map((w) => (w.name === 'Bash' ? `Bash${w.background ? '(bg)' : ''}: ${w.show ? `show.mjs ${w.sub}` : w.command.slice(0, 90)}` : w.name)),
    work: work.map(({ command, ...w }) => w),
    background: toolUses.some((t) => t.name === 'Bash' && t.input?.run_in_background),
    pluginRootLiteral,
    // The mode the skill's first show.mjs call chose (a served case's later call opens a URL).
    firstMode: firstJson?.mode ?? null,
    plan,
    showCalls: showCalls.map((c) => ({ sub: c.sub, mode: c.json?.mode ?? null, ms: Number.isFinite(c.json?.ms) ? c.json.ms : null, opened: c.json?.opened ?? null, background: c.background })),
    // Script time of the whole case: every show.mjs call that reported one, summed.
    scriptMs: timed.length ? timed.reduce((s, c) => s + c.json.ms, 0) : null,
    final: final?.json || null,
    oneshot,
    stop,
    turns: turnReplies.length,
    followUpTurns,
    followUpAfterNotice,
    taskNotices,
    // Replies of the turns before the final one ([] for a single turn).
    earlierReplies: turnReplies.slice(0, -1),
    reply,
  };
}

/** Every window title a show.mjs result names as its proof (a matched window, never a near miss). */
export function windowTitles(j) {
  const titles = [];
  if (j?.window?.matched === true && typeof j.window.title === 'string') titles.push(j.window.title);
  for (const e of asList(j?.evidence)) {
    const m = String(e).match(/^window "(.*)"(?: \([^)]*\))?(?: — .*)?$/);
    if (m) titles.push(m[1]);
  }
  return [...new Set(titles)];
}

// ---------- reply checks ----------
const HEB = '\\u0590-\\u05FF';
const BIDI = /[‎‏‪-‮⁦-⁩]/g;
// Paths and URLs as a reply may spell them: file:/// or not, %-encoded or not, either slash.
const normRef = (s) => String(s)
  .replace(BIDI, '')
  .replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } })
  .replace(/\\/g, '/')
  .replace(/\/+/g, '/')
  .toLowerCase();

/** Does the reply name the full target: the absolute path, its file:/// URL, or the full URL? */
export function mentionsTarget(reply, target) {
  const want = normRef(target).replace(/\/+$/, '');
  return want.length > 0 && normRef(reply).includes(want);
}

// Words that turn "נפתח" (it opened) earlier in the same sentence into a hedge or a negation:
// "לא נפתח", "לא הצלחתי לאמת שזה נפתח", "ניסיתי…", "אם הוא נפתח", "ייתכן שהוא נפתח".
const HEDGES = new Set(['לא', 'לאמת', 'ניסיתי', 'אם', 'ייתכן', 'יתכן', 'אולי', 'כנראה', 'נראה']);
const isHedge = (word) => HEDGES.has(word) || (/^[ושה]/.test(word) && HEDGES.has(word.slice(1))) || (/^כש/.test(word) && HEDGES.has(word.slice(2)));

/** Does the reply claim that something opened? ("פתחתי", an unhedged "נפתח", or "opened".) */
export function claimsOpened(reply) {
  const t = String(reply).replace(BIDI, '')
    .replace(/\b(?:not|never) (?:been )?opened\b|\b(?:didn't|did not|couldn't|could not|wasn't|was not) (?:open|be opened)\b|\b(?:verify|confirm|check|tell|see) (?:that |whether |if )?(?:it|the \w+) (?:was |had |has )?(?:been )?opened\b/gi, '');
  if (/\bopened\b/i.test(t)) return true;
  if (new RegExp(`(?<!לא )(?<![${HEB}])פתחתי`).test(t)) return true;
  const opens = new RegExp(`(?<![${HEB}])נפתח[הו]?(?![${HEB}])`, 'g');
  for (const sentence of t.split(/[.!?;:](?=\s|$)|\n+/)) {
    for (const m of sentence.matchAll(opens)) {
      const before = sentence.slice(0, m.index).split(new RegExp(`[^${HEB}]+`)).filter(Boolean);
      const prev = before[before.length - 1] || '';
      if (before.some(isHedge) || prev.startsWith('ש')) continue; // "…שזה נפתח" is a subordinate clause
      return true;
    }
  }
  return false;
}

// A reply that could not verify says what was tried and that it could not be confirmed. It never
// guesses how likely it is that the page opened.
const LIKELIHOOD = [
  ['כנראה', new RegExp(`(?<![${HEB}])[ו]?כנראה(?![${HEB}])`)],
  ['סיכוי', /סיכוי/],
  ['נראה ש', new RegExp(`(?<![${HEB}])[וכ]?נראה\\s+ש`)],
  ['probably', /\bprobabl[ey]\b/i],
  ['likely', /\b(?:most\s+)?(?:un)?likely\b/i],
  ['chances are', /\bchances?\s+(?:are|is)\b|\bgood chance\b/i],
];
/** The likelihood words a reply uses ("כנראה", "סיכוי", "נראה ש", "probably", "likely", …). Pure. */
export function likelihoodClaims(reply) {
  const t = String(reply ?? '').replace(BIDI, '');
  return LIKELIHOOD.filter(([, re]) => re.test(t)).map(([word]) => word);
}

/** Is the reply in this language? Hebrew: it has Hebrew letters. English: it has Latin words and no Hebrew. Pure. */
export function replyInLanguage(reply, lang = 'he') {
  const t = String(reply ?? '');
  const hebrew = /[֐-׿]/.test(t);
  return lang === 'en' ? !hebrew && /[A-Za-z]{3}/.test(t) : hebrew;
}

// ---------- judging one case ----------
/** Problems with one case, each in English (console, results.md) and Hebrew (release report). */
export function judge(c, a) {
  const problems = [];
  const bad = (en, he) => problems.push({ en, he });
  const wantOpen = c.expect.opened !== false;
  const served = !!c.expect.served;
  const lang = c.lang || 'he';
  const j = a.final;

  if (!a.skills.some((s) => /show/.test(s || ''))) bad('show-local skill not invoked', 'הסקיל של show-local לא הופעל');
  if (a.firstMode !== c.mode) {
    bad(`first show.mjs call chose mode ${a.firstMode ?? '(none)'}, expected ${c.mode}${c.planWhy ? ` (${c.planWhy})` : ''}`,
      `הקריאה הראשונה ל-show.mjs בחרה מצב ${a.firstMode ?? '(אין)'} ולא ${c.mode}`);
  }
  if (!j) bad('no show.mjs result found', 'לא נמצאה תוצאה של show.mjs');
  else if (!wantOpen) {
    if (j.opened || j.verified === true) bad('failure case reported as opened', 'מקרה הכשל דווח כאילו נפתח');
    if (!j.error) bad('failure case carries no error code', 'במקרה הכשל אין קוד שגיאה');
  } else if (j.opened !== true) {
    bad(`expected it to open, got ${j.error || `opened: ${j.opened}`}`, `היה צריך להיפתח, והתקבל ${j.error || 'opened: false'}`);
  } else {
    if (c.expect.verified === true && j.verified !== true) bad(`expected verified, got ${j.verified}`, `היה צריך לאמת, והתקבל verified: ${j.verified}`);
    if (c.expect.verified === false && j.verified !== false) bad(`expected verified: false, got ${j.verified}`, `האימות היה צריך להיכשל, והתקבל verified: ${j.verified}`);
    // Dev servers have no access log show-local can read: their proof is the HTTP answer and
    // the window title (a declared limit), so only static serving must quote a GET.
    if (served && c.mode !== 'dev' && !(j.evidence || []).some((e) => /server log: .*GET/.test(e))) bad('no server-log GET evidence', 'אין ביומן השרת GET מהדפדפן');
    // The window that proves it must show the page itself, not whichever tab changed.
    if (c.expect.titleIncludes) {
      const want = normTitle(c.expect.titleIncludes);
      const titles = windowTitles(j);
      if (!titles.some((t) => normTitle(t).includes(want))) {
        bad(`no window in the proof has "${c.expect.titleIncludes}" in its title (${titles.length ? `windows: ${titles.map((t) => `"${t}"`).join(', ')}` : 'no window named'})`,
          `כותרת החלון שבהוכחה לא מכילה את כותרת הדף, "${c.expect.titleIncludes}"`);
      }
    }
  }

  // Over the limit with an 8.3 short path: file mode through it, and the reply still gives the
  // real full path (checked with the target below).
  if (c.expect.shortPath && a.firstMode === 'file' && !a.plan?.shortPath && !usedShortPath(j)) {
    bad('the file was not opened through its 8.3 short path (no shortPath: true, no reason that says so)', 'הקובץ לא נפתח דרך הנתיב המקוצר (8.3)');
  }
  // The served fallback for a long path says that its link lives only as long as the session.
  if (c.expect.servedReason && a.firstMode === 'serve' && !asList(a.plan?.reasons).some((r) => /session/i.test(r))) {
    bad('the served fallback gives no reason saying the link works only while the session is open', 'בנפילה למצב שרת אין סיבה שאומרת שהקישור עובד רק כל עוד הסשן פתוח');
  }

  // The fixture really has the length the case is named for.
  const rule = c.expect.pathLength;
  if (rule && Number.isFinite(c.pathLength)) {
    const n = c.pathLength;
    const wrong = [
      Number.isFinite(rule.exact) && n !== rule.exact && `not exactly ${rule.exact}`,
      Number.isFinite(rule.atMost) && n > rule.atMost && `over ${rule.atMost}`,
      Number.isFinite(rule.over) && !(n > rule.over) && `not over ${rule.over}`,
    ].filter(Boolean);
    if (wrong.length) bad(`the fixture path is ${n} characters, ${wrong.join(' and ')}`, `הנתיב של קובץ הבדיקה הוא ${n} תווים, ולא כנדרש`);
  } else if (rule) {
    bad('the fixture path length was not measured', 'אורך הנתיב של קובץ הבדיקה לא נמדד');
  }

  // No new Edge browser process, no Edge process with the fixture, no Edge window with the page.
  if (c.expect.notInEdge) {
    const e = a.edge;
    if (!e || !e.cmdChecked) {
      bad('Edge was not checked: the msedge process list could not be read', 'לא נבדק אם Edge נפתח: רשימת תהליכי msedge לא נקראה');
    } else {
      if (e.before.withFixture) {
        bad(`${e.before.withFixture} msedge process(es) already had the fixture on their command line before the case, so the case cannot show that Edge stayed out`,
          'תהליך msedge קיבל את קובץ הבדיקה עוד לפני המקרה, ולכן המקרה לא יכול להראות ש-Edge לא נפתח');
      } else if (e.withFixture) {
        bad(`${e.withFixture} msedge process(es) have the fixture on their command line`, `${e.withFixture} תהליכי msedge קיבלו את קובץ הבדיקה בשורת הפקודה`);
      }
      if (e.newBrowserProcesses) {
        bad(`${e.newBrowserProcesses} new Edge browser process(es) started during the case (pid ${e.newBrowser.map((p) => p.pid).join(', ')})`,
          `במהלך המקרה נפתחו ${e.newBrowserProcesses} תהליכי דפדפן Edge חדשים`);
      }
    }
    if (c.title) {
      const q = `"${c.title}"`;
      if (!e || !e.listed) {
        bad('Edge windows were not checked: the list of windows could not be read', 'לא נבדק אם הדף הופיע בחלון Edge: רשימת החלונות לא נקראה');
      } else if (e.before.matching.length) {
        bad(`an Edge window already showed ${q} before the case, so the case cannot show that Edge stayed out`,
          `חלון Edge הציג את ${q} עוד לפני המקרה, ולכן המקרה לא יכול להראות שהדף לא נפתח ב-Edge`);
      } else if (e.after.matching.length) {
        bad(`the page opened in Edge too: ${e.after.matching.map((t) => `"${t}"`).join(', ')}`, `הדף נפתח גם ב-Edge: חלון Edge מציג את ${q}`);
      }
    }
  }

  // A file:/// page belongs to the browser, not to the session: it stays after the session exits.
  if (c.expect.survivesSession && a.survivesSession !== true) {
    bad(a.survivesSession === false ? 'the page\'s window was gone once the session had exited' : 'whether the page outlived the session could not be checked',
      a.survivesSession === false ? 'חלון הדף לא נשאר פתוח אחרי שהסשן נסגר' : 'לא נבדק אם חלון הדף נשאר אחרי שהסשן נסגר');
  }

  // Every case: the reply judged is the final one, and nothing runs on after it.
  if (a.followUpTurns) {
    bad(`${a.followUpTurns} more turn(s) ran after the first reply${a.followUpAfterNotice ? ', after a background-task notice' : ''}`,
      `אחרי התשובה רצו עוד ${a.followUpTurns} תורות${a.followUpAfterNotice ? ', בעקבות הודעה על משימת רקע' : ''}`);
  }
  if (a.background) bad('a Bash call ran with run_in_background', 'קריאת Bash רצה ברקע (run_in_background)');

  // Headless served: the plan offers next.oneshot only, the skill runs exactly the plan call and
  // the oneshot call, oneshot stops its server, the port is free afterwards and the session exits.
  const port = portOf(j?.url) ?? a.oneshot?.port ?? null;
  if (served) {
    if (!a.plan?.oneshot) {
      bad(`the plan offers no next.oneshot (headless: ${a.plan?.headless ?? 'no plan'}, next: ${a.plan?.nextKeys?.join(', ') || 'none'})`,
        'התוכנית לא הציעה next.oneshot (הריצה לא זוהתה כריצה בלי ממשק)');
    } else if (a.plan.nextKeys.length !== 1) {
      bad(`the headless plan's next must hold oneshot only, it holds ${a.plan.nextKeys.join(', ')}`, 'בריצה בלי ממשק next צריך להכיל רק oneshot');
    }
    const w = a.work || [];
    const flowOk = w.length === 2 && w[0].show && ['open', 'plan'].includes(w[0].sub) && !w[0].background
      && w[1].show && w[1].sub === 'oneshot' && !w[1].background;
    if (!flowOk) {
      const flow = w.map((x) => (x.show ? `show.mjs ${x.sub}${x.background ? ' (background)' : ''}` : x.name)).join(' → ') || 'nothing';
      bad(`headless served case: the Bash work must be exactly the plan call and the oneshot call, got ${flow}`,
        `בריצה בלי ממשק העבודה צריכה להיות בדיוק קריאת התוכנית וקריאת oneshot, והתקבל ${flow}`);
    }
    if (a.oneshot?.calls) {
      if (a.oneshot.stopped !== true) bad('oneshot did not report server.stopped: true', 'oneshot לא דיווח server.stopped: true');
      else if (port && a.oneshot.port !== null && a.oneshot.port !== port) {
        bad(`oneshot stopped port ${a.oneshot.port}, but the page was on port ${port}`, `oneshot עצר את פורט ${a.oneshot.port}, אבל הדף היה בפורט ${port}`);
      }
    }
    if (port && a.portFreeAfter === false) bad(`port ${port} still answered after the session had exited`, `פורט ${port} עדיין ענה אחרי שהסשן הסתיים`);
    else if (port && a.portFreeAfter == null) bad(`whether port ${port} was free after the session could not be checked`, `לא נבדק אם פורט ${port} התפנה אחרי הסשן`);
    if (a.endedBy && a.endedBy !== 'itself') {
      bad(`the session did not exit by itself (${ENDED[a.endedBy] || a.endedBy})`, 'הסשן לא הסתיים בעצמו');
    }
  }

  // Budget, for every case.
  const budget = served ? BUDGETS.served : BUDGETS.direct;
  const kind = served ? 'served' : 'direct';
  const kindHe = served ? 'מצב שרת' : 'פתיחה ישירה';
  const work = a.toolCallsAfterSkill;
  if (work > budget.calls) {
    bad(`${kind} mode used ${work} work calls (budget ${budget.calls})`, `${kindHe}: ${work} קריאות (התקציב ${budget.calls})`);
  }
  if (a.scriptMs === null) bad('no script time was reported', 'הסקריפט לא דיווח על זמן');
  else if (a.scriptMs > budget.ms) {
    bad(`${kind} mode took ${a.scriptMs} ms of script time (budget ${budget.ms})`, `${kindHe}: ${a.scriptMs} ms (התקציב ${budget.ms})`);
  }
  if (a.rejectedCalls) bad(`${a.rejectedCalls} tool call(s) rejected by the harness`, `${a.rejectedCalls} קריאות נדחו על ידי סביבת ההרצה`);

  // The reply: the session's final `result`.
  if (!replyInLanguage(a.reply, lang)) {
    bad(lang === 'en' ? 'reply is not in English' : 'reply is not in Hebrew', lang === 'en' ? 'התשובה לא באנגלית' : 'התשובה לא בעברית');
  }
  if (wantOpen) {
    // Something opened (verified or not): the reply names it in full, so the user can reach it.
    const target = served ? j?.url : c.target;
    if (served && !/^https?:\/\//.test(target || '')) bad('served case has no http URL in the result', 'למקרה השרת אין כתובת http בתוצאה');
    else if (!target) bad('case has no target to look for', 'למקרה אין יעד לבדיקה');
    else if (!mentionsTarget(a.reply, target)) {
      bad(`reply does not give the full ${served ? 'URL' : 'path or file:// URL'} (${target})`,
        `התשובה לא נותנת את ${served ? 'הכתובת המלאה' : 'הנתיב המלא או קישור file://'}`);
    }
  }
  if ((!wantOpen || c.expect.verified === false) && claimsOpened(a.reply)) {
    bad('the reply claims it opened', 'התשובה טוענת שזה נפתח');
  }
  if (wantOpen && c.expect.verified === false) {
    const said = lang === 'en' ? /\btried\b|\bcould(?: not|n't) (?:verify|confirm)\b/i : /ניסיתי|לא הצלחתי לאמת/;
    if (!said.test(a.reply)) {
      bad(`unverified reply does not say ${lang === 'en' ? '"tried" or "could not verify"' : '"ניסיתי" or "לא הצלחתי לאמת"'}`, 'התשובה לא אומרת "ניסיתי" או "לא הצלחתי לאמת"');
    }
    const guesses = likelihoodClaims(a.reply);
    if (guesses.length) {
      bad(`the unverified reply guesses instead of saying it could not be confirmed (${guesses.map((g) => `"${g}"`).join(', ')})`,
        `התשובה משערת במקום לומר שלא ניתן היה לאמת (${guesses.join(', ')})`);
    }
  }
  // A page opened as a file (8.3 short form included) needs no session: the reply must not tie
  // it to one, and must never shorten the path it links.
  if (!served && (a.finalMode === 'file' || a.firstMode === 'file')
    && /(?:רק\s+)?כל\s+עוד\s+ה?סשן|\bonly while\b|\bwhile (?:this|the) session\b/i.test(a.reply)) {
    bad('the reply ties a file to the session (a file keeps working after it)', 'התשובה קושרת קובץ לסשן, אף שקובץ ממשיך לעבוד אחריו');
  }
  if (/`[^`]*(?:\\|\/)(?:\.\.\.|…)(?:\\|\/)[^`]*`/.test(a.reply)) {
    bad('the reply shortens the path with "..."', 'התשובה מקצרת את הנתיב עם "..."');
  }
  // Headless: the reply says the server was stopped, and never that it still runs.
  if (served && a.oneshot?.stopped === true) {
    if (!/עצרתי|הפסקתי|כיביתי|סגרתי את השרת|נעצר|נסגר|stopped|shut down/i.test(a.reply)) {
      bad('headless served reply does not say the server was stopped', 'התשובה לא אומרת שהשרת נעצר');
    }
    if (/(?<![א-ת])(?<!היה )(?:חי|רץ|פועל|ממשיך לרוץ|ימשיך לרוץ)\s+כל\s+עוד|\b(?:still running|keeps running|runs as long as|works while)\b/i.test(a.reply)) {
      bad('the reply says the server still runs, after it was stopped', 'התשובה אומרת שהשרת עדיין חי, אחרי שהוא נעצר');
    }
  }
  return problems;
}

// ---------- results ----------
/** Local paths shown as <fixtures>/…, <session-fixtures>/… and <repo>/… (either slash, any case). */
function tidy(s) {
  let t = String(s ?? '').replace(/\\/g, '/');
  for (const [p, label] of [[FX, '<fixtures>'], [sessionFixtureRoot().root, '<session-fixtures>'], [ROOT, '<repo>']]) {
    const needle = p.replace(/\\/g, '/').toLowerCase();
    let i;
    while ((i = t.toLowerCase().indexOf(needle)) > -1) t = t.slice(0, i) + label + t.slice(i + needle.length);
  }
  return t;
}

const weakWhy = (reason) => {
  if (/not known in advance/.test(reason)) return 'page title not known in advance';
  if (/already open/.test(reason)) return 'a window with this title was already open';
  if (/did not contain the expected text/.test(reason)) return 'title lacks the expected text';
  return reason.length > 60 ? `${reason.slice(0, 57)}…` : reason;
};

/** One short line of proof from a show.mjs result, for the results table. */
export function shortEvidence(j) {
  if (!j) return '—';
  if (j.opened === false && j.error) return tidy(`nothing opened: ${j.error}${j.detail ? ` — ${j.detail}` : ''}`);
  const items = (j.evidence || []).map((e) => {
    let m;
    if ((m = e.match(/^server log: \S+ (GET \S+ \d{3})/))) return `server log ${m[1]}`;
    if ((m = e.match(/^file manager window on (.+?)(?:, selected: (.+?))?(?: — .*)?$/))) return `file manager on ${m[1]}${m[2] ? `, selected ${m[2]}` : ''}`;
    if ((m = e.match(/^(window "[^"]*")(?: \([^)]*\))?(?: — (.*))?$/))) return `${m[1]}${m[2] ? ` (weak: ${weakWhy(m[2])})` : ''}`;
    return e.length > 100 ? `${e.slice(0, 97)}…` : e;
  });
  return items.length ? tidy(items.join('; ')) : '—';
}

const cell = (s) => String(s ?? '—').replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

const ENDED = {
  itself: 'session exited by itself',
  'runner-after-reply': 'runner ended the session 4 s after its final result',
  'runner-guard': 'runner ended the session at the 8-minute guard',
  'did-not-start': 'session did not start',
};

/**
 * The Edge accounting of one case in one line: 'Edge: before N → after M (new browser
 * processes: X, with the fixture: Y; new child processes: Z are Edge's own background work)'. Pure.
 */
export function edgeLine(e) {
  if (!e) return 'Edge: not checked';
  if (!e.cmdChecked) return 'Edge: could not be checked (the msedge process list was not read)';
  if (!Number.isFinite(e.newBrowserProcesses)) {
    // A row from before the runner told new processes apart.
    return `Edge: before ${e.before?.edgeProcesses ?? '?'} → after ${e.after?.edgeProcesses ?? '?'} msedge processes (older run: new processes not told apart)`;
  }
  const own = e.newChildrenOfRunningEdge;
  const kids = own === e.newChildProcesses
    ? `new child processes: ${e.newChildProcesses} are Edge's own background work`
    : `new child processes: ${e.newChildProcesses}, of which ${e.newChildProcesses - own} belong to a new browser process`;
  const extra = [
    e.before?.withFixture ? 'the fixture was already in Edge before the case' : null,
    e.after?.matching?.length ? `an Edge window shows "${e.title}"` : null,
    e.before?.matching?.length ? `an Edge window already showed "${e.title}" before the case` : null,
  ].filter(Boolean);
  return `Edge: before ${e.before.edgeProcesses} → after ${e.after.edgeProcesses} (new browser processes: ${e.newBrowserProcesses}, with the fixture: ${e.withFixture}; ${kids})${extra.length ? `; ${extra.join('; ')}` : ''}`;
}

/** The checks beyond the result JSON, in one short English line (results.md). */
export function extraChecks(r) {
  const out = [];
  if (Number.isFinite(r.pathLength)) out.push(`path ${r.pathLength} chars`);
  if (r.expect?.shortPath || r.shortPath) out.push(`8.3 short path used: ${r.shortPath ? 'yes' : 'no'}`);
  if (r.titleCheck) out.push(`title has "${r.titleCheck.want}": ${r.titleCheck.ok ? 'yes' : 'no'}`);
  if (r.edge) out.push(edgeLine(r.edge));
  else if (r.expect?.notInEdge) out.push('Edge: not checked');
  if ('survivesSession' in r) out.push(`window still there after the session: ${r.survivesSession === true ? 'yes' : r.survivesSession === false ? 'NO' : 'not checked'}`);
  if (r.expect?.served) {
    const o = r.oneshot;
    if (o && o.calls) {
      out.push(`oneshot: ${o.stopped ? `server stopped${o.port ? ` on port ${o.port}` : ''}` : 'server NOT reported stopped'}${Number.isFinite(o.lingerMs) ? `, linger ${o.lingerMs} ms` : ''}`);
    } else if (o) out.push('oneshot: never called');
    else if (r.stop) out.push(`stop before reply: ${r.stop.stoppedPorts?.length ? `port ${r.stop.stoppedPorts.join(', ')} stopped` : 'nothing stopped'} (older run)`);
    if ('portFreeAfter' in r) out.push(`port free after the session: ${r.portFreeAfter === true ? 'yes' : r.portFreeAfter === false ? 'NO' : 'not checked'}`);
  }
  if (r.followUpTurns) out.push(`${r.followUpTurns} follow-up turn(s)${r.followUpAfterNotice ? ' after a background-task notice' : ''}`);
  if (r.endedBy) out.push(ENDED[r.endedBy] || r.endedBy);
  return out.join('; ') || '—';
}

const runLabel = (at) => (at ? String(at).replace('T', ' ').replace(/:\d\d\.\d+Z$/, 'Z') : 'older runner, no timestamp');

/**
 * Fold one run's rows into the previous results. A case this run did replaces its old row; every
 * other old row stays exactly as it was, with its own run timestamp and cleanup record; a row
 * whose case no longer exists (`knownIds`) is dropped; rows follow today's case order. Runs are
 * kept while a row still comes from them. Pure.
 */
export function mergeResults(prev, rows, run, knownIds = null) {
  const known = knownIds ? new Set(knownIds) : null;
  const old = asList(prev?.rows).filter((r) => r && (!known || known.has(r.id)));
  const fresh = new Map(rows.map((r) => [r.id, r]));
  const merged = old.map((r) => fresh.get(r.id) || r);
  for (const r of rows) if (!old.some((p) => p.id === r.id)) merged.push(r);
  if (knownIds) {
    const order = new Map(knownIds.map((id, i) => [id, i]));
    merged.sort((x, y) => (order.get(x.id) ?? 1e9) - (order.get(y.id) ?? 1e9));
  }
  const used = new Set(merged.map((r) => r.runAt).filter(Boolean));
  const runs = [...asList(prev?.runs).filter((x) => x && used.has(x.runAt) && x.runAt !== run.runAt), run];
  return { rows: merged, runs };
}

/** Every cleanup line of the rows and runs, flat, each saying which case and run it belongs to. Pure. */
export function cleanupLines(rows, runs = []) {
  const out = [];
  for (const r of rows) for (const l of asList(r.cleanup?.closed)) out.push(`${r.id} (run ${runLabel(r.runAt)}): ${l}`);
  for (const run of runs) for (const l of asList(run.finalSweep)) out.push(`end of run ${runLabel(run.runAt)}: ${l}`);
  return out;
}

export function renderMarkdown(summary) {
  const { rows, passed } = summary;
  const runs = asList(summary.runs);
  const opened = (r) => (r.opened === false ? `— (not opened${r.error ? `: ${r.error}` : ''})` : r.openedWith ?? '—');
  const verified = (r) => {
    if (r.opened === false) return '— (nothing to verify)';
    if (r.verified === true) return `yes (${r.confidence ?? 'no confidence given'})`;
    if (r.verified === false) return 'no';
    return 'not checked';
  };
  const calls = (r) => `${r.toolCallsAfterSkill} (+${r.toolSearches ?? 0} ToolSearch)`;
  const undated = rows.filter((r) => !r.runAt).map((r) => r.id);
  const runCount = runs.length + (undated.length ? 1 : 0);
  const runLines = runs.map((x) => `- ${runLabel(x.runAt)}: model ${x.model || '?'}, ${rows.filter((r) => r.runAt === x.runAt).map((r) => r.id).join(', ') || 'no rows left'}`);
  const cleanupSection = rows.map((r) => {
    const lines = asList(r.cleanup?.closed);
    if (!r.cleanup) return `- ${r.id} (run ${runLabel(r.runAt)}): no cleanup record (older runner)`;
    return lines.length ? lines.map((l) => `- ${r.id} (run ${runLabel(r.runAt)}): ${tidy(l)}`).join('\n') : `- ${r.id} (run ${runLabel(r.runAt)}): nothing needed closing`;
  });
  const sweeps = runs.map((x) => (asList(x.finalSweep).length
    ? asList(x.finalSweep).map((l) => `- end of run ${runLabel(x.runAt)}: ${tidy(l)}`).join('\n')
    : `- end of run ${runLabel(x.runAt)}: nothing left to close`));
  return [
    `# show-local e2e — ${passed}/${rows.length} passed (written ${summary.date})`, '',
    runCount > 1
      ? `These rows come from ${runCount} runs: a subset run replaces its own cases and keeps the other rows as they were. Each row names its run.`
      : 'These rows come from one run.',
    ...runLines,
    ...(undated.length ? [`- ${runLabel(null)}: ${undated.join(', ')}`] : []), '',
    `Budgets, enforced for every case: direct ${BUDGETS.direct.calls} work call and ≤ ${BUDGETS.direct.ms} ms; served ≤ ${BUDGETS.served.calls} work calls and ≤ ${BUDGETS.served.ms} ms of script time (summed over the case's show.mjs calls). Mode is the one the first show.mjs call chose. ToolSearch calls are counted over the whole transcript, outside the budget.`, '',
    'Checks: the reply judged is the session\'s final result, and a follow-up turn or a run_in_background call fails the case. Url, file and folder cases list every msedge.exe process (pid, parent pid, command line) and every visible window before and after: no new Edge browser process, no msedge command line with the fixture, no Edge window with the page (new child processes of an Edge that was already running are its own background work, reported only). File cases check that the page\'s window is still there after `claude -p` exited (required for 2-file). 1-url must be proven by a window whose title has the page title. Served cases run headless: the plan offers `next.oneshot` only, the skill runs exactly the plan call and the oneshot call, oneshot reports the server stopped, the port is free after the session, the session exits by itself, and the reply says the server was stopped. Dev servers have no readable access log, so their proof is the HTTP answer and the window title. 9b and 14 are over 256 characters: file mode through the 8.3 short path when the runner measured one, else the served fallback. 11 must not guess (no "probably", "כנראה", "סיכוי").', '',
    '| Case | Run | Mode (first call) | Opened with | Verified | Evidence (short) | Checks | ms | Calls (+ToolSearch) | Result |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.id)} | ${cell(runLabel(r.runAt))} | ${cell(r.firstMode ?? '—')} | ${cell(opened(r))} | ${cell(verified(r))} | ${cell(r.evidenceShort ?? '—')} | ${cell(extraChecks(r))} | ${cell(r.scriptMs ?? '—')} | ${cell(calls(r))} | ${cell(r.pass ? 'PASS' : `FAIL: ${tidy(r.problems.join('; '))}`)} |`),
    '', '## Cleanup', '',
    'After each case: Explorer windows on a fixture folder, programs running from the fixtures, and app windows whose title has one of that run\'s fixture file names. Browser tabs stay open.', '',
    ...cleanupSection, ...sweeps, '',
  ].join('\n');
}

// ---------- cleanup ----------
// Closes only what the tests made: Explorer windows whose folder is inside a fixture root,
// programs other than browsers and Explorer whose command line names a fixture root, the fixture
// dev app by its port and file, and app windows whose title contains one of this run's fixture
// FILE names (each carries RUN_TAG). Never a window found by a generic word.
const CLEANUP_PS = String.raw`$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$rootList = $env:E2E_ROOTS | ConvertFrom-Json
$roots = @(foreach ($r in $rootList) { ([string]$r).Replace('/', '\').TrimEnd('\').ToLowerInvariant() + '\' })
$tokenList = $env:E2E_TOKENS | ConvertFrom-Json
$tokens = @(foreach ($t in $tokenList) { $s = ([string]$t).ToLowerInvariant(); if ($s) { $s } })
$self = @([int]$env:E2E_SELF, $PID)
function Inside([string]$p) { if (-not $p) { return $false }; $l = $p.Replace('/', '\').TrimEnd('\').ToLowerInvariant() + '\'; foreach ($r in $roots) { if ($l.StartsWith($r)) { return $true } }; return $false }
function Names([string]$c) { if (-not $c) { return $false }; $l = $c.Replace('/', '\').ToLowerInvariant(); foreach ($r in $roots) { if ($l.Contains($r)) { return $true } }; return $false }
$sh = New-Object -ComObject Shell.Application
foreach ($w in @($sh.Windows())) { try { if ($w.FullName -match "explorer\.exe$") { $loc = ([uri]$w.LocationURL).LocalPath; if (Inside $loc) { $w.Quit(); "closed explorer: " + $loc } } } catch {} }
Add-Type -Namespace E2E -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'
foreach ($p in Get-Process) { if (-not $p.MainWindowTitle) { continue }; if ($p.ProcessName -match "^(chrome|msedge|firefox|brave|opera|vivaldi|explorer)$") { continue }; $title = $p.MainWindowTitle.ToLowerInvariant(); foreach ($k in $tokens) { if ($title.Contains($k)) { [void][E2E.W]::PostMessage($p.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); "closed " + $p.ProcessName + ": " + $p.MainWindowTitle; break } } }
foreach ($c in @(Get-NetTCPConnection -LocalPort 5199 -State Listen -ErrorAction SilentlyContinue)) { $o = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess); if ($o -and $o.CommandLine -match "server\.cjs") { Stop-Process -Id $o.ProcessId -Force; "stopped fixture dev app " + $o.ProcessId } }
foreach ($p in Get-CimInstance Win32_Process) { if ($self -contains [int]$p.ProcessId) { continue }; if ($p.Name -match "^(chrome|msedge|firefox|brave|opera|vivaldi|explorer)\.exe$") { continue }; if (Names $p.CommandLine) { $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; if ($gp -and $gp.MainWindowHandle -ne 0) { [void]$gp.CloseMainWindow(); Start-Sleep -Milliseconds 800 }; if ($gp -and -not $gp.HasExited) { Stop-Process -Id $p.ProcessId -Force }; "ended " + $p.Name + " " + $p.ProcessId + " (ran from the fixtures)" } }`;

/**
 * Run the cleanup for these fixture roots and file names. Returns one line per thing it closed or
 * ended, plus a "cleanup error" line when PowerShell complained, so a broken cleanup shows in the
 * record instead of reading as "nothing needed closing". Windows only.
 */
export function cleanup({ roots, tokens }) {
  const r = spawnSync('powershell.exe', [...PS, '-EncodedCommand', encoded(CLEANUP_PS)], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, E2E_ROOTS: JSON.stringify(roots), E2E_TOKENS: JSON.stringify(tokens), E2E_SELF: String(process.pid) },
  });
  const lines = (r.stdout || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // PowerShell reports progress on stderr as CLIXML: that is not an error.
  const err = String(r.stderr || r.error || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^#< CLIXML|^<Objs /.test(l));
  return err ? [...lines, `cleanup error: ${err}`] : lines;
}

// ---------- main ----------
async function main() {
  if (process.platform !== 'win32') {
    console.log('e2e: Windows only for now (window verification needs a desktop). Unit tests run everywhere: npm test');
    process.exit(0);
  }
  mkdirSync(OUT, { recursive: true });
  const runAt = new Date().toISOString();
  const fx = buildFixtures();
  const roots = [FX, fx.sessionRoot];
  const tokens = cleanupTokens(fx);
  const known = cases(fx);
  const all = known.filter((c) => !ONLY.length || ONLY.some((o) => selects(c.id, o)));
  const rows = [];
  for (const c of all) {
    process.stdout.write(`▶ ${c.id} … `);
    const caseAt = new Date().toISOString();
    const before = await desktopLook();
    const raw = await runClaude(c.prompt, FX, c.env);
    writeFileSync(path.join(OUT, `${c.id}.jsonl`), raw.out);
    const a = analyse(raw);
    a.endedBy = raw.endedBy;
    const j = a.final || {};
    // What is left once the session has exited: the page's window, the server's port, Edge.
    await sleep(1500);
    const after = await desktopLook();
    if (c.mode === 'file' && a.firstMode === 'file' && j.opened === true) a.survivesSession = survives(after, { title: c.title, process: proofProcess(j) });
    const port = portOf(j.url) ?? a.oneshot.port;
    if (c.expect.served && port) a.portFreeAfter = await portFree(port);
    const needles = [...(c.edgeNeedles || (c.target && !/^https?:/i.test(c.target) ? [path.basename(c.target)] : []))];
    if (c.fixture) needles.push(path.basename(c.fixture));
    if (c.expect.served && /^https?:/i.test(j.url || '')) needles.push(new URL(j.url).host);
    a.edge = edgeCheck(before, after, { title: c.title ?? null, needles: [...new Set(needles)] });
    const problems = judge(c, a);
    const cleanupAt = new Date().toISOString();
    const closed = cleanup({ roots, tokens });
    const titleWant = c.expect.titleIncludes;
    const row = {
      id: c.id, runAt, caseAt, expectedMode: c.mode, prompt: c.prompt, expect: c.expect,
      ...(c.lang ? { lang: c.lang } : {}), ...(c.env ? { env: c.env } : {}),
      ...(c.title ? { title: c.title } : {}), ...(Number.isFinite(c.pathLength) ? { pathLength: c.pathLength } : {}),
      ...(c.planWhy ? { planWhy: c.planWhy } : {}),
      pass: problems.length === 0, problems: problems.map((p) => p.en), problemsHe: problems.map((p) => p.he),
      mode: a.firstMode, firstMode: a.firstMode, finalMode: j.mode ?? null,
      opened: j.opened ?? null, openedWith: j.openedWith ?? null, verified: j.verified ?? null, confidence: j.confidence ?? null,
      error: j.error ?? null, detail: j.detail ?? null, url: j.url ?? null,
      ...(c.mode === 'file' || c.expect.shortPath ? { shortPath: !!(a.plan?.shortPath || usedShortPath(a.final)) } : {}),
      evidence: j.evidence ?? [], evidenceShort: shortEvidence(a.final),
      ...(titleWant ? { titleCheck: { want: titleWant, ok: windowTitles(j).some((t) => normTitle(t).includes(normTitle(titleWant))) } } : {}),
      edge: a.edge,
      ...('survivesSession' in a ? { survivesSession: a.survivesSession } : {}),
      plan: a.plan, oneshot: a.oneshot, ...('portFreeAfter' in a ? { portFreeAfter: a.portFreeAfter } : {}),
      stop: a.stop, stopCalls: a.stopCalls, endedBy: raw.endedBy,
      turns: a.turns, followUpTurns: a.followUpTurns, followUpAfterNotice: a.followUpAfterNotice,
      ...(a.earlierReplies.length ? { earlierReplies: a.earlierReplies } : {}),
      scriptMs: a.scriptMs, finalMs: j.ms ?? null, showCalls: a.showCalls, sessionMs: raw.ms,
      skills: a.skills, toolCallsAfterSkill: a.toolCallsAfterSkill, toolSearches: a.toolSearches, toolSearchesAfterSkill: a.toolSearchesAfterSkill,
      rejectedCalls: a.rejectedCalls, background: a.background,
      toolSequence: a.toolSequence, pluginRootLiteral: a.pluginRootLiteral, reply: a.reply,
      cleanup: { at: cleanupAt, closed },
    };
    rows.push(row);
    console.log(row.pass
      ? `PASS (${a.firstMode}, ${j.openedWith || j.error}, ${a.scriptMs} ms, ${a.toolCallsAfterSkill} calls; ${extraChecks(row)})`
      : `FAIL: ${row.problems.join('; ')}`);
  }
  // A last sweep, for anything that came up after its case's own cleanup.
  const run = { runAt, model: MODEL || 'sonnet', cases: rows.map((r) => r.id), finalSweep: cleanup({ roots, tokens }) };
  let merged = { rows, runs: [run] };
  // Running a subset (e.g. `run-e2e.mjs 10`) updates those rows in the last results; every
  // other row keeps its own run timestamp and cleanup record.
  if (ONLY.length && existsSync(path.join(OUT, 'results.json'))) {
    try {
      merged = mergeResults(JSON.parse(readFileSync(path.join(OUT, 'results.json'), 'utf8')), rows, run, known.map((c) => c.id));
    } catch { /* no usable previous results: keep this run only */ }
  }
  const passed = merged.rows.filter((r) => r.pass).length;
  const summary = {
    date: new Date().toISOString(), model: MODEL || 'sonnet', budgets: BUDGETS, passed, total: merged.rows.length,
    runs: merged.runs, closedAfter: cleanupLines(merged.rows, merged.runs), rows: merged.rows,
  };
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(OUT, 'results.md'), renderMarkdown(summary));
  console.log(`\n${passed}/${merged.rows.length} passed. Details: ${path.relative(ROOT, path.join(OUT, 'results.md'))}`);
  process.exit(passed === merged.rows.length ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return path.resolve(process.argv[1] || '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase(); } catch { return false; }
})();
if (invokedDirectly) await main();
