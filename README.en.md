# show-local

**Say "show me" and the result opens on your own computer: in your default browser, your file manager or your video player, not in a preview pane inside Claude. And Claude checks that it actually opened before it says so.**

A plugin for Claude Code, both the desktop app and the terminal. Install it once and it works by itself.

[README בעברית](README.md)

## Install

Inside Claude Code:

```
/plugin marketplace add ofeklevy11/show-local
/plugin install show-local@show-local
```

Or in one line from a terminal:

```bash
claude plugin marketplace add ofeklevy11/show-local && claude plugin install show-local@show-local
```

<details><summary>Install script (Windows / macOS / Linux)</summary>

```powershell
irm https://raw.githubusercontent.com/ofeklevy11/show-local/main/install.ps1 | iex
```
```bash
curl -fsSL https://raw.githubusercontent.com/ofeklevy11/show-local/main/install.sh | sh
```

If a step fails, the script says which one and ends with an error (a non-zero exit code), so nothing reports success by mistake.
</details>

Open a **new session** and the plugin is active.

**Requirements:** Node 18 or newer, reachable as `node` (check with `node --version`). The native Claude Code installer does not install Node, so you may need to install it yourself from [nodejs.org](https://nodejs.org). Without it nothing in the plugin runs, not even `show-doctor`. There are no other dependencies.

**Tested on:** Windows 11, end to end through Claude Code itself, with real windows ([release report](RELEASE-REPORT.html), in Hebrew, or [view it rendered](https://htmlpreview.github.io/?https://github.com/ofeklevy11/show-local/blob/main/RELEASE-REPORT.html)). **macOS and Linux are beta.** Their code is covered by unit tests, and every change runs the basic scenarios on GitHub's macOS and Ubuntu machines: on macOS with the real `open` and Finder (an HTML page, a PDF, a folder with its main file selected, and a `.command` script, an `.app`, a Finder alias and a link named `.pdf` that must be revealed and never run, each next to a control that shows the same file does run when opened directly); on Ubuntu, what reaches `xdg-open`. They have not yet been used day to day on a Mac or a Linux desktop, so reports are welcome.

## Use

Say it in your own words:

- "show me the report"
- "open the site in my browser"
- "open the folder with the files"
- "let me see the video"
- Hebrew works too: "תציג לי", "תפתח לי בדפדפן", "תפתח את התיקייה"

Or type the command: `/show-local:show <file, folder or URL>`.

Every reply gives the full path or URL as a clickable link, so you can always find the result again.

Claude also opens a result by itself, once, when it finishes something made for you to look at (a report, a page, a video, a folder of outputs). It never does this for intermediate files or test pages.

<details><summary>Optional: a bare <code>/show-local</code> command</summary>

Claude Code names a plugin's commands and skills `/<plugin>:<name>`, so the plugin itself provides `/show-local:show` and cannot register a bare `/show-local`. If you want to type just `/show-local`, add a personal command of your own. It is optional, and it only hands the request to the plugin's `show` skill. Save this as `~/.claude/commands/show-local.md` (on Windows `%USERPROFILE%\.claude\commands\show-local.md`), with exactly this content:

```markdown
---
description: Open a file, folder or URL on this computer with show-local, and verify that it opened
argument-hint: <file, folder or URL>
---

Use the `show-local:show` skill (from the show-local plugin) to open this on the user's own computer and verify that it opened: $ARGUMENTS

If nothing was named, open the last deliverable made in this session that was meant for the user to look at.
```

Claude Code then lists a personal `show-local` next to the plugin's `show-local:show`. That entry is this file, not a second copy of the plugin. To remove it, delete the file.
</details>

## What opens where

| What there is to show | What happens |
|---|---|
| An http/https address | Opens in your default browser. A plain address has its page title read first, for the check; an address that could be a one-time link is never fetched, and neither is one that leads to this computer or your local network |
| An HTML file | Opens in that same browser, even if `.html` files are associated with another program. On Windows, a path too long for `file:///` (past about 256 characters) opens through its 8.3 short name, so the link keeps working after the session. Only when Windows has no short name for it is it served instead, and then the link works only while the session is open |
| HTML that needs a server (ES modules, `fetch`, JSON or another local data file, in the page or in the local scripts it loads), or a folder with `index.html` | A local server on `127.0.0.1` (the first free port from 4400), then the browser |
| A project with `npm run dev` | The project's own dev server (a local https one with a self-signed certificate works too), then the browser. It is started only when you want the site running |
| A folder of outputs | Your file manager (Explorer, Finder or the Linux file manager), with the main file selected |
| A PDF or other document (`.docx`, `.xlsx`, `.pptx`, `.epub`, `.xps`), an image, a video, audio, text | Its default app |
| A program, script, shortcut, a file of unknown type or with no extension, a macOS `.app`, a document that can carry macros (`.doc`, `.xls`, `.ppt`, macro-enabled Office files, OpenDocument, `.rtf`) | Shown selected in your file manager. It is never run |

**On Linux**, pages and HTML files open with the default browser's own command: the `Exec` line of its `.desktop` file, the one `xdg-settings` names. Folders open through the file manager's D-Bus interface, `org.freedesktop.FileManager1` (called with `gdbus`), which can select the main file. `xdg-open` is the fallback for both, and it opens everything else. So an HTML file lands in your browser even when `.html` is associated with another program.

## How it knows it opened

Claude does not write "opened" without proof:

- **Windows:** titles of the open windows. For example, a Chrome window with the page's title appeared or changed after opening. Another window that merely changed its title meanwhile does not count. Folders are checked through the list of Explorer windows, including which file is selected: when the folder opened but the main file is not selected in it, the reply says so.
- **Pages served from show-local's own static server:** also the browser's own `GET` in the server log.
- **A project's dev server:** the HTTP answer and the window title only. A dev server keeps whatever it logs in its own output, which show-local cannot read, so there is no server-log line for it.
- **macOS:** AppleScript. The first time, macOS may ask for Automation permission for your browser and Finder.
- **Linux:** `wmctrl` or `xdotool`, if installed. Pure Wayland does not expose window titles.

The check waits up to 5 seconds for the window. On a slow machine, set the environment variable `SHOW_LOCAL_TIMEOUT_MS` (in milliseconds) to make it wait longer. A value above 5000 also extends the open's overall time limit by the same amount, so the whole wait is used. With `0` no window is looked for at all: only the server log of show-local's static server can still prove the open, and otherwise the reply says it cannot be confirmed.

"Opened" is said only on real proof. When the check ran and the window did not show up, the reply says so explicitly ("I tried to open it but could not verify it"), with the reason. When there is no way to check, the reply says "I tried to open it, but I cannot confirm that it opened", with the reason: for example, a window with the same title was already open before, so a new one cannot be told apart. Neither reply guesses: no "probably", no odds. On some systems that is the normal answer, because the system offers no way to check:

- **macOS:** a file opened in its app (PDF, video, image), and anything when AppleScript is not allowed or `SHOW_LOCAL_NO_OSASCRIPT=1` is set.
- **Linux:** anything when neither `wmctrl` nor `xdotool` is installed, and under Wayland anything that show-local's static server does not serve (a dev server's page included).

A remote page is never fetched before it opens if its address could be a one-time link (sign-in, password reset, invitation): an address with a user name or password, a query string (`?…`) or a fragment (`#…`), or with a path segment that is long or looks like a token. The fetch would use such a link up. Its title is then unknown, so on every system the reply says the open cannot be confirmed. A plain address, such as `https://example.com/docs`, is requested once before opening, only to read its title for the window check. That request comes from show-local, not from your browser, so it carries none of your cookies or sign-ins. If it yields no title (an error, a file rather than a page, a redirect to an address that could be a one-time link), the reply says the open cannot be confirmed. The same goes for a local page, such as a dev server's, that redirects to an address that could be a one-time link (an outside sign-in service's page): the page opens, that address is not fetched, and the reply says the open cannot be confirmed.

These requests never reach this computer or your local network on a remote site's word. The check is made on the address a name actually resolves to, as the connection is made, so a remote address or a redirect from one that leads to a loopback, private, link-local or cloud-metadata address (`127.0.0.1` under any name, `[::ffff:127.0.0.1]`, `192.168.x.x`, `10.x.x.x`, `169.254.169.254`) is not fetched. The page still opens, and the reply says the open cannot be confirmed. A title read from a page or a window reaches Claude cut to 120 characters, without control or invisible characters, and the skills tell Claude it is text from the page, never instructions.

**Known limitation:** a page that reloads itself (live reload, a refresh tag, polling) and is already open in a tab can put its own `GET` in the server log. Then the server-log proof may come from that tab, not from the one just opened.

## Desktop app vs terminal

The local server lives as long as the session:

| | Desktop app | Terminal | Headless run |
|---|---|---|---|
| Starting the server | An entry in the project's `.claude/launch.json` (merged in; nothing else in the file is touched), then `preview_start`. The entry runs `node`, never `cmd.exe` or `npm.cmd` | A Claude background task (`run_in_background`) | Nothing in the background: `oneshot`, one foreground command, serves the page, opens and verifies it, keeps serving for 3 seconds, then stops the server |
| Claude's preview pane | Closed as soon as the page is up in your browser. The server keeps running | None | None |

A headless run is one that nobody can answer after the final reply: `claude -p`, a script, a CI job, an SDK program, a subagent or a workflow step. Such a session could not end while a server runs, so Claude passes `--headless` there (a subagent or workflow step inherits the desktop app's environment, so the flag is what tells show-local), and its reply says that it stopped the server, but only once show-local confirmed that the port is free again; otherwise the reply names the port. The page stays open, but reloading it needs the server again.

A static server gets the first free port from 4400, and a folder keeps its port while its server is running or its entry is in `.claude/launch.json`.

Both kinds of server watch the process that started them: `node show.mjs serve` and `node show.mjs dev-run` check about once a second whether it is still alive, and exit when it is gone, so a session that is closed or killed leaves no server behind. `dev-run` is how show-local runs a project's dev server. It starts `npm`, `pnpm`, `yarn` or `bun run dev` inside the project folder, so the path is never on a command line (a folder name with `&` or `%` in it is safe), records the server for `servers`, and ends the dev tool's whole process tree (npm and the Vite or Next it starts) when it stops.

Claude stops the servers it started when you say you are done with them. `node show.mjs servers` lists the servers show-local knows (its static servers, and the dev servers it started or opened a page on), and `node show.mjs stop <port>` stops one.

**Known limitation:** the dev server itself is the project's own tool, and it often runs the real server in a child process (npm starts Vite or Next). show-local ends that whole tree when `dev-run` stops, when it is killed, and when the session that started it is gone. Only a process in the middle of that chain that is killed forcibly on its own (`kill -9`, or ending that one process in Task Manager) can leave a child running that holds the port. A process that show-local no longer tracks is yours to end (Task Manager, Activity Monitor or `kill`).

## Three skills

| Skill | Command | When |
|---|---|---|
| `show` | `/show-local:show` | Open something and prove it opened. This is the main one |
| `show-serve` | `/show-local:show-serve` | Run a site or project locally, list the running servers, stop them |
| `show-doctor` | `/show-local:show-doctor` | When something opened in the wrong program, or not at all |

Everything runs through one dependency-free script, `scripts/show.mjs`, which you can also run by hand:

```bash
node show.mjs <path|url>                            # open and verify
node show.mjs plan <path|url> [--desktop|--headless] # what would happen; opens nothing, but --desktop adds or updates the launch.json entry
node show.mjs oneshot <path|url>                    # headless: serve, open, verify, then stop the server
node show.mjs serve <folder>                        # static server on 127.0.0.1
node show.mjs dev-run <project> --port <port>       # the project's dev server, ended with its whole process tree
node show.mjs servers                               # running servers (static and dev)
node show.mjs stop <port|all>                       # stop them
node show.mjs doctor                                # environment check
```

## Security

- show-local's static server listens on `127.0.0.1` only, so no other device on the network can see it. A project's dev server listens wherever the project configures it (`vite --host`, for example, opens it to the network): show-local does not force `127.0.0.1` on it.
- It serves only the chosen folder. A backslash counts as a path separator, like `/`. Then `..` (also encoded, such as `%2e%2e`), drive letters, alternate data streams and symlinks that lead outside the folder are refused, and so are dotfiles such as `.env` and `.git`, also through their Windows short names (`ENV~1`).
- It never lists a folder's contents.
- The `Host` header must name this machine, which blocks DNS rebinding.
- It never runs what it shows: only known viewable types open in their app, and everything else is revealed in its folder, including documents that can carry macros (`.doc`, `.xls`, `.ppt`, `.rtf`, OpenDocument, macro-enabled Office files), a link or a Finder alias that leads to something else, and a macOS package. `--select` must name a file inside the folder.
- Its own requests (the title of a remote page, the readiness check of a local one) never reach this computer or your local network on a remote site's word: the address a name resolves to is checked as the connection is made.
- Windows programs it starts (PowerShell, `reg`, `netstat`, Explorer, `cmd.exe`, `taskkill`) run by their full path in the Windows folder, and macOS ones by their fixed system path, so a file with the same name in the project folder never runs instead.
- Page and window titles reach Claude cut to 120 characters, without control or invisible characters, and the skills tell Claude they are data, never instructions.
- When a port is taken by a process it cannot tie to your project, it reports only that process's pid and name, never its command line, which can hold secrets.
- Programs that show-local starts itself get paths and URLs as separate arguments or environment variables, never through a shell. The one fixed command line is `dev-run` on Windows, where `npm`, `pnpm` and `yarn` are `.cmd` scripts that only `cmd.exe` runs: it runs `<runner> run dev` there with the project folder as its working folder, so no path is part of it. The follow-up commands it prints for Claude (`next.start`, `next.then`, `next.oneshot`) are shell strings for Claude's Bash tool, with every path in POSIX single quotes. In PowerShell they must be re-quoted: single quotes, with any apostrophe doubled.
- The plugin changes no settings: not your default browser, not file associations, not browser settings. It only opens.

Details in [SECURITY.md](SECURITY.md).

## Troubleshooting

| What happened | What to do |
|---|---|
| **Double-clicking an HTML file opens Edge, but show-local opens Chrome** | That is on purpose. On Windows, `.html` files can be associated with a different program from the one that opens links. show-local follows the links' browser. To make double-click match: Settings → Apps → Default apps → Chrome → `.html` |
| "Nothing opened" | Ask Claude "why didn't it open" and the `show-doctor` skill will check. Sometimes the window opened behind another one, so it is worth a look at the taskbar |
| `node` is not found | Install Node 18 or newer from [nodejs.org](https://nodejs.org), then open a new session |
| It showed a script or program in its folder instead of running it | That is on purpose: show-local never runs what it was asked to show |
| "Could not verify" on Linux | Install `wmctrl` (`sudo apt install wmctrl`). Pure Wayland cannot verify window titles, but pages from show-local's static server are still verified through the server log |
| A dev server does not come up | Read its output. Usually `npm install` is missing or the build fails |
| A dev server is still running after the session closed | show-local's servers exit on their own about a second after the session that started them ends. If `node show.mjs servers` still lists one, `node show.mjs stop <port>` stops it. Otherwise close it where it runs |
| A path with `;`, `&`, `\|`, `'`, `"`, `$` or a backtick | Claude Code's Bash tool refuses a command with such characters in it, even inside quotes. show-local takes the path as a percent-encoded `file:///` URL instead (`R&D` becomes `R%26D`), and the skill tells Claude to pass it that way. Only when the plugin's own install path has an apostrophe does Claude Code ask you to approve each command |
| All ports 4400–4499 are taken | `node show.mjs servers` shows which of them are show-local's. Stop the ones you no longer need with `node show.mjs stop <port>`, or all of them with `node show.mjs stop all`. `node show.mjs doctor` counts the free ports. A port held by another program is freed only by closing that program |

## Why a skill and not a hook

A hook knows **when** something happened, for example that a file was written or a turn ended. It does not know **what** you should see: a test page or the final result. A hook on file writes also misses files that scripts create (ffmpeg, a build), and a hook on words fires on "show the plan" too. A skill knows what was built. The consistency a hook would give comes from the script instead: all the mechanical work runs in one command, identical every time.

## Uninstall

If `node show.mjs servers` still lists a server, stop it first with `node show.mjs stop all`, while the plugin is still installed. Then:

```
/plugin uninstall show-local@show-local
/plugin marketplace remove show-local
```

Uninstalling leaves show-local's state folder behind: the server registry, the access logs and, on Windows, the compiled window helper (`ShowLocalWin-*.dll`). Delete it yourself. On Windows (PowerShell):

```powershell
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$env:TEMP\show-local", "$env:USERPROFILE\.cache\show-local"
```

On macOS and Linux:

```bash
rm -rf "${TMPDIR:-/tmp}/show-local-$(id -u)" ~/.cache/show-local
[ -n "$XDG_RUNTIME_DIR" ] && rm -rf "$XDG_RUNTIME_DIR/show-local-$(id -u)"
```

That is `%TEMP%\show-local` on Windows, `$TMPDIR/show-local-<uid>` on macOS, and on Linux `$XDG_RUNTIME_DIR/show-local-<uid>` when that variable is set, otherwise `show-local-<uid>` in the temp folder. `~/.cache/show-local` is the fallback when that folder cannot be used. A folder in the temp folder named `show-local-` followed by random characters is a last-resort copy of the same state, and it can go too.

If you ran a server in the desktop app, `show-…` entries (one per served folder or dev project) remain in the project's `.claude/launch.json`. You can delete them, and nothing else is affected.

If you added the optional bare `/show-local` command, delete `~/.claude/commands/show-local.md` as well.

## Development

```bash
npm test          # unit tests, no windows, any OS (Node 18.1+)
npm run e2e       # Windows: real Claude, real windows (opens windows on screen)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT license.
