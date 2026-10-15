# Silent start of the rewards services: control API (:3010) + panel (:8890).
#
# Idempotent: a port already listening is left alone, so this can be run
# repeatedly (logon task, desktop shortcut, manual) without starting a second
# copy. Each process is detached with Start-Process, so nothing here waits on
# it and closing the caller does not close the service.
#
# Logs go to %LOCALAPPDATA%\RewardsPanel\ so a later failure is still
# diagnosable after the fact.
$ErrorActionPreference = 'Stop'

$node  = 'C:\Program Files\nodejs\node.exe'
$repo  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # ...\Microsoft-Rewards-Script
$panel = Join-Path $repo 'dashboard\rewards-dashboard'
$dir   = Join-Path $env:LOCALAPPDATA 'RewardsPanel'

if (-not (Test-Path $node)) { throw "node.exe not found at $node" }
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

function Test-Listening([int]$port) {
    [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (-not (Test-Listening 3010)) {
    Start-Process -FilePath $node `
        -ArgumentList '--env-file-if-exists=.env', '.\scripts\api\server.js', '--port', '3010' `
        -WorkingDirectory $repo -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $dir 'api.log') `
        -RedirectStandardError  (Join-Path $dir 'api.log.err')
}

if (-not (Test-Listening 8890)) {
    Start-Process -FilePath $node `
        -ArgumentList '--env-file-if-exists=.env', 'server.js' `
        -WorkingDirectory $panel -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $dir 'panel.log') `
        -RedirectStandardError  (Join-Path $dir 'panel.log.err')
}
