// The 8.3 short spelling of a long Windows path ("C:\Users\me\AppData\Local\Temp\SL-FSO~1\…"),
// so a page too deep for file:/// (past MAX_PATH) still opens as a file instead of being served.
import { statSync } from 'node:fs';
import { run, winProgram } from './util.mjs';

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/**
 * Scripting.FileSystemObject's ShortPath throws for a path of 260 characters or more (measured
 * on Windows 11: 258 worked, 262 threw CTL_E_FILENOTFOUND), which is exactly the case this is
 * for. So the path is walked one name at a time: each lookup is the short spelling found so
 * far plus one more name, which stays under MAX_PATH. The path travels in an environment
 * variable only, never on the command line, and the output is UTF-8 whatever the console
 * code page (a short name can keep non-ASCII letters).
 */
export const SHORT_PATH_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  'try {',
  '  $fso = New-Object -ComObject Scripting.FileSystemObject',
  '  $parts = $env:SHOW_LOCAL_P.TrimEnd([char]92).Split([char]92)',
  '  $cur = $parts[0] + [char]92',
  '  for ($i = 1; $i -lt $parts.Count; $i++) {',
  '    $next = $cur.TrimEnd([char]92) + [char]92 + $parts[$i]',
  '    if ($i -eq $parts.Count - 1 -and $env:SHOW_LOCAL_KIND -eq "file") { $cur = $fso.GetFile($next).ShortPath }',
  '    else { $cur = $fso.GetFolder($next).ShortPath }',
  '  }',
  '  $cur',
  '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
].join('\n');

const DRIVE_PATH = /^[a-z]:\\/i;

/**
 * The 8.3 short path of an existing local file or folder on Windows, or null: on another
 * platform, for anything but a plain drive-letter path, when PowerShell or the lookup fails
 * (8.3 names turned off for that volume leave the long names in place), when the result is
 * not shorter, or when it does not lead to the very same file. Synchronous: one PowerShell
 * run, about 0.4 s. `runFn` and `statFn` exist for tests.
 * @returns {string|null}
 */
export function shortPath(p, { runFn = run, platform = process.platform, statFn = statSync, timeout = 10000 } = {}) {
  if (platform !== 'win32') return null;
  const long = String(p ?? '');
  if (!DRIVE_PATH.test(long) || long.includes('\0')) return null;
  let st;
  try { st = statFn(long, { bigint: true }); } catch { return null; }
  const kind = st.isDirectory() ? 'folder' : 'file';
  let r;
  try {
    r = runFn(winProgram('powershell'), [...PS, SHORT_PATH_SCRIPT], { env: { SHOW_LOCAL_P: long, SHOW_LOCAL_KIND: kind }, timeout });
  } catch { return null; }
  if (!r || r.status !== 0) return null;
  const out = String(r.stdout ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  if (!out || !DRIVE_PATH.test(out) || out.length >= long.length) return null;
  // The same file under its other name, or nothing: a stray line of output is never trusted.
  try {
    const s = statFn(out, { bigint: true });
    if (s.ino !== st.ino || s.dev !== st.dev || s.isDirectory() !== st.isDirectory()) return null;
  } catch { return null; }
  return out;
}
