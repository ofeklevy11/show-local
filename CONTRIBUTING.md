# Contributing

Thanks for helping. show-local is small on purpose: one script with no dependencies, and three short skills.

## Layout

```
.claude-plugin/marketplace.json     the repo is its own marketplace
plugins/show-local/
  .claude-plugin/plugin.json
  skills/show/SKILL.md              open + verify (the main skill)
  skills/show-serve/SKILL.md        servers: start, open, list, stop
  skills/show-doctor/SKILL.md       read-only environment diagnosis
  scripts/show.mjs                  the CLI every skill calls
  scripts/lib/*.mjs                 detection, 8.3 short paths, server, dev-run, oneshot, launch.json, browser, orchestration, doctor
  scripts/lib/adapters/*.mjs        per-OS open + verify (win, mac, linux)
  scripts/win/windows.ps1           Windows window watcher (EnumWindows, Shell.Application)
tests/*.test.mjs                    unit tests (node:test), no windows opened
tests/e2e/run-e2e.mjs               Windows end to end through `claude -p`, real windows
```

## Rules

- **System programs by full path.** Start a Windows program through `winProgram()` and a macOS one through `MAC_PROGRAMS` (`lib/util.mjs`), never by a bare name, which Windows looks up in the working folder first. A test fails on a bare name.
- **Text from pages and windows goes through `outputText()`** before it reaches a result: titles, process names, log lines. Claude reads results, and that text is someone else's.
- **Requests to remote addresses are public-only** (`httpRequest(url, { publicOnly: true })`): they never reach this computer or the local network on a remote site's word.
- **No dependencies.** Only `node:` built-ins and Node 18 APIs (the plugin runs on Node 18+; `npm test` needs 18.1+, for `node --test`).
- **No shell strings for what we start.** Programs show-local starts itself get paths, URLs and titles as argument arrays or environment variables, never spliced into a shell string or into PowerShell `-Command` text. The one verbatim command line is Explorer's `/select,"<path>"`, safe because Windows paths cannot contain `"`. The one fixed shell command is `dev-run`'s `cmd.exe /d /s /c "<runner> run dev"` on Windows, which carries no path: the project folder is its working folder.
- **Printed commands are for Bash.** The `next.start` / `next.then` / `next.oneshot` strings handed to the agent quote every path with `cmdPath` (POSIX single quotes; a percent-encoded `file:///` URL for a path with `'`, `"`, `;`, `&`, `|`, `$`, a backtick or a POSIX backslash, because Claude Code's Bash tool refuses `;`, `&` and `|` even inside quotes), URLs with `cmdUrl`, and the script's own path with `cmdScript`. Every command that takes a path must accept the `file:///` form (`toPathArg`). Do not claim they work unchanged in PowerShell: there an apostrophe is doubled instead, and the skills say so.
- **Only open, never run.** Never close user windows, never change default apps or browser settings. App mode is an allow-list of viewable types; anything else is revealed in its folder.
- **Never report success without proof.** A new code path that opens something must return `verified` and `evidence`. The reply templates in the `show` skill say "opened" only when `verified` is true, which always means real proof (a new window with the expected title, or the browser's own GET in the server log); otherwise they say it could not be confirmed, with the reason, and never guess the outcome ("probably", "likely" and their Hebrew counterparts are out).
- **Every reply carries the full path or URL as a clickable link**, never only a file name. A file opened through its 8.3 short name (`shortPath: true`) is still shown by its real full path.
- **Stop what you start.** A server that show-local starts, or opens a page on, must be listed by `servers` and ended by `stop <port>` (a dev server once it is tied to the project folder, never a stranger's process). A `dev-run` or `oneshot` entry names show-local's own process, and is stopped only while the OS confirms that its pid is still that same process: a stale entry (its pid reused by another process) is removed, never stopped. On Windows, never tree-kill a `oneshot` process: the browser it opened the page with can run under it. `serve` and `dev-run` exit when their parent process is gone (tests turn that off with `--no-parent-watch`). A headless run uses `oneshot`, which stops its own server before it returns; the skills tell Claude to pass `--headless` when it is a subagent or a workflow step, and to stop interactive servers when the user is done.
- Keep each `SKILL.md` under 250 lines with a description under 1024 characters. Trigger phrases must be unique across skills: no skill's phrase may equal another's or appear inside it. The tests check the length limits and exact duplicates; check containment yourself when you add a phrase.
- Keep `README.md` (Hebrew) and `README.en.md` saying the same things: the same commands, links and table rows (a test compares them).

## Tests

```bash
npm test                 # all unit tests; runs on Windows, macOS and Linux, Node 18.1+
node tests/run.mjs server   # one file
npm run e2e              # Windows only: needs a logged-in `claude` CLI; opens real windows
```

CI also runs two smoke scripts, which refuse to run outside CI (`CI=true`): `tests/smoke/macos.mjs` (the `smoke-macos` job) runs the basic scenarios on GitHub's macOS runner with the real `open` and Finder, and opens real windows and runs scripts it creates on purpose, to prove that the ones show-local reveals never run. Never run it on your own Mac. `tests/smoke/linux.mjs` (the `smoke-linux` job) records what reaches `xdg-open`, `gdbus` and the browser on Ubuntu.

The e2e runner starts headless Claude sessions with only this plugin loaded, so it uses your Claude plan. `SHOW_LOCAL_TIMEOUT_MS` (how long the window check waits, in milliseconds) is also how a test forces the "could not verify" path: with `SHOW_LOCAL_TIMEOUT_MS=1` the window cannot be seen in time. `SHOW_LOCAL_TIMEOUT_MS=0` is different: no window is looked for at all, so the result is `verified: null` ("cannot confirm"), not `false`. A value above the default 5000 also extends a direct open's 9.6 s budget by the same amount.

## Releasing

Bump the version in `plugins/show-local/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (both places), `package.json` and `CHANGELOG.md`. A test fails if they disagree. Tag the release (`vX.Y.Z`) on the commit CI passed on, and publish a GitHub release for the tag; release tags cannot be moved or deleted once pushed. The workflow's actions are pinned to commit SHAs: take Dependabot's pull requests for them rather than editing the SHAs by hand.

`RELEASE-REPORT.html` at the repository root is the maintainer's record of the release: the measured unit counts, the end-to-end matrix (`npm run e2e` writes `tests/e2e/out/results.json` and `results.md`) and the desktop-app run. The tool that turns those results into the page stays in the maintainer's local release folder and is not part of the repository, so a contribution does not need to touch the report: attach your own `tests/e2e/out/results.md` to the pull request instead. Both READMEs link the report, directly and through an htmlpreview viewer (GitHub shows `.html` files as source). The link test reports it as skipped while the file is missing.
