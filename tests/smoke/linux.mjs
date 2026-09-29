// Linux smoke run, for GitHub's Ubuntu runner. It runs show.mjs for real, with stand-ins for
// the desktop programs it hands things to (xdg-open, gdbus, xdg-settings and the browser named
// by a .desktop file), placed first on PATH. Each stand-in only writes down what it was given.
// The checks: pages reach the default browser's own Exec line, documents reach xdg-open,
// folders reach the file manager over D-Bus, and nothing runnable (a script, a .desktop
// launcher, a link or a macro document named like something else) is ever handed to anything
// but the file manager's "show this item".
//
//   node tests/smoke/linux.mjs          (CI only: refuses to run unless CI=true)
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'linux' || process.env.CI !== 'true') {
  console.error('linux.mjs runs only on a Linux CI runner');
  process.exit(2);
}

const SHOW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/show-local/scripts/show.mjs');
const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'show-local-smoke-')));
const bin = path.join(work, 'bin');
const share = path.join(work, 'share');
const log = path.join(work, 'handed.log');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const put = (file, text, mode) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); if (mode) chmodSync(file, mode); return file; };

// Stand-ins: each appends "<program>\t<arg>\t<arg>…" to the log and succeeds.
const recorder = (name) => put(path.join(bin, name), `#!/bin/sh\nprintf '%s' "${name}" >> "${log}"\nfor a in "$@"; do printf '\\t%s' "$a" >> "${log}"; done\nprintf '\\n' >> "${log}"\n`, 0o755);
for (const name of ['xdg-open', 'gdbus', 'fake-browser']) recorder(name);
put(path.join(bin, 'xdg-settings'), '#!/bin/sh\n[ "$1 $2" = "get default-web-browser" ] && echo fake-browser.desktop\n', 0o755);
put(path.join(share, 'applications', 'fake-browser.desktop'), `[Desktop Entry]\nType=Application\nName=Fake Browser\nExec=${path.join(bin, 'fake-browser')} %u\n`);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_DATA_HOME: share, WAYLAND_DISPLAY: '', DISPLAY: '' };

function show(target, ...args) {
  writeFileSync(log, '');
  const r = spawnSync(process.execPath, [SHOW, 'open', target, '--timeout', '300', ...args], { encoding: 'utf8', env, timeout: 60000 });
  let res;
  try { res = JSON.parse(r.stdout); } catch { res = { ok: false, error: 'no-json', detail: `${r.stdout}\n${r.stderr}` }; }
  const handed = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  return { res, handed };
}

// ---- what opens, and where -----------------------------------------------------------------

const page = put(path.join(work, 'report.html'), '<!doctype html><title>Smoke</title>');
let { res, handed } = show(page);
check('an HTML page goes to the default browser\'s own Exec line, as a file:// URL', res.ok && handed.length === 1 && handed[0][0] === 'fake-browser' && handed[0][1] === pathToFileURL(page).href, JSON.stringify(handed));

const pdf = put(path.join(work, 'doc.pdf'), '%PDF-1.4\n%%EOF\n');
({ res, handed } = show(pdf));
check('a PDF goes to xdg-open', res.ok && res.mode === 'app' && handed.length === 1 && handed[0][0] === 'xdg-open' && handed[0][1] === pdf, JSON.stringify(handed));

const out = path.join(work, 'outputs');
put(path.join(out, 'final.pdf'), '%PDF-1.4\n%%EOF\n');
({ res, handed } = show(out));
check('a folder goes to the file manager over D-Bus, main file selected (ShowItems)', res.ok && res.mode === 'folder' && handed.length === 1 && handed[0][0] === 'gdbus'
  && handed[0].includes('org.freedesktop.FileManager1.ShowItems') && handed[0].some((a) => a.includes(pathToFileURL(path.join(out, 'final.pdf')).href)), JSON.stringify(handed));

// ---- nothing runnable is ever handed over to run -------------------------------------------

const cases = [
  ['a shell script (+x)', put(path.join(work, 'evil.sh'), '#!/bin/sh\necho ran\n', 0o755)],
  ['a .desktop launcher', put(path.join(work, 'evil.desktop'), '[Desktop Entry]\nType=Application\nExec=sh -c "echo ran"\n', 0o755)],
  ['a program with no extension (+x)', put(path.join(work, 'evilbin'), '#!/bin/sh\necho ran\n', 0o755)],
  ['an AppImage', put(path.join(work, 'tool.AppImage'), 'x', 0o755)],
  ['a .doc (can carry macros)', put(path.join(work, 'old.doc'), 'x')],
];
const linkPdf = path.join(work, 'notes-link.pdf');
symlinkSync(path.join(work, 'evil.sh'), linkPdf);
cases.push(['a symlink named notes-link.pdf that leads to evil.sh', linkPdf]);
const linkHtml = path.join(work, 'page-link.html');
symlinkSync(path.join(work, 'evil.sh'), linkHtml);
cases.push(['a symlink named page-link.html that leads to evil.sh', linkHtml]);

for (const [label, target] of cases) {
  ({ res, handed } = show(target));
  const onlyShown = handed.length === 1 && handed[0][0] === 'gdbus' && handed[0].includes('org.freedesktop.FileManager1.ShowItems')
    && handed[0].some((a) => a.includes(pathToFileURL(target).href));
  const neverOpened = !handed.some((h) => h[0] !== 'gdbus');
  check(`${label}: only shown in the file manager, never handed to xdg-open or the browser`, res.ok && res.mode === 'folder' && onlyShown && neverOpened,
    `reason=${(res.reasons || [])[0] || ''} handed=${JSON.stringify(handed)}`);
}

// ---- report ------------------------------------------------------------------------------------

const failed = results.filter((x) => !x.ok);
const table = ['| Check | Result | Detail |', '|---|---|---|', ...results.map((x) => `| ${x.name} | ${x.ok ? 'PASS' : '**FAIL**'} | ${String(x.detail).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)];
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Linux smoke\n\n${table.join('\n')}\n\n${results.length - failed.length}/${results.length} passed\n`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
