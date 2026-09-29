// `show.mjs doctor`: read-only checks of everything show-local depends on, with fixes.
// Never changes a setting; it only reports.
import { existsSync } from 'node:fs';
import { resolveLinuxBrowser, resolveMacBrowser, resolveWindowsBrowser, windowsAppFor } from './browser.mjs';
import { isPortFree, PORT_MAX, PORT_MIN } from './ports.mjs';
import { listServers } from './registry.mjs';
import { launchJsonPath } from './launchjson.mjs';
import { MAC_PROGRAMS, run } from './util.mjs';
import { createWindowsAdapter } from './adapters/win.mjs';
import { isWaylandSession } from './adapters/linux.mjs';

const check = (id, status, detail, fix) => ({ id, status, detail, ...(fix ? { fix } : {}) });

async function freePorts() {
  let free = 0;
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (await isPortFree(p)) free++;
  return free;
}

function windowsChecks(runFn) {
  const out = [];
  const b = resolveWindowsBrowser(runFn);
  if (!b) {
    out.push(check('browser', 'warn', 'The default https browser could not be read from the registry.', 'Set a default browser in Settings > Apps > Default apps. show-local falls back to Start-Process meanwhile.'));
  } else {
    const ok = existsSync(b.exe);
    out.push(check('browser', ok ? 'ok' : 'fail', `Default browser for https: ${b.name} (${b.progId}) → ${b.exe}`, ok ? null : 'The registered browser executable is missing; reinstall it or choose another default browser.'));
  }
  // The same lookup the opener uses, so a Store app gets the name the open result gives it
  // ("Photos"), with the raw ProgId in parentheses.
  const html = windowsAppFor(runFn, '.html');
  if (html) {
    // One ProgId is one registered command, whatever each read made of a non-ASCII path.
    const same = b && (html.progId.toLowerCase() === b.progId.toLowerCase()
      || (html.exe && html.exe.toLowerCase() === b.exe.toLowerCase()));
    out.push(same
      ? check('html-association', 'ok', `.html files open in the same browser (${html.name}).`)
      : check('html-association', 'warn',
        `.html files are associated with ${html.name} (${html.progId}), but https links open in ${b ? b.name : 'another browser'}. Double-clicking an HTML file would land in ${html.name}.`,
        `Nothing to do for show-local: it opens HTML files with ${b ? b.name : 'the https browser'} directly. To change double-click behaviour too: Settings > Apps > Default apps > ${b ? b.name : 'your browser'} > .html.`));
  }
  for (const ext of ['.pdf', '.mp4', '.png']) {
    const app = windowsAppFor(runFn, ext);
    out.push(check(`app${ext}`, app ? 'ok' : 'info', app ? `${ext} opens with ${app.name} (${app.progId})` : `${ext} has no per-user default app; Windows will ask or use the system default.`));
  }
  const snap = createWindowsAdapter({ runFn }).snapshot();
  out.push(snap.ok
    ? check('window-titles', 'ok', `Window titles are readable (${snap.windows.length} visible windows), so opens can be verified.`)
    : check('window-titles', 'fail', `Window titles could not be read: ${snap.error}`, 'PowerShell must be able to run scripts with -ExecutionPolicy Bypass; check group policy.'));
  return out;
}

function macChecks(runFn, env) {
  const out = [];
  const b = resolveMacBrowser(runFn);
  out.push(b
    ? check('browser', 'ok', `Default browser for https: ${b.name} (${b.bundleId})`)
    : check('browser', 'warn', 'The default browser could not be read from LaunchServices; `open` will choose.', null));
  // The mac adapter skips AppleScript when this is set, so doctor must not promise a prompt or run osascript.
  if (env.SHOW_LOCAL_NO_OSASCRIPT === '1') {
    out.push(check('osascript', 'info', 'AppleScript verification is turned off (SHOW_LOCAL_NO_OSASCRIPT=1), so opens are reported as "cannot verify" and no Automation permission is asked.', 'Unset SHOW_LOCAL_NO_OSASCRIPT to verify opens through AppleScript again.'));
    return out;
  }
  const osa = runFn(MAC_PROGRAMS.osascript, ['-e', 'return 1']);
  out.push(osa.status === 0
    ? check('osascript', 'ok', 'AppleScript is available. The first verification may ask for Automation permission for your browser and Finder.', 'Set SHOW_LOCAL_NO_OSASCRIPT=1 to skip verification instead.')
    : check('osascript', 'warn', 'osascript is not available; opens will not be verified.'));
  return out;
}

function linuxChecks(runFn, env) {
  const out = [];
  const b = resolveLinuxBrowser(runFn, { env });
  out.push(b?.exe
    ? check('browser', 'ok', `Default browser: ${b.name} (${b.desktopId})`)
    : check('browser', 'warn', b ? `Default browser ${b.desktopId} found, but its .desktop file was not; xdg-open will be used.` : 'xdg-settings did not report a default browser; xdg-open will be used.', 'Run: xdg-settings set default-web-browser <browser>.desktop'));
  const wayland = isWaylandSession(env);
  const lister = ['wmctrl', 'xdotool'].find((bin) => runFn('/bin/sh', ['-c', 'command -v "$0"', bin]).status === 0);
  out.push(wayland
    ? check('window-titles', 'warn', `Wayland session: native windows hide their titles${lister && env.DISPLAY ? ` (${lister} sees only X11/XWayland windows)` : ''}, so a missing match is reported as "cannot verify", not as a failure. Served pages are still verified through the server log.`)
    : lister
      ? check('window-titles', 'ok', `Window titles readable through ${lister}.`)
      : check('window-titles', 'warn', 'No window lister installed; opens cannot be verified by window title.', 'Install wmctrl (sudo apt install wmctrl) to enable verification.'));
  return out;
}

// countFreePorts and serversFn are injectable so tests neither probe 100 ports nor touch the real registry.
export async function doctor({ platform = process.platform, runFn = run, env = process.env, cwd = process.cwd(), countFreePorts = freePorts, serversFn = listServers } = {}) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(major >= 18
    ? check('node', 'ok', `Node ${process.versions.node}`)
    : check('node', 'fail', `Node ${process.versions.node} is too old`, 'Install Node 18 or newer.'));
  if (platform === 'win32') checks.push(...windowsChecks(runFn));
  else if (platform === 'darwin') checks.push(...macChecks(runFn, env));
  else checks.push(...linuxChecks(runFn, env));

  const free = await countFreePorts();
  checks.push(free > 0
    ? check('ports', 'ok', `${free} of ${PORT_MAX - PORT_MIN + 1} ports free in ${PORT_MIN}-${PORT_MAX}.`)
    : check('ports', 'fail', `No free port in ${PORT_MIN}-${PORT_MAX}.`, 'See which of them are show-local servers with show.mjs servers, and stop those no longer needed (show.mjs stop <port>, or show.mjs stop all). Ports held by other programs are not show-local\'s to stop.'));
  const servers = await serversFn();
  checks.push(check('servers', 'info', servers.length ? `${servers.length} show-local server(s) running: ${servers.map((s) => `${s.port} → ${s.root}${s.kind === 'dev' ? ' (dev server)' : ''}${s.responding === false ? ' (not responding)' : ''}`).join('; ')}` : 'No show-local servers running.'));
  const lj = launchJsonPath(cwd);
  checks.push(check('launch-json', 'info', existsSync(lj) ? `Desktop preview config present: ${lj}` : 'No .claude/launch.json in this folder (created on first served preview in the desktop app).'));

  const worst = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { ok: worst !== 'fail', status: worst, platform, checks };
}
