// lib/browser.mjs (default-browser resolution, launch argv) and the pure helpers in lib/util.mjs.
// Everything runs through fakes: no registry, plutil, xdg-settings, browser or window is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeRun, lib, tempDir } from './helpers.mjs';

const B = await import(lib('browser.mjs'));
const U = await import(lib('util.mjs'));

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

// URLs that must reach the browser as exactly one argument, byte for byte.
const URLS = {
  hebrew: 'http://127.0.0.1:4401/%D7%A9%D7%9C%D7%95%D7%9D%20%D7%A2%D7%95%D7%9C%D7%9D/index.html?q=%D7%90%20b&x=1&y=2#%D7%9B%D7%95%D7%AA%D7%A8%D7%AA',
  spaces: 'http://localhost:4402/My%20Site/about%20us.html',
  hashAmp: 'http://127.0.0.1:4403/app/?a=1&b=2&c=%26#/route?x=1&y=2',
  file: 'file:///C:/Users/dana/Desktop/%D7%94%D7%90%D7%AA%D7%A8%20%D7%A9%D7%9C%D7%99/index.html#top&x=1',
  // Placeholder look-alikes and String.replace patterns inside the URL must not be expanded.
  tricky: 'http://localhost:5173/a%1Fb/%L/%2A/$&/$1/$$?x=%25&y=%*#frag&z',
};

// Real registry "shell\open\command" templates.
const T = {
  chrome: String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --single-argument %1`,
  edge: String.raw`"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --single-argument %1`,
  firefox: String.raw`"C:\Program Files\Mozilla Firefox\firefox.exe" -osint -url "%1"`,
  brave: String.raw`"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --single-argument %1`,
  braveLegacy: String.raw`"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" -- "%1"`,
  vivaldi: String.raw`"C:\Users\Dana\AppData\Local\Vivaldi\Application\vivaldi.exe"  -- "%1"`,
  operaL: String.raw`"C:\Users\Dana\AppData\Local\Programs\Opera\launcher.exe" -noautoupdate -- "%L"`,
  lowerL: String.raw`"C:\Apps\Browser\b.exe" %l`,
  star: String.raw`"C:\Tools\BrowserPicker\picker.exe" %*`,
  embedded: String.raw`"C:\Tools\Kiosk\kiosk.exe" --app=%1 --kiosk`,
  none: String.raw`"C:\Program Files\Internet Explorer\iexplore.exe"`,
  noneWithFlag: String.raw`"C:\Tools\Viewer\viewer.exe" -nohome`,
};

const EXE = {
  chrome: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  edge: String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  firefox: String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`,
  brave: String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`,
  vivaldi: String.raw`C:\Users\Dana\AppData\Local\Vivaldi\Application\vivaldi.exe`,
};

// Expected argv (after the exe) for each template, given the URL.
const EXPECTED_ARGS = {
  chrome: (u) => ['--single-argument', u],
  edge: (u) => ['--single-argument', u],
  firefox: (u) => ['-osint', '-url', u],
  brave: (u) => ['--single-argument', u],
  braveLegacy: (u) => ['--', u],
  vivaldi: (u) => ['--', u],
  operaL: (u) => ['-noautoupdate', '--', u],
  lowerL: (u) => [u],
  star: (u) => [u],
  embedded: (u) => [`--app=${u}`, '--kiosk'],
  none: (u) => [u],
  noneWithFlag: (u) => ['-nohome', u],
};

// ---- A fake `reg query` over an in-memory registry --------------------------------------------

const HIVES = { HKCU: 'HKEY_CURRENT_USER', HKCR: 'HKEY_CLASSES_ROOT', HKLM: 'HKEY_LOCAL_MACHINE' };
const URL_CHOICE = (scheme) => `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`;
const FILE_CHOICE = (ext) => `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`;
const HKCR_CMD = (progId) => `HKCR\\${progId}\\shell\\open\\command`;
const HKLM_CMD = (progId) => `HKLM\\SOFTWARE\\Classes\\${progId}\\shell\\open\\command`;
const HKCU_CMD = (progId) => `HKCU\\SOFTWARE\\Classes\\${progId}\\shell\\open\\command`;

function regLookup(reg, args) {
  const values = reg[args[1]];
  if (!values) return undefined;
  const name = args[2] === '/v' ? args[3] : args[2] === '/ve' ? '' : undefined;
  return name === undefined ? undefined : values[name];
}

/**
 * reg: { 'HKCU\\...': { ProgId: 'ChromeHTML' }, 'HKCR\\X\\shell\\open\\command': { '': template } }.
 * A value may be [type, data] to choose the REG_ type. Missing keys/values exit 1, like reg.exe.
 * `label` is the (localised) name reg.exe prints for the default value.
 */
function fakeRegistry(reg, { label = '(Default)', eol = '\r\n' } = {}) {
  return fakeRun([[
    (cmd, args) => cmd === 'reg' && args[0] === 'query' && regLookup(reg, args) !== undefined,
    (cmd, args) => {
      const v = regLookup(reg, args);
      const [type, data] = Array.isArray(v) ? v : ['REG_SZ', v];
      const name = args[2] === '/v' ? args[3] : label;
      const key = args[1].replace(/^(HKCU|HKCR|HKLM)/, (h) => HIVES[h]);
      return { stdout: `${eol}${key}${eol}    ${name}    ${type}    ${data}${eol}${eol}` };
    },
  ]]);
}

const regKeysQueried = (runFn) => runFn.calls.filter((c) => c.cmd === 'reg').map((c) => c.args[1]);

// ---- Linux fakes -------------------------------------------------------------------------------

const slash = (p) => String(p).replace(/\\/g, '/');

/** Injected exists/readFile over { '/abs/path': text | Error }; paths compared with forward slashes. */
function fakeFs(files) {
  const map = new Map(Object.entries(files).map(([k, v]) => [slash(k), v]));
  const probed = [];
  const read = [];
  return {
    probed,
    read,
    exists: (p) => { probed.push(slash(p)); return map.has(slash(p)); },
    readFile: (p, enc) => {
      read.push({ path: slash(p), enc });
      const v = map.get(slash(p));
      if (v instanceof Error) throw v;
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return v;
    },
  };
}

const xdg = (stdout, status = 0) => fakeRun([['xdg-settings get default-web-browser', { status, stdout }]]);
const LINUX_ENV = { XDG_DATA_HOME: '/home/tester/.local/share', XDG_DATA_DIRS: '/usr/local/share:/usr/share' };
const HOME = '/home/tester';

// ---------------------------------------------------------------------------------------------
// util.splitWindowsCommand
// ---------------------------------------------------------------------------------------------

test('splitWindowsCommand: quoted exe with spaces stays one argument, quotes removed', () => {
  assert.deepEqual(U.splitWindowsCommand(T.chrome), [EXE.chrome, '--single-argument', '%1']);
  assert.deepEqual(U.splitWindowsCommand(T.edge), [EXE.edge, '--single-argument', '%1']);
  assert.deepEqual(U.splitWindowsCommand(T.firefox), [EXE.firefox, '-osint', '-url', '%1']);
});

test('splitWindowsCommand: unquoted command splits on whitespace', () => {
  assert.deepEqual(U.splitWindowsCommand('notepad.exe a b'), ['notepad.exe', 'a', 'b']);
});

test('splitWindowsCommand: runs of spaces/tabs and leading/trailing whitespace are ignored', () => {
  assert.deepEqual(U.splitWindowsCommand('  a \t  b\t\tc   '), ['a', 'b', 'c']);
  assert.deepEqual(U.splitWindowsCommand(T.vivaldi), [EXE.vivaldi, '--', '%1']);
});

test('splitWindowsCommand: empty and whitespace-only input give no arguments', () => {
  assert.deepEqual(U.splitWindowsCommand(''), []);
  assert.deepEqual(U.splitWindowsCommand('   \t '), []);
});

test('splitWindowsCommand: backslashes not followed by a quote are literal (paths, UNC)', () => {
  assert.deepEqual(U.splitWindowsCommand(String.raw`C:\Tools\a.exe C:\dir\file.txt`), [String.raw`C:\Tools\a.exe`, String.raw`C:\dir\file.txt`]);
  assert.deepEqual(U.splitWindowsCommand(String.raw`\\server\share\app.exe /x`), [String.raw`\\server\share\app.exe`, '/x']);
  assert.deepEqual(U.splitWindowsCommand(String.raw`a\\b`), [String.raw`a\\b`]);
});

test('splitWindowsCommand: trailing backslashes at the end of input are kept', () => {
  assert.deepEqual(U.splitWindowsCommand('C:\\dir\\'), ['C:\\dir\\']);
  assert.deepEqual(U.splitWindowsCommand('x C:\\dir\\\\'), ['x', 'C:\\dir\\\\']);
});

test('splitWindowsCommand: odd backslashes before a quote give a literal quote', () => {
  // a\"b  ->  a"b
  assert.deepEqual(U.splitWindowsCommand(String.raw`a\"b`), ['a"b']);
  // a\\\"b  ->  a\"b
  assert.deepEqual(U.splitWindowsCommand(String.raw`a\\\"b`), ['a\\"b']);
  // literal quote inside a quoted region does not end it
  assert.deepEqual(U.splitWindowsCommand(String.raw`"say \"hi\" now" next`), ['say "hi" now', 'next']);
});

test('splitWindowsCommand: even backslashes before a quote halve and the quote toggles', () => {
  // "a\\" b  ->  a\  and  b
  assert.deepEqual(U.splitWindowsCommand(String.raw`"a\\" b`), ['a\\', 'b']);
  // "a\\\\" b  ->  a\\  and  b
  assert.deepEqual(U.splitWindowsCommand(String.raw`"a\\\\" b`), ['a\\\\', 'b']);
  // quoted directory with an escaped trailing backslash
  assert.deepEqual(U.splitWindowsCommand(String.raw`"C:\Program Files\App\\" --x`), ['C:\\Program Files\\App\\', '--x']);
});

test('splitWindowsCommand: empty quoted argument is kept as an empty string', () => {
  assert.deepEqual(U.splitWindowsCommand('a "" b'), ['a', '', 'b']);
  assert.deepEqual(U.splitWindowsCommand('""'), ['']);
});

test('splitWindowsCommand: quotes in the middle of a token join the parts', () => {
  assert.deepEqual(U.splitWindowsCommand('abc"d e"f g'), ['abcd ef', 'g']);
  assert.deepEqual(U.splitWindowsCommand('--user-data-dir="C:\\My Profile" %1'), ['--user-data-dir=C:\\My Profile', '%1']);
});

test('splitWindowsCommand: an unterminated quote runs to the end of the line', () => {
  assert.deepEqual(U.splitWindowsCommand(String.raw`"C:\Program Files\x.exe --flag`), [String.raw`C:\Program Files\x.exe --flag`]);
});

test('splitWindowsCommand: Hebrew and other non-ASCII text passes through untouched', () => {
  assert.deepEqual(U.splitWindowsCommand('"C:\\Users\\אופק\\תוכנה\\app.exe" "קובץ עם רווח.txt"'), ['C:\\Users\\אופק\\תוכנה\\app.exe', 'קובץ עם רווח.txt']);
});

// ---------------------------------------------------------------------------------------------
// parseWindowsTemplate + browserArgs
// ---------------------------------------------------------------------------------------------

test('parseWindowsTemplate: splits real browser templates into exe + args', () => {
  assert.deepEqual(B.parseWindowsTemplate(T.chrome), { exe: EXE.chrome, args: ['--single-argument', '%1'] });
  assert.deepEqual(B.parseWindowsTemplate(T.edge), { exe: EXE.edge, args: ['--single-argument', '%1'] });
  assert.deepEqual(B.parseWindowsTemplate(T.firefox), { exe: EXE.firefox, args: ['-osint', '-url', '%1'] });
  assert.deepEqual(B.parseWindowsTemplate(T.brave), { exe: EXE.brave, args: ['--single-argument', '%1'] });
  assert.deepEqual(B.parseWindowsTemplate(T.braveLegacy), { exe: EXE.brave, args: ['--', '%1'] });
  assert.deepEqual(B.parseWindowsTemplate(T.none), { exe: String.raw`C:\Program Files\Internet Explorer\iexplore.exe`, args: [] });
});

test('parseWindowsTemplate: empty template gives null', () => {
  assert.equal(B.parseWindowsTemplate(''), null);
  assert.equal(B.parseWindowsTemplate('   '), null);
});

test('browserArgs: every real template x every tricky URL -> URL appears exactly once, unchanged', async (t) => {
  for (const [tname, template] of Object.entries(T)) {
    await t.test(tname, () => {
      const parsed = B.parseWindowsTemplate(template);
      for (const [uname, url] of Object.entries(URLS)) {
        const args = B.browserArgs(parsed, url);
        assert.deepEqual(args, EXPECTED_ARGS[tname](url), `${tname} with ${uname} URL`);
        const carrying = args.filter((a) => a.includes(url));
        assert.equal(carrying.length, 1, `${tname}: URL must be in exactly one argument`);
      }
    });
  }
});

test('browserArgs: Chrome with a Hebrew percent-encoded URL -> [--single-argument, url]', () => {
  const args = B.browserArgs(B.parseWindowsTemplate(T.chrome), URLS.hebrew);
  assert.deepEqual(args, ['--single-argument', URLS.hebrew]);
  assert.equal(args[1], URLS.hebrew);
});

test('browserArgs: Firefox quoted "%1" becomes the bare URL (no quote characters)', () => {
  const args = B.browserArgs(B.parseWindowsTemplate(T.firefox), URLS.hashAmp);
  assert.deepEqual(args, ['-osint', '-url', URLS.hashAmp]);
  assert.ok(!args.some((a) => a.includes('"')));
});

test('browserArgs: %L, %l and %* are placeholders too', () => {
  assert.deepEqual(B.browserArgs(B.parseWindowsTemplate(T.operaL), URLS.spaces), ['-noautoupdate', '--', URLS.spaces]);
  assert.deepEqual(B.browserArgs(B.parseWindowsTemplate(T.lowerL), URLS.spaces), [URLS.spaces]);
  assert.deepEqual(B.browserArgs(B.parseWindowsTemplate(T.star), URLS.spaces), [URLS.spaces]);
});

test('browserArgs: no placeholder -> URL appended after the existing args', () => {
  assert.deepEqual(B.browserArgs({ exe: 'x.exe', args: [] }, URLS.hebrew), [URLS.hebrew]);
  assert.deepEqual(B.browserArgs(B.parseWindowsTemplate(T.noneWithFlag), URLS.hebrew), ['-nohome', URLS.hebrew]);
});

test('browserArgs: placeholder embedded in a flag is substituted in place', () => {
  assert.deepEqual(B.browserArgs(B.parseWindowsTemplate(T.embedded), URLS.file), [`--app=${URLS.file}`, '--kiosk']);
});

test('browserArgs: $-patterns and %-look-alikes in the URL are inserted literally', () => {
  const args = B.browserArgs(B.parseWindowsTemplate(T.chrome), URLS.tricky);
  assert.equal(args[1], URLS.tricky);
  assert.ok(args[1].includes('$&') && args[1].includes('$1') && args[1].includes('%L') && args[1].includes('%*'));
});

test('browserArgs: does not mutate the parsed template (reusable across calls)', () => {
  const parsed = B.parseWindowsTemplate(T.chrome);
  B.browserArgs(parsed, URLS.hebrew);
  const second = B.browserArgs(parsed, URLS.spaces);
  assert.deepEqual(parsed.args, ['--single-argument', '%1']);
  assert.deepEqual(second, ['--single-argument', URLS.spaces]);
});

test('browserArgs: accepts a resolved browser object (exe/args plus extra fields)', () => {
  const browser = { platform: 'win32', progId: 'ChromeHTML', name: 'Google Chrome', process: 'chrome', ...B.parseWindowsTemplate(T.chrome) };
  assert.deepEqual(B.browserArgs(browser, URLS.hebrew), ['--single-argument', URLS.hebrew]);
});

test('browserArgs: "%1" %* opens the URL once (%* is the extra parameters, empty for a single URL)', () => {
  // Windows shell semantics: in `"%1" %*` (e.g. exefile, many protocol handlers) %1 is the target and
  // %* expands to the *remaining* parameters, which are empty when opening one URL. Passing the URL
  // for both would open it twice (two tabs).
  const parsed = B.parseWindowsTemplate(String.raw`"C:\Tools\Handler\handler.exe" "%1" %*`);
  assert.deepEqual(B.browserArgs(parsed, URLS.hebrew), [URLS.hebrew]);
});

// ---------------------------------------------------------------------------------------------
// Registry reading: windowsProgId / windowsFileProgId / windowsCommandFor / resolveWindowsBrowser
// ---------------------------------------------------------------------------------------------

const chromeRegistry = () => ({
  [URL_CHOICE('https')]: { ProgId: 'ChromeHTML', Hash: 'abc=' },
  [HKCR_CMD('ChromeHTML')]: { '': T.chrome },
});

// resolveWindowsBrowser checks that the exe exists, with the real file system on Windows. These
// registry-parsing tests say "it exists" explicitly, so their result never depends on which
// browsers the machine running them has installed; the fallback has tests of its own below.
const resolveWin = (runFn, exists = () => true) => B.resolveWindowsBrowser(runFn, exists);

/** fakeRegistry plus a PowerShell that answers the Unicode registry read with `template`. */
function withUnicodeFallback(reg, template, opts) {
  const regRun = fakeRegistry(reg, opts);
  const fn = (cmd, args = [], o = {}) => {
    if (cmd === 'powershell.exe') {
      regRun.calls.push({ cmd, args, opts: o });
      return template == null ? { status: 1, stdout: '', stderr: 'not found', error: null } : { status: 0, stdout: `${template}\r\n`, stderr: '', error: null };
    }
    return regRun(cmd, args, o);
  };
  fn.calls = regRun.calls;
  return fn;
}

test('resolveWindowsBrowser: an exe that does not exist asks PowerShell for the Unicode value, progId only in the environment', () => {
  const unicode = String.raw`"C:\Users\דנה\AppData\Local\Google\Chrome\Application\chrome.exe" --single-argument %1`;
  const runFn = withUnicodeFallback(chromeRegistry(), unicode);
  const checked = [];
  const b = resolveWin(runFn, (p) => { checked.push(p); return false; });
  assert.deepEqual(checked, [EXE.chrome], 'the reg.exe answer is checked first');
  const ps = runFn.calls.filter((c) => c.cmd === 'powershell.exe');
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0].opts.env, { SHOW_LOCAL_PROGID: 'ChromeHTML' });
  assert.ok(!ps[0].args.join(' ').includes('ChromeHTML'), 'the ProgId is never spliced into the script');
  assert.equal(ps[0].args[ps[0].args.indexOf('-Command') - 1], 'Bypass');
  assert.equal(b.template, unicode);
  assert.equal(b.exe, String.raw`C:\Users\דנה\AppData\Local\Google\Chrome\Application\chrome.exe`);
  assert.equal(b.name, 'Google Chrome');
});

test('resolveWindowsBrowser: a mangled reg.exe value (U+FFFD) is re-read through PowerShell even when that path "exists"', () => {
  const mangled = String.raw`"C:\Users\D�na\AppData\Local\Vivaldi\Application\vivaldi.exe" -- "%1"`;
  const runFn = withUnicodeFallback({ [URL_CHOICE('https')]: { ProgId: 'VivaldiHTM.X' }, [HKCR_CMD('VivaldiHTM.X')]: { '': mangled } }, T.vivaldi);
  const b = resolveWin(runFn, () => true);
  assert.equal(runFn.calls.filter((c) => c.cmd === 'powershell.exe').length, 1);
  assert.equal(b.template, T.vivaldi);
  assert.equal(b.exe, EXE.vivaldi);
});

test('resolveWindowsBrowser: when PowerShell has nothing better, the reg.exe answer is kept', () => {
  const runFn = withUnicodeFallback(chromeRegistry(), null);
  const b = resolveWin(runFn, () => false);
  assert.equal(runFn.calls.filter((c) => c.cmd === 'powershell.exe').length, 1);
  assert.equal(b.exe, EXE.chrome);
  assert.equal(b.template, T.chrome);
});

test('resolveWindowsBrowser: a clean value whose exe exists never starts PowerShell', () => {
  const runFn = withUnicodeFallback(chromeRegistry(), T.edge);
  const b = resolveWin(runFn, () => true);
  assert.deepEqual(runFn.calls.map((c) => c.cmd), ['reg', 'reg']);
  assert.equal(b.exe, EXE.chrome);
});

test('resolveWindowsBrowser: Chrome via https UserChoice + HKCR command (English "(Default)")', () => {
  const runFn = fakeRegistry(chromeRegistry());
  const b = resolveWin(runFn);
  assert.deepEqual(b, {
    platform: 'win32', progId: 'ChromeHTML', template: T.chrome, exe: EXE.chrome,
    args: ['--single-argument', '%1'], name: 'Google Chrome', process: 'chrome',
  });
  // The first query is the https UserChoice ProgId, asked by value name.
  assert.deepEqual(runFn.calls[0], { cmd: 'reg', args: ['query', URL_CHOICE('https'), '/v', 'ProgId'], opts: {} });
  // The command is read as the key's default value (/ve).
  assert.deepEqual(runFn.calls[1].args, ['query', HKCR_CMD('ChromeHTML'), '/ve']);
  assert.ok(runFn.calls.every((c) => c.cmd === 'reg'));
});

test('resolveWindowsBrowser: localised default-value label (Hebrew "(ברירת מחדל)") still parses', () => {
  const runFn = fakeRegistry(chromeRegistry(), { label: '(ברירת מחדל)' });
  const b = resolveWin(runFn);
  assert.equal(b.template, T.chrome);
  assert.equal(b.exe, EXE.chrome);
});

test('resolveWindowsBrowser: other localised labels (German "(Standard)", French "(par défaut)")', () => {
  for (const label of ['(Standard)', '(par défaut)']) {
    const b = resolveWin(fakeRegistry(chromeRegistry(), { label }));
    assert.equal(b?.exe, EXE.chrome, label);
  }
});

test('resolveWindowsBrowser: LF-only output parses the same as CRLF', () => {
  const b = resolveWin(fakeRegistry(chromeRegistry(), { eol: '\n' }));
  assert.equal(b.template, T.chrome);
  assert.equal(b.progId, 'ChromeHTML');
});

test('resolveWindowsBrowser: no carriage return leaks into progId, template or args', () => {
  const b = resolveWin(fakeRegistry(chromeRegistry()));
  assert.ok(!/[\r\n]/.test(b.progId + b.template + b.exe + b.args.join('')));
});

test('resolveWindowsBrowser: Edge, Firefox and Brave map to the right names/processes', () => {
  const cases = [
    ['MSEdgeHTM', T.edge, EXE.edge, 'Microsoft Edge', 'msedge'],
    ['FirefoxURL-308046B0AF4A39CB', T.firefox, EXE.firefox, 'Firefox', 'firefox'],
    ['BraveHTML', T.brave, EXE.brave, 'Brave', 'brave'],
  ];
  for (const [progId, template, exe, name, proc] of cases) {
    const b = resolveWin(fakeRegistry({ [URL_CHOICE('https')]: { ProgId: progId }, [HKCR_CMD(progId)]: { '': template } }));
    assert.equal(b.progId, progId);
    assert.equal(b.exe, exe);
    assert.equal(b.name, name);
    assert.equal(b.process, proc);
  }
});

test('resolveWindowsBrowser: two spaces inside the command value (Vivaldi) are preserved in the template', () => {
  const b = resolveWin(fakeRegistry({ [URL_CHOICE('https')]: { ProgId: 'VivaldiHTM.X' }, [HKCR_CMD('VivaldiHTM.X')]: { '': T.vivaldi } }));
  assert.equal(b.template, T.vivaldi);
  assert.deepEqual(b.args, ['--', '%1']);
  assert.equal(b.name, 'Vivaldi');
});

test('resolveWindowsBrowser: REG_EXPAND_SZ values are read like REG_SZ', () => {
  const b = resolveWin(fakeRegistry({ [URL_CHOICE('https')]: { ProgId: 'ChromeHTML' }, [HKCR_CMD('ChromeHTML')]: { '': ['REG_EXPAND_SZ', T.chrome] } }));
  assert.equal(b.template, T.chrome);
});

test('resolveWindowsBrowser: https ProgId missing -> falls back to the http ProgId', () => {
  const runFn = fakeRegistry({ [URL_CHOICE('http')]: { ProgId: 'FirefoxURL-308046B0AF4A39CB' }, [HKCR_CMD('FirefoxURL-308046B0AF4A39CB')]: { '': T.firefox } });
  const b = resolveWin(runFn);
  assert.equal(b.progId, 'FirefoxURL-308046B0AF4A39CB');
  assert.equal(b.name, 'Firefox');
  assert.deepEqual(regKeysQueried(runFn).slice(0, 2), [URL_CHOICE('https'), URL_CHOICE('http')]);
});

test('resolveWindowsBrowser: https ProgId wins over http when both exist', () => {
  const b = resolveWin(fakeRegistry({
    [URL_CHOICE('https')]: { ProgId: 'ChromeHTML' }, [URL_CHOICE('http')]: { ProgId: 'MSEdgeHTM' },
    [HKCR_CMD('ChromeHTML')]: { '': T.chrome }, [HKCR_CMD('MSEdgeHTM')]: { '': T.edge },
  }));
  assert.equal(b.progId, 'ChromeHTML');
});

test('resolveWindowsBrowser: no ProgId for https or http -> null, no command lookup', () => {
  const runFn = fakeRegistry({});
  assert.equal(resolveWin(runFn), null);
  assert.deepEqual(regKeysQueried(runFn), [URL_CHOICE('https'), URL_CHOICE('http')]);
});

test('resolveWindowsBrowser: ProgId whose value is an empty string counts as missing', () => {
  assert.equal(resolveWin(fakeRegistry({ [URL_CHOICE('https')]: { ProgId: '' } })), null);
});

test('resolveWindowsBrowser: HKCR command missing -> HKLM\\SOFTWARE\\Classes is used', () => {
  const runFn = fakeRegistry({ [URL_CHOICE('https')]: { ProgId: 'ChromeHTML' }, [HKLM_CMD('ChromeHTML')]: { '': T.chrome } });
  const b = resolveWin(runFn);
  assert.equal(b.exe, EXE.chrome);
  assert.deepEqual(regKeysQueried(runFn).slice(1), [HKCR_CMD('ChromeHTML'), HKLM_CMD('ChromeHTML')]);
});

test('resolveWindowsBrowser: HKCR and HKLM missing -> HKCU\\SOFTWARE\\Classes is used', () => {
  const runFn = fakeRegistry({ [URL_CHOICE('https')]: { ProgId: 'ChromeHTML' }, [HKCU_CMD('ChromeHTML')]: { '': T.chrome } });
  const b = resolveWin(runFn);
  assert.equal(b.exe, EXE.chrome);
  assert.deepEqual(regKeysQueried(runFn).slice(1), [HKCR_CMD('ChromeHTML'), HKLM_CMD('ChromeHTML'), HKCU_CMD('ChromeHTML')]);
});

test('resolveWindowsBrowser: unset default "(value not set)" -> null', () => {
  const runFn = fakeRegistry({ [URL_CHOICE('https')]: { ProgId: 'ChromeHTML' }, [HKCR_CMD('ChromeHTML')]: { '': '(value not set)' } });
  assert.equal(resolveWin(runFn), null);
});

test('resolveWindowsBrowser: unset default with a localised placeholder -> null', () => {
  const runFn = fakeRegistry({ [URL_CHOICE('https')]: { ProgId: 'ChromeHTML' }, [HKCR_CMD('ChromeHTML')]: { '': '(הערך לא נקבע)' } }, { label: '(ברירת מחדל)' });
  assert.equal(resolveWin(runFn), null);
});

test('resolveWindowsBrowser: "(value not set)" in HKCR falls through to a real HKLM command', () => {
  const b = resolveWin(fakeRegistry({
    [URL_CHOICE('https')]: { ProgId: 'ChromeHTML' },
    [HKCR_CMD('ChromeHTML')]: { '': '(value not set)' },
    [HKLM_CMD('ChromeHTML')]: { '': T.chrome },
  }));
  assert.equal(b?.exe, EXE.chrome);
});

test('resolveWindowsBrowser: a ProgId containing a space is passed as one reg argument', () => {
  const runFn = fakeRegistry({ [URL_CHOICE('https')]: { ProgId: 'Opera GXStable' }, [HKCR_CMD('Opera GXStable')]: { '': T.operaL } });
  const b = resolveWin(runFn);
  assert.equal(b.progId, 'Opera GXStable');
  assert.equal(runFn.calls[1].args[1], HKCR_CMD('Opera GXStable'));
});

test('resolveWindowsBrowser + browserArgs: end to end, Hebrew URL is one untouched argument', () => {
  const b = resolveWin(fakeRegistry(chromeRegistry(), { label: '(ברירת מחדל)' }));
  assert.deepEqual(B.browserArgs(b, URLS.hebrew), ['--single-argument', URLS.hebrew]);
});

test('windowsProgId: defaults to https, accepts another scheme', () => {
  const runFn = fakeRegistry({ [URL_CHOICE('https')]: { ProgId: 'ChromeHTML' }, [URL_CHOICE('http')]: { ProgId: 'MSEdgeHTM' } });
  assert.equal(B.windowsProgId(runFn), 'ChromeHTML');
  assert.equal(B.windowsProgId(runFn, 'http'), 'MSEdgeHTM');
  assert.equal(B.windowsProgId(runFn, 'mailto'), null);
});

test('windowsFileProgId: reads FileExts\\<ext>\\UserChoice ProgId', () => {
  const runFn = fakeRegistry({
    [FILE_CHOICE('.html')]: { ProgId: 'MSEdgeHTM' },
    [FILE_CHOICE('.mp4')]: { ProgId: 'AppX6eg8h5sxqq90pv53845wmnbewywdqq5h' },
    [FILE_CHOICE('.pdf')]: { ProgId: 'Acrobat.Document.DC' },
  });
  assert.equal(B.windowsFileProgId(runFn, '.html'), 'MSEdgeHTM');
  assert.equal(B.windowsFileProgId(runFn, '.mp4'), 'AppX6eg8h5sxqq90pv53845wmnbewywdqq5h');
  assert.equal(B.windowsFileProgId(runFn, '.pdf'), 'Acrobat.Document.DC');
  assert.deepEqual(runFn.calls[0].args, ['query', FILE_CHOICE('.html'), '/v', 'ProgId']);
});

test('windowsFileProgId: no UserChoice for the extension -> null', () => {
  assert.equal(B.windowsFileProgId(fakeRegistry({}), '.xyz'), null);
});

test('windowsFileProgId: works with a localised reg output and LF endings', () => {
  const runFn = fakeRegistry({ [FILE_CHOICE('.html')]: { ProgId: 'ChromeHTML' } }, { label: '(ברירת מחדל)', eol: '\n' });
  assert.equal(B.windowsFileProgId(runFn, '.html'), 'ChromeHTML');
});

test('windowsCommandFor: queries HKCR, then HKLM\\SOFTWARE\\Classes, then HKCU\\SOFTWARE\\Classes; null if none', () => {
  const runFn = fakeRegistry({});
  assert.equal(B.windowsCommandFor(runFn, 'VLC.mp4'), null);
  assert.deepEqual(regKeysQueried(runFn), [HKCR_CMD('VLC.mp4'), HKLM_CMD('VLC.mp4'), HKCU_CMD('VLC.mp4')]);
  assert.ok(runFn.calls.every((c) => c.args[2] === '/ve'));
});

test('windowsCommandFor: stops at the first hive that answers', () => {
  const vlc = String.raw`"C:\Program Files\VideoLAN\VLC\vlc.exe" --started-from-file "%1"`;
  const runFn = fakeRegistry({ [HKCR_CMD('VLC.mp4')]: { '': vlc }, [HKLM_CMD('VLC.mp4')]: { '': 'other.exe' } });
  assert.equal(B.windowsCommandFor(runFn, 'VLC.mp4'), vlc);
  assert.equal(runFn.calls.length, 1);
});

// ---------------------------------------------------------------------------------------------
// windowsStoreAppName + windowsAppFor (the program a file type opens with: opener and doctor)
// ---------------------------------------------------------------------------------------------

const APP_KEY = (progId) => `HKCR\\${progId}\\Application`;
const PHOTOS = 'AppX43hnxtbyyps62jhe9sqpdzxn1790zetc';
const PHOTOS_NAME = '@{Microsoft.Windows.Photos_2026.11080.24002.0_x64__8wekyb3d8bbwe?ms-resource://Microsoft.Windows.Photos/Resources/AppDisplayName}';

test('windowsStoreAppName: the package name gives the app, a plain name is kept, a bare resource is not shown', () => {
  const name = (value) => B.windowsStoreAppName(fakeRegistry(value === undefined ? {} : { [APP_KEY(PHOTOS)]: { ApplicationName: value } }), PHOTOS);
  assert.equal(name(PHOTOS_NAME), 'Photos');
  assert.equal(name('@{Microsoft.ZuneVideo_10.22091.10061.0_x64__8wekyb3d8bbwe?ms-resource://Microsoft.ZuneVideo/Files/Assets/x}'), 'ZuneVideo');
  assert.equal(name('@{Microsoft.Paint_11.2409.23.0_x64__8wekyb3d8bbwe?ms-resource://Microsoft.Paint/Resources/AppName}'), 'Paint');
  assert.equal(name('Clipchamp'), 'Clipchamp');
  assert.equal(name('@%SystemRoot%\\system32\\shell32.dll,-22072'), null);
  assert.equal(name('ms-resource:AppName'), null);
  assert.equal(name(undefined), null, 'no Application key');
  const runFn = fakeRegistry({ [APP_KEY(PHOTOS)]: { ApplicationName: PHOTOS_NAME } });
  B.windowsStoreAppName(runFn, PHOTOS);
  assert.deepEqual(runFn.calls[0].args, ['query', APP_KEY(PHOTOS), '/v', 'ApplicationName'], 'one read-only reg query');
});

test('windowsAppFor: a program with a command line, a Store app by name, a ProgId alone, or null', () => {
  const vlc = String.raw`"C:\Program Files\VideoLAN\VLC\vlc.exe" --started-from-file "%1"`;
  const runFn = fakeRegistry({
    [FILE_CHOICE('.mp4')]: { ProgId: 'VLC.mp4' },
    [HKCR_CMD('VLC.mp4')]: { '': vlc },
    [FILE_CHOICE('.png')]: { ProgId: PHOTOS },
    [APP_KEY(PHOTOS)]: { ApplicationName: PHOTOS_NAME },
    [FILE_CHOICE('.jpg')]: { ProgId: 'AppX4mntx4h978m1v9gtzv0ewksfd6pmwsre' },
    [FILE_CHOICE('.xyz')]: { ProgId: 'Custom.Thing' },
  });
  assert.deepEqual(B.windowsAppFor(runFn, '.mp4'), { progId: 'VLC.mp4', exe: String.raw`C:\Program Files\VideoLAN\VLC\vlc.exe`, name: 'VLC media player', process: 'vlc' });
  assert.deepEqual(B.windowsAppFor(runFn, '.png'), { progId: PHOTOS, name: 'Photos', process: null });
  assert.deepEqual(B.windowsAppFor(runFn, '.jpg'), { progId: 'AppX4mntx4h978m1v9gtzv0ewksfd6pmwsre', name: 'a Microsoft Store app', process: null });
  assert.deepEqual(B.windowsAppFor(runFn, '.xyz'), { progId: 'Custom.Thing', name: 'Custom.Thing', process: null });
  assert.equal(B.windowsAppFor(runFn, '.none'), null);
  assert.ok(runFn.calls.every((c) => c.cmd === 'reg' && c.args[0] === 'query'), 'reads only');
  assert.ok(!regKeysQueried(runFn).includes(APP_KEY('Custom.Thing')), 'the Application key is asked only for Store (AppX) ProgIds');
});

// ---------------------------------------------------------------------------------------------
// util.selectionUnchecked (folder watchers that cannot read the file manager's selection)
// ---------------------------------------------------------------------------------------------

test('selectionUnchecked: every result gains selectedOk null; ready and cancel are the watcher\'s own', async () => {
  let cancelled = 0;
  const ready = Promise.resolve('r');
  const w = U.selectionUnchecked({ ready, result: Promise.resolve({ matched: true, confidence: 'high', title: 'out', selectedOk: true }), cancel() { cancelled += 1; } });
  assert.equal(w.ready, ready);
  assert.deepEqual(await w.result, { matched: true, confidence: 'high', title: 'out', selectedOk: null }, 'a match never implies a selection');
  w.cancel();
  assert.equal(cancelled, 1);
  const miss = U.selectionUnchecked({ ready, result: Promise.resolve({ matched: false, reason: 'none' }), cancel() {} });
  assert.deepEqual(await miss.result, { matched: false, reason: 'none', selectedOk: null });
});

test('pollTitles: a miss answers at the timeout, with a last look there, not a whole interval later', async () => {
  const looks = [];
  const t0 = Date.now();
  const w = U.pollTitles(() => { looks.push(Date.now() - t0); return { titles: ['Other'] }; }, (t) => t === 'Mine', 700, { intervalMs: 300 });
  const res = await w.result;
  const took = Date.now() - t0;
  assert.deepEqual(res, { matched: false, reason: 'no new window matching the target appeared within 700 ms' });
  assert.ok(took >= 690 && took < 860, `answered after ${took} ms (an uncapped last pause would end at 900)`);
  assert.ok(looks.at(-1) >= 690, `the last look is at the deadline (looks at ${looks.join(', ')} ms)`);
});

test('pollTitles: a 0 ms timeout takes no look after the before-snapshot, so its verdict is null, never false', async () => {
  let looks = 0;
  const w = U.pollTitles(() => { looks += 1; return { titles: looks > 1 ? ['Mine'] : [] }; }, (t) => t === 'Mine', 0);
  assert.deepEqual(await w.result, { matched: null, reason: 'the window timeout is 0 ms, so no window was looked for after the open' });
  assert.equal(looks, 1, 'only the before-snapshot');
});

test('pollTitles: a window that shows up just before the deadline is still seen, in time', async () => {
  const t0 = Date.now();
  const w = U.pollTitles(() => ({ titles: Date.now() - t0 >= 650 ? ['Mine'] : [] }), (t) => t === 'Mine', 700, { intervalMs: 300 });
  const res = await w.result;
  assert.equal(res.matched, true, JSON.stringify(res));
  assert.ok(Date.now() - t0 < 860, 'found at the last look, at the deadline');
});

// ---------------------------------------------------------------------------------------------
// browserName
// ---------------------------------------------------------------------------------------------

test('browserName: known browsers from exe paths', () => {
  assert.deepEqual(B.browserName(EXE.chrome), { name: 'Google Chrome', process: 'chrome' });
  assert.deepEqual(B.browserName(EXE.edge), { name: 'Microsoft Edge', process: 'msedge' });
  assert.deepEqual(B.browserName(EXE.firefox), { name: 'Firefox', process: 'firefox' });
  assert.deepEqual(B.browserName(EXE.brave), { name: 'Brave', process: 'brave' });
  assert.deepEqual(B.browserName(EXE.vivaldi), { name: 'Vivaldi', process: 'vivaldi' });
  assert.deepEqual(B.browserName(String.raw`C:\Users\Dana\AppData\Local\Programs\Opera\opera.exe`), { name: 'Opera', process: 'opera' });
});

test('browserName: known browsers from ProgIds and Linux desktop ids', () => {
  assert.deepEqual(B.browserName('ChromeHTML'), { name: 'Google Chrome', process: 'chrome' });
  assert.deepEqual(B.browserName('MSEdgeHTM'), { name: 'Microsoft Edge', process: 'msedge' });
  assert.deepEqual(B.browserName('FirefoxURL-308046B0AF4A39CB'), { name: 'Firefox', process: 'firefox' });
  assert.deepEqual(B.browserName('microsoft-edge.desktop'), { name: 'Microsoft Edge', process: 'msedge' });
  assert.deepEqual(B.browserName('org.mozilla.firefox.desktop'), { name: 'Firefox', process: 'firefox' });
  assert.deepEqual(B.browserName('google-chrome.desktop'), { name: 'Google Chrome', process: 'chrome' });
});

test('browserName: media players and PDF readers', () => {
  assert.deepEqual(B.browserName(String.raw`C:\Program Files\VideoLAN\VLC\vlc.exe`), { name: 'VLC media player', process: 'vlc' });
  assert.deepEqual(B.browserName('VLC.mp4'), { name: 'VLC media player', process: 'vlc' });
  assert.deepEqual(B.browserName('SumatraPDF.exe'), { name: 'SumatraPDF', process: 'sumatrapdf' });
  assert.deepEqual(B.browserName('wmplayer.exe'), { name: 'Windows Media Player', process: 'wmplayer' });
  // Acrobat has no fixed process name: it falls back to the exe basename.
  assert.deepEqual(B.browserName('AcroRd32.exe'), { name: 'Adobe Acrobat', process: 'acrord32' });
  assert.deepEqual(B.browserName('mpc-hc64.exe'), { name: 'MPC-HC', process: 'mpc-hc64' });
});

test('browserName: Arc matches only as a whole path/dot segment', () => {
  assert.equal(B.browserName('TheBrowserCompany.Arc').name, 'Arc');
  assert.equal(B.browserName('C:/Users/Dana/AppData/Local/Arc/Arc.exe').name, 'Arc');
  assert.notEqual(B.browserName('Research.exe').name, 'Arc');
  assert.notEqual(B.browserName('archive.exe').name, 'Arc');
});

test('browserName: AppX ProgId -> a Microsoft Store app with no process name', () => {
  assert.deepEqual(B.browserName('AppX43hnxtbyyps62jhe9sqpdzxn1790zetc'), { name: 'a Microsoft Store app', process: null });
  assert.deepEqual(B.browserName('appxq0fevzme2pys62n3e0fbqa7peapykr8v'), { name: 'a Microsoft Store app', process: null });
});

test('browserName: unknown program -> basename without .exe, lower-cased process', () => {
  assert.deepEqual(B.browserName('MyViewer.exe'), { name: 'MyViewer', process: 'myviewer' });
  assert.deepEqual(B.browserName('C:/Tools/My Viewer/MyViewer.EXE'), { name: 'MyViewer', process: 'myviewer' });
  assert.deepEqual(B.browserName('/usr/bin/qutebrowser'), { name: 'qutebrowser', process: 'qutebrowser' });
});

test('browserName: unknown Windows backslash path (win32 path semantics)', { skip: process.platform !== 'win32' }, () => {
  assert.deepEqual(B.browserName(String.raw`C:\Tools\My Viewer\MyViewer.exe`), { name: 'MyViewer', process: 'myviewer' });
});

test('browserName: empty / null / undefined -> "default app" with no process', () => {
  for (const v of ['', null, undefined]) assert.deepEqual(B.browserName(v), { name: 'default app', process: null });
});

// ---------------------------------------------------------------------------------------------
// resolveMacBrowser
// ---------------------------------------------------------------------------------------------

const PLIST_REL = ['Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist'];

function macHome() {
  const t = tempDir('show-local-mac-');
  mkdirSync(path.join(t.dir, ...PLIST_REL.slice(0, -1)), { recursive: true });
  writeFileSync(path.join(t.dir, ...PLIST_REL), '<plist/>');
  return t;
}
const plutil = (json, status = 0) => fakeRun([['plutil -convert json -o -', { status, stdout: typeof json === 'string' ? json : JSON.stringify(json) }]]);

test('resolveMacBrowser: https handler bundle id -> friendly name', () => {
  const t = macHome();
  try {
    const runFn = plutil({ LSHandlers: [
      { LSHandlerContentType: 'public.html', LSHandlerRoleAll: 'com.apple.safari' },
      { LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'org.mozilla.firefox' },
      { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.chrome', LSHandlerPreferredVersions: { LSHandlerRoleAll: '-' } },
    ] });
    assert.deepEqual(B.resolveMacBrowser(runFn, t.dir), { platform: 'darwin', bundleId: 'com.google.chrome', name: 'Google Chrome' });
    assert.equal(runFn.calls.length, 1);
    assert.equal(runFn.calls[0].cmd, 'plutil');
    assert.deepEqual(runFn.calls[0].args, ['-convert', 'json', '-o', '-', path.join(t.dir, ...PLIST_REL)]);
  } finally { t.cleanup(); }
});

test('resolveMacBrowser: only an http handler -> used as fallback', () => {
  const t = macHome();
  try {
    const runFn = plutil({ LSHandlers: [{ LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'org.mozilla.firefox' }] });
    assert.deepEqual(B.resolveMacBrowser(runFn, t.dir), { platform: 'darwin', bundleId: 'org.mozilla.firefox', name: 'Firefox' });
  } finally { t.cleanup(); }
});

test('resolveMacBrowser: https wins even when http is listed first', () => {
  const t = macHome();
  try {
    const runFn = plutil({ LSHandlers: [
      { LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'com.apple.safari' },
      { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.brave.browser' },
    ] });
    assert.equal(B.resolveMacBrowser(runFn, t.dir).name, 'Brave');
  } finally { t.cleanup(); }
});

test('resolveMacBrowser: bundle-id lookup is case-insensitive, bundleId keeps its case', () => {
  const t = macHome();
  try {
    const runFn = plutil({ LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.Microsoft.EdgeMac' }] });
    assert.deepEqual(B.resolveMacBrowser(runFn, t.dir), { platform: 'darwin', bundleId: 'com.Microsoft.EdgeMac', name: 'Microsoft Edge' });
  } finally { t.cleanup(); }
});

test('resolveMacBrowser: every known bundle id has its name', () => {
  const t = macHome();
  try {
    const known = {
      'com.google.chrome': 'Google Chrome', 'com.apple.safari': 'Safari', 'org.mozilla.firefox': 'Firefox',
      'com.microsoft.edgemac': 'Microsoft Edge', 'com.brave.browser': 'Brave', 'company.thebrowser.browser': 'Arc',
      'com.vivaldi.vivaldi': 'Vivaldi', 'com.operasoftware.opera': 'Opera',
    };
    for (const [bundle, name] of Object.entries(known)) {
      const b = B.resolveMacBrowser(plutil({ LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: bundle }] }), t.dir);
      assert.equal(b.name, name, bundle);
    }
  } finally { t.cleanup(); }
});

test('resolveMacBrowser: unknown bundle id -> name is the bundle id', () => {
  const t = macHome();
  try {
    const runFn = plutil({ LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'org.chromium.chromium' }] });
    assert.deepEqual(B.resolveMacBrowser(runFn, t.dir), { platform: 'darwin', bundleId: 'org.chromium.chromium', name: 'org.chromium.chromium' });
  } finally { t.cleanup(); }
});

test('resolveMacBrowser: missing plist -> Safari (the macOS default) and plutil is never run', () => {
  const t = tempDir('show-local-mac-empty-');
  try {
    const runFn = plutil({ LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.chrome' }] });
    assert.deepEqual(B.resolveMacBrowser(runFn, t.dir), { platform: 'darwin', bundleId: 'com.apple.Safari', name: 'Safari' });
    assert.equal(runFn.calls.length, 0);
  } finally { t.cleanup(); }
});

test('resolveMacBrowser: unreadable plist -> null; no https handler at all -> Safari (never changed)', () => {
  const t = macHome();
  const safari = { platform: 'darwin', bundleId: 'com.apple.Safari', name: 'Safari' };
  try {
    assert.equal(B.resolveMacBrowser(plutil('', 1), t.dir), null, 'plutil exit 1');
    assert.equal(B.resolveMacBrowser(plutil('{not json'), t.dir), null, 'invalid JSON');
    assert.deepEqual(B.resolveMacBrowser(plutil({}), t.dir), safari, 'no LSHandlers');
    assert.deepEqual(B.resolveMacBrowser(plutil({ LSHandlers: [] }), t.dir), safari, 'empty LSHandlers');
    assert.deepEqual(B.resolveMacBrowser(plutil({ LSHandlers: [{ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' }] }), t.dir), safari, 'no web scheme');
    assert.deepEqual(B.resolveMacBrowser(plutil({ LSHandlers: [{ LSHandlerURLScheme: 'https' }] }), t.dir), safari, 'no LSHandlerRoleAll');
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// parseDesktopExec + desktopArgs
// ---------------------------------------------------------------------------------------------

test('parseDesktopExec: plain Exec lines split on whitespace', () => {
  assert.deepEqual(B.parseDesktopExec('firefox %u'), ['firefox', '%u']);
  assert.deepEqual(B.parseDesktopExec('/usr/bin/google-chrome-stable %U'), ['/usr/bin/google-chrome-stable', '%U']);
  assert.deepEqual(B.parseDesktopExec('  brave-browser \t --incognito   %U  '), ['brave-browser', '--incognito', '%U']);
  assert.deepEqual(B.parseDesktopExec(''), []);
});

test('parseDesktopExec: double-quoted argument keeps its spaces', () => {
  assert.deepEqual(B.parseDesktopExec('"/opt/My Browser/browser" --flag %U'), ['/opt/My Browser/browser', '--flag', '%U']);
  assert.deepEqual(B.parseDesktopExec('a"b c"d'), ['ab cd']);
});

test('parseDesktopExec: escaped quote, backslash, $ and backtick inside quotes', () => {
  assert.deepEqual(B.parseDesktopExec(String.raw`"/opt/say \"hi\"/app" %u`), ['/opt/say "hi"/app', '%u']);
  assert.deepEqual(B.parseDesktopExec(String.raw`"a\\b"`), ['a\\b']);
  // Exec value: "\$HOME \`x\`"  ->  $HOME `x`
  assert.deepEqual(B.parseDesktopExec('"\\$HOME \\`x\\`"'), ['$HOME `x`']);
});

test('parseDesktopExec: empty quoted argument is kept', () => {
  assert.deepEqual(B.parseDesktopExec('foo "" bar'), ['foo', '', 'bar']);
});

test('parseDesktopExec: snap and flatpak Exec lines', () => {
  assert.deepEqual(
    B.parseDesktopExec('env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop /snap/bin/firefox %u'),
    ['env', 'BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop', '/snap/bin/firefox', '%u'],
  );
  assert.deepEqual(
    B.parseDesktopExec('/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=firefox --file-forwarding org.mozilla.firefox @@u %u @@'),
    ['/usr/bin/flatpak', 'run', '--branch=stable', '--arch=x86_64', '--command=firefox', '--file-forwarding', 'org.mozilla.firefox', '@@u', '%u', '@@'],
  );
});

test('desktopArgs: %u and %U become the URL, untouched', () => {
  for (const code of ['%u', '%U']) {
    for (const url of [URLS.hebrew, URLS.spaces, URLS.hashAmp]) {
      assert.deepEqual(B.desktopArgs([code], url), [url], `${code} ${url}`);
      assert.deepEqual(B.desktopArgs(['--new-window', code], url), ['--new-window', url]);
    }
  }
});

test('desktopArgs: %u/%U keep a file:// URL as a URL', () => {
  const url = 'file:///home/u/My%20Site/index.html#top';
  assert.deepEqual(B.desktopArgs(['%u'], url), [url]);
  assert.deepEqual(B.desktopArgs(['%U'], url), [url]);
});

test('desktopArgs: %f/%F turn a file:// URL into a decoded local path', () => {
  assert.deepEqual(B.desktopArgs(['%f'], 'file:///home/u/My%20Site/index.html'), ['/home/u/My Site/index.html']);
  assert.deepEqual(B.desktopArgs(['%F'], 'file:///home/u/%D7%94%D7%90%D7%AA%D7%A8/index.html'), ['/home/u/האתר/index.html']);
  // The fragment is not part of a file path.
  assert.deepEqual(B.desktopArgs(['%f'], 'file:///tmp/a%23b/page.html#x'), ['/tmp/a#b/page.html']);
});

test('desktopArgs: %f/%F with an http URL pass the URL itself', () => {
  assert.deepEqual(B.desktopArgs(['%f'], URLS.hebrew), [URLS.hebrew]);
  assert.deepEqual(B.desktopArgs(['--x', '%F'], URLS.hashAmp), ['--x', URLS.hashAmp]);
});

test('desktopArgs: other field codes (%i %c %k and deprecated ones) are dropped', () => {
  assert.deepEqual(B.desktopArgs(['%i', '--flag', '%c', '%k', '%u'], URLS.spaces), ['--flag', URLS.spaces]);
  assert.deepEqual(B.desktopArgs(['%d', '%D', '%n', '%N', '%v', '%m', '%U'], URLS.spaces), [URLS.spaces]);
});

test('desktopArgs: %% is unescaped to % in ordinary arguments, never in the URL', () => {
  assert.deepEqual(B.desktopArgs(['--name=100%%', '%u'], 'http://h/?a=%25%25'), ['--name=100%', 'http://h/?a=%25%25']);
  assert.deepEqual(B.desktopArgs(['%%'], 'http://h/'), ['%', 'http://h/']);
});

test('desktopArgs: no URL placeholder -> URL appended', () => {
  assert.deepEqual(B.desktopArgs([], URLS.hebrew), [URLS.hebrew]);
  assert.deepEqual(B.desktopArgs(['--incognito'], URLS.hebrew), ['--incognito', URLS.hebrew]);
  assert.deepEqual(B.desktopArgs(['%i'], URLS.hebrew), [URLS.hebrew]);
});

test('desktopArgs: flatpak @@u %u @@ markers are kept around the URL', () => {
  const argv = B.parseDesktopExec('/usr/bin/flatpak run --command=firefox --file-forwarding org.mozilla.firefox @@u %u @@');
  assert.deepEqual(B.desktopArgs(argv.slice(1), URLS.hebrew), ['run', '--command=firefox', '--file-forwarding', 'org.mozilla.firefox', '@@u', URLS.hebrew, '@@']);
});

test('desktopArgs: does not mutate its input argv', () => {
  const argv = ['--flag', '%u'];
  B.desktopArgs(argv, 'http://h/');
  assert.deepEqual(argv, ['--flag', '%u']);
});

// ---------------------------------------------------------------------------------------------
// desktopFileDirs + resolveLinuxBrowser
// ---------------------------------------------------------------------------------------------

test('desktopFileDirs: XDG defaults, then flatpak and snap exports', () => {
  assert.deepEqual(B.desktopFileDirs({}, HOME).map(slash), [
    '/home/tester/.local/share/applications', '/usr/local/share/applications', '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications',
  ]);
});

test('desktopFileDirs: XDG_DATA_HOME / XDG_DATA_DIRS override, empty segments skipped', () => {
  assert.deepEqual(B.desktopFileDirs({ XDG_DATA_HOME: '/data/home', XDG_DATA_DIRS: '::/opt/share:' }, HOME).map(slash), [
    '/data/home/applications', '/opt/share/applications',
    '/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications',
  ]);
});

const FIREFOX_DESKTOP = [
  '[Desktop Entry]', 'Version=1.0', 'Name=Firefox Web Browser', '# Exec=not-this', 'TryExec=firefox-try',
  'Exec=firefox %u', 'Terminal=false', 'Type=Application', '',
  '[Desktop Action new-window]', 'Name=Open a New Window', 'Exec=firefox -new-window', '',
].join('\n');

test('resolveLinuxBrowser: xdg-settings id -> .desktop Exec -> argv (Firefox)', () => {
  const runFn = xdg('firefox.desktop\n');
  const fs = fakeFs({ '/usr/share/applications/firefox.desktop': FIREFOX_DESKTOP });
  const b = B.resolveLinuxBrowser(runFn, { env: LINUX_ENV, home: HOME, ...fs });
  assert.deepEqual(b, { platform: 'linux', desktopId: 'firefox.desktop', exe: 'firefox', argv: ['firefox', '%u'], name: 'Firefox', process: 'firefox' });
  assert.deepEqual(runFn.calls.map((c) => [c.cmd, c.args]), [['xdg-settings', ['get', 'default-web-browser']]]);
  assert.deepEqual(fs.read, [{ path: '/usr/share/applications/firefox.desktop', enc: 'utf8' }]);
});

test('resolveLinuxBrowser: takes Exec from [Desktop Entry], not from a Desktop Action listed first', () => {
  const text = [
    '[Desktop Action new-private-window]', 'Name=New Incognito Window', 'Exec=/usr/bin/google-chrome-stable --incognito', '',
    '[Desktop Entry]', 'Name=Google Chrome', 'Exec=/usr/bin/google-chrome-stable %U', '',
  ].join('\n');
  const fs = fakeFs({ '/usr/share/applications/google-chrome.desktop': text });
  const b = B.resolveLinuxBrowser(xdg('google-chrome.desktop'), { env: LINUX_ENV, home: HOME, ...fs });
  assert.deepEqual(b.argv, ['/usr/bin/google-chrome-stable', '%U']);
  assert.equal(b.exe, '/usr/bin/google-chrome-stable');
  assert.equal(b.name, 'Google Chrome');
  assert.equal(b.process, 'chrome');
});

test('resolveLinuxBrowser: CRLF desktop file -> no \\r in argv', () => {
  const fs = fakeFs({ '/usr/share/applications/brave-browser.desktop': '[Desktop Entry]\r\nName=Brave\r\nExec=/usr/bin/brave-browser-stable %U\r\n' });
  const b = B.resolveLinuxBrowser(xdg('brave-browser.desktop\r\n'), { env: LINUX_ENV, home: HOME, ...fs });
  assert.equal(b.desktopId, 'brave-browser.desktop');
  assert.deepEqual(b.argv, ['/usr/bin/brave-browser-stable', '%U']);
  assert.equal(b.name, 'Brave');
});

test('resolveLinuxBrowser: quoted Exec path with spaces', () => {
  const fs = fakeFs({ '/home/tester/.local/share/applications/mybrowser.desktop': '[Desktop Entry]\nExec="/home/tester/My Apps/browser" --new-tab %u\n' });
  const b = B.resolveLinuxBrowser(xdg('mybrowser.desktop'), { env: LINUX_ENV, home: HOME, ...fs });
  assert.deepEqual(b.argv, ['/home/tester/My Apps/browser', '--new-tab', '%u']);
  assert.equal(b.exe, '/home/tester/My Apps/browser');
});

test('resolveLinuxBrowser: user XDG_DATA_HOME file wins over the system one', () => {
  const fs = fakeFs({
    '/home/tester/.local/share/applications/firefox.desktop': '[Desktop Entry]\nExec=/home/tester/bin/firefox-nightly %u\n',
    '/usr/share/applications/firefox.desktop': FIREFOX_DESKTOP,
  });
  const b = B.resolveLinuxBrowser(xdg('firefox.desktop'), { env: LINUX_ENV, home: HOME, ...fs });
  assert.equal(b.exe, '/home/tester/bin/firefox-nightly');
});

test('resolveLinuxBrowser: without XDG vars searches ~/.local/share, /usr/local/share, /usr/share, flatpak, snap in order', () => {
  const fs = fakeFs({});
  const b = B.resolveLinuxBrowser(xdg('firefox.desktop'), { env: {}, home: HOME, ...fs });
  assert.deepEqual(fs.probed, [
    '/home/tester/.local/share/applications/firefox.desktop', '/usr/local/share/applications/firefox.desktop',
    '/usr/share/applications/firefox.desktop', '/var/lib/flatpak/exports/share/applications/firefox.desktop',
    '/var/lib/snapd/desktop/applications/firefox.desktop',
  ]);
  // Not found anywhere: still reports the id and name, but no argv to launch.
  assert.deepEqual(b, { platform: 'linux', desktopId: 'firefox.desktop', exe: null, argv: null, name: 'Firefox', process: 'firefox' });
});

test('resolveLinuxBrowser: flatpak export is found and its argv kept intact', () => {
  const exec = '/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=firefox --file-forwarding org.mozilla.firefox @@u %u @@';
  const fs = fakeFs({ '/var/lib/flatpak/exports/share/applications/org.mozilla.firefox.desktop': `[Desktop Entry]\nExec=${exec}\n` });
  const b = B.resolveLinuxBrowser(xdg('org.mozilla.firefox.desktop'), { env: LINUX_ENV, home: HOME, ...fs });
  assert.equal(b.exe, '/usr/bin/flatpak');
  assert.deepEqual(b.argv, B.parseDesktopExec(exec));
  assert.equal(b.name, 'Firefox');
});

test('resolveLinuxBrowser: a file without Exec is skipped for the next directory', () => {
  const fs = fakeFs({
    '/usr/local/share/applications/firefox.desktop': '[Desktop Entry]\nName=Broken\nTryExec=firefox\n',
    '/usr/share/applications/firefox.desktop': FIREFOX_DESKTOP,
  });
  const b = B.resolveLinuxBrowser(xdg('firefox.desktop'), { env: LINUX_ENV, home: HOME, ...fs });
  assert.deepEqual(b.argv, ['firefox', '%u']);
});

test('resolveLinuxBrowser: an unreadable file is skipped for the next directory', () => {
  const fs = fakeFs({
    '/home/tester/.local/share/applications/firefox.desktop': Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    '/usr/share/applications/firefox.desktop': FIREFOX_DESKTOP,
  });
  const b = B.resolveLinuxBrowser(xdg('firefox.desktop'), { env: LINUX_ENV, home: HOME, ...fs });
  assert.deepEqual(b.argv, ['firefox', '%u']);
});

test('resolveLinuxBrowser: blank Exec value is skipped', () => {
  const fs = fakeFs({
    '/home/tester/.local/share/applications/firefox.desktop': '[Desktop Entry]\nExec=   \n',
    '/usr/share/applications/firefox.desktop': FIREFOX_DESKTOP,
  });
  const b = B.resolveLinuxBrowser(xdg('firefox.desktop'), { env: LINUX_ENV, home: HOME, ...fs });
  assert.equal(b.exe, 'firefox');
});

test('resolveLinuxBrowser: xdg-settings fails or prints nothing -> null, no file probing', () => {
  for (const [stdout, status] of [['', 1], ['firefox.desktop\n', 1], ['', 0], ['  \n', 0]]) {
    const fs = fakeFs({ '/usr/share/applications/firefox.desktop': FIREFOX_DESKTOP });
    assert.equal(B.resolveLinuxBrowser(xdg(stdout, status), { env: LINUX_ENV, home: HOME, ...fs }), null, JSON.stringify({ stdout, status }));
    assert.equal(fs.probed.length, 0);
  }
});

test('resolveLinuxBrowser + desktopArgs: end to end launch argv for a Hebrew URL', () => {
  const fs = fakeFs({ '/usr/share/applications/firefox.desktop': FIREFOX_DESKTOP });
  const b = B.resolveLinuxBrowser(xdg('firefox.desktop'), { env: LINUX_ENV, home: HOME, ...fs });
  assert.deepEqual([b.argv[0], ...B.desktopArgs(b.argv.slice(1), URLS.hebrew)], ['firefox', URLS.hebrew]);
});

test('resolveLinuxBrowser: an unrecognised browser gets a human name, not the raw ".desktop" file name', () => {
  // The name is shown to the user ("opened with ..." and in doctor). Known browsers get "Firefox",
  // "Google Chrome"; an unknown one such as Chromium should at least lose the ".desktop" suffix,
  // the way Windows names lose ".exe".
  const fs = fakeFs({ '/usr/share/applications/chromium.desktop': '[Desktop Entry]\nName=Chromium\nExec=/usr/bin/chromium %U\n' });
  const b = B.resolveLinuxBrowser(xdg('chromium.desktop'), { env: LINUX_ENV, home: HOME, ...fs });
  assert.equal(b.exe, '/usr/bin/chromium');
  assert.ok(!/\.desktop$/i.test(b.name), `name should not be the desktop file name, got "${b.name}"`);
});

// ---------------------------------------------------------------------------------------------
// util: decodeEntities / titleFromHtml / normTitle
// ---------------------------------------------------------------------------------------------

test('decodeEntities: the basic named entities', () => {
  assert.equal(U.decodeEntities('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'');
  assert.equal(U.decodeEntities('a&nbsp;b'), 'a b', '&nbsp; is U+00A0, as in the browser');
});

test('decodeEntities: named entities are case-insensitive for the supported set', () => {
  assert.equal(U.decodeEntities('&AMP; &Lt; &GT;'), '& < >');
});

test('decodeEntities: decimal entities, including Hebrew and astral code points', () => {
  assert.equal(U.decodeEntities('&#65;&#39;'), "A'");
  assert.equal(U.decodeEntities('&#1513;&#1500;&#1493;&#1501;'), 'שלום');
  assert.equal(U.decodeEntities('&#128512;'), '😀');
});

test('decodeEntities: hex entities, lower and upper x, any digit case', () => {
  assert.equal(U.decodeEntities('&#x41;&#X42;&#x5e9;&#x5E9;'), 'ABשש');
  assert.equal(U.decodeEntities('&#x1F600;'), '😀');
});

test('decodeEntities: decodes once (no double-unescaping)', () => {
  assert.equal(U.decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(U.decodeEntities('&amp;#65;'), '&#65;');
});

test('decodeEntities: malformed or unknown references are left alone', () => {
  assert.equal(U.decodeEntities('AT&T &amp'), 'AT&T &amp');
  assert.equal(U.decodeEntities('&#; &#x; &#xZZ;'), '&#; &#x; &#xZZ;');
  assert.equal(U.decodeEntities('&unknownentity;'), '&unknownentity;');
  assert.equal(U.decodeEntities('plain text'), 'plain text');
});

test('decodeEntities: non-string input is stringified', () => {
  assert.equal(U.decodeEntities(42), '42');
});

test('decodeEntities: an out-of-range numeric reference does not throw', () => {
  // String.fromCodePoint throws RangeError above 0x10FFFF. A page title such as "&#x110000;" or
  // "&#99999999;" must not crash title extraction; browsers render U+FFFD for these.
  for (const s of ['&#x110000;', '&#99999999;', '&#x7FFFFFFF;']) {
    let out;
    assert.doesNotThrow(() => { out = U.decodeEntities(`A ${s} B`); }, s);
    assert.ok(out === 'A \uFFFD B' || out === `A ${s} B`, `${s} -> ${JSON.stringify(out)}`);
  }
});

test('titleFromHtml: linear on unclosed tags; <titlebar> is not <title>; attributes and case are fine', () => {
  const t0 = Date.now();
  assert.equal(U.titleFromHtml('<title>'.repeat(300000)), null);
  assert.ok(Date.now() - t0 < 1000, 'a 2 MB page of unclosed <title> tags returns at once');
  assert.equal(U.titleFromHtml('<titlebar>x</titlebar><title>real</title>'), 'real');
  assert.equal(U.titleFromHtml('<TITLE lang="he">  שלום\n עולם </TITLE>'), 'שלום עולם');
  assert.equal(U.titleFromHtml('<title>no close'), null);
  assert.equal(U.titleFromHtml('<title></title>'), null);
});

test('titleFromHtml: a Turkish "İ" before or inside the title does not shift it (toLowerCase makes it two code units)', () => {
  assert.equal('İ'.toLowerCase().length, 2, 'the reason the scan must not use toLowerCase offsets');
  assert.equal(U.titleFromHtml('<html><title>İstanbul Rehberi</title></html>'), 'İstanbul Rehberi');
  assert.equal(U.titleFromHtml('<html lang="tr"><meta name="description" content="İzmir"><title>Ana Sayfa</title></html>'), 'Ana Sayfa');
  assert.equal(U.titleFromHtml('<meta content="İzmir ve İstanbul"><title>Satış Raporu</title>'), 'Satış Raporu');
  assert.equal(U.titleFromHtml('<meta content="İİİ"><TITLE>Gezi</TITLE>'), 'Gezi');
  // HTML lower-cases tag names in ASCII only: <TİTLE> is not a title tag.
  assert.equal(U.titleFromHtml('<TİTLE>x</TİTLE><title>ok</title>'), 'ok');
});

test('titleFromHtml: an out-of-range numeric reference in <title> does not throw', () => {
  let t;
  assert.doesNotThrow(() => { t = U.titleFromHtml('<title>Broken &#x110000; page</title>'); });
  assert.ok(typeof t === 'string' && t.startsWith('Broken'));
});

test('decodeEntities: common typographic named entities used in page titles', () => {
  // titleFromHtml promises "the page title as a browser would show it", and the title is then
  // matched against real window titles. "Docs &mdash; Site" must become "Docs — Site" or the
  // window can never be matched by title.
  const expected = {
    '&mdash;': '—', '&ndash;': '–', '&middot;': '·', '&raquo;': '»', '&laquo;': '«', '&hellip;': '…',
    '&bull;': '•', '&copy;': '©', '&reg;': '®', '&trade;': '™', '&rsquo;': '’', '&lsquo;': '‘',
    '&rdquo;': '”', '&ldquo;': '“', '&rsaquo;': '›', '&lsaquo;': '‹', '&times;': '×',
  };
  const actual = Object.fromEntries(Object.keys(expected).map((e) => [e, U.decodeEntities(e)]));
  assert.deepEqual(actual, expected);
});

test('titleFromHtml: title with an em dash entity comes out as the browser shows it', () => {
  assert.equal(U.titleFromHtml('<head><title>Docs &mdash; Show Local</title></head>'), 'Docs — Show Local');
});

test('titleFromHtml: simple, attributed, and upper-case title tags', () => {
  assert.equal(U.titleFromHtml('<html><head><title>Hello</title></head></html>'), 'Hello');
  assert.equal(U.titleFromHtml('<title id="t" data-x="1">With attrs</title>'), 'With attrs');
  assert.equal(U.titleFromHtml('<TITLE>Upper</TITLE>'), 'Upper');
});

test('titleFromHtml: entities decoded and whitespace collapsed like a browser', () => {
  assert.equal(U.titleFromHtml('<title>\n   Tom &amp; Jerry\t&#8211;   &#x5E9;&#1500;&#x5D5;&#1501;\n</title>'), 'Tom & Jerry – שלום');
  assert.equal(U.titleFromHtml('<title>a&nbsp;&nbsp;&nbsp;b</title>'), 'a b');
});

test('titleFromHtml: raw Hebrew title is returned as is', () => {
  assert.equal(U.titleFromHtml('<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>האתר של אופק</title>'), 'האתר של אופק');
});

test('titleFromHtml: no title, empty title, whitespace-only title -> null', () => {
  assert.equal(U.titleFromHtml('<html><head></head><body>x</body></html>'), null);
  assert.equal(U.titleFromHtml('<title></title>'), null);
  assert.equal(U.titleFromHtml('<title>  \n\t </title>'), null);
  assert.equal(U.titleFromHtml('<title>&nbsp;</title>'), null);
  assert.equal(U.titleFromHtml(''), null);
  assert.equal(U.titleFromHtml('<title>never closed'), null);
});

test('titleFromHtml: the first title wins; markup-looking text inside is kept literally', () => {
  assert.equal(U.titleFromHtml('<title>First</title><title>Second</title>'), 'First');
  assert.equal(U.titleFromHtml('<title>a &lt;b&gt; c</title>'), 'a <b> c');
});

test('titleFromHtml: accepts a Buffer / non-string', () => {
  assert.equal(U.titleFromHtml(Buffer.from('<title>From buffer</title>')), 'From buffer');
  assert.equal(U.titleFromHtml(null), null);
  assert.equal(U.titleFromHtml(undefined), null);
});

test('normTitle: collapses whitespace, trims and lower-cases', () => {
  assert.equal(U.normTitle('  Hello \n\t  WORLD  '), 'hello world');
  assert.equal(U.normTitle('a\u00a0\u00a0B'), 'a b');
  assert.equal(U.normTitle('ÉCOLE Ünï'), 'école ünï');
  assert.equal(U.normTitle('  שלום   עולם '), 'שלום עולם');
});

test('normTitle: null/undefined -> empty string, numbers stringified', () => {
  assert.equal(U.normTitle(null), '');
  assert.equal(U.normTitle(undefined), '');
  assert.equal(U.normTitle(42), '42');
});

// ---------------------------------------------------------------------------------------------
// util: pathKey / slugFor / isLocalHost
// ---------------------------------------------------------------------------------------------

const TMP = os.tmpdir();

test('pathKey: linux keeps case exactly', () => {
  const p = path.join(TMP, 'Show', 'MySite');
  assert.equal(U.pathKey(p, 'linux'), path.resolve(p));
  assert.notEqual(U.pathKey(path.join(TMP, 'Site'), 'linux'), U.pathKey(path.join(TMP, 'site'), 'linux'));
});

test('pathKey: win32 and darwin are case-insensitive (lower-cased)', () => {
  const p = path.join(TMP, 'Show', 'MySite');
  assert.equal(U.pathKey(p, 'win32'), path.resolve(p).toLowerCase());
  assert.equal(U.pathKey(p, 'darwin'), path.resolve(p).toLowerCase());
  assert.equal(U.pathKey(path.join(TMP, 'SITE'), 'win32'), U.pathKey(path.join(TMP, 'site'), 'win32'));
  assert.equal(U.pathKey(path.join(TMP, 'SITE'), 'darwin'), U.pathKey(path.join(TMP, 'site'), 'darwin'));
});

test('pathKey: resolves relative paths, "..", "." and trailing separators', () => {
  assert.equal(U.pathKey('rel/Dir', 'linux'), path.resolve('rel/Dir'));
  assert.equal(U.pathKey(path.join(TMP, 'a', 'b', '..', 'c', '.'), 'linux'), path.resolve(TMP, 'a', 'c'));
  assert.equal(U.pathKey(path.join(TMP, 'a') + path.sep, 'linux'), U.pathKey(path.join(TMP, 'a'), 'linux'));
});

test('pathKey: defaults to the current platform', () => {
  const p = path.join(TMP, 'Default', 'Plat');
  assert.equal(U.pathKey(p), U.pathKey(p, process.platform));
});

test('pathKey: platforms other than Windows and macOS keep case ("exact elsewhere")', () => {
  // The doc comment says "Case-insensitive path key on Windows and macOS, exact elsewhere", and
  // adapterFor() treats every non-win32/non-darwin platform like Linux (case-sensitive file systems).
  const p = path.join(TMP, 'Show', 'MySite');
  for (const platform of ['freebsd', 'openbsd', 'sunos', 'aix']) {
    assert.equal(U.pathKey(p, platform), path.resolve(p), platform);
  }
});

test('slugFor: ASCII name -> lower-case slug + 6 hex of sha1(pathKey)', () => {
  const dir = path.join(TMP, 'My Cool Site!');
  const slug = U.slugFor(dir, 'linux');
  assert.equal(slug, `my-cool-site-${U.sha1(U.pathKey(dir, 'linux')).slice(0, 6)}`);
  assert.match(slug, /^my-cool-site-[0-9a-f]{6}$/);
});

test('slugFor: stable across calls and trailing separators', () => {
  const dir = path.join(TMP, 'stable-site');
  assert.equal(U.slugFor(dir), U.slugFor(dir));
  assert.equal(U.slugFor(dir + path.sep), U.slugFor(dir));
  assert.equal(U.slugFor(path.join(dir, 'sub', '..')), U.slugFor(dir));
});

test('slugFor: Hebrew folder name -> "site-<hash>", ASCII only', () => {
  const slug = U.slugFor(path.join(TMP, 'האתר שלי'));
  assert.match(slug, /^site-[0-9a-f]{6}$/);
  assert.match(slug, /^[\x20-\x7e]+$/);
});

test('slugFor: mixed Hebrew/English/emoji keeps only the ASCII words', () => {
  assert.match(U.slugFor(path.join(TMP, 'אתר Demo 2 🚀')), /^demo-2-[0-9a-f]{6}$/);
});

test('slugFor: punctuation-only names fall back to "site"', () => {
  assert.match(U.slugFor(path.join(TMP, '---')), /^site-[0-9a-f]{6}$/);
  assert.match(U.slugFor(path.join(TMP, '___ ...')), /^site-[0-9a-f]{6}$/);
});

test('slugFor: long names are cut to 32 characters before the hash', () => {
  const slug = U.slugFor(path.join(TMP, 'a'.repeat(50)));
  assert.match(slug, /^a{32}-[0-9a-f]{6}$/);
});

test('slugFor: always matches ^[a-z0-9-]+$ for a variety of names', () => {
  for (const name of ['Site', 'my_site.v2', 'Ünïcödé Fólder', 'שלום', 'dots...and--dashes', '  spaced  ', '日本語サイト', 'C++ & C#']) {
    assert.match(U.slugFor(path.join(TMP, name)), /^[a-z0-9-]+-[0-9a-f]{6}$/, name);
    assert.match(U.slugFor(path.join(TMP, name)), /^[a-z0-9-]+$/, name);
  }
});

test('slugFor: same basename in different folders -> different slugs', () => {
  assert.notEqual(U.slugFor(path.join(TMP, 'one', 'site')), U.slugFor(path.join(TMP, 'two', 'site')));
});

test('slugFor: case-insensitive on win32/darwin, case-sensitive on linux', () => {
  const upper = path.join(TMP, 'Demo');
  const lower = path.join(TMP, 'demo');
  assert.equal(U.slugFor(upper, 'win32'), U.slugFor(lower, 'win32'));
  assert.equal(U.slugFor(upper, 'darwin'), U.slugFor(lower, 'darwin'));
  assert.notEqual(U.slugFor(upper, 'linux'), U.slugFor(lower, 'linux'));
});

test('isLocalHost: loopback names and addresses', () => {
  for (const h of ['localhost', 'LOCALHOST', 'LocalHost', '127.0.0.1', '::1', '[::1]', 'app.localhost', 'a.b.localhost', 'API.LOCALHOST']) {
    assert.equal(U.isLocalHost(h), true, h);
  }
});

test('isLocalHost: WHATWG URL hostnames for loopback URLs', () => {
  for (const u of ['http://localhost:4401/', 'http://127.0.0.1:4401/x', 'http://[::1]:8080/', 'http://my-app.localhost:3000/']) {
    assert.equal(U.isLocalHost(new URL(u).hostname), true, u);
  }
});

test('isLocalHost: everything else is remote', () => {
  for (const h of ['example.com', 'localhost.example.com', 'notlocalhost', 'mylocalhost', 'localhostx', '127.0.0.1.nip.io', '192.168.1.5', '10.0.0.1', '', 'undefined']) {
    assert.equal(U.isLocalHost(h), false, h);
  }
  assert.equal(U.isLocalHost(undefined), false);
  assert.equal(U.isLocalHost(null), false);
});
