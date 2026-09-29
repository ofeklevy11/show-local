// macOS: `open` for everything; verification through AppleScript where the system allows it.
// Implemented from Apple's documented commands but not yet run on a real Mac (see README).
import path from 'node:path';
import { resolveMacBrowser } from '../browser.mjs';
import { normTitle, pollTitles, run, selectionUnchecked } from '../util.mjs';

// Browsers whose AppleScript dictionary exposes tab titles, and the property that holds them.
const TAB_TITLE = {
  'com.google.chrome': 'title of active tab', 'com.google.chrome.canary': 'title of active tab',
  'com.brave.browser': 'title of active tab', 'com.microsoft.edgemac': 'title of active tab',
  'com.vivaldi.vivaldi': 'title of active tab', 'company.thebrowser.browser': 'title of active tab',
  'com.apple.safari': 'name of current tab', 'com.apple.safaritechnologypreview': 'name of current tab',
};
const SAFE_ID = /^[A-Za-z0-9.-]+$/;

function osa(runFn, lines) {
  return runFn('osascript', lines.flatMap((l) => ['-e', l]), { timeout: 4000 });
}

const notAuthorized = (r) => /-1743|not authori[sz]ed/i.test(`${r.stderr} ${r.stdout}`);
const settled = (result) => ({ ready: Promise.resolve(), result: Promise.resolve(result), cancel() {} });
const trimSlash = (p) => p.replace(/\/+$/, '') || '/';

/**
 * A folder name with what looks like an extension may be a package (.prefPane, .workflow,
 * .saver, .sparsebundle…) that `open` would hand to LaunchServices. With nothing to select,
 * openFolder reveals such a folder itself with `open -R`, so Finder shows its parent.
 */
const revealsItself = (dir, select) => !select && /\.[A-Za-z0-9]+$/.test(trimSlash(dir));

/** Why an osascript run gave no answer: not installed, no answer in time, or its own error. */
function osaFailure(r) {
  const text = `${r.error || ''} ${r.stderr || ''}`;
  if (/ENOENT/.test(text)) return 'osascript was not found';
  if (/ETIMEDOUT/.test(text) || r.status === null) return 'osascript did not answer within 4 s';
  const msg = (r.stderr || r.error || '').trim().slice(0, 160);
  return `osascript failed (exit ${r.status})${msg ? `: ${msg}` : ''}`;
}

export function createMacAdapter({ runFn = run, env = process.env } = {}) {
  // Checked before any AppleScript runs, so turning it off never triggers a permission prompt.
  const noScript = env.SHOW_LOCAL_NO_OSASCRIPT === '1';
  const disabled = { matched: null, reason: 'verification disabled (SHOW_LOCAL_NO_OSASCRIPT=1)' };

  function browserTitles(bundleId) {
    const prop = TAB_TITLE[String(bundleId).toLowerCase()];
    if (!prop || !SAFE_ID.test(bundleId)) return { titles: null, reason: `window titles of ${bundleId} are not readable from AppleScript` };
    // Only a clean "false" means the browser is not running (no windows yet). When the check
    // itself fails, nothing is known about its windows: "cannot verify", never "did not open".
    const running = osa(runFn, [`application id "${bundleId}" is running`]);
    if (notAuthorized(running)) return { titles: null, reason: 'macOS Automation permission for the browser was not granted' };
    if (running.status !== 0 || running.error) {
      return { titles: null, reason: `could not check whether the browser is running: ${osaFailure(running)}` };
    }
    const answer = running.stdout.trim();
    if (answer === 'false') return { titles: [] };
    if (answer !== 'true') return { titles: null, reason: `could not check whether the browser is running: osascript answered "${answer.slice(0, 40)}"` };
    const r = osa(runFn, [
      `tell application id "${bundleId}"`,
      'set out to ""',
      'repeat with w in windows',
      'try',
      `set out to out & (${prop} of w) & linefeed`,
      'end try',
      'end repeat',
      'return out',
      'end tell',
    ]);
    if (notAuthorized(r)) return { titles: null, reason: 'macOS Automation permission for the browser was not granted' };
    if (r.status !== 0) return { titles: null, reason: `AppleScript failed: ${(r.stderr || '').trim().slice(0, 160)}` };
    return { titles: r.stdout.split('\n').map((t) => t.trim()).filter(Boolean) };
  }

  function finderPaths() {
    const r = osa(runFn, [
      'tell application "Finder"',
      'set out to ""',
      'repeat with w in Finder windows',
      'try',
      'set out to out & POSIX path of (target of w as alias) & linefeed',
      'end try',
      'end repeat',
      'return out',
      'end tell',
    ]);
    if (notAuthorized(r)) return { titles: null, reason: 'macOS Automation permission for Finder was not granted' };
    if (r.status !== 0) return { titles: null, reason: 'Finder windows could not be read' };
    return { titles: r.stdout.split('\n').map((t) => t.trim()).filter(Boolean).map(trimSlash) };
  }

  /**
   * Poll a title source; same contract as the Windows watcher. Only a new matching title is
   * proof: one that was already open before gives matched:null (see pollTitles).
   */
  const poll = (source, matches, timeoutMs) => pollTitles(source, matches, timeoutMs);

  let browser;
  return {
    platform: 'darwin',
    resolveBrowser() { browser = resolveMacBrowser(runFn); return browser; },

    async openUrl(url, b) {
      const args = b?.bundleId && SAFE_ID.test(b.bundleId) ? ['-b', b.bundleId, url] : [url];
      const r = runFn('open', args);
      return r.status === 0 ? { ok: true, with: b?.name || 'default browser', how: args[0] === '-b' ? 'open -b' : 'open' } : { ok: false, error: (r.stderr || r.error || 'open failed').trim() };
    },
    async openFolder(dir, select) {
      const reveal = select || (revealsItself(dir, select) ? dir : null);
      const r = runFn('open', reveal ? ['-R', reveal] : [dir]);
      return r.status === 0 ? { ok: true, with: 'Finder', how: reveal ? 'open -R' : 'open' } : { ok: false, error: (r.stderr || r.error || 'open failed').trim() };
    },
    async openApp(file) {
      const r = runFn('open', [file]);
      return r.status === 0 ? { ok: true, with: 'default app', how: 'open' } : { ok: false, error: (r.stderr || r.error || 'open failed').trim() };
    },
    appFor() { return null; },

    watchWindows({ tokens = [], timeoutMs = 5000 }) {
      if (noScript) return settled(disabled);
      const b = browser || resolveMacBrowser(runFn);
      if (!b?.bundleId) return settled({ matched: null, reason: 'default browser could not be identified' });
      const wanted = tokens.map(normTitle).filter(Boolean);
      if (!wanted.length) return settled({ matched: null, reason: 'the page title is not known in advance' });
      return poll(() => browserTitles(b.bundleId), (t) => wanted.some((w) => normTitle(t).includes(w)), timeoutMs);
    },
    watchAppWindows() {
      return settled({ matched: null, reason: "macOS does not expose other apps' window titles without Accessibility permission" });
    },
    // `open -R` selects the file, but Finder's AppleScript is only asked for window folders,
    // so whether the file is selected is not checked: selectedOk is null. A folder openFolder
    // reveals itself is shown in its parent, so that is the window to wait for.
    watchFolder({ dir, select, timeoutMs = 5000 }) {
      if (noScript) return selectionUnchecked(settled(disabled));
      const clean = trimSlash(dir);
      const want = revealsItself(clean, select) ? path.posix.dirname(clean) : clean;
      return selectionUnchecked(poll(finderPaths, (p) => p === want, timeoutMs));
    },
    snapshot() { return { ok: false, error: 'not available on macOS' }; },
  };
}
