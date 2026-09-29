// The E2E runner's judge (tests/e2e/run-e2e.mjs), on synthetic transcripts: what counts as a
// pass for a served case (plan + one foreground oneshot, the final reply judged), Edge process
// accounting, the session-survival check, case ids and fixture lengths, the reply language, no
// likelihood words in an unverified reply, and cleanup by tagged fixture names only. Importing
// the runner runs nothing; nothing here starts claude or opens a window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = await import(pathToFileURL(path.join(REPO, 'tests', 'e2e', 'run-e2e.mjs')).href);
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'show-local-judge-'));
process.on('exit', () => { try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } });

// ---------- transcript builders ----------
const asst = (blocks) => ({ type: 'assistant', message: { content: blocks } });
const tool = (id, name, input) => asst([{ type: 'tool_use', id, name, input }]);
const res = (id, text) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const say = (text) => asst([{ type: 'text', text }]);
const result = (text) => ({ type: 'result', subtype: 'success', result: text });
const out = (events) => ({ out: events.map((e) => JSON.stringify(e)).join('\n') });
const SHOW = "node 'C:/x/plugins/show-local/scripts/show.mjs'";

const planJson = (extra = {}) => JSON.stringify({ mode: 'serve', action: 'start-server', headless: true, opened: false, ms: 20, next: { oneshot: `${SHOW} oneshot 'C:/fx/site' --port 4400` }, ...extra });
const oneshotJson = (server = { stopped: true, port: 4400, lingerMs: 3000 }, extra = {}) => JSON.stringify({
  ok: true, mode: 'url', opened: true, verified: true, confidence: 'high', openedWith: 'Google Chrome', url: 'http://127.0.0.1:4400/',
  evidence: ['HTTP 200 from 127.0.0.1:4400', 'window "show-local e2e site T - Google Chrome" (chrome)', 'server log: 2026-09-29T00:00:00.000Z GET / 200 "Mozilla/5.0"'],
  ms: 5200, server, ...extra,
});
const REPLY_SERVED = 'האתר נפתח בכרום: http://127.0.0.1:4400/\n✓ חלון "show-local e2e site T", ביומן השרת GET / 200. עצרתי את השרת.';

function servedTranscript({ bgOneshot = false, extraStop = false, plan = planJson(), oneshot = oneshotJson(), reply = REPLY_SERVED, followUp = false } = {}) {
  const ev = [
    { type: 'system', subtype: 'init' },
    tool('t0', 'ToolSearch', { query: 'select:Skill' }), res('t0', ''),
    tool('s1', 'Skill', { skill: 'show-local:show-serve' }), res('s1', 'Launching skill'),
    tool('t1', 'ToolSearch', { query: 'select:Bash' }), res('t1', ''),
    tool('b1', 'Bash', { command: `${SHOW} 'C:/fx/site'` }), res('b1', plan),
    tool('b2', 'Bash', { command: `${SHOW} oneshot 'C:/fx/site' --port 4400`, ...(bgOneshot ? { run_in_background: true } : {}) }), res('b2', bgOneshot ? 'Command running in background with ID: x' : oneshot),
  ];
  if (extraStop) ev.push(tool('b3', 'Bash', { command: `${SHOW} stop 4400` }), res('b3', JSON.stringify({ ok: true, stopped: [{ port: 4400 }], notFound: [] })));
  ev.push(say(reply), result(reply));
  if (followUp) ev.push({ type: 'system', subtype: 'task_notification', status: 'failed' }, { type: 'system', subtype: 'init' }, say('exit code 1 זה צפוי'), result('exit code 1 זה צפוי'));
  return out(ev);
}

const fx = R.fixturePaths({});
const CASES = R.cases(fx);
const byId = (id) => CASES.find((c) => c.id === id);
const judged = (c, a, extra = {}) => R.judge(c, Object.assign(a, { endedBy: 'itself', portFreeAfter: true, ...extra })).map((p) => p.en);

// ---------- headless served through oneshot ----------
test('a clean plan + oneshot served case passes', () => {
  const a = R.analyse(servedTranscript());
  assert.equal(a.firstMode, 'serve');
  assert.deepEqual(a.work.map((w) => w.sub), ['open', 'oneshot']);
  assert.equal(a.oneshot.stopped, true);
  assert.equal(a.oneshot.port, 4400);
  assert.equal(a.oneshot.lingerMs, 3000);
  assert.equal(a.followUpTurns, 0);
  assert.equal(a.reply, REPLY_SERVED);
  assert.deepEqual(judged(byId('4-site'), a), []);
});

test('run_in_background, an extra stop call, a missing oneshot offer, an unstopped server all fail', () => {
  const bg = judged(byId('4-site'), R.analyse(servedTranscript({ bgOneshot: true })));
  assert.ok(bg.some((p) => /run_in_background/.test(p)), bg.join(' | '));
  assert.ok(bg.some((p) => /exactly the plan call and the oneshot call/.test(p)), bg.join(' | '));
  const stop = judged(byId('4-site'), R.analyse(servedTranscript({ extraStop: true })));
  assert.ok(stop.some((p) => /show\.mjs open → show\.mjs oneshot → show\.mjs stop/.test(p)), stop.join(' | '));
  const noOffer = judged(byId('4-site'), R.analyse(servedTranscript({ plan: planJson({ headless: false, next: { start: 'x', then: 'y' } }) })));
  assert.ok(noOffer.some((p) => /offers no next\.oneshot/.test(p)), noOffer.join(' | '));
  const mixed = judged(byId('4-site'), R.analyse(servedTranscript({ plan: planJson({ next: { oneshot: 'a', stop: 'b' } }) })));
  assert.ok(mixed.some((p) => /oneshot only/.test(p)), mixed.join(' | '));
  const unstopped = judged(byId('4-site'), R.analyse(servedTranscript({ oneshot: oneshotJson({ stopped: false, port: 4400 }) })));
  assert.ok(unstopped.some((p) => /server\.stopped: true/.test(p)), unstopped.join(' | '));
  const busy = judged(byId('4-site'), R.analyse(servedTranscript()), { portFreeAfter: false });
  assert.ok(busy.some((p) => /port 4400 still answered/.test(p)), busy.join(' | '));
  const killed = judged(byId('4-site'), R.analyse(servedTranscript()), { endedBy: 'runner-after-reply' });
  assert.ok(killed.some((p) => /did not exit by itself/.test(p)), killed.join(' | '));
  const quiet = judged(byId('4-site'), R.analyse(servedTranscript({ reply: 'האתר נפתח בכרום: http://127.0.0.1:4400/' })));
  assert.ok(quiet.some((p) => /does not say the server was stopped/.test(p)), quiet.join(' | '));
});

test('the FINAL result is judged, and a follow-up turn after a task notice fails', () => {
  const a = R.analyse(servedTranscript({ followUp: true }));
  assert.equal(a.turns, 2);
  assert.equal(a.followUpTurns, 1);
  assert.equal(a.followUpAfterNotice, true);
  assert.equal(a.reply, 'exit code 1 זה צפוי');
  assert.deepEqual(a.earlierReplies, [REPLY_SERVED]);
  const p = judged(byId('4-site'), a);
  assert.ok(p.some((x) => /more turn\(s\) ran after the first reply, after a background-task notice/.test(x)), p.join(' | '));
  assert.ok(p.some((x) => /reply does not give the full URL/.test(x)), p.join(' | '));
});

// ---------- every ToolSearch ----------
test('ToolSearch calls are counted over the whole transcript', () => {
  const a = R.analyse(servedTranscript());
  assert.equal(a.toolSearches, 2);
  assert.equal(a.toolSearchesAfterSkill, 1);
});

// ---------- Edge accounting ----------
const look = (procs, windows = [{ process: 'chrome', title: 'x - Google Chrome' }]) => ({ windows: { ok: true, windows }, edge: { ok: true, processes: procs } });
const BROWSER = { pid: 100, ppid: 4, cmd: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --no-startup-window' };
const CHILD = { pid: 101, ppid: 100, cmd: '"msedge.exe" --type=renderer --lang=en-US' };
test('Edge\'s own new children pass and are reported in the agreed wording', () => {
  const e = R.edgeCheck(look([BROWSER, CHILD]), look([BROWSER, CHILD, { pid: 102, ppid: 100, cmd: '"msedge.exe" --type=utility' }]), { title: 'show-local e2e plain T', needles: ['show-local-e2e-plain-T.html'] });
  assert.equal(e.ok, true);
  assert.equal(e.newBrowserProcesses, 0);
  assert.equal(e.withFixture, 0);
  assert.equal(e.newChildProcesses, 1);
  assert.equal(R.edgeLine(e), "Edge: before 2 → after 3 (new browser processes: 0, with the fixture: 0; new child processes: 1 are Edge's own background work)");
  const c = byId('2-file');
  assert.deepEqual(judged(c, { ...R.analyse(out([])), edge: e }).filter((p) => /Edge|msedge/.test(p)), []);
});

test('a new browser process, or the fixture on a command line, fails file, url and folder cases', () => {
  const file = fx.plain;
  const fresh = { pid: 200, ppid: 9, cmd: `"msedge.exe" --single-argument ${file}` };
  const e = R.edgeCheck(look([BROWSER]), look([BROWSER, fresh, { pid: 201, ppid: 200, cmd: '"msedge.exe" --type=gpu-process' }]), { title: R.TITLES.plain, needles: [path.basename(file)] });
  assert.equal(e.ok, false);
  assert.equal(e.newBrowserProcesses, 1);
  assert.equal(e.withFixture, 1);
  assert.equal(e.newChildProcesses, 1);
  assert.equal(e.newChildrenOfRunningEdge, 0);
  assert.match(R.edgeLine(e), /^Edge: before 1 → after 3 \(new browser processes: 1, with the fixture: 1; new child processes: 1, of which 1 belong to a new browser process\)$/);
  for (const id of ['1-url', '2-file', '5-folder', '10-fail']) {
    const p = judged(byId(id), { ...R.analyse(out([])), edge: e });
    assert.ok(p.some((x) => /new Edge browser process/.test(x)), `${id}: ${p.join(' | ')}`);
  }
  assert.ok(byId('5-folder').expect.notInEdge, '5-folder has the Edge check');
  // A url with the fixture's host on an Edge command line.
  const u = R.edgeCheck(look([BROWSER]), look([BROWSER, { pid: 300, ppid: 100, cmd: '"msedge.exe" --type=renderer https://example.com/' }]), { needles: ['example.com'] });
  assert.equal(u.withFixture, 1);
  assert.equal(u.newBrowserProcesses, 0);
  assert.equal(u.ok, false);
});

test('an unreadable process list is "not checked", never clean', () => {
  const e = R.edgeCheck(look([BROWSER]), { windows: { ok: true, windows: [] }, edge: { ok: false, error: 'x' } }, { needles: ['a.html'] });
  assert.equal(e.cmdChecked, false);
  assert.equal(e.ok, null);
  const p = judged(byId('2-file'), { ...R.analyse(out([])), edge: e });
  assert.ok(p.some((x) => /msedge process list could not be read/.test(x)));
});

// ---------- survives the session ----------
test('survivesSession is required for 2-file', () => {
  const win = (title) => ({ windows: { ok: true, windows: [{ process: 'chrome', title }] } });
  assert.equal(R.survives(win(`${R.TITLES.plain} - Google Chrome`), { title: R.TITLES.plain, process: 'chrome' }), true);
  assert.equal(R.survives(win('Other - Google Chrome'), { title: R.TITLES.plain, process: 'chrome' }), false);
  assert.equal(R.survives({ windows: { ok: false } }, { title: R.TITLES.plain }), null);
  assert.equal(R.survives({ windows: { ok: true, windows: [{ process: 'msedge', title: R.TITLES.plain }] } }, { title: R.TITLES.plain }), false);
  assert.equal(R.proofProcess({ evidence: ['window "a - Google Chrome" (chrome)'] }), 'chrome');
  assert.ok(byId('2-file').expect.survivesSession);
  const gone = judged(byId('2-file'), { ...R.analyse(out([])), survivesSession: false });
  assert.ok(gone.some((x) => /window was gone once the session had exited/.test(x)));
  const kept = judged(byId('2-file'), { ...R.analyse(out([])), survivesSession: true });
  assert.ok(!kept.some((x) => /session had exited|outlived/.test(x)));
});

test('a file reply that ties the page to the session, or shortens the path with "...", fails', () => {
  const base = { ...R.analyse(out([])), firstMode: 'file', finalMode: 'file' };
  const tied = judged(byId('14-session-temp'), { ...base, reply: 'פתחתי את הדוח: [`C:\\a\\b.html`](file:///C:/a/b.html) — הקישור עובד רק כל עוד הסשן הזה פתוח.' });
  assert.ok(tied.some((x) => /ties a file to the session/.test(x)), tied.join(' | '));
  const elided = judged(byId('14-session-temp'), { ...base, reply: 'Opened: [`C:\\Users\\me\\...\\report.html`](file:///C:/x.html)' });
  assert.ok(elided.some((x) => /shortens the path/.test(x)), elided.join(' | '));
  const fine = judged(byId('14-session-temp'), { ...base, reply: 'Opened: [`C:\\Users\\me\\report.html`](file:///C:/x.html)' });
  assert.ok(!fine.some((x) => /ties a file|shortens the path/.test(x)), fine.join(' | '));
});

// ---------- cases and fixtures ----------
test('case ids, exact fixture lengths, English and odd-name cases', () => {
  const ids = CASES.map((c) => c.id);
  for (const id of ['9a-path250', '9b-path270', '12-english', '13-badname', '14-session-temp']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.some((id) => /long200|long250/.test(id)));
  assert.equal(fx.path250.length, 250);
  assert.equal(fx.path270.length, 270);
  assert.ok(fx.session.length > 256);
  assert.deepEqual(R.longPathProblems(fx), []);
  assert.deepEqual(R.longPathProblems({ ...fx, path270: fx.path270 + 'x' }).length, 1);
  assert.equal(byId('12-english').lang, 'en');
  assert.match(byId('12-english').prompt, /^open the report .* in my browser$/);
  const odd = byId('13-badname').target;
  for (const ch of ["'", '$', '&', ';', '`', '%', ' ']) {
    assert.ok(path.basename(odd).includes(ch), `file name has ${ch}`);
    assert.ok(path.basename(path.dirname(odd)).includes(ch), `folder name has ${ch}`);
  }
  // 9b and 14 expect file + short path by default, the served fallback when the runner found no 8.3 path.
  assert.equal(byId('9b-path270').mode, 'file');
  assert.ok(byId('9b-path270').expect.shortPath);
  const off = R.cases({ ...fx, overLimit: { '9b-path270': { mode: 'serve', why: 'no 8.3' } } }).find((c) => c.id === '9b-path270');
  assert.equal(off.mode, 'serve');
  assert.ok(off.expect.served && off.expect.servedReason);
  assert.deepEqual(byId('9a-path250').expect.pathLength, { exact: 250, atMost: 256 });
});

test('14-session-temp goes into $SHOW_LOCAL_E2E_SESSION_DIR, in a folder of its own', () => {
  const env = { [R.SESSION_ENV]: SCRATCH };
  const f = R.fixturePaths(env);
  assert.equal(f.sessionRoot, path.join(SCRATCH, 'show-local-e2e'));
  assert.ok(f.session.startsWith(f.sessionRoot + path.sep));
  assert.ok(f.session.length > 256, String(f.session.length));
  const d = R.fixturePaths({});
  assert.ok(d.session.startsWith(path.join(os.tmpdir(), 'claude') + path.sep));
  assert.ok(d.session.length > 256);
});

test('the English case needs an English reply, the others Hebrew', () => {
  assert.equal(R.replyInLanguage('I opened the report in Chrome: C:/x.html', 'en'), true);
  assert.equal(R.replyInLanguage('פתחתי את הדוח', 'en'), false);
  assert.equal(R.replyInLanguage('פתחתי את הדוח', 'he'), true);
  const c = byId('12-english');
  const a = R.analyse(out([tool('s', 'Skill', { skill: 'show-local:show' }), res('s', ''), tool('b', 'Bash', { command: `${SHOW} '${c.target}'` }),
    res('b', JSON.stringify({ ok: true, mode: 'file', opened: true, verified: true, url: 'file:///x', evidence: ['window "t" (chrome)'], ms: 900 })), result(`פתחתי את ${c.target}`)]));
  const p = judged(c, a);
  assert.ok(p.includes('reply is not in English'), p.join(' | '));
});

test('8.3 expectations for 9b and 14 follow the runner\'s own measurement', () => {
  const long = 'C:\\' + 'a'.repeat(280);
  assert.equal(R.overLimitPlan(long, { ok: true, short: 'C:\\AAAAAA~1' }).mode, 'file');
  assert.equal(R.overLimitPlan(long, { ok: true, short: long }).mode, 'serve');
  assert.equal(R.overLimitPlan(long, { ok: false, error: 'x' }).mode, 'serve');
  assert.equal(R.usedShortPath({ shortPath: true }), true);
  assert.equal(R.usedShortPath({ mode: 'file', reasons: ['opened through its 8.3 short path'] }), true);
  assert.equal(R.usedShortPath({ mode: 'serve', reasons: ['no 8.3 short path'] }), false);
  const c = byId('9b-path270');
  const a = R.analyse(out([tool('s', 'Skill', { skill: 'show-local:show' }), res('s', ''), tool('b', 'Bash', { command: `${SHOW} '${c.target}'` }),
    res('b', JSON.stringify({ ok: true, mode: 'file', opened: true, verified: true, url: 'file:///C:/X~1/Y.HTM', evidence: ['window "t" (chrome)'], ms: 900 })), result(`פתחתי את ${c.target}`)]));
  const p = judged(c, a, { edge: R.edgeCheck(look([]), look([]), { title: c.title, needles: ['n'] }) });
  assert.ok(p.some((x) => /8\.3 short path/.test(x)), p.join(' | '));
});

// ---------- no guessing when unverified ----------
test('likelihood words fail an unverified reply', () => {
  assert.deepEqual(R.likelihoodClaims('בדוק בשורת המשימות — הסיכוי גבוה שהוא נפתח'), ['סיכוי']);
  assert.deepEqual(R.likelihoodClaims('הדף כנראה נפתח'), ['כנראה']);
  assert.deepEqual(R.likelihoodClaims('נראה שהוא נפתח'), ['נראה ש']);
  assert.deepEqual(R.likelihoodClaims('It probably opened; most likely in Chrome'), ['probably', 'likely']);
  assert.deepEqual(R.likelihoodClaims('ניסיתי לפתוח ולא הצלחתי לאמת שהחלון עלה. לא נראה חלון חדש.'), []);
  const c = byId('11-unverified');
  const mk = (reply) => R.analyse(out([tool('s', 'Skill', { skill: 'show-local:show' }), res('s', ''), tool('b', 'Bash', { command: `${SHOW} '${c.target}'` }),
    res('b', JSON.stringify({ ok: true, mode: 'file', opened: true, verified: false, url: 'file:///x', evidence: ['no window'], ms: 700 })), result(reply)]));
  const guess = judged(c, mk(`ניסיתי לפתוח את ${c.target} ולא הצלחתי לאמת. הסיכוי גבוה שהוא נפתח.`));
  assert.ok(guess.some((x) => /guesses/.test(x)), guess.join(' | '));
  const honest = judged(c, mk(`ניסיתי לפתוח את ${c.target} ולא הצלחתי לאמת שהחלון עלה.`));
  assert.ok(!honest.some((x) => /guesses/.test(x)), honest.join(' | '));
});

// ---------- cleanup tokens, run timestamps, merging ----------
test('cleanup looks only for this run\'s tagged fixture file names', () => {
  const t = R.cleanupTokens(fx);
  assert.ok(t.length >= 10);
  for (const x of t) assert.ok(x.includes(R.RUN_TAG), x);
  for (const generic of ['outputs', 'דוח בדיקה', 'show-local-e2e']) assert.ok(!t.includes(generic), generic);
});

test('a subset run keeps the other rows\' run timestamps and cleanup records', () => {
  const prev = {
    runs: [{ runAt: '2026-09-29T01:00:00.000Z', model: 'sonnet', finalSweep: ['closed VLC media player: clip.mp4'] }],
    rows: [
      { id: '1-url', runAt: '2026-09-29T01:00:00.000Z', pass: true, cleanup: { closed: ['closed explorer: <x>'] } },
      { id: '9a-long200', runAt: '2026-09-29T01:00:00.000Z', pass: true },
      { id: '2-file', runAt: '2026-09-29T01:00:00.000Z', pass: false, cleanup: { closed: [] } },
      { id: '5-folder', pass: true },
    ],
  };
  const run = { runAt: '2026-09-29T02:00:00.000Z', model: 'sonnet', finalSweep: [] };
  const fresh = [{ id: '2-file', runAt: run.runAt, pass: true, cleanup: { closed: ['closed Photos: img.png'] } }];
  const m = R.mergeResults(prev, fresh, run, CASES.map((c) => c.id));
  assert.deepEqual(m.rows.map((r) => r.id), ['1-url', '2-file', '5-folder']);
  assert.equal(m.rows[0].runAt, '2026-09-29T01:00:00.000Z');
  assert.deepEqual(m.rows[0].cleanup.closed, ['closed explorer: <x>']);
  assert.equal(m.rows[1].runAt, run.runAt);
  assert.deepEqual(m.runs.map((x) => x.runAt), ['2026-09-29T01:00:00.000Z', run.runAt]);
  const lines = R.cleanupLines(m.rows, m.runs);
  assert.ok(lines.some((l) => /^1-url \(run 2026-09-29 01:00Z\): closed explorer/.test(l)), lines.join(' | '));
  assert.ok(lines.some((l) => /^2-file \(run 2026-09-29 02:00Z\): closed Photos/.test(l)));
  assert.ok(lines.some((l) => /^end of run 2026-09-29 01:00Z: closed VLC/.test(l)));
  const md = R.renderMarkdown({ date: 'D', passed: 3, rows: m.rows.map((r) => ({ toolCallsAfterSkill: 1, toolSearches: 2, problems: [], ...r })), runs: m.runs });
  assert.match(md, /\| Case \| Run \|/);
  assert.match(md, /\| 1-url \| 2026-09-29 01:00Z \|/);
  assert.match(md, /\| 2-file \| 2026-09-29 02:00Z \|/);
  assert.match(md, /\| 5-folder \| older runner, no timestamp \|/);
  assert.match(md, /- 1-url \(run 2026-09-29 01:00Z\): closed explorer/);
  assert.match(md, /- 5-folder \(run older runner, no timestamp\): no cleanup record/);
  assert.match(md, /1 \(\+2 ToolSearch\)/);
});

test('selectors and subcommands', () => {
  assert.equal(R.selects('1-url', '1'), true);
  assert.equal(R.selects('10-fail', '1'), false);
  assert.equal(R.selects('12-english', '1'), false);
  assert.equal(R.selects('9a-path250', '9'), true);
  assert.equal(R.selects('9b-path270', '9b'), true);
  assert.equal(R.selects('14-session-temp', '14'), true);
  assert.equal(R.showSubcommand(`${SHOW} oneshot 'C:/x'`), 'oneshot');
  assert.equal(R.showSubcommand(`${SHOW} dev-run 'C:/x' --port 3000`), 'dev-run');
  assert.equal(R.showSubcommand(`${SHOW} 'C:/plan/x.html'`), 'open');
  assert.equal(R.showSubcommand(`${SHOW} plan 'C:/x' --headless`), 'plan');
});

// ---------- real, read-only measurements on this machine ----------
test('real: the runner measures an 8.3 short path for a 270-character file and a session-folder file', { skip: process.platform !== 'win32' }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'sl-e2e-d-'));
  try {
    const f270 = R.pathOfLength(base, `show-local-e2e-path270-${R.RUN_TAG}.html`, 270);
    mkdirSync(path.dirname(f270), { recursive: true });
    writeFileSync(f270, '<title>x</title>');
    let t = Date.now();
    const m = R.shortPathOf(f270);
    const ms270 = Date.now() - t;
    assert.equal(m.ok, true, JSON.stringify(m));
    const plan = R.overLimitPlan(f270, m);
    console.log(`# 270-char file: short path ${m.short.length} chars in ${ms270} ms → ${plan.mode}`);
    assert.equal(plan.mode, 'file');
    assert.ok(existsSync(m.short));
    assert.equal(statSync(m.short, { bigint: true }).ino, statSync(f270, { bigint: true }).ino);

    const f = R.fixturePaths({ [R.SESSION_ENV]: SCRATCH });
    mkdirSync(path.dirname(f.session), { recursive: true });
    writeFileSync(f.session, '<title>x</title>');
    try {
      t = Date.now();
      const s = R.shortPathOf(f.session);
      const msS = Date.now() - t;
      assert.equal(s.ok, true, JSON.stringify(s));
      const p = R.overLimitPlan(f.session, s);
      console.log(`# session file: ${f.session.length} chars, short path ${s.short.length} chars in ${msS} ms → ${p.mode}`);
      assert.equal(p.mode, 'file');
    } finally {
      rmSync(f.sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('real: the msedge process list reads pid, parent pid and command line', { skip: process.platform !== 'win32' }, () => {
  const t = Date.now();
  const e = R.edgeProcesses();
  assert.equal(e.ok, true, JSON.stringify(e));
  const ps = Array.isArray(e.processes) ? e.processes : e.processes == null ? [] : [e.processes];
  for (const p of ps) {
    assert.equal(typeof p.pid, 'number');
    assert.equal(typeof p.ppid, 'number');
    assert.equal(typeof p.cmd, 'string');
  }
  console.log(`# msedge processes: ${ps.length} (${ps.filter((p) => !/--type=/.test(p.cmd)).length} without --type=), read in ${Date.now() - t} ms`);
});

