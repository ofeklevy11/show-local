// Real-macOS smoke run, for GitHub's macOS runner (a real macOS with a desktop session).
// It runs show.mjs with the real `open` and Finder on the basic scenarios, and checks the one
// promise that matters most there: what show-local reveals is never run. Every "was not run"
// check has a control next to it: the same kind of file, opened directly with /usr/bin/open,
// must run (it writes its marker). Without that, a marker that never appeared would prove
// nothing. Opens real windows and runs real scripts: never run it on your own Mac.
//
//   node tests/smoke/macos.mjs          (CI only: refuses to run unless CI=true)
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.env.CI !== 'true') {
  console.error('macos.mjs runs only on a macOS CI runner (it opens windows and runs scripts on purpose)');
  process.exit(2);
}

const SHOW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/show-local/scripts/show.mjs');
const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'show-local-smoke-')));
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** show.mjs open <target> [...args], parsed. */
function show(target, ...args) {
  const r = spawnSync(process.execPath, [SHOW, 'open', target, '--timeout', '3000', ...args], { encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, error: 'no-json', detail: `${r.stdout}\n${r.stderr}` }; }
}

const put = (file, text, mode) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); if (mode) chmodSync(file, mode); return file; };
const script = (name, marker) => put(path.join(work, name), `#!/bin/sh\necho ran > "${marker}"\n`, 0o755);

/** An application bundle whose executable is a shell script that writes `marker`. */
function appBundle(name, marker) {
  const app = path.join(work, `${name}.app`);
  put(path.join(app, 'Contents', 'MacOS', name), `#!/bin/sh\necho ran > "${marker}"\n`, 0o755);
  put(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>dev.show-local.smoke.${name.toLowerCase()}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
  return app;
}

/** A Finder alias (bookmark file) at `at` that leads to `target`, made through the Foundation bridge (no Automation permission needed). */
function finderAlias(target, at) {
  const js = `ObjC.import('Foundation');
const t = $.NSURL.fileURLWithPath(${JSON.stringify(target)});
const data = t.bookmarkDataWithOptionsIncludingResourceValuesForKeysRelativeToURLError(1 << 10, null, null, null);
const ok = $.NSURL.writeBookmarkDataToURLOptionsError(data, $.NSURL.fileURLWithPath(${JSON.stringify(at)}), 0, null);
ok ? 'ok' : 'failed';`;
  const r = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 && r.stdout.trim() === 'ok' && existsSync(at);
}

async function appears(file, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (existsSync(file)) return true; await sleep(250); }
  return existsSync(file);
}

const marker = (name) => path.join(work, `${name}.ran`);

// ---- the basic scenarios -------------------------------------------------------------------

const page = put(path.join(work, 'report.html'), '<!doctype html><title>show-local smoke report</title><h1>smoke</h1>');
let r = show(page);
check('HTML page opens in the default browser', r.ok && r.opened && r.mode === 'file', `mode=${r.mode} how=${r.how} verified=${r.verified} ${r.detail || ''}`);

const pdf = put(path.join(work, 'doc.pdf'), '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
r = show(pdf);
check('PDF opens in its default app', r.ok && r.opened && r.mode === 'app' && r.how === 'open', `mode=${r.mode} how=${r.how} ${r.detail || ''}`);

const out = path.join(work, 'outputs');
put(path.join(out, 'final.pdf'), '%PDF-1.4\n%%EOF\n');
put(path.join(out, 'notes.txt'), 'notes');
r = show(out);
check('a folder opens in Finder with its main file selected (open -R)', r.ok && r.opened && r.mode === 'folder' && r.how === 'open -R' && r.select === path.join(out, 'final.pdf'), `how=${r.how} select=${r.select}`);

r = show(out, '--select', path.join(out, 'notes.txt'));
check('--select reveals the named file', r.ok && r.opened && r.how === 'open -R' && r.select === path.join(out, 'notes.txt'), `how=${r.how} select=${r.select}`);

// ---- never run what it shows, each with a control that does run ------------------------------

async function neverRuns(label, target, markerFile, control, controlMarker, expectReason) {
  const res = show(target);
  const revealed = res.ok && res.opened && res.mode === 'folder' && res.how === 'open -R' && res.select === target;
  check(`${label}: revealed in Finder, not opened`, revealed, `mode=${res.mode} how=${res.how} reason=${(res.reasons || [])[0] || ''}`);
  if (expectReason) check(`${label}: the reason says why`, expectReason.test((res.reasons || []).join(' ')), (res.reasons || []).join(' | '));
  const ran = await appears(markerFile, 6000);
  check(`${label}: never ran`, !ran, ran ? 'its marker was written' : 'no marker after 6 s');
  if (control) {
    const c = spawnSync('/usr/bin/open', [control], { encoding: 'utf8', timeout: 30000 });
    const controlRan = await appears(controlMarker, 30000);
    check(`${label}: control — the same kind of file opened directly does run (so "never ran" means something)`, c.status === 0 && controlRan,
      `open exit ${c.status}${c.stderr ? `: ${c.stderr.trim()}` : ''}; marker ${controlRan ? 'written' : 'not written in 30 s'}`);
  }
}

await neverRuns('a .command script', script('evil.command', marker('command')), marker('command'),
  script('control.command', marker('command-control')), marker('command-control'), /run when opened/);

await neverRuns('an .app bundle', appBundle('Evil', marker('app')), marker('app'),
  appBundle('Control', marker('app-control')), marker('app-control'), /application bundle/);

const aliasTarget = script('alias-target.command', marker('alias'));
const alias = path.join(work, 'report-alias.pdf');
const controlAliasTarget = script('alias-control-target.command', marker('alias-control'));
const controlAlias = path.join(work, 'control-alias.pdf');
if (finderAlias(aliasTarget, alias) && finderAlias(controlAliasTarget, controlAlias)) {
  await neverRuns('a Finder alias named report-alias.pdf that leads to a .command', alias, marker('alias'),
    controlAlias, marker('alias-control'), /Finder alias/);
} else {
  check('a Finder alias could be created for the test', false, 'the Foundation bookmark call failed');
}

const link = path.join(work, 'notes-link.pdf');
symlinkSync(script('link-target.command', marker('link')), link);
await neverRuns('a symlink named notes-link.pdf that leads to a .command', link, marker('link'), null, null, /leads to link-target\.command/);

const htmlLink = path.join(work, 'page-link.html');
symlinkSync(script('html-link-target.command', marker('html-link')), htmlLink);
await neverRuns('a symlink named page-link.html that leads to a .command', htmlLink, marker('html-link'), null, null, /not an HTML page/);

// An older alias: an empty file with the alias bit in its Finder flags.
const legacy = put(path.join(work, 'legacy.pdf'), '');
const setFlags = spawnSync('/usr/bin/xattr', ['-wx', 'com.apple.FinderInfo', `0000000000000000 8000 ${'0'.repeat(44)}`.replace(/ /g, ''), legacy], { encoding: 'utf8' });
if (setFlags.status === 0) {
  const d = show(legacy);
  check('an older alias (alias bit in the Finder flags) is revealed', d.ok && d.mode === 'folder' && /Finder alias/.test((d.reasons || []).join(' ')), `mode=${d.mode} reason=${(d.reasons || [])[0] || ''}`);
} else {
  check('the Finder flags could be set for the test', false, setFlags.stderr);
}

// Quarantine: show-local reveals a quarantined script and leaves the attribute alone.
const quarantined = script('downloaded.command', marker('quarantine'));
spawnSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', quarantined]);
await neverRuns('a quarantined .command', quarantined, marker('quarantine'), null, null, /run when opened/);
const q = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', quarantined], { encoding: 'utf8' });
check('the quarantine attribute is left in place', q.status === 0 && q.stdout.includes('Safari'), q.stdout.trim() || q.stderr.trim());

// A package folder other than .app (.prefPane): with nothing to select, revealed in its parent.
const pane = path.join(work, 'Thing.prefPane');
put(path.join(pane, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundlePackageType</key><string>BNDL</string></dict></plist>');
r = show(pane, '--folder');
check('a .prefPane package is revealed in its parent, never handed to open', r.ok && r.opened && r.how === 'open -R', `how=${r.how} select=${r.select}`);

// A document that can carry macros.
const doc = put(path.join(work, 'old.doc'), 'x');
r = show(doc);
check('a .doc (can carry macros) is revealed, not opened', r.ok && r.mode === 'folder' && r.how === 'open -R' && /macros/.test((r.reasons || []).join(' ')), `how=${r.how} reason=${(r.reasons || [])[0] || ''}`);

// ---- report ------------------------------------------------------------------------------------

const failed = results.filter((x) => !x.ok);
const table = ['| Check | Result | Detail |', '|---|---|---|', ...results.map((x) => `| ${x.name} | ${x.ok ? 'PASS' : '**FAIL**'} | ${String(x.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)];
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## macOS smoke (${os.release()})\n\n${table.join('\n')}\n\n${results.length - failed.length}/${results.length} passed\n`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
