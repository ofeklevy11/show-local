---
name: show
description: Opens a finished result on the user's own computer instead of inside Claude. Pages and HTML reports go to their real default browser, a site that needs http gets a local server, a folder of outputs opens in the file manager with the main file selected, and any other file opens in its default app. It then checks that the window came up before saying so. Use when the user wants to see something locally, for example "show me", "open it", "open it in my browser", "let me see it", "open the folder", "show it locally", "תציג לי", "תפתח לי", "תראה לי בדפדפן", "תציג לוקאלית", "תפתח את התיקייה" or "/show-local" (the slash command itself is /show-local:show). Also use it on your own initiative, once, when a deliverable made for the user to look at is finished, such as a report, a page, a rendered video or a folder of generated files. Never use it for intermediate files or test pages.
---

# show: open it on the user's computer, then prove it opened

The user wants to see the result where they normally look at things: their own default browser, their file manager, their video player. They do not want a preview inside Claude. One script does the mechanical work (detect, open, verify). Your job is to choose what to open and to report exactly what happened.

## The script

The script is `${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs`. If a command with that path fails because the file does not exist, use `<Base directory for this skill>/../../scripts/show.mjs` instead (the base directory is printed above these instructions). Write the full path in every command, because shell variables do not survive between tool calls.

It needs Node 18 or newer. If the shell answers that `node` is not found, nothing in this plugin can run, not even `show-doctor`: tell the user to install Node 18 or newer (https://nodejs.org) and open a new session.

Run the commands with the **Bash** tool, from the session's working folder (no `cd`). Wrap each path in **single quotes**. On Windows, use forward slashes (`'C:/Users/...'`).

**A path with an awkward character.** Claude Code refuses a Bash command whose arguments hold `;`, `&` or `|` (even inside quotes), and it treats `'\''` and `$'…'` as obfuscation. So when a path holds any of `'` `"` `;` `&` `|` `$` `` ` `` (or, on macOS and Linux, a backslash), do not escape it: pass it as a `file:///` URL. In that URL, percent-encode those characters and the ones URL syntax needs: `'` is `%27`, `"` `%22`, `;` `%3B`, `&` `%26`, `|` `%7C`, `$` `%24`, `` ` `` `%60`, `\` `%5C`, `%` `%25`, `#` `%23`, `?` `%3F`, and a space `%20`. For example `C:/work/R&D/Mom's report.html` is passed as `'file:///C:/work/R%26D/Mom%27s%20report.html'`. Letters in any language stay as they are. The script reads a `file:///` URL anywhere it takes a path (the target, `--select`, `--cwd`), and the `next.*` commands it prints already use this form where needed, so run them exactly as printed. Never write a helper script to get around a refused command.

The `next.*` commands the script prints are for the Bash tool (POSIX single quotes). In PowerShell, quote with single quotes and double any apostrophe, as in `'C:/work/Mom''s report'`. PowerShell also reads the curly quotes ‘ ’ ‚ ‛ as apostrophes, so double those too. If you only have PowerShell, re-quote every path of a `next.*` command that way instead of pasting it as it is.

## Headless or not: decide first

A run is **headless** when nobody can answer after your final reply: your own instructions say you are a subagent or a workflow step, or that you run in print mode (`claude -p`) or in the Claude Agent SDK (a script, a CI job), or you have no tool at all for asking the user a question. This comes first: a subagent or a workflow step is headless even when `preview_start` is among its tools. Otherwise, with `preview_start` among your tools you are in the desktop app, and an interactive terminal session is not headless either.

A headless session cannot end while a server it started is still running, so its caller would hang. That is why a headless run passes `--headless` in step 1: a page that needs a server then comes with one command that serves it, opens it, verifies it and stops the server again (step 2).

## What to open

- **The deliverable itself.** Open the report, page, video or folder the user will actually look at. Never open scratch files, logs, test harnesses or the intermediate steps that produced it.
- **One main thing:** open that file (or URL).
- **Several outputs that belong together** (renders, exports, a batch of images): open the folder **with `--folder`**, so it is shown in the file manager even when it also holds an `index.html` or a `package.json`. Pass `--select` if you know which file matters most; it must be a file inside that folder. Otherwise the script highlights HTML first, then video, PDF, images and audio, newest first within each type.
- **"Open the folder" means the folder.** When the user asks for a folder, pass `--folder`. Then even a web project is shown in the file manager, not run.
- **A site or web app the user wants to see running:** open its folder, its entry HTML file, or its URL, and the script works out whether it needs a server.

## Step 1: one command

```bash
node '${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs' '<path or URL>' [--select '<file in the folder>'] [--folder] [--desktop | --headless]
```

Pass `--headless` in a headless run, and then never `--desktop`. Otherwise pass `--desktop` **only if `preview_start` is among your tools** (the Claude desktop app's browser tools, such as `mcp__Claude_Browser__preview_start`). It makes the script write the preview entry that `preview_start` needs into `./.claude/launch.json`, in the same call. If you do not see the tool, you are in the terminal: leave the flag out, and do not go searching for it.

Read the JSON it prints:

| `mode` | What the script already did |
|---|---|
| `url` | Opened the address in the default browser (the one that opens https links). A plain remote address (no user name or password, query string or fragment, and no long or token-like path segment) was fetched once first, only to read its page title for the window check. Any other remote address could be a one-time link (sign-in, password reset, invitation), so it is never fetched: its title stays unknown, and the result is `verified: null`. So is a plain page whose title could not be read (an error, not HTML, no `<title>`), and a local page that redirects to such an address (a hosted sign-in): it is opened, but that address is not fetched |
| `file` | Opened the HTML file in that same browser as `file:///`. This works even when `.html` files are associated with a different program. On Windows, a path too long for `file:///` (past about 256 characters) is opened through its 8.3 short form: the result then has `shortPath: true`, and its `url` uses the short form |
| `folder` | Opened the file manager on the folder, with the main file selected. Everything that is not a known viewable type comes here and is revealed, never run: programs, scripts, shortcuts, files of unknown type or with no extension, and `.app` bundles (only a folder whose name ends in `.app` counts as a bundle) |
| `app` | Opened the file with its default app. Only known viewable types get here: documents such as PDF, images, video, audio and text |
| `serve` / `dev` with `"alreadyRunning": true` | The server was already up, so the page has been opened. Go to step 4 (you did not start this one now) |
| `serve` / `dev` with `"action": "start-server"` | Nothing opened yet. The page needs http: go to step 2. An HTML file whose path is too long for `file:///` and has no 8.3 short form is served too, and `reasons` says so |

## Step 2: only when `action` is `start-server`

The JSON has `server` (name, port, url) and `next`, with exact Bash commands, ready to run. For `dev` it also has a `caution`: starting a dev server runs the project's own code. Do that only when the user wants the site or app running. If they only asked to open the folder, run step 1 again with `--folder`.

**Headless run (the plan has `headless: true`, and `next` holds only `oneshot`):**
1. Run `next.oneshot` with Bash, in the foreground: no `run_in_background`, and keep the default timeout. It starts the server (a dev project's through `dev-run`), opens and verifies the page exactly like `next.then` would, keeps serving for a few seconds (`lingerMs`), stops the server, and prints the open result with `server: { stopped: true, port, lingerMs }`.
2. Reply (step 4) from that result: the link, the proof, and, with `server.stopped: true`, that you stopped the server. Nothing was left in the background, so there is nothing else to stop and no background task to wait for.

If the run is headless but the plan has no `headless: true` (you left out `--headless`), start nothing: run step 1 again with `--headless`. If `server.stopped` is not `true`, never say that you stopped the server, and kill nothing yourself: when `server.note` says a server that was already running was used and left running, say that; otherwise say in the reply that the server on port `<port>` could not be confirmed stopped (in Hebrew: "לא הצלחתי לוודא שהשרת בפורט `<port>` נעצר").

**Desktop app (you have `preview_start`, and the run is not headless):**
1. Check `launchJson.ok`. If it is `false`, the project's `launch.json` is not strict JSON and was left untouched: use the terminal steps below instead.
2. Call `preview_start` with `name` set to `server.name`. Check that the `name` and `port` it returns are `server.name` and `server.port`. `preview_start` reads `.claude/launch.json` from the folder the session started in, and with an unknown name it can start a different entry. On a mismatch, `preview_stop` what it started and use the terminal steps below.
3. Run `next.then` with Bash. It waits for the server, opens the page in the user's browser, and verifies the window. For a static server it also finds the browser's own request in show-local's server log. A dev server keeps whatever it logs in its own output, which show-local cannot read, so a dev page is proved by the HTTP answer and the window title only.
4. `preview_start` also opened a tab in Claude's own browser pane. Close it with `tabs_close` on the tab id it returned. The server keeps running (tested), and the user sees the page in their own browser, not in the pane.

**Terminal (no `preview_start`, not headless):**
1. Run `next.start` with Bash and `run_in_background: true`.
2. Run `next.then`.

Then go on to step 4. The server lives as long as this session: it checks about once a second that the process that started it is still there, and exits when it is gone. Never start it any other way, and never leave a persistent background daemon behind.

Other results in this step:
- `"error": "dev-port-unknown"`: the dev script and the project's config do not say which port it uses. Start it with `next.start` in the background (Bash `run_in_background`, in either app), read the address it prints, then run the command at the end of `next.then`, with `'<that address>'` replaced by that address (keep its `--dev-root`, which lets `servers` and `stop` find the server later). In a headless run, start nothing: tell the user that the port is not named (the `detail`; when the script names several, `candidates` lists them), so the site cannot be served and checked in a run nobody can answer, and that naming it in the project (for example `--port 5173` in the dev script) fixes that.
- `"error": "port-busy"`: something already answers on the project's port, but it could not be tied to this project, so nothing was opened. If you started that server yourself in this session, open its URL directly. Otherwise tell the user what holds the port: `owner` gives only its pid and process name (never its command line, which can hold secrets).

### Servers you start are yours to stop

- `node '${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs' servers` lists the servers show-local knows (port, folder, pid, kind): its static servers, the dev servers it started through `dev-run`, and each dev server whose page opened with a `registered` field in the result. `node '${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs' stop <port>` stops one. A dev server that is not listed (`notes` says it was not recorded) is stopped the way it was started: its background task, or `preview_stop` in the desktop app.
- Stop each server you started when the user says they are done with it. Until then it keeps running for this session. A headless run leaves none running: `next.oneshot` stops its own.
- A dev server is the project's own tool, and it often runs the real server in a child process (npm starts Vite or Next). `dev-run` ends that whole process tree when it stops, when it is killed, and when the process that started it is gone. Only a process in the middle of that chain that is killed forcibly on its own can leave a child running that keeps its port. If `servers` lists it, `stop <port>` ends it. If not, kill nothing yourself: tell the user which port is held and by what (the pid and process name from a `port-busy` result).

More on servers is in the `show-serve` skill.

## Step 3: Headless runs only, nothing left running

Skip this step if the run is not headless. Before your final reply, nothing you started may still run, because a headless session cannot end while a server is alive, and its caller hangs. `next.oneshot` has already stopped its own server, and its `server.stopped` says whether that was confirmed (step 2): do not stop it twice. If you started a server any other way in this session (for example in the background, before you knew the run was headless):

1. Run `node '${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs' stop <port>` (the port of its URL) for it.
2. Read the result: `stopped` lists what ended. A port under `refused` is still running: end the background task you started it with. A port under `notFound` has no live entry in show-local's records: its server either ended already or was never recorded (for example a dev server without `registered`). Check the background task you started it with: if that task has already ended, nothing you started holds the port, so do not call it held; if it still runs, end it. If a server you started still runs after that, kill nothing else, and name its port as still held in your reply.

## Step 4: tell the user, in their language

Answer in the language the user wrote their request in: an English request gets an English reply, a Hebrew one a Hebrew reply. The Hebrew phrases in this file are only the wording to use when the user writes Hebrew; never let them switch an English reply to Hebrew.

Two lines, not a bulleted list:
1. What opened, where (`openedWith`), and the **full path or URL as a clickable Markdown link**.
2. The proof, taken from `evidence`, and the time (`ms`). In served mode, add that the server runs while this session is open. After `next.oneshot` with `server.stopped: true`, say instead that you stopped the server, because a headless session cannot end while a server runs (in Hebrew: "עצרתי את השרת, כי סשן בלי ממשק לא יכול להסתיים כשהוא רץ"). With any other `server.stopped`, say what step 2 says instead.

**The link, in every mode and every row below.** Never give only the file name, and never shorten the path with `...` or `…`, however long it is: the user must be able to find the result again and reopen it. The link text is the full path (`target` in the JSON) or the full URL, in backticks so that backslashes show as they are. If the path itself holds a backtick, wrap it in double backticks with a space inside each end (``` `` C:\a`b.html `` ```), so the name shows whole. The link target is `url` when the JSON has one (pages and HTML files). For a folder or a file opened in its app, turn the full path into a `file:///` URL yourself: forward slashes, and `%20` for a space (`%23` for `#`, `%25` for `%`, `%3F` for `?`). For example [`C:\out\my renders`](file:///C:/out/my%20renders) or [`/home/dana/report.pdf`](file:///home/dana/report.pdf).

**Long paths.** With `shortPath: true`, the link text is still `target`, the real full path, never the 8.3 short form with `~1` in it. The link target stays `url`, the short form, because that is the one that opens. Such a page is a plain file opened as `file:///`: it keeps working after this session ends, so never say it depends on the session. Only when the mode is `serve` and `reasons` says the file was served because its path is too long for `file:///` (no short form existed), add that the link works only while this session is open (in Hebrew: "הקישור עובד רק כל עוד הסשן הזה פתוח, כי הנתיב ארוך מדי לפתיחה כקובץ"). After `next.oneshot`, say that reopening the page needs it served again.

Read `ok` first. A result with `ok: false` also carries `verified: false`, but nothing was opened: use the first row. The other rows are for `opened: true`. Only `verified: true` lets you write "opened" (in Hebrew "פתחתי") as a fact.

| Result | Say |
|---|---|
| `ok: false` (an `error`, nothing opened) | "I did not open `<link>`: `<detail>`." In Hebrew: "לא פתחתי את `<link>`: `<detail>`" |
| `verified: true` | It opened, plus the proof. `verified: true` always rests on real evidence: a window whose title contains the expected page, file or folder name appeared or changed after the open, or the browser's own `GET` reached show-local's server log after the open |
| `verified: null` | "I tried to open `<link>` with `<openedWith>`, but I cannot confirm that it opened: `<reason>`." In Hebrew: "ניסיתי לפתוח את `<link>` ב-`<openedWith>`, אבל אין לי דרך לאשר שזה נפתח: `<reason>`". The reason is in `evidence`: for example a window with that title was already open before, so a new one cannot be told apart; a remote address show-local does not fetch (it has a query string or a token-like path), or a local page that redirects to one (a hosted sign-in), so there is no page title to look for; a window timeout of 0 ms, so no window was looked for; an app on macOS; Linux without `wmctrl`. It is a limit of the check, not a failure. **Never write "opened" or "פתחתי" as a fact here** |
| `verified: false` | "I tried to open `<link>` but could not verify it: `<reason>`." In Hebrew: "ניסיתי לפתוח את `<link>` ולא הצלחתי לאמת: `<reason>`". The expected window did not show up in time; another window that changed its title does not count. **Never write "opened" or "פתחתי" here.** Suggest a look at the taskbar, then the `show-doctor` skill, as things to check |

**Never guess the outcome.** When `verified` is not `true`, say what was tried and that it could not be confirmed, with the reason, and nothing more about whether it opened. No likelihood and no odds, in either direction, and no conditional guess either: never "probably", "likely", "most likely", "there is a good chance", "it should be there" or "if Chrome opened, the page is probably there", and in Hebrew never "כנראה", "סביר ש", "יש סיכוי", "הסיכוי גבוה", "נראה ש" or "אם הדפדפן נפתח, הדף שם". The next step is an instruction, not a guess: "check the taskbar; if the window is not there, the `show-doctor` skill can find out why" (in Hebrew: "אפשר להציץ בשורת המשימות, ואם אין שם חלון כזה, הסקיל `show-doctor` יבדוק למה"), word for word as in the last example below.

**A folder with a file to select.** A folder result that asked to select a file has `selected`. `true`: the file was seen selected. `false`: the folder window was seen (so the result can still be `verified: true`), but the file was not selected in it: say so, for example "I opened the folder, but `<file>` is not selected in it" (in Hebrew: "פתחתי את התיקייה, אבל הקובץ `<file>` לא סומן בה"). `null`: the selection could not be checked, so do not say that the file is selected.

A page that reloads itself (live reload, a refresh tag, polling) and is already open in a tab can put its own request in the server log. When the only proof of such a page is the server log, say that the window itself was not seen.

Examples:

> Opened the cuts review in Chrome: [`C:\work\cuts-review.html`](file:///C:/work/cuts-review.html)
> ✓ Chrome showed "Cuts review · lesson 12" (window title), 1.8 s

> פתחתי לך בכרום את האתר: [`http://127.0.0.1:4400/`](http://127.0.0.1:4400/)
> ✓ השרת החזיר 200, הכרום ביקש את הדף (יומן השרת: `GET / 200`), וכותרת החלון "Lesson 05". השרת חי כל עוד הסשן הזה פתוח.

After `next.oneshot` with `server.stopped: true`, that last sentence becomes: "עצרתי את השרת, כי סשן בלי ממשק לא יכול להסתיים כשהוא רץ. הדף נשאר פתוח, אבל כדי לרענן אותו צריך להגיש אותו שוב."

> Opened the report in Chrome: [`C:\Users\dana\AppData\Local\Temp\claude\session-files\reports\weekly-summary\weekly-report-2026-09-29.html`](file:///C:/Users/dana/AppData/Local/Temp/claude/SESSIO~1/reports/WEEKLY~1/WEEKLY~1.HTM)
> ✓ Chrome showed "Weekly report" (window title), 2.1 s. The path is too long for `file:///`, so it opened through its short form; it is still a plain file.

> פתחתי את התיקייה בסייר הקבצים: [`C:\out\renders`](file:///C:/out/renders), אבל הקובץ `final.mp4` לא סומן בה.
> ✓ חלון סייר על התיקייה הזאת הופיע אחרי הפתיחה, 1.2 שניות.

> ניסיתי לפתוח את התיקייה בסייר הקבצים: [`C:\out\renders`](file:///C:/out/renders), אבל אין לי דרך לאשר שהיא נפתחה.
> חלון סייר על התיקייה הזאת כבר היה פתוח לפני כן, ולכן אי אפשר להבחין בחלון חדש.

> ניסיתי לפתוח בכרום את [`https://app.example.com/invite?code=7f3k9q`](https://app.example.com/invite?code=7f3k9q), אבל אין לי דרך לאשר שזה נפתח.
> כתובת עם פרמטרים עלולה להיות קישור חד-פעמי, ולכן לא טענתי אותה מראש, ואין כותרת דף לחפש בחלונות.

> ניסיתי לפתוח את [`C:\out\report.pdf`](file:///C:/out/report.pdf) ולא הצלחתי לאמת: לא הופיע חלון עם שם הקובץ תוך 5 שניות.
> אפשר להציץ בשורת המשימות, ואם אין שם חלון כזה, הסקיל `show-doctor` יבדוק למה.

## Opening on your own initiative

Do it **once per deliverable version**, at the end of the task, when the thing was made for the user's eyes. Never do it for intermediate files, test pages or drafts you are still changing. Never reopen the same unchanged result. If the user is working remotely (for example from a phone), the window still opens on the computer. Always include the full path or URL as a link in your reply too.

## Rules

- **Only open.** Never close the user's windows or tabs, and never change default apps, file associations or browser settings. If something opens in the wrong program, explain it (`show-doctor`) and do not "fix" it.
- **Never run what you were asked to show.** Only known viewable types open in their app. Programs, scripts, shortcuts and files of unknown type are revealed in their folder. A dev server starts only when the user wants the site running.
- **Open what exists.** Do not build a special preview page just to have something to show.
- **Local only.** Nothing gets uploaded or published. Network paths (`\\server\share`) are refused.
