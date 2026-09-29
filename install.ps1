# show-local one-line install (Windows PowerShell):
#   irm https://raw.githubusercontent.com/ofeklevy11/show-local/main/install.ps1 | iex
# Same as typing in Claude Code:  /plugin marketplace add ofeklevy11/show-local
#                                 /plugin install show-local@show-local
# A failed step says so and stops with an error: exit code 1 when run as a file (-File).
# It throws instead of calling exit, because exit under `irm | iex` would close the user's window.
# The script block keeps the helper function out of the user's session.
& {
    function Stop-ShowLocalInstall([string]$Reason) {
        Write-Host "show-local: $Reason" -ForegroundColor Red
        throw 'show-local: install failed.'
    }
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Stop-ShowLocalInstall 'Claude Code CLI not found. Install it first: https://claude.com/claude-code'
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host 'show-local: warning: Node 18+ not found. The plugin installs, but needs Node to run.' -ForegroundColor Yellow
    }
    # "add" fails when the marketplace is already there; then refresh it instead.
    claude plugin marketplace add ofeklevy11/show-local
    if ($LASTEXITCODE -ne 0) {
        claude plugin marketplace update show-local
        if ($LASTEXITCODE -ne 0) { Stop-ShowLocalInstall 'could not add or update the show-local marketplace (offline, or GitHub unreachable?).' }
    }
    claude plugin install show-local@show-local
    if ($LASTEXITCODE -ne 0) { Stop-ShowLocalInstall "'claude plugin install show-local@show-local' failed." }
    Write-Host ''
    Write-Host 'show-local installed. Open a NEW Claude Code session and say: show me <file, folder or URL>.' -ForegroundColor Green
}
