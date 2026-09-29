// Docs, skills, install scripts and doctor: what the READMEs, SECURITY, CHANGELOG and the three
// skills promise, and that the reply rules Claude follows stay the ones the code backs. A `#n`
// in a test name is the finding the test came from.
//
// Nothing here opens a window. The install-script tests run the real scripts with PATH set to a
// temp folder that holds only a fake `claude`, so the real Claude CLI is never reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeRun, lib, PLUGIN, ROOT, tempDir } from './helpers.mjs';

const { doctor } = await import(lib('doctor.mjs'));
const { detect, WINDOWS_LONG_PATH } = await import(lib('detect.mjs'));
const { DEFAULT_TIMEOUT_MS, DIRECT_BUDGET_MS } = await import(lib('open.mjs'));

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const skill = (name) => readFileSync(path.join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8');
const description = (text) => text.match(/^description: (.*)$/m)[1];
const EN = () => read('README.en.md');
const HE = () => read('README.md');
const lineOf = (text, re) => text.split('\n').find((l) => re.test(l)) || '';

// ---- doctor: the osascript check follows SHOW_LOCAL_NO_OSASCRIPT (#57) -----------------------

// No port probing and no real server registry: both are injected.
const quietDoctor = (env, runFn) => doctor({ platform: 'darwin', runFn, env, cwd: ROOT, countFreePorts: async () => 100, serversFn: async () => [] });
const osaRun = () => fakeRun([['osascript', { stdout: '1\n' }]]);

test('doctor (macOS): SHOW_LOCAL_NO_OSASCRIPT=1 reports verification off (info) and never runs osascript', async () => {
  const runFn = osaRun();
  const r = await quietDoctor({ SHOW_LOCAL_NO_OSASCRIPT: '1' }, runFn);
  const osa = r.checks.find((c) => c.id === 'osascript');
  assert.ok(osa, 'an osascript check is still listed');
  assert.equal(osa.status, 'info');
  assert.match(osa.detail, /SHOW_LOCAL_NO_OSASCRIPT=1/);
  assert.match(osa.detail, /cannot verify/i);
  assert.doesNotMatch(osa.detail, /may ask for Automation permission/, 'no permission prompt is promised when AppleScript is off');
  assert.deepEqual(runFn.calls.filter((c) => c.cmd === 'osascript'), [], 'osascript must not run');
});

test('doctor (macOS): without the variable, a working osascript is ok and the prompt is mentioned', async () => {
  const runFn = osaRun();
  const r = await quietDoctor({}, runFn);
  const osa = r.checks.find((c) => c.id === 'osascript');
  assert.equal(osa.status, 'ok');
  assert.match(osa.detail, /Automation permission/);
  assert.equal(runFn.calls.filter((c) => c.cmd === 'osascript').length, 1);
});

test('doctor (macOS): SHOW_LOCAL_NO_OSASCRIPT set to something other than 1 still checks osascript', async () => {
  const runFn = osaRun();
  const r = await quietDoctor({ SHOW_LOCAL_NO_OSASCRIPT: '0' }, runFn);
  assert.equal(r.checks.find((c) => c.id === 'osascript').status, 'ok');
  assert.equal(runFn.calls.filter((c) => c.cmd === 'osascript').length, 1);
});

// ---- install scripts: a failed step exits non-zero and says so (#44 #56) ---------------------

/** First executable called `name` on the current PATH (sh.exe from Git on Windows), or null. */
function findExe(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

// The fake `claude` logs its arguments and fails the verbs named in FAKE_FAIL_ADD/UPDATE/INSTALL.
const FAKE_SH = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
if [ "$2" = marketplace ]; then
  [ "$3" = add ] && [ "\${FAKE_FAIL_ADD:-}" = 1 ] && exit 1
  [ "$3" = update ] && [ "\${FAKE_FAIL_UPDATE:-}" = 1 ] && exit 1
  exit 0
fi
[ "\${FAKE_FAIL_INSTALL:-}" = 1 ] && exit 1
exit 0
`;
const FAKE_CMD = [
  '@echo off',
  '>>"%FAKE_LOG%" echo %*',
  'if "%2"=="marketplace" goto market',
  'if "%FAKE_FAIL_INSTALL%"=="1" exit /b 1',
  'exit /b 0',
  ':market',
  'if "%3"=="add" if "%FAKE_FAIL_ADD%"=="1" exit /b 1',
  'if "%3"=="update" if "%FAKE_FAIL_UPDATE%"=="1" exit /b 1',
  'exit /b 0',
  '',
].join('\r\n');

/**
 * A temp folder with one fake claude in it: `sh` (a shell script), `cmd` (for PowerShell) or none.
 * Never both: PowerShell would also find an extensionless `claude` and hand it to the shell.
 */
function fakeBin(kind) {
  const t = tempDir('show-local-install-');
  if (kind === 'sh') {
    writeFileSync(path.join(t.dir, 'claude'), FAKE_SH);
    chmodSync(path.join(t.dir, 'claude'), 0o755);
  } else if (kind === 'cmd') {
    writeFileSync(path.join(t.dir, 'claude.cmd'), FAKE_CMD);
  }
  const log = path.join(t.dir, 'calls.log');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
  return { ...t, log, calls };
}

/** Environment whose PATH holds only `dirs`: every other Path/PATH spelling is dropped. */
function isolatedEnv(dirs, extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') env[k] = v;
  return { ...env, PATH: dirs.join(path.delimiter), ...extra };
}

const SH = findExe('sh');
const shSkip = SH ? false : 'no POSIX sh on this machine';

function runInstallSh(bin, fail = {}) {
  const env = isolatedEnv([bin.dir], {
    FAKE_LOG: bin.log,
    FAKE_FAIL_ADD: fail.add ? '1' : '', FAKE_FAIL_UPDATE: fail.update ? '1' : '', FAKE_FAIL_INSTALL: fail.install ? '1' : '',
  });
  return spawnSync(SH, [path.join(ROOT, 'install.sh')], { cwd: bin.dir, env, encoding: 'utf8', timeout: 30000 });
}

test('install.sh: a failed `claude plugin install` exits non-zero and says so', { skip: shSkip }, () => {
  const bin = fakeBin('sh');
  try {
    const r = runInstallSh(bin, { install: true });
    assert.notEqual(r.status, 0, `exit status ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /install failed/);
    assert.doesNotMatch(r.stdout, /show-local installed/);
    assert.deepEqual(bin.calls(), ['plugin marketplace add ofeklevy11/show-local', 'plugin install show-local@show-local']);
  } finally { bin.cleanup(); }
});

test('install.sh: a marketplace that can be neither added nor updated stops before installing', { skip: shSkip }, () => {
  const bin = fakeBin('sh');
  try {
    const r = runInstallSh(bin, { add: true, update: true });
    assert.notEqual(r.status, 0, `exit status ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /marketplace/);
    assert.match(r.stderr, /install failed/);
    assert.ok(!bin.calls().some((c) => c.startsWith('plugin install')), bin.calls().join('\n'));
  } finally { bin.cleanup(); }
});

test('install.sh: an already-added marketplace is updated, then the install succeeds (exit 0)', { skip: shSkip }, () => {
  const bin = fakeBin('sh');
  try {
    const r = runInstallSh(bin, { add: true });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /show-local installed/);
    assert.deepEqual(bin.calls(), ['plugin marketplace add ofeklevy11/show-local', 'plugin marketplace update show-local', 'plugin install show-local@show-local']);
  } finally { bin.cleanup(); }
});

test('install.sh: no claude CLI on PATH exits non-zero with a message', { skip: shSkip }, () => {
  const bin = fakeBin('none');
  try {
    const r = runInstallSh(bin);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Claude Code CLI not found/);
  } finally { bin.cleanup(); }
});

const PS = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const psSkip = PS && existsSync(PS) ? false : 'Windows PowerShell only';

function runInstallPs(bin, fail = {}) {
  // System32 stays on PATH for cmd.exe (the fake is a .cmd); the real claude is never there.
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const env = isolatedEnv([bin.dir, system32], {
    FAKE_LOG: bin.log,
    FAKE_FAIL_ADD: fail.add ? '1' : '', FAKE_FAIL_UPDATE: fail.update ? '1' : '', FAKE_FAIL_INSTALL: fail.install ? '1' : '',
  });
  return spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'install.ps1')],
    { cwd: bin.dir, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
}

test('install.ps1: a failed `claude plugin install` fails the script (exit 1) and says so', { skip: psSkip }, () => {
  const bin = fakeBin('cmd');
  try {
    const r = runInstallPs(bin, { install: true });
    assert.notEqual(r.status, 0, `exit status ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /install failed/);
    assert.doesNotMatch(r.stdout, /show-local installed/);
    assert.deepEqual(bin.calls(), ['plugin marketplace add ofeklevy11/show-local', 'plugin install show-local@show-local']);
  } finally { bin.cleanup(); }
});

test('install.ps1: a marketplace that can be neither added nor updated stops before installing', { skip: psSkip }, () => {
  const bin = fakeBin('cmd');
  try {
    const r = runInstallPs(bin, { add: true, update: true });
    assert.notEqual(r.status, 0, `exit status ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /marketplace/);
    assert.ok(!bin.calls().some((c) => c.startsWith('plugin install')), bin.calls().join('\n'));
  } finally { bin.cleanup(); }
});

test('install.ps1: an already-added marketplace is updated, then the install succeeds (exit 0)', { skip: psSkip }, () => {
  const bin = fakeBin('cmd');
  try {
    const r = runInstallPs(bin, { add: true });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /show-local installed/);
    assert.deepEqual(bin.calls(), ['plugin marketplace add ofeklevy11/show-local', 'plugin marketplace update show-local', 'plugin install show-local@show-local']);
  } finally { bin.cleanup(); }
});

test('install.ps1: no claude CLI on PATH fails the script (exit 1)', { skip: psSkip }, () => {
  const bin = fakeBin('none');
  try {
    const r = runInstallPs(bin);
    assert.notEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /Claude Code CLI not found/);
  } finally { bin.cleanup(); }
});

test('install.ps1 stays plain ASCII (Windows PowerShell reads a BOM-less file in the ANSI code page)', () => {
  assert.doesNotMatch(read('install.ps1'), /[^\x00-\x7f]/);
});

// ---- the printed commands are for Bash; PowerShell quoting is stated exactly (#15 #25 #64 #69) --

test('no skill claims the same commands work in PowerShell', () => {
  for (const name of ['show', 'show-serve', 'show-doctor']) {
    assert.doesNotMatch(skill(name), /same commands work (there|in PowerShell)/i, name);
  }
});

test('show and show-serve scope next.* to the Bash tool and give the PowerShell rule', () => {
  for (const name of ['show', 'show-serve']) {
    const text = skill(name);
    assert.match(text, /commands the script prints are for the Bash tool \(POSIX single quotes\)/, name);
    assert.match(text, /In PowerShell, quote with single quotes and double any apostrophe/, name);
    assert.match(text, /‘ ’ ‚ ‛/, `${name}: PowerShell also treats the curly single quotes as apostrophes`);
    // A path the Bash tool would refuse travels as a percent-encoded file:/// URL, never escaped.
    assert.match(text, /as a (percent-encoded )?`file:\/\/\/` URL/, name);
    assert.match(text, /percent-encod/, name);
    assert.match(text, /never write a helper script to get around a refused command/i, name);
    assert.doesNotMatch(text, /apostrophe inside (a path )?is written `'\\''`/, `${name}: no longer tells the agent to escape an apostrophe`);
  }
  assert.match(skill('show'), /`'` is `%27`, `"` `%22`, `;` `%3B`, `&` `%26`, `\|` `%7C`, `\$` `%24`/);
  assert.match(skill('show-doctor'), /double any apostrophe/);
});

// ---- where shell strings really are (#45) ------------------------------------------------------

test('docs no longer promise that paths never pass through a shell string, and say where they do', () => {
  assert.doesNotMatch(read('SECURITY.md'), /never interpolated into a shell command/);
  assert.doesNotMatch(EN(), /never pass through a shell string/);
  assert.doesNotMatch(HE(), /לא עוברים אף פעם דרך מחרוזת shell/);
  assert.doesNotMatch(read('CONTRIBUTING.md'), /never spliced into a command line\./);
  const sec = read('SECURITY.md');
  assert.match(sec, /`next\.start`/);
  assert.match(sec, /\/select/, 'the one verbatim Explorer argument is named');
  assert.match(sec, /double any apostrophe/);
  for (const text of [EN(), HE(), read('CONTRIBUTING.md')]) assert.match(text, /next\.start/);
});

// ---- the static server's path rules (#46) ------------------------------------------------------

test('docs say a backslash is a path separator (not refused), and list the real refusals', () => {
  const sec = read('SECURITY.md');
  assert.doesNotMatch(sec, /backslashes, Windows drive letters/);
  assert.match(sec, /backslash is treated as a path separator/i);
  assert.match(sec, /8\.3 short name/);
  assert.match(sec, /alternate data streams/);
  assert.doesNotMatch(EN(), /`%2e%2e`, backslashes/);
  assert.match(EN(), /backslash counts as a path separator/i);
  assert.match(HE(), /backslash נחשב למפריד נתיב/);
  const serve = skill('show-serve');
  assert.doesNotMatch(serve, /`%2e%2e`, backslashes/);
  assert.match(serve, /backslash counts as a path separator/i);
  assert.match(serve, /ENV~1/);
  for (const text of [EN(), HE()]) assert.match(text, /ENV~1/);
});

// ---- "opened" only with proof (#47) and the auto-reload limitation (#61) ------------------------

test('the show skill never tells Claude to write "It was opened" for verified:null', () => {
  const row = lineOf(skill('show'), /^\| `verified: null`/);
  assert.ok(row, 'there is a verified:null row');
  assert.doesNotMatch(row, /It was opened/);
  assert.match(row, /I tried to open/);
});

test('the READMEs say when "cannot verify" is the normal answer', () => {
  assert.match(EN(), /On some systems that is the normal answer/);
  assert.match(HE(), /במערכות מסוימות זו התשובה הרגילה/);
  for (const text of [EN(), HE()]) assert.match(text, /SHOW_LOCAL_NO_OSASCRIPT=1/);
});

test('the READMEs document that a self-reloading page can supply the server-log proof', () => {
  assert.match(EN(), /Known limitation:\*\* a page that reloads itself/);
  assert.match(HE(), /מגבלה ידועה:\*\* דף שמרענן את עצמו/);
  assert.match(skill('show'), /reloads itself/);
});

// ---- links (#48) ---------------------------------------------------------------------------------

const VIEWER = 'https://htmlpreview.github.io/?https://github.com/ofeklevy11/show-local/blob/main/RELEASE-REPORT.html';

test('both READMEs link the release report and a rendered view of it', () => {
  for (const text of [EN(), HE()]) {
    assert.ok(text.includes('](RELEASE-REPORT.html)'), 'relative link to the report');
    assert.ok(text.includes(`](${VIEWER})`), 'viewer link, since GitHub shows .html files as source');
  }
});

// Generated by the release step; until then its link is reported as a skip, not hidden.
const GENERATED = new Set(['RELEASE-REPORT.html']);

test('every relative link in the READMEs, SECURITY and CONTRIBUTING points at a file in the repository', async (t) => {
  for (const file of ['README.md', 'README.en.md', 'SECURITY.md', 'CONTRIBUTING.md']) {
    for (const m of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const skip = GENERATED.has(target) && !existsSync(path.join(ROOT, target)) ? `${target} is generated at release time` : false;
      await t.test(`${file} → ${target}`, { skip }, () => {
        assert.ok(existsSync(path.join(ROOT, target)), `${file} links ${target}, which does not exist`);
      });
    }
  }
});

// ---- state folder (#49) --------------------------------------------------------------------------

test('SECURITY.md names the per-OS state folder and one launch.json entry per served folder', () => {
  const sec = read('SECURITY.md');
  for (const s of ['%TEMP%\\show-local', '$TMPDIR/show-local-<uid>', '$XDG_RUNTIME_DIR/show-local-<uid>', '~/.cache/show-local']) {
    assert.ok(sec.includes(s), `mentions ${s}`);
  }
  assert.doesNotMatch(sec, /in your temp folder \(`show-local\/`\)/);
  assert.match(sec, /one per served folder or dev project/);
});

// ---- the slash command (#50) ---------------------------------------------------------------------

test('the show skill keeps "/show-local" and names the real command; the READMEs name it too', () => {
  const desc = description(skill('show'));
  assert.ok(desc.includes('"/show-local"'), 'the approved trigger phrase stays');
  assert.match(desc, /slash command itself is \/show-local:show\b/);
  assert.ok([...desc].length <= 1024, `description is ${[...desc].length} characters`);
  for (const text of [EN(), HE()]) {
    for (const cmd of ['/show-local:show', '/show-local:show-serve', '/show-local:show-doctor']) assert.ok(text.includes(`\`${cmd}\``), cmd);
  }
});

// ---- Node versions (#51) -------------------------------------------------------------------------

test('Node: runtime 18+, npm test 18.1+, and no claim that Claude Code brings Node', () => {
  assert.match(read('CONTRIBUTING.md'), /npm test[^\n]*Node 18\.1\+/);
  assert.doesNotMatch(read('CONTRIBUTING.md'), /npm test[^\n]*Node 18\+/);
  assert.doesNotMatch(EN(), /most Claude Code installs already have/);
  assert.doesNotMatch(HE(), /שכבר מגיע עם רוב ההתקנות/);
  for (const text of [EN(), HE()]) {
    assert.match(text, /Node 18/);
    assert.match(text, /Node 18\.1\+/);
    assert.ok(text.includes('](https://nodejs.org)'), 'where to get Node');
  }
  for (const name of ['show', 'show-serve', 'show-doctor']) assert.match(skill(name), /`node` is not found/, `${name}: what to do without node`);
});

// ---- the two READMEs say the same things (#53) --------------------------------------------------

/** Comparable facts of a README: inline code, links, table shapes, section count, code blocks. */
function readmeFacts(text) {
  const blocks = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1].replace(/[ \t]*#.*$/gm, '').trimEnd());
  const prose = text.replace(/```[\s\S]*?```/g, '');
  const code = [...new Set([...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]))].sort();
  const links = [...new Set([...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^README(\.en)?\.md$/.test(l)))].sort();
  const tables = [];
  let rows = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('|')) rows++;
    else if (rows) { tables.push(rows); rows = 0; }
  }
  return { blocks, code, links, tables, sections: (text.match(/^## /gm) || []).length };
}

test('README.md and README.en.md carry the same commands, links, tables and sections', () => {
  const he = readmeFacts(HE());
  const en = readmeFacts(EN());
  assert.deepEqual(he.code, en.code, 'inline code');
  assert.deepEqual(he.links, en.links, 'links');
  assert.deepEqual(he.tables, en.tables, 'rows per table');
  assert.equal(he.sections, en.sections, 'sections');
  assert.deepEqual(he.blocks, en.blocks, 'code blocks (comments aside)');
});

test('the Hebrew tagline promises the default browser, not Chrome, and both folder rows name Finder', () => {
  const tagline = HE().split(/\r?\n/).find((l) => l.startsWith('**'));
  assert.doesNotMatch(tagline, /כרום|Chrome/);
  assert.match(tagline, /דפדפן ברירת המחדל/);
  assert.match(lineOf(HE(), /^\| תיקיית תוצרים/), /Finder/);
  assert.match(lineOf(EN(), /^\| A folder of outputs/), /Finder/);
});

// ---- skill wording (#54 #55) ---------------------------------------------------------------------

test('"several outputs" tells Claude to pass --folder', () => {
  const bullet = lineOf(skill('show'), /^- \*\*Several outputs/);
  assert.match(bullet, /--folder/);
  assert.match(bullet, /index\.html/);
});

test('headless runs (claude -p) leave no server running past the final reply', () => {
  for (const text of [skill('show'), skill('show-serve'), EN(), HE()]) {
    assert.match(text, /claude -p/);
  }
  assert.match(skill('show'), /Headless runs only, nothing left running/);
  assert.match(skill('show-serve'), /Headless: Stop the server before your final reply/);
});

// ---- headless runs: one foreground oneshot, and --headless for subagents and workflow steps ----

test('headless: show and show-serve run next.oneshot in the foreground and pass --headless', () => {
  for (const name of ['show', 'show-serve']) {
    const text = skill(name);
    assert.match(text, /`next\.oneshot`/, name);
    assert.match(text, /`next\.oneshot` with Bash, in the foreground/, `${name}: one foreground Bash call`);
    assert.match(text, /no `run_in_background`/, name);
    assert.match(text, /headless: true/, name);
    assert.match(text, /stopped: true/, `${name}: the reply reads that the server was stopped`);
    assert.match(text, /subagent or a workflow step/, `${name}: subagents and workflow steps are headless`);
    assert.match(text, /even when `preview_start` is among (its|your) tools/, `${name}: preview_start does not make a subagent interactive`);
    assert.match(text, /run step 1 again with `--headless`/, `${name}: a plan without headless:true is redone, not started`);
    // The old background flow and its task-notice workaround are gone.
    assert.doesNotMatch(text, /answer the notice|final reply again|task ended/i, `${name}: no task-notice workaround`);
    assert.doesNotMatch(text, /`next\.stop`/, `${name}: a headless plan has no next.stop`);
    // The step-1 command offers --headless next to --desktop.
    assert.match(lineOf(text, /scripts\/show\.mjs' '</), /\[--desktop \| --headless\]/, name);
  }
  assert.match(skill('show'), /Pass `--headless` in a headless run, and then never `--desktop`/);
  assert.match(skill('show-doctor'), /`oneshot`/);
});

test('headless: the READMEs describe oneshot and --headless for subagents and workflow steps', () => {
  assert.match(EN(), /Headless run \|/);
  assert.match(HE(), /הרצה בלי ממשק \|/);
  assert.match(EN(), /a subagent or a workflow step/);
  assert.match(HE(), /סוכן-משנה \(subagent\) או שלב ב-workflow/);
  for (const text of [EN(), HE()]) {
    assert.ok(text.includes('`oneshot`'), 'oneshot');
    assert.ok(text.includes('`--headless`'), '--headless');
    assert.ok(text.includes('node show.mjs oneshot <path|url>'), 'the oneshot command');
  }
});

// ---- an unverified reply never guesses ----------------------------------------------------------

const GUESS = /\b(probably|likely)\b|good chance|כנראה|סביר ש|סיכוי|נראה ש/i;

test('unverified replies never guess: the rule is stated, and no template or example hedges', () => {
  const show = skill('show');
  assert.match(show, /\*\*Never guess the outcome\.\*\*/);
  for (const w of ['"probably"', '"likely"', '"most likely"', '"כנראה"', '"יש סיכוי"', '"הסיכוי גבוה"', '"נראה ש"']) {
    assert.ok(show.includes(w), `show names ${w} as forbidden`);
  }
  assert.match(skill('show-serve'), /never guess the outcome/);
  assert.match(skill('show-doctor'), /Do not guess whether it is there/);
  for (const re of [/^\| `verified: null`/, /^\| `verified: false`/]) {
    const row = lineOf(show, re);
    assert.ok(row, `row ${re}`);
    assert.doesNotMatch(row, GUESS, `${re}: the reply template hedges`);
  }
  for (const [name, text] of [['show', show], ['show-serve', skill('show-serve')]]) {
    for (const line of text.split('\n').filter((l) => l.startsWith('> '))) {
      assert.doesNotMatch(line, GUESS, `${name} example: ${line}`);
    }
  }
  // The pdf example shows the right way to point at the taskbar: something to check, no odds.
  assert.ok(show.split('\n').some((l) => l.startsWith('> ') && l.includes('שורת המשימות')), 'a taskbar pointer without a guess');
  assert.match(EN(), /Neither reply guesses/);
  assert.match(HE(), /אף אחת מהתשובות האלה לא מנחשת/);
});

// ---- a folder whose file was not selected --------------------------------------------------------

test('selected:false is reported: the folder opened, but the file was not selected', () => {
  const show = skill('show');
  assert.match(show, /`false`: the folder window was seen \(so the result can still be `verified: true`\), but the file was not selected in it/);
  assert.match(show, /`null`: the selection could not be checked, so do not say that the file is selected/);
  assert.match(show, /is not selected in it/);
  assert.match(show, /לא סומן בה/);
  assert.ok(show.split('\n').some((l) => l.startsWith('> ') && l.includes('לא סומן בה')), 'a reply example for selected:false');
  assert.match(skill('show-doctor'), /`selected: false`/);
  assert.match(EN(), /the folder opened but the main file is not selected in it, the reply says so/);
  assert.match(HE(), /התיקייה נפתחה אבל הקובץ הראשי לא מסומן בה, התשובה אומרת את זה/);
});

// ---- long Windows paths: 8.3 short names, and the served fallback -------------------------------

test('long paths: a short-path open shows the real full path; a served fallback says the link lasts the session', () => {
  const show = skill('show');
  assert.match(lineOf(show, /^\| `file`/), /8\.3 short form[\s\S]*`shortPath: true`/);
  assert.match(show, /With `shortPath: true`, the link text is still `target`, the real full path, never the 8\.3 short form/);
  assert.match(show, /The link target stays `url`, the short form/);
  assert.match(show, /add that the link works only while this session is open/);
  assert.match(show, /הקישור עובד רק כל עוד הסשן הזה פתוח/);
  assert.match(lineOf(EN(), /^\| An HTML file/), /8\.3 short name[\s\S]*works only while the session is open/);
  assert.match(lineOf(HE(), /^\| קובץ HTML/), /8\.3[\s\S]*הקישור עובד רק כל עוד הסשן פתוח/);
  assert.match(read('CHANGELOG.md'), /8\.3 short name \(`shortPath: true`/);
  assert.match(read('SECURITY.md'), /8\.3 short name/);
});

// ---- show-serve stands on its own -----------------------------------------------------------------

test("show-serve replies in the user's language, with the link and proof rules, without the show skill loaded", () => {
  const serve = skill('show-serve');
  assert.match(serve, /\*\*Reply in the language the user wrote their request in\*\*: an English request gets an English reply/);
  assert.match(skill('show'), /an English request gets an English reply/);
  assert.match(skill('show'), /never shorten the path with `\.\.\.`/);
  assert.match(skill('show'), /keeps working after this session ends, so never say it depends on the session/);
  assert.match(serve, /\*\*full URL as a clickable Markdown link\*\*/);
  assert.match(serve, /The proof from `evidence`, and the time \(`ms`\)/);
  assert.match(serve, /Only `verified: true` lets you say it opened/);
  assert.match(serve, /עצרתי את השרת, כי סשן בלי ממשק לא יכול להסתיים כשהוא רץ/);
});

// ---- plan opens nothing; --desktop writes the launch.json entry ---------------------------------

test('plan: the READMEs say it opens nothing, and that --desktop adds or updates the launch.json entry', () => {
  for (const [name, text] of [['README.en.md', EN()], ['README.md', HE()]]) {
    const line = lineOf(text, /^node show\.mjs plan /);
    assert.match(line, /\[--desktop\|--headless\]/, name);
    assert.match(line, /launch\.json/, `${name}: the plan line says --desktop writes launch.json`);
  }
  assert.match(lineOf(EN(), /^node show\.mjs plan /), /opens nothing, but --desktop adds or updates the launch\.json entry/);
  assert.match(read('CHANGELOG.md'), /`plan` opens nothing\. With `--desktop` it adds or updates the project's `\.claude\/launch\.json` entry/);
});

// ---- uninstall removes the state folder ------------------------------------------------------------

test('uninstall: both READMEs delete the state folder on every OS, after stopping the servers', () => {
  for (const [name, text] of [['README.en.md', EN()], ['README.md', HE()]]) {
    const uninstall = text.slice(text.search(/^## (Uninstall|הסרה)$/m));
    for (const s of [
      'node show.mjs stop all', '"$env:TEMP\\show-local"', '"$env:USERPROFILE\\.cache\\show-local"',
      '"${TMPDIR:-/tmp}/show-local-$(id -u)"', '"$XDG_RUNTIME_DIR/show-local-$(id -u)"', '~/.cache/show-local',
      '`%TEMP%\\show-local`', '`$TMPDIR/show-local-<uid>`', '`$XDG_RUNTIME_DIR/show-local-<uid>`', '`ShowLocalWin-*.dll`',
    ]) {
      assert.ok(uninstall.includes(s), `${name} uninstall mentions ${s}`);
    }
  }
});

test('uninstall: the documented state folder is the one util.mjs stateDir computes here', async () => {
  const { stateDir } = await import(lib('util.mjs'));
  const dir = stateDir();
  if (process.platform === 'win32') {
    // %TEMP%\show-local, unless it could not be created (then %USERPROFILE%\.cache\show-local).
    const expected = [path.join(os.tmpdir(), 'show-local'), path.join(os.homedir(), '.cache', 'show-local')].map((p) => p.toLowerCase());
    assert.ok(expected.includes(dir.toLowerCase()), dir);
  } else {
    const uid = process.getuid();
    const expected = [
      process.env.XDG_RUNTIME_DIR && process.platform === 'linux' ? path.join(process.env.XDG_RUNTIME_DIR, `show-local-${uid}`) : null,
      path.join(os.tmpdir(), `show-local-${uid}`),
      path.join(os.homedir(), '.cache', 'show-local'),
    ].filter(Boolean);
    assert.ok(expected.includes(dir) || /^show-local-/.test(path.basename(dir)), dir);
  }
});

// ---- the Hebrew README speaks in one voice ----------------------------------------------------------

test('the Hebrew README addresses the reader in the plural throughout', () => {
  const he = HE();
  assert.doesNotMatch(he, /תגיד |אצלך|שלך|כשאני|תרצה|אתה /);
  const tagline = he.split(/\r?\n/).find((l) => l.startsWith('**'));
  assert.match(tagline, /^\*\*תגידו ל-Claude/);
  assert.match(tagline, /אצלכם/);
  assert.match(tagline, /שלכם/);
});

// ---- the optional bare /show-local command ----------------------------------------------------------

test('both READMEs document the optional bare /show-local command: why, the exact file, and removal', () => {
  const fileOf = (text) => (text.match(/```markdown\n([\s\S]*?)```/) || [])[1];
  const en = fileOf(EN());
  assert.ok(en, 'README.en.md gives the file content');
  assert.equal(fileOf(HE()), en, 'the same file content in both READMEs');
  assert.match(en, /^---\ndescription: [^\n]+\nargument-hint: [^\n]+\n---\n\n/, 'command frontmatter');
  assert.match(en, /Use the `show-local:show` skill/);
  assert.match(en, /\$ARGUMENTS/);
  assert.match(EN(), /cannot register a bare `\/show-local`/);
  assert.match(HE(), /לא יכול לרשום פקודה קצרה `\/show-local`/);
  for (const [name, text] of [['README.en.md', EN()], ['README.md', HE()]]) {
    assert.ok(text.includes('`~/.claude/commands/show-local.md`'), `${name}: where the file goes`);
    assert.ok(text.includes('`%USERPROFILE%\\.claude\\commands\\show-local.md`'), `${name}: the Windows spelling`);
    assert.ok(text.includes('`/<plugin>:<name>`'), `${name}: why a plugin cannot provide it`);
    const uninstall = text.slice(text.search(/^## (Uninstall|הסרה)$/m));
    assert.ok(uninstall.includes('`~/.claude/commands/show-local.md`'), `${name}: the uninstall steps remove it`);
  }
});

// ---- dev servers, the Linux route, dev-run, oneshot and server lifetime --------------------------

test('dev servers bind where the project configures them: show-local does not force 127.0.0.1', () => {
  assert.match(read('SECURITY.md'), /binds wherever the project configures it, and show-local does not force `127\.0\.0\.1` on it/);
  assert.match(EN(), /listens wherever the project configures it[^\n]*show-local does not force `127\.0\.0\.1` on it/);
  assert.match(HE(), /show-local לא כופה עליו `127\.0\.0\.1`/);
  assert.match(skill('show-serve'), /show-local does not force `127\.0\.0\.1` on it/);
  assert.match(read('CHANGELOG.md'), /show-local does not force `127\.0\.0\.1` on it/);
});

test('the Linux opening route is documented as built: .desktop Exec, gdbus FileManager1, xdg-open fallback', () => {
  for (const [name, text] of [['README.en.md', EN()], ['README.md', HE()], ['CHANGELOG.md', read('CHANGELOG.md')]]) {
    for (const s of ['.desktop', 'Exec', 'xdg-settings', 'org.freedesktop.FileManager1', 'gdbus', 'xdg-open']) {
      assert.ok(text.includes(s), `${name} mentions ${s}`);
    }
  }
  // The same route in the adapter, so the docs cannot drift from it unnoticed.
  const linux = readFileSync(path.join(PLUGIN, 'scripts', 'lib', 'adapters', 'linux.mjs'), 'utf8');
  for (const s of ['resolveLinuxBrowser', "'gdbus'", 'org.freedesktop.FileManager1', "'xdg-open'"]) assert.ok(linux.includes(s), `linux.mjs uses ${s}`);
});

test('dev-run, oneshot and the parent-watch lifetime are documented in the READMEs, CHANGELOG and SECURITY', () => {
  for (const [name, text] of [['README.en.md', EN()], ['README.md', HE()], ['CHANGELOG.md', read('CHANGELOG.md')]]) {
    for (const s of ['dev-run', 'oneshot', '--headless']) assert.ok(text.includes(s), `${name} mentions ${s}`);
  }
  for (const text of [EN(), HE()]) assert.ok(text.includes('node show.mjs dev-run <project> --port <port>'), 'the dev-run command');
  assert.match(EN(), /check about once a second whether it is still alive, and exit when it is gone/);
  assert.match(HE(), /בודקים בערך פעם בשנייה שהוא עדיין חי, ויוצאים כשהוא נעלם/);
  assert.match(EN(), /The entry runs `node`, never `cmd\.exe` or `npm\.cmd`/);
  const log = read('CHANGELOG.md');
  assert.match(log, /`serve` and `dev-run` check every second that their parent process is still there \(`kill\(ppid, 0\)`\), and on Windows also the Claude Code process/);
  assert.match(log, /travel as percent-encoded `file:\/\/\/` URLs/);
  assert.match(log, /`runtimeExecutable: "node"`/);
  assert.match(log, /`&` or `%VAR%`/);
  const sec = read('SECURITY.md');
  assert.match(sec, /`cmd\.exe \/d \/s \/c "<runner> run dev"`, with the project folder as the working folder/);
  assert.match(sec, /`next\.oneshot`/);
  assert.match(skill('show-serve'), /`dev-run` starts the project's runner with the project folder as its working folder/);
});

// ---- decisions made in this round, stated where users and Claude read them ----------------------

test('decisions: app mode is an allow-list, only .app folders are bundles, --select stays inside', () => {
  const sec = read('SECURITY.md');
  assert.match(sec, /Only known viewable types/);
  assert.match(sec, /files of unknown type or with no extension/);
  assert.match(sec, /Only a folder whose name ends in `\.app` is treated as a bundle/);
  assert.match(sec, /`--select` must name a file inside the folder/);
  const show = skill('show');
  assert.match(lineOf(show, /^\| `folder`/), /unknown type or with no extension/);
  assert.match(lineOf(show, /^\| `folder`/), /only a folder whose name ends in `\.app` counts as a bundle/);
  assert.match(lineOf(show, /^\| `app`/), /Only known viewable types/);
  assert.match(lineOf(EN(), /^\| A program, script, shortcut/), /never run/);
  assert.match(lineOf(HE(), /^\| תוכנה, סקריפט/), /אף פעם לא מורץ/);
});

test('decisions: port-busy reports pid and process name only; a remote page that could be a one-time link is never fetched', () => {
  const sec = read('SECURITY.md');
  assert.match(sec, /only that process's \*\*pid and process name\*\*/);
  for (const name of ['show', 'show-serve']) assert.match(skill(name), /pid and process name/, name);
  // only a plain remote address is fetched (once, for its title); anything that could be a
  // one-time link never is. Where users and Claude read it, both halves are stated.
  assert.match(sec, /never fetches a \*\*remote\*\* page before opening it when the address could be a one-time link/);
  assert.match(sec, /query string or a fragment/);
  assert.match(sec, /longer than 32 characters/);
  assert.match(sec, /plain remote address[\s\S]{0,120}requested once before opening/i);
  assert.match(EN(), /A remote page is never fetched before it opens if its address could be a one-time link/);
  assert.match(EN(), /A plain address[\s\S]{0,80}is requested once before opening/);
  assert.match(HE(), /דף מרוחק אף פעם לא נטען לפני שהוא נפתח אם הכתובת שלו עלולה להיות קישור חד-פעמי/);
  assert.match(HE(), /כתובת פשוטה[\s\S]{0,80}נטענת פעם אחת לפני הפתיחה/);
  assert.match(lineOf(skill('show'), /^\| `url`/), /plain remote address[\s\S]*fetched once/);
  assert.match(lineOf(skill('show'), /^\| `url`/), /never fetched[\s\S]*`verified: null`/);
});

test('no reply template routes a weak or low-confidence open to "it seems to have opened"', () => {
  // verified:true now always means real proof, so no document may keep a "weak proof" branch.
  const docs = {
    'skills/show': skill('show'), 'skills/show-serve': skill('show-serve'), 'skills/show-doctor': skill('show-doctor'),
    'README.en.md': EN(), 'README.md': HE(), 'SECURITY.md': read('SECURITY.md'),
  };
  for (const [name, text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /confidence: "low"|`low`|seems to have opened|proof is weak|נראה שנפתח|ההוכחה חלשה/, name);
  }
  assert.match(skill('show'), /\| `verified: null` \|/);
  assert.match(skill('show'), /\| `verified: false` \|/);
});

test('decisions: a local https dev server with a self-signed certificate is accepted', () => {
  assert.match(read('SECURITY.md'), /self-signed or mkcert certificate is accepted/);
  assert.match(skill('show-serve'), /https with a self-signed or mkcert certificate is fine/);
  assert.match(EN(), /self-signed certificate works too/);
  assert.match(HE(), /תעודה בחתימה עצמית/);
});

// ---- production review: the docs say what the code does ("prod #n" is the finding) -------------

test('prod #22: after next.oneshot, "I stopped the server" is said only with server.stopped: true, in both skills', () => {
  const show = skill('show');
  const serve = skill('show-serve');
  // show-serve must carry the rule itself: a headless run can load it without the show skill.
  assert.match(serve, /If `server\.stopped` is not `true`, do not say you stopped it, and kill nothing yourself/);
  assert.match(show, /If `server\.stopped` is not `true`, never say that you stopped the server, and kill nothing yourself/);
  assert.doesNotMatch(serve, /after `next\.oneshot`, say instead that you stopped it/, 'show-serve: no unconditional "I stopped it"');
  assert.match(serve, /after `next\.oneshot` with `server\.stopped: true`, say instead that you stopped it/);
  assert.doesNotMatch(show, /After `next\.oneshot`, say instead that you stopped the server/, 'show: no unconditional "I stopped it"');
  assert.match(show, /After `next\.oneshot` with `server\.stopped: true`, say instead that you stopped the server/);
  assert.doesNotMatch(show, /the proof, and that you stopped the server/);
  assert.match(show, /After `next\.oneshot` with `server\.stopped: true`, that last sentence becomes/);
  for (const [name, text] of [['show', show], ['show-serve', serve]]) {
    // What to say instead: the port could not be confirmed stopped, or the server was left running.
    assert.match(text, /לא הצלחתי לוודא שהשרת בפורט `<port>` נעצר/, name);
    assert.match(text, /`server\.note` says[^.]*already running[^.]*left running/, name);
    // The stop steps no longer take oneshot's own stop on trust.
    assert.doesNotMatch(text, /has already stopped its own( server)?: do not stop it twice/, name);
    assert.match(text, /its `server\.stopped` says whether that was confirmed/, name);
  }
  assert.match(read('CHANGELOG.md'), /`stopped` is `false` when the port still answered after the stop, or when a server that was already running was used and left running/);
  assert.match(EN(), /it stopped the server, but only once show-local confirmed that the port is free again; otherwise the reply names the port/);
  assert.match(HE(), /עצר את השרת, אבל רק אחרי ש-show-local וידא שהפורט התפנה; אחרת התשובה מציינת את הפורט/);
});

test('prod #24: SECURITY and show-serve give dev-run and oneshot entries the rules the code applies to them', () => {
  const sec = read('SECURITY.md');
  // The old blanket statements held only for a dev server show-local opened a page on.
  assert.doesNotMatch(sec, /A dev server is recorded only when/);
  assert.doesNotMatch(sec, /\(its static servers, and the dev servers it opened a page on\)/);
  assert.match(sec, /`show\.mjs stop` ends only servers in show-local's own registry: its static servers, the dev servers it started through `dev-run` \(or a headless `oneshot`\), and the dev servers it opened a page on\. It never ends a process it did not register\./);
  assert.match(sec, /a registry of running servers \(its static servers, the dev servers it started through `dev-run` or `oneshot`, and the dev servers it opened a page on\)/);
  assert.match(sec, /A dev server started through `dev-run` or `oneshot` is recorded by that show-local process as soon as it starts, under the port it was given/);
  assert.match(sec, /it stays listed while both run, whether or not anything listens on the port yet/);
  assert.match(sec, /It does not ask who owns the port: it ends that show-local process on its own, and the guard's process tree \(the runner and the dev server\)/);
  assert.match(sec, /A dev server that show-local only opened a page on is recorded only when the process listening on its port can be tied to the project folder/);
  assert.match(sec, /`stop` ends it only while the OS shows that pid listening on the port; otherwise it refuses/);
  const serve = skill('show-serve');
  assert.doesNotMatch(serve, /A dev server is stopped only while the OS ties its recorded pid to its port/);
  assert.match(serve, /A dev server that `dev-run` \(or `oneshot`\) started is recorded under the port it was given, even before anything listens there/);
  assert.match(serve, /`stop` then ends that process on its own and the dev tool's process tree under the guard, whatever listens on the port/);
  assert.match(serve, /Any other recorded dev server is stopped only while the OS shows its recorded pid listening on its port/);
});

test('prod: a dev-run or oneshot entry is proved by process identity, and a stale one is removed, never stopped', () => {
  const sec = read('SECURITY.md');
  assert.match(sec, /`stop` ends such a server only after the OS confirms that the recorded pid is still that same show-local process \(its command line runs `show\.mjs dev-run` or `oneshot` for this port\) and that the guard is its own/);
  assert.match(sec, /An entry whose pids the OS shows now belong to something else[^.]*is stale: `stop` removes it from the registry, lists it under `removed`, and ends nothing\. When the OS cannot tell, `stop` refuses/);
  const serve = skill('show-serve');
  assert.match(serve, /It is listed while both run, and stopped only while the OS confirms that the recorded pid is still that same show-local process and the guard its own/);
  assert.match(serve, /An entry whose pids the OS shows now belong to something else is stale: `stop` removes it and lists it under `removed`, and nothing is stopped/);
  assert.match(read('CHANGELOG.md'), /A `dev-run` or `oneshot` entry is listed while its show-local process and that process's guard both run, and stopped only while the OS confirms they are still exactly those; an entry left behind whose pids other processes now have is removed \(`removed` in the `stop` result\), never stopped/);
  assert.match(read('CONTRIBUTING.md'), /is stopped only while the OS confirms that its pid is still that same process: a stale entry \(its pid reused by another process\) is removed, never stopped/);
});

test('prod: on Windows, stop never ends a oneshot process\'s whole tree, because the browser can run under it', () => {
  for (const [name, text] of [['SECURITY.md', read('SECURITY.md')], ['show-serve', skill('show-serve')], ['CHANGELOG.md', read('CHANGELOG.md')]]) {
    assert.match(text, /On Windows,? (`stop` |it ){1,2}never ends a `oneshot` process's whole tree, because the browser it opened the page with can run under it/, name);
  }
  assert.match(read('CONTRIBUTING.md'), /On Windows, never tree-kill a `oneshot` process: the browser it opened the page with can run under it/);
});

test('prod #25: a port under notFound is not called still running; one under refused is', () => {
  for (const name of ['show', 'show-serve']) {
    const text = skill(name);
    assert.doesNotMatch(text, /`refused` or `notFound` is still running/, name);
    assert.match(text, /A port under `refused` is still running: end the background task you started it with/, name);
    assert.match(text, /A port under `notFound` has no live entry in show-local's records: its server either ended already or was never recorded/, name);
    assert.match(text, /if that task has already ended, nothing you started holds the port, so do not call it held; if it still runs, end it/, name);
  }
});

test('prod #26: the CHANGELOG measures the long-path limit on the path, as detect() does', () => {
  const log = read('CHANGELOG.md');
  assert.doesNotMatch(log, /`file:\/\/\/` URL would pass/);
  assert.match(log, new RegExp(`an HTML file whose path is longer than ${WINDOWS_LONG_PATH} characters \\(too long for \`file:///\`\\) is opened through its 8\\.3 short name`));
  // A path under the limit whose file:/// URL is past it (spaces become %20) opens as it is.
  const t = tempDir('show-local-docs-');
  try {
    // Filled up to a few characters under the limit, with spaces in it (a name never ends in one).
    const fill = WINDOWS_LONG_PATH - 6 - t.dir.length - '/my page.html'.length - 1;
    const folder = path.join(t.dir, `${'ab c'.repeat(80).slice(0, fill - 1)}x`);
    mkdirSync(folder, { recursive: true });
    const page = path.join(folder, 'my page.html');
    writeFileSync(page, '<title>Long URL</title>');
    assert.ok(page.length <= WINDOWS_LONG_PATH, `path is ${page.length} characters`);
    assert.ok(pathToFileURL(page).href.length > WINDOWS_LONG_PATH, 'its URL is past the limit');
    const calls = [];
    const d = detect(page, { platform: 'win32', shortPathFn: (p) => { calls.push(p); return 'C:\\SHORT~1.HTM'; } });
    assert.equal(d.mode, 'file');
    assert.equal('shortPath' in d, false, 'no short path for a path under the limit');
    assert.deepEqual(calls, [], 'no short-path lookup either');
  } finally { t.cleanup(); }
});

test('prod #27: show-doctor does not limit selected: null to macOS and Linux', () => {
  const row = lineOf(skill('show-doctor'), /^\| "The folder opened, but the file is not selected"/);
  assert.ok(row, 'there is a row for it');
  assert.doesNotMatch(row, /\(macOS and Linux\)/);
  assert.match(row, /on macOS and Linux it never is; on Windows, Explorer's selection could not be read in time/);
  assert.match(row, /`--no-verify`/);
  assert.match(row, /do not tell the user whether the file is selected/);
});

test('prod: SHOW_LOCAL_TIMEOUT_MS above the default extends the budget, and 0 looks for no window (verified: null)', () => {
  const log = read('CHANGELOG.md');
  // The numbers the docs give are the code's.
  assert.match(log, new RegExp(`window check waits \\(default ${DEFAULT_TIMEOUT_MS} ms\\)`));
  assert.match(log, new RegExp(`finishes within ${DIRECT_BUDGET_MS / 1000} s end to end \\(plus whatever \`SHOW_LOCAL_TIMEOUT_MS\` sets above its default\\)`));
  assert.match(log, /A value above the default also extends a direct open's time budget by the same amount/);
  assert.match(log, /With `0` no window is looked for, so the open is `verified: null` \(never `false`\)/);
  assert.match(EN(), new RegExp(`A value above ${DEFAULT_TIMEOUT_MS} also extends the open's overall time limit by the same amount`));
  assert.match(HE(), new RegExp(`ערך מעל ${DEFAULT_TIMEOUT_MS} גם מאריך באותה מידה את מגבלת הזמן של הפתיחה כולה`));
  assert.match(EN(), /With `0` no window is looked for at all/);
  assert.match(HE(), /עם `0` לא מחפשים חלון בכלל/);
  const doctorSkill = skill('show-doctor');
  assert.match(doctorSkill, new RegExp(`A value above ${DEFAULT_TIMEOUT_MS} also extends the open's overall time budget by the same amount`));
  assert.match(doctorSkill, /\(`SHOW_LOCAL_TIMEOUT_MS` or `--timeout`\) was 0, so no window was looked for/);
  assert.match(lineOf(skill('show'), /^\| `verified: null`/), /a window timeout of 0 ms, so no window was looked for/);
  const contributing = read('CONTRIBUTING.md');
  assert.match(contributing, /`SHOW_LOCAL_TIMEOUT_MS=0` is different: no window is looked for at all, so the result is `verified: null`/);
  assert.match(contributing, new RegExp(`extends a direct open's ${DIRECT_BUDGET_MS / 1000} s budget`));
});

test('prod: the readiness check asks like a browser, and a local page that redirects to a hosted sign-in opens with verified: null', () => {
  const log = read('CHANGELOG.md');
  const sec = read('SECURITY.md');
  const serve = skill('show-serve');
  assert.match(log, /The check asks with a browser's `Accept` header \(`text\/html`\), so a single-page app's history fallback serves its deep links/);
  assert.match(serve, /The check asks for the page with a browser's `Accept` header \(`text\/html`\)/);
  assert.match(sec, /that check asks the way a browser does, with an `Accept` header for `text\/html`/);
  assert.match(log, /A local page that redirects to a remote address that could be a one-time link \(a hosted sign-in such as OAuth, Clerk or Auth0\) is opened without fetching that address, with `verified: null`/);
  assert.match(serve, /A local page that redirects to a hosted sign-in \(OAuth, Clerk, Auth0\) is opened without show-local fetching the sign-in address[^.]*: the result is then `verified: null`/);
  assert.match(sec, /a redirect to one that could be a one-time link \(a hosted sign-in, which carries one-time state\) is never followed by show-local, the page is opened anyway, and its open is reported as "cannot confirm"/);
  assert.match(lineOf(skill('show'), /^\| `url`/), /a local page that redirects to such an address \(a hosted sign-in\): it is opened, but that address is not fetched/);
  assert.match(lineOf(skill('show'), /^\| `verified: null`/), /a local page that redirects to one \(a hosted sign-in\)/);
  assert.match(skill('show-doctor'), /a local page redirected to such an address \(a hosted sign-in, for example\), and was opened without fetching it/);
  assert.match(EN(), /The same goes for a local page, such as a dev server's, that redirects to an address that could be a one-time link/);
  assert.match(HE(), /כך גם דף מקומי, למשל של שרת פיתוח, שמפנה לכתובת שעלולה להיות קישור חד-פעמי/);
});

test('prod: dev-port-unknown lists the ports a dev script names in `candidates`', () => {
  assert.match(lineOf(skill('show-serve'), /^\| `dev-port-unknown`/), /when the script names several, `candidates` lists them, and so does `detail`/);
  assert.match(skill('show'), /when the script names several, `candidates` lists them/);
  assert.match(read('CHANGELOG.md'), /a dev script that names several ports, whose result lists them in `candidates`/);
});
