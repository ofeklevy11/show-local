// Linux: the default browser's .desktop Exec line (falls back to xdg-open), the freedesktop
// FileManager1 D-Bus call to reveal a file, xdg-open for the rest. Verification through
// wmctrl or xdotool when installed. On Wayland those only see X11 (XWayland) windows, so a
// miss there is reported as "cannot verify", never as "did not open".
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { desktopArgs, resolveLinuxBrowser } from '../browser.mjs';
import { normTitle, pollTitles, run, selectionUnchecked } from '../util.mjs';
import { spawnDetached } from './win.mjs';

const has = (runFn, bin) => runFn('/bin/sh', ['-c', 'command -v "$0"', bin]).status === 0;
const settled = (result) => ({ ready: Promise.resolve(), result: Promise.resolve(result), cancel() {} });

/**
 * A Wayland session, whatever DISPLAY says: XWayland always sets DISPLAY, and a compositor
 * started from a console login (sway, river) leaves XDG_SESSION_TYPE at "tty". Doctor asks
 * the same question, so both always agree.
 */
export const isWaylandSession = (env) => env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY;

export function createLinuxAdapter({ runFn = run, spawnFn = spawn, env = process.env } = {}) {
  const wayland = isWaylandSession(env);

  function titleSource() {
    if (wayland && !env.DISPLAY) {
      return () => ({ titles: null, reason: 'Wayland does not expose window titles to other programs' });
    }
    if (has(runFn, 'wmctrl')) {
      return () => {
        const r = runFn('wmctrl', ['-l']);
        if (r.status !== 0) return { titles: null, reason: 'wmctrl could not list windows' };
        // columns: id desktop host title...
        return { titles: r.stdout.split('\n').map((l) => l.trim().split(/\s+/).slice(3).join(' ')).filter(Boolean) };
      };
    }
    if (has(runFn, 'xdotool')) {
      return () => {
        const ids = runFn('xdotool', ['search', '--onlyvisible', '--name', '.+']);
        // `xdotool search` exits 1, silently, when no window matches: that alone is an empty
        // desktop. Anything else without output (a message such as "Can't open display", a
        // timeout, another exit code) means the windows could not be listed: cannot verify.
        const err = `${ids.error || ''} ${ids.stderr || ''}`.trim();
        if (/can'?t open display|cannot open display/i.test(err)) return { titles: null, reason: 'xdotool cannot open the display (no X server reachable)' };
        if (ids.error) return { titles: null, reason: `xdotool could not list windows: ${ids.error.slice(0, 160)}` };
        if (!ids.stdout.trim()) {
          if (ids.status === 0 || (ids.status === 1 && !err)) return { titles: [] };
          return { titles: null, reason: `xdotool could not list windows (exit ${ids.status})${err ? `: ${err.slice(0, 160)}` : ''}` };
        }
        const titles = ids.stdout.split('\n').filter(Boolean).slice(0, 200)
          .map((id) => runFn('xdotool', ['getwindowname', id]).stdout.trim()).filter(Boolean);
        return { titles };
      };
    }
    return () => ({ titles: null, reason: 'no window lister installed (install wmctrl or xdotool to verify)' });
  }

  /**
   * Poll a title source; same contract as the Windows watcher. Only a new matching title is
   * proof: one that was already open before gives matched:null (see pollTitles). Under
   * Wayland a miss is "cannot confirm", because a native window is invisible to the lister.
   */
  const poll = (source, matches, timeoutMs) => pollTitles(source, matches, timeoutMs, {
    miss: () => (wayland
      ? { matched: null, reason: 'under Wayland only X11 windows are visible, so a native window cannot be confirmed' }
      : { matched: false, reason: `no new window matching the target appeared within ${timeoutMs} ms` }),
  });

  const watchTitles = ({ tokens = [], timeoutMs = 5000 }) => {
    const wanted = tokens.map(normTitle).filter(Boolean);
    if (!wanted.length) return settled({ matched: null, reason: 'the page title is not known in advance' });
    return poll(titleSource(), (t) => wanted.some((w) => normTitle(t).includes(w)), timeoutMs);
  };

  return {
    platform: 'linux',
    resolveBrowser: () => resolveLinuxBrowser(runFn, { env }),

    async openUrl(url, b) {
      if (b?.argv?.length) {
        const r = await spawnDetached(b.argv[0], desktopArgs(b.argv.slice(1), url), {}, spawnFn);
        if (r.ok) return { ok: true, with: b.name, how: `${b.desktopId} (default browser)`, exe: b.argv[0] };
      }
      const r = await spawnDetached('xdg-open', [url], {}, spawnFn);
      return r.ok ? { ok: true, with: 'default browser', how: 'xdg-open' } : { ok: false, error: r.error };
    },
    async openFolder(dir, select) {
      const uri = pathToFileURL(select || dir).href;
      const method = select ? 'ShowItems' : 'ShowFolders';
      const r = runFn('gdbus', ['call', '--session', '--dest', 'org.freedesktop.FileManager1',
        '--object-path', '/org/freedesktop/FileManager1', '--method', `org.freedesktop.FileManager1.${method}`,
        `['${uri.replace(/'/g, '%27')}']`, '']);
      if (r.status === 0) return { ok: true, with: 'file manager', how: `FileManager1.${method}` };
      const x = await spawnDetached('xdg-open', [dir], {}, spawnFn);
      return x.ok ? { ok: true, with: 'file manager', how: 'xdg-open' } : { ok: false, error: x.error };
    },
    async openApp(file) {
      const r = await spawnDetached('xdg-open', [file], {}, spawnFn);
      return r.ok ? { ok: true, with: 'default app', how: 'xdg-open' } : { ok: false, error: r.error };
    },
    appFor() { return null; },

    watchWindows: watchTitles,
    watchAppWindows: watchTitles,
    watchFolder({ dir, timeoutMs = 5000 }) {
      // File managers title their window with the folder's name. Match that name as a whole
      // (alone, or followed by " - App") or the full path, never as a substring of another title.
      // Titles say nothing about the selected file, so selectedOk is null.
      const base = normTitle(dir.split('/').filter(Boolean).pop() || dir);
      const full = normTitle(dir);
      const matches = (t) => {
        const n = normTitle(t);
        return n === base || n.startsWith(`${base} - `) || n.startsWith(`${base} — `) || n.includes(full);
      };
      return selectionUnchecked(poll(titleSource(), matches, timeoutMs));
    },
    snapshot() {
      const s = titleSource()();
      return s.titles ? { ok: true, windows: s.titles.map((title) => ({ process: '', title })) } : { ok: false, error: s.reason };
    },
  };
}
