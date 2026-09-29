#!/bin/sh
# show-local one-line install (macOS / Linux / Git Bash):
#   curl -fsSL https://raw.githubusercontent.com/ofeklevy11/show-local/main/install.sh | sh
# Same as typing in Claude Code:  /plugin marketplace add ofeklevy11/show-local
#                                 /plugin install show-local@show-local
# Exits non-zero, with a message, when any step fails, so `... | sh && next` stops there.
set -u
fail() {
  echo "show-local: $1" >&2
  echo "show-local: install failed." >&2
  exit 1
}
if ! command -v claude >/dev/null 2>&1; then
  fail "Claude Code CLI not found. Install it first: https://claude.com/claude-code"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "show-local: warning: Node 18+ not found. The plugin installs, but needs Node to run." >&2
fi
# "add" fails when the marketplace is already there; then refresh it instead.
if ! claude plugin marketplace add ofeklevy11/show-local; then
  claude plugin marketplace update show-local || fail "could not add or update the show-local marketplace (offline, or GitHub unreachable?)."
fi
claude plugin install show-local@show-local || fail "'claude plugin install show-local@show-local' failed."
echo
echo "show-local installed. Open a NEW Claude Code session and say: show me <file, folder or URL>."
