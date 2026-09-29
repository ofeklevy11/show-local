# show-local window watcher for Windows.
#
# Run by show.mjs, never by hand. All input arrives through environment variables, so no
# path or title is ever spliced into a command line:
#   SHOW_LOCAL_MODE       window | explorer | snapshot
#   SHOW_LOCAL_TOKENS     JSON array of lower-cased title fragments to look for (window mode)
#   SHOW_LOCAL_PROCESSES  JSON array of process names without .exe (optional filter)
#   SHOW_LOCAL_DIR        folder expected in an Explorer window (explorer mode)
#   SHOW_LOCAL_SELECT     file name expected to be selected in it (optional)
#   SHOW_LOCAL_DIR_ALT    the same folder under its 8.3 short spelling (optional)
#   SHOW_LOCAL_SELECT_ALT the same file under its 8.3 short spelling (optional)
#   SHOW_LOCAL_TIMEOUT    milliseconds to wait (default 5000)
#   SHOW_LOCAL_DLL        cache path for the compiled window-enumeration helper
#
# Protocol: prints READY once the "before" snapshot is taken (show.mjs opens the target only
# after that), then prints exactly one JSON line with the result.
#
# Dot-sourcing the file only defines the functions (the tests drive Watch-Window and
# Watch-Explorer that way, with scripted window lists instead of the real desktop).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$src = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ShowLocalWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public class Win { public long Handle; public uint Pid; public string Title; }
  public static List<Win> List() {
    var r = new List<Win>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h);
      if (n == 0) return true;
      var sb = new StringBuilder(n + 1);
      GetWindowText(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      r.Add(new Win { Handle = h.ToInt64(), Pid = pid, Title = sb.ToString() });
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@

function Load-Helper {
  if ('ShowLocalWin' -as [type]) { return }
  $dll = $env:SHOW_LOCAL_DLL
  if ($dll) {
    try {
      if (-not (Test-Path -LiteralPath $dll)) {
        $tmp = "$dll.$PID.tmp"
        Add-Type -TypeDefinition $src -OutputAssembly $tmp -OutputType Library
        try { Move-Item -LiteralPath $tmp -Destination $dll -Force } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
      }
      Add-Type -Path $dll
      return
    } catch { }
  }
  Add-Type -TypeDefinition $src
}

function Norm([string]$s) { if ($null -eq $s) { return '' }; return (($s -replace '\s+', ' ').Trim()).ToLowerInvariant() }
function NormPath([string]$p) { if (-not $p) { return '' }; return $p.TrimEnd('\').ToLowerInvariant() }
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }

$procNames = @{}
function ProcName([uint32]$procId) {
  if (-not $procNames.ContainsKey($procId)) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $procNames[$procId] = if ($p) { $p.ProcessName.ToLowerInvariant() } else { '' }
  }
  return $procNames[$procId]
}

# Title of every window, keyed by handle: the "before" picture window mode compares against.
function Get-TitleSnapshot($windows) {
  $snap = @{}
  foreach ($w in $windows) { $snap[[long]$w.Handle] = [string]$w.Title }
  return $snap
}

function Has-Token([string]$NormTitle, [string[]]$Tokens) {
  foreach ($tok in $Tokens) { if ($NormTitle.Contains($tok)) { return $true } }
  return $false
}

# Pause before the next poll, but never past the deadline: show.mjs budgets the whole open,
# and a full pause after the time is up would only add to it.
function Wait-NextPoll([Diagnostics.Stopwatch]$Sw, [int]$Timeout, [int]$PollMs) {
  $left = [long]$Timeout - $Sw.ElapsedMilliseconds
  if ($left -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min([long]$PollMs, $left)) }
}

# Window mode: wait for a window of the expected program that shows the page. $List returns
# the visible windows (Handle, Pid, Title, topmost first) and $ProcOf gives one window's
# lower-cased process name; both are parameters so the tests can script the desktop.
#
# The only proof is a window that shows the expected title and did not show it before: a new
# window, or one whose title changed to it (a new tab in it). Nothing weaker counts:
#   - no expected title at all: nothing to recognise the page by, so matched:null at once;
#   - a window that already showed the title before the open (unchanged, or a counter in it
#     ticking): the open cannot be told apart from it, so matched:null, never true;
#   - another window changing its title (an unread counter, a video, a page loading in an
#     old tab): proves nothing about this page, so it never makes a match.
function Watch-Window {
  param([hashtable]$Before, [string[]]$Tokens, [string[]]$Procs, [int]$Timeout, [scriptblock]$List, [scriptblock]$ProcOf, [int]$PollMs = 200)
  $Tokens = @($Tokens | ForEach-Object { Norm $_ } | Where-Object { $_ })
  $Procs = @($Procs | Where-Object { $_ })
  if ($Tokens.Count -eq 0) {
    return [pscustomobject]@{ matched = $null; reason = 'the page title is not known in advance, so no window can be recognised as this page'; elapsedMs = 0 }
  }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $preexisting = $null; $othersChanged = $false
  while ($sw.ElapsedMilliseconds -lt $Timeout) {
    foreach ($w in @(& $List)) {
      $pn = [string](& $ProcOf $w)
      if ($Procs.Count -gt 0 -and -not ($Procs -contains $pn)) { continue }
      $h = [long]$w.Handle
      $isNew = -not $Before.ContainsKey($h)
      if (Has-Token (Norm $w.Title) $Tokens) {
        # Did this very window already show the title before the open?
        $hadIt = (-not $isNew) -and (Has-Token (Norm ([string]$Before[$h])) $Tokens)
        if (-not $hadIt) {
          return [pscustomobject]@{ matched = $true; confidence = 'high'; title = $w.Title; process = $pn; newWindow = $isNew; elapsedMs = $sw.ElapsedMilliseconds }
        }
        if (-not $preexisting) { $preexisting = [pscustomobject]@{ title = $w.Title; process = $pn } }
      } elseif ($isNew -or ($Before[$h] -ne [string]$w.Title)) {
        $othersChanged = $true
      }
    }
    Wait-NextPoll $sw $Timeout $PollMs
  }
  $ms = $sw.ElapsedMilliseconds
  if ($preexisting) {
    return [pscustomobject]@{ matched = $null; title = $preexisting.title; process = $preexisting.process; reason = "a window showing this title was already open before, and no new or changed window showed it within $Timeout ms, so this open cannot be told apart from that window"; elapsedMs = $ms }
  }
  # The tokens are page titles, which the page's owner chose: each is quoted at most 60 characters long.
  $quoted = @($Tokens | ForEach-Object { if ($_.Length -gt 60) { $_.Substring(0, 60) + '...' } else { $_ } })
  $why = 'no new or changed window containing "' + ($quoted -join '" or "') + '" appeared within ' + $Timeout + ' ms'
  if ($othersChanged) { $why += ' (other windows changed their titles, but none showed it)' }
  return [pscustomobject]@{ matched = $false; reason = $why; elapsedMs = $ms }
}

function Get-PairKey($e) { return ([string][long]$e.hwnd) + '|' + (NormPath ([string]$e.path)) }

# Does $List hold any of $Items?
function Has-Any($List, [string[]]$Items) {
  foreach ($i in $Items) { if (@($List) -contains $i) { return $true } }
  return $false
}

# How many Explorer windows or tabs show each window+folder pair.
function Get-PairCount($entries) {
  $count = @{}
  foreach ($e in $entries) { $k = Get-PairKey $e; $count[$k] = 1 + [int]$count[$k] }
  return $count
}

# Explorer mode: wait for an Explorer window or tab on the folder, with the file selected.
# $List returns the Explorer windows (hwnd, path, selected); a parameter for the tests.
# `selected` is the list of selected paths, or $null when the window's selection could not
# be read (its view was not ready, or it has none). $Want and $Select each list every spelling
# of the path: past MAX_PATH Explorer is given the 8.3 short one, and may show either.
#
# Proof is a new Explorer window or tab on the folder, or an Explorer window that was already
# on the folder and now has the file selected when it did not before (Explorer reuses a window
# for /select). A window that was already on the folder and did not change proves nothing:
# matched:null, never true.
#
# selectedOk is checked on its own and never follows from matched. When a file was asked for,
# it is true when that file is selected in the window, false when it is not (or when no window
# came up at all), and null only when the window's selection could not be read. When no file
# was asked for there is nothing to check, so it is null.
function Watch-Explorer {
  param([object[]]$Before, [string[]]$Want, [string[]]$Select, [int]$Timeout, [scriptblock]$List, [int]$PollMs = 200)
  $Want = @($Want | Where-Object { $_ })
  $Select = @($Select | Where-Object { $_ })
  # Windows 11 Explorer tabs share their window's handle, so count the tabs of each
  # window+folder pair: one more than before is a new tab, even beside an old tab on the
  # same folder. A new window is a handle that was not there at all.
  $beforeCount = Get-PairCount $Before
  $beforeHwnd = @{}
  $beforeSel = @{}
  foreach ($e in $Before) {
    $beforeHwnd[[long]$e.hwnd] = $true
    $k = Get-PairKey $e
    $beforeSel[$k] = @($beforeSel[$k]) + @($e.selected | Where-Object { $_ })
  }
  $asked = $Select.Count -gt 0
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $found = $null; $preexisting = $null
  while ($sw.ElapsedMilliseconds -lt $Timeout) {
    $now = @(& $List)
    $nowCount = Get-PairCount $now
    foreach ($e in $now) {
      if (-not ($Want -contains (NormPath ([string]$e.path)))) { continue }
      $k = Get-PairKey $e
      $isChanged = [int]$nowCount[$k] -gt [int]$beforeCount[$k]
      $sel = $e.selected
      $has = $asked -and ($null -ne $sel) -and (Has-Any $sel $Select)
      $selOk = if (-not $asked) { $null } elseif ($has) { $true } elseif ($null -eq $sel) { $null } else { $false }
      $newWindow = -not $beforeHwnd.ContainsKey([long]$e.hwnd)
      if ($isChanged) {
        if ((-not $asked) -or $has) {
          return [pscustomobject]@{ matched = $true; confidence = 'high'; path = $e.path; selected = $sel; selectedOk = $selOk; newWindow = $newWindow; elapsedMs = $sw.ElapsedMilliseconds }
        }
        # The folder is there but the file is not (yet) selected: keep watching for it.
        $found = [pscustomobject]@{ path = $e.path; selected = $sel; selectedOk = $selOk; newWindow = $newWindow }
      } elseif ($has -and -not (Has-Any $beforeSel[$k] $Select)) {
        # The window was already on the folder, and the open selected the file in it.
        return [pscustomobject]@{ matched = $true; confidence = 'high'; path = $e.path; selected = $sel; selectedOk = $true; newWindow = $false; reusedWindow = $true; elapsedMs = $sw.ElapsedMilliseconds }
      } elseif (-not $preexisting) { $preexisting = [pscustomobject]@{ path = $e.path; selected = $sel; selectedOk = $selOk } }
    }
    Wait-NextPoll $sw $Timeout $PollMs
  }
  $ms = $sw.ElapsedMilliseconds
  if ($found) {
    $why = if ($null -eq $found.selectedOk) { 'the folder opened, but which file is selected in it could not be read' } else { 'the folder opened but the expected file was not selected' }
    return [pscustomobject]@{ matched = $true; confidence = 'high'; path = $found.path; selected = $found.selected; selectedOk = $found.selectedOk; newWindow = $found.newWindow; reason = $why; elapsedMs = $ms }
  }
  if ($preexisting) {
    return [pscustomobject]@{ matched = $null; path = $preexisting.path; selected = $preexisting.selected; selectedOk = $preexisting.selectedOk; reason = "an Explorer window on this folder was already open before, and no new window, tab or selection appeared within $Timeout ms, so this open cannot be told apart from that window"; elapsedMs = $ms }
  }
  $none = if ($asked) { $false } else { $null }
  return [pscustomobject]@{ matched = $false; selectedOk = $none; reason = "no Explorer window on this folder appeared within $Timeout ms"; elapsedMs = $ms }
}

# Dot-sourced: the functions above are all that was wanted.
if ($MyInvocation.InvocationName -eq '.') { return }

$mode = if ($env:SHOW_LOCAL_MODE) { $env:SHOW_LOCAL_MODE } else { 'window' }
$timeout = if ($env:SHOW_LOCAL_TIMEOUT) { [int]$env:SHOW_LOCAL_TIMEOUT } else { 5000 }
$tokens = @()
if ($env:SHOW_LOCAL_TOKENS) { $tokens = @(($env:SHOW_LOCAL_TOKENS | ConvertFrom-Json) | ForEach-Object { Norm $_ } | Where-Object { $_ }) }
$procs = @()
if ($env:SHOW_LOCAL_PROCESSES) { $procs = @(($env:SHOW_LOCAL_PROCESSES | ConvertFrom-Json) | ForEach-Object { "$_".ToLowerInvariant() }) }

try {
  if ($mode -eq 'snapshot') {
    Load-Helper
    $list = @([ShowLocalWin]::List() | ForEach-Object { [pscustomobject]@{ process = (ProcName $_.Pid); title = $_.Title } })
    Emit ([pscustomobject]@{ ok = $true; windows = $list })
    exit 0
  }

  if ($mode -eq 'window') {
    Load-Helper
    $before = Get-TitleSnapshot ([ShowLocalWin]::List())
    [Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
    # With no title to look for, Watch-Window answers matched:null at once.
    Emit (Watch-Window -Before $before -Tokens $tokens -Procs $procs -Timeout $timeout -List { [ShowLocalWin]::List() } -ProcOf { param($w) ProcName $w.Pid })
    exit 0
  }

  if ($mode -eq 'explorer') {
    $shell = New-Object -ComObject Shell.Application
    function Explorers {
      $out = @()
      foreach ($w in @($shell.Windows())) {
        try {
          if ($w.FullName -notmatch 'explorer\.exe$') { continue }
          $loc = $w.LocationURL
          if (-not $loc) { continue }
          $p = ([uri]$loc).LocalPath
          # Compare full paths: SelectedItems().Name hides extensions when Explorer is set to do so.
          # $null (not an empty list) when the selection cannot be read, e.g. while the view loads.
          $sel = $null
          try { $sel = @($w.Document.SelectedItems() | ForEach-Object { NormPath $_.Path }) } catch { }
          $out += [pscustomobject]@{ hwnd = [long]$w.HWND; path = $p; selected = $sel }
        } catch { }
      }
      return $out
    }
    $before = @(Explorers)
    [Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
    $want = @((NormPath $env:SHOW_LOCAL_DIR), (NormPath $env:SHOW_LOCAL_DIR_ALT))
    $select = @((NormPath $env:SHOW_LOCAL_SELECT), (NormPath $env:SHOW_LOCAL_SELECT_ALT))
    Emit (Watch-Explorer -Before $before -Want $want -Select $select -Timeout $timeout -List { Explorers })
    exit 0
  }

  Emit ([pscustomobject]@{ matched = $null; reason = "unknown mode '$mode'" })
  exit 2
} catch {
  Emit ([pscustomobject]@{ matched = $null; reason = "watcher error: $($_.Exception.Message)" })
  exit 1
}
