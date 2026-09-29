---
name: show-doctor
description: Diagnoses why show-local opened something in the wrong program, or could not open or verify it. It checks the default browser, file-type associations (for example .html set to Edge while links open in Chrome), whether window titles are readable, free ports and running servers, then explains the fix in plain words without changing any setting. Use when the user says things like "why did it open in Edge", "it didn't open", "nothing opened", "it opened in the wrong browser", "check show-local", "show-local doctor", "למה זה נפתח ב-Edge", "זה לא נפתח לי", "נפתח בדפדפן הלא נכון" or "בדיקת סביבה ל-show-local".
---

# show-doctor: why it opened wrong, or not at all

Read-only. It changes nothing, and neither do you: default apps and browser settings belong to the user. Explain what to change and where, and let them do it.

The script is `${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs`. If a command with that path fails because the file does not exist, use `<Base directory for this skill>/../../scripts/show.mjs` instead (the base directory is printed above these instructions). Write the full path in every command, because shell variables do not survive between tool calls.

## Run it

```bash
node '${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs' doctor
```

Run it with the Bash tool, the path in single quotes. If the plugin's own path contains an apostrophe, write it `'\''` in Bash (Claude Code then asks the user to approve the command); in PowerShell, quote with single quotes and double any apostrophe.

If the shell says `node` is not found, the doctor cannot run, and that is the whole diagnosis: show-local needs Node 18 or newer. Tell the user to install it (https://nodejs.org) and open a new session.

It prints `status` (`ok`, `warn` or `fail`) and a list of `checks`. Each check has an `id`, a `status`, a `detail` and sometimes a `fix`.

## Read it to the user, in their language

Lead with the one check that explains their problem. Then list anything else that is `warn` or `fail`. Skip the `ok` lines unless they asked for everything. Pass each `fix` on as the user's action, never yours.

Statuses are `ok`, `warn`, `fail` and `info` (just a fact, nothing wrong). Not every check appears on every system:

| Check | Where | What it means |
|---|---|---|
| `node` | all | show-local needs Node 18 or newer |
| `browser` | all | Which browser opens https links. show-local opens HTML files and pages there |
| `html-association` | Windows | **Most common surprise.** `.html` files are set to open in another program than the https browser, often Edge. Double-clicking an HTML file lands there, but show-local deliberately opens HTML with the https browser. If the user wants double-click to match: Settings → Apps → Default apps → their browser → `.html` |
| `app.pdf` / `app.mp4` / `app.png` | Windows | The default app for those types, which is where show-local's app mode sends them |
| `window-titles` | Windows, Linux | Whether opens can be verified by window title. On Linux it needs `wmctrl` or `xdotool`, and under Wayland only X11 windows are visible |
| `osascript` | macOS | AppleScript verification. It may ask for Automation permission once. `SHOW_LOCAL_NO_OSASCRIPT=1` turns it off: the check then says so (`info`), and every open is reported as "cannot verify" |
| `ports` | all | Free ports in 4400–4499 for local servers |
| `servers` | all | Servers show-local started that are running right now (`info`) |
| `launch-json` | all | Whether this folder has a desktop-app preview config (`info`) |

## Common questions

| The user says | Usually |
|---|---|
| "It opened in Edge, not Chrome" | Check `browser` first. If the https browser is Edge, the user's default browser is Edge, and show-local follows it. The fix is to change the default browser in Settings. Only `.html` files opened by double-click are governed by `html-association` |
| "Nothing opened" | Look at the last `show` result: `error` and `detail` say why nothing was opened (for example `server-not-responding`, `port-busy`, `not-found`). If it says `opened: true` with `verified: false`, the program was started but no matching window appeared in time. Ask the user to check the taskbar, since a window can sit behind another one or still be starting. Do not guess whether it is there |
| "The folder opened, but the file is not selected" | The result had `selected: false`: the file manager window on the folder was seen, but not with the file selected in it. show-local does not try again and never closes the window: the user can click the file. With `selected: null` the selection could not be checked at all: on macOS and Linux it never is; on Windows, Explorer's selection could not be read in time (the evidence says so), or no new Explorer window proved the open; and with `--no-verify` or a 0 ms window timeout nothing is checked. Then do not tell the user whether the file is selected |
| "It says it cannot confirm that it opened" | The result was `verified: null`: the open was attempted, but the check had no way to tell. A window with that title was already open before, so a new one could not be told apart; or the address could be a one-time link (a user name or password, a query string or fragment, or a long or token-like path), so show-local did not fetch it and had no page title to look for; or a local page redirected to such an address (a hosted sign-in, for example), and was opened without fetching it; or a plain address gave no title when fetched (an error, not an HTML page, no `<title>`); or the window timeout (`SHOW_LOCAL_TIMEOUT_MS` or `--timeout`) was 0, so no window was looked for; or the system gives no way to check: files opened in their app on macOS, Linux without `wmctrl`/`xdotool`, Wayland, and macOS without Automation permission or with `SHOW_LOCAL_NO_OSASCRIPT=1`. This is a limitation, not a failure, and the reply never states as a fact that it opened |
| "It says not verified, but I see it" | The result was `verified: false`: no window with the expected title appeared or changed in time. Another window that changed its title meanwhile (a tab's unread counter, a video) does not count. Either the window's title did not contain what was expected (for example a PDF whose own title differs from its file name), or it appeared after the 5 s window. On a slow machine the user can make every check wait longer with the environment variable `SHOW_LOCAL_TIMEOUT_MS` (milliseconds, default 5000), for example in the `env` block of Claude Code's `settings.json`. A value above 5000 also extends the open's overall time budget by the same amount, so the whole wait is used; when a slow server start still cut the watch short, the result's `notes` say so |
| "The page opened, but reloading it fails" | After a headless run (`claude -p`, a subagent, a workflow step, a script, a CI job, an SDK program), this is expected: there Claude serves, opens and checks the page with one command (`oneshot`) that stops the server again before the final reply, because such a session cannot end while one runs. The page stays open, but reloading it needs the server. Asked in an interactive session, the server lives as long as the session. A file whose path was too long for `file:///` and had no 8.3 short name is served too, so its link also works only while the session is open |
| "It opened a script's folder instead of running it" | On purpose. Only known viewable types (documents, images, video, audio, text) open in their app. Programs, scripts, shortcuts and files of unknown type or with no extension are revealed in their folder, never run |
| "The site shows an old version" | The static server sends `no-store`. A dev server's own cache or build is another matter: restart it through `show-serve` |
| "All the ports are busy" or "a server is still running after I closed Claude" | show-local's servers exit on their own within about a second after the process that started them is gone, and `dev-run` takes the dev tool's whole process tree with it. Run `node '${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs' servers`. It lists show-local's static servers and the dev servers it started or opened a page on, even one left behind when a process in a dev server's chain was killed forcibly on its own (a dev tool's child process can outlive it then). If the user wants one gone, that is a change: stop it only when they ask, through the `show-serve` skill (`stop <port>`). A port held by a program show-local did not start is the user's to end (Task Manager, Activity Monitor or `kill`): the `ports` check only counts free ports, and a `port-busy` result names the pid and process name |
