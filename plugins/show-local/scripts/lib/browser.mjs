// Find the user's default browser — the one that opens https links — so HTML files open
// there too, even when the .html file type is associated with a different program.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAC_PROGRAMS, run, splitWindowsCommand, winProgram } from './util.mjs';

/** Turn a registry "shell\open\command" template into {exe, args}; %1 marks the URL. */
export function parseWindowsTemplate(template) {
  const argv = splitWindowsCommand(template);
  if (!argv.length) return null;
  return { exe: argv[0], args: argv.slice(1) };
}

/**
 * Arguments for opening `url` with a parsed template. %1 and %L are the URL. %* means "the
 * remaining arguments": it carries the URL only when the template has no %1/%L, and is
 * otherwise empty (a single URL has nothing left over). No placeholder: the URL is appended.
 */
export function browserArgs(parsed, url) {
  const hasOne = parsed.args.some((a) => /%[1lL]/.test(a));
  let used = false;
  const args = [];
  for (const a of parsed.args) {
    if (a === '%*') { if (!hasOne) { args.push(url); used = true; } continue; }
    if (/%[1lL]/.test(a)) { args.push(a.replace(/%[1lL]/g, () => url)); used = true; continue; }
    args.push(a);
  }
  if (!used) args.push(url);
  return args;
}

const regValue = (runFn, key, value) => {
  const r = runFn(winProgram('reg'), ['query', key, ...(value ? ['/v', value] : ['/ve'])]);
  if (r.status !== 0) return null;
  // The default value's label is localised ("(Default)", "(ברירת מחדל)"), so match on the type column.
  const m = r.stdout.match(value ? new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`) : /^\s*\S.*?\s{2,}REG_\w+\s+(.+)$/m);
  const v = m ? m[1].trim() : '';
  // An unset default prints a localised placeholder in parentheses, e.g. "(value not set)".
  return !v || /^\(.*\)$/.test(v) ? null : v;
};

export function windowsProgId(runFn, scheme = 'https') {
  return regValue(runFn, `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`, 'ProgId');
}

export function windowsFileProgId(runFn, ext) {
  return regValue(runFn, `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`, 'ProgId');
}

export function windowsCommandFor(runFn, progId) {
  return regValue(runFn, `HKCR\\${progId}\\shell\\open\\command`)
    || regValue(runFn, `HKLM\\SOFTWARE\\Classes\\${progId}\\shell\\open\\command`)
    || regValue(runFn, `HKCU\\SOFTWARE\\Classes\\${progId}\\shell\\open\\command`);
}

const KNOWN = [
  [/chromium/i, 'Chromium', 'chromium'], [/chrome/i, 'Google Chrome', 'chrome'], [/msedge|microsoft.?edge/i, 'Microsoft Edge', 'msedge'],
  [/firefox/i, 'Firefox', 'firefox'], [/brave/i, 'Brave', 'brave'], [/opera/i, 'Opera', 'opera'],
  [/vivaldi/i, 'Vivaldi', 'vivaldi'], [/(^|[\\/.])arc([\\/.]|$)/i, 'Arc', 'arc'],
  [/vlc/i, 'VLC media player', 'vlc'], [/acrord32|acrobat/i, 'Adobe Acrobat', null],
  [/sumatrapdf/i, 'SumatraPDF', 'sumatrapdf'], [/mpc-hc/i, 'MPC-HC', null], [/wmplayer/i, 'Windows Media Player', 'wmplayer'],
];
/**
 * A readable name, and the process name that owns the program's windows (what the window
 * watcher filters on). The name comes from the whole path, since the folder tells Chromium
 * apart from Chrome; the process is the executable itself when that is a known program,
 * because windows belong to the executable: Chromium and ungoogled-chromium install
 * chrome.exe. A launcher stub such as Opera's launcher.exe names no program, so there the
 * known label (opera) stays.
 */
export function browserName(exeOrId) {
  const s = String(exeOrId || '');
  const hit = KNOWN.find(([re]) => re.test(s));
  // Either separator: a registry path is a Windows path on whatever platform reads it.
  const base = s.replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  if (hit) {
    const own = KNOWN.find(([re]) => re.test(base));
    return { name: hit[1], process: (own ? own[2] : hit[2]) ?? base.toLowerCase() };
  }
  if (/^AppX/i.test(s)) return { name: 'a Microsoft Store app', process: null };
  return { name: base || 'default app', process: base.toLowerCase() || null };
}

/**
 * A Microsoft Store app's readable name, from its ProgId's Application key. The value names
 * the package, "@{Microsoft.Windows.Photos_…?ms-resource://…}", and its last dotted part is
 * the app ("Photos"); a plain name is kept as it is. Null when there is none, or when it is
 * only a resource reference that cannot be resolved here.
 */
export function windowsStoreAppName(runFn, progId) {
  const v = regValue(runFn, `HKCR\\${progId}\\Application`, 'ApplicationName');
  if (!v) return null;
  const pkg = v.match(/^@\{([A-Za-z0-9.]+?)_/);
  if (pkg) return pkg[1].split('.').pop() || null;
  return /^@|ms-resource:/i.test(v) ? null : v;
}

/**
 * The program a file type opens with, from the user's choice in the registry: { progId, exe,
 * name, process }, without exe for a ProgId that has no command line (Store apps), or null
 * when no program is chosen. The opener names the program with it and doctor describes the
 * association with it, so both always say the same ("Photos", never a raw AppX id alone).
 */
export function windowsAppFor(runFn, ext) {
  const progId = windowsFileProgId(runFn, ext);
  if (!progId) return null;
  const template = windowsCommandFor(runFn, progId);
  let parsed = template && parseWindowsTemplate(template);
  // A path reg.exe garbled is re-read as Unicode, as resolveWindowsBrowser does, so doctor
  // compares the same path for .html as for https. Only then: PowerShell is slow.
  if (parsed?.exe && garbled(parsed.exe)) {
    const unicode = windowsCommandUnicode(runFn, progId);
    const p2 = unicode && parseWindowsTemplate(unicode);
    if (p2?.exe) parsed = p2;
  }
  if (!parsed?.exe) {
    const storeName = /^AppX/i.test(progId) ? windowsStoreAppName(runFn, progId) : null;
    return { progId, name: storeName || browserName(progId).name, process: null };
  }
  const known = browserName(parsed.exe);
  return { progId, exe: parsed.exe, name: known.name, process: known.process };
}

/**
 * A path reg.exe could not print in the console code page: what it cannot show comes back as
 * U+FFFD or as '?', and no Windows path holds a '?' past a \\?\ prefix.
 */
const garbled = (p) => /[\uFFFD?]/.test(p.replace(/^\\\\\?\\/, ''));

/**
 * reg.exe prints in the console code page, so a non-ASCII value (a browser installed under a
 * non-English user name) can come back mangled. PowerShell reads the registry as Unicode;
 * it is slower, so it is only asked when reg.exe's answer does not hold up.
 */
export function windowsCommandUnicode(runFn, progId) {
  const script = [
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    "foreach ($root in 'Registry::HKEY_CLASSES_ROOT', 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes', 'Registry::HKEY_CURRENT_USER\\SOFTWARE\\Classes') {",
    '  $v = (Get-Item -LiteralPath (Join-Path $root ($env:SHOW_LOCAL_PROGID + "\\shell\\open\\command")) -ErrorAction SilentlyContinue).GetValue("")',
    '  if ($v) { $v; break }',
    '}',
  ].join('\n');
  const r = runFn(winProgram('powershell'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { SHOW_LOCAL_PROGID: progId } });
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v || null;
}

/** Windows: https ProgId → open command → exe + args. Null when anything is missing. */
export function resolveWindowsBrowser(runFn = run, exists = process.platform === 'win32' ? existsSync : () => true) {
  const progId = windowsProgId(runFn, 'https') || windowsProgId(runFn, 'http');
  if (!progId) return null;
  let template = windowsCommandFor(runFn, progId);
  let parsed = template && parseWindowsTemplate(template);
  if (!parsed?.exe || /�/.test(template) || !exists(parsed.exe)) {
    const unicode = windowsCommandUnicode(runFn, progId);
    const p2 = unicode && parseWindowsTemplate(unicode);
    if (p2?.exe) { template = unicode; parsed = p2; }
  }
  if (!parsed || !parsed.exe) return null;
  return { platform: 'win32', progId, template, exe: parsed.exe, args: parsed.args, ...browserName(parsed.exe) };
}

/** macOS: bundle id of the https handler from LaunchServices, or null. */
export function resolveMacBrowser(runFn = run, home = os.homedir(), exists = existsSync) {
  const plist = path.join(home, 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
  let data = { LSHandlers: [] };
  if (exists(plist)) {
    const r = runFn(MAC_PROGRAMS.plutil, ['-convert', 'json', '-o', '-', plist]);
    if (r.status !== 0) return null;
    try { data = JSON.parse(r.stdout); } catch { return null; }
  }
  const handler = (data.LSHandlers || []).find((h) => h.LSHandlerURLScheme === 'https')
    || (data.LSHandlers || []).find((h) => h.LSHandlerURLScheme === 'http');
  // No explicit https handler means the user never changed it: macOS uses Safari.
  const bundle = handler?.LSHandlerRoleAll || 'com.apple.Safari';
  const name = {
    'com.google.chrome': 'Google Chrome', 'com.apple.safari': 'Safari', 'org.mozilla.firefox': 'Firefox',
    'com.microsoft.edgemac': 'Microsoft Edge', 'com.brave.browser': 'Brave', 'company.thebrowser.browser': 'Arc',
    'com.vivaldi.vivaldi': 'Vivaldi', 'com.operasoftware.opera': 'Opera',
  }[bundle.toLowerCase()] || bundle;
  return { platform: 'darwin', bundleId: bundle, name };
}

/** Parse an Exec= line from a .desktop file (Desktop Entry Specification quoting). */
export function parseDesktopExec(exec) {
  const argv = [];
  let cur = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < exec.length; i++) {
    const ch = exec[i];
    if (quoted && ch === '\\' && i + 1 < exec.length) { cur += exec[++i]; continue; }
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (started) { argv.push(cur); cur = ''; started = false; } continue; }
    cur += ch; started = true;
  }
  if (started) argv.push(cur);
  return argv;
}

/** Exec argv with field codes resolved: %u %U %f %F become the target, the rest are dropped. */
export function desktopArgs(argv, url) {
  const out = [];
  let used = false;
  for (const a of argv) {
    if (/^%[uUfF]$/.test(a)) {
      const v = /^%[fF]$/.test(a) && url.startsWith('file://') ? decodeURIComponent(new URL(url).pathname) : url;
      out.push(v); used = true; continue;
    }
    if (/^%[a-zA-Z]$/.test(a)) continue;
    out.push(a.replace(/%%/g, '%'));
  }
  if (!used) out.push(url);
  return out;
}

export function desktopFileDirs(env = process.env, home = os.homedir()) {
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local/share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [dataHome, ...dataDirs, '/var/lib/flatpak/exports/share', '/var/lib/snapd/desktop']
    .map((d) => path.join(d, 'applications'));
}

/** Linux: xdg-settings default browser → .desktop Exec line → argv. */
export function resolveLinuxBrowser(runFn = run, { env = process.env, home = os.homedir(), readFile = readFileSync, exists = existsSync } = {}) {
  const r = runFn('xdg-settings', ['get', 'default-web-browser']);
  const id = r.status === 0 ? r.stdout.trim() : '';
  if (!id) return null;
  for (const dir of desktopFileDirs(env, home)) {
    const file = path.join(dir, id);
    if (!exists(file)) continue;
    let text = '';
    try { text = readFile(file, 'utf8'); } catch { continue; }
    const section = text.split(/^\[/m).find((s) => s.startsWith('Desktop Entry]')) || text;
    const m = section.match(/^Exec=(.+)$/m);
    if (!m) continue;
    const argv = parseDesktopExec(m[1].trim());
    if (!argv.length) continue;
    return { platform: 'linux', desktopId: id, exe: argv[0], argv, ...linuxName(id, section) };
  }
  return { platform: 'linux', desktopId: id, exe: null, argv: null, ...linuxName(id, '') };
}

/** Human name: a known browser, else the .desktop file's Name=, else the id without ".desktop". */
function linuxName(id, section) {
  const known = browserName(id);
  const stem = id.replace(/\.desktop$/i, '');
  if (known.name !== path.basename(id).replace(/\.exe$/i, '') && known.name !== 'default app') return known;
  const name = (section.match(/^Name=(.+)$/m) || [])[1]?.trim();
  return { name: name || stem.split('.').pop() || stem, process: known.process };
}
