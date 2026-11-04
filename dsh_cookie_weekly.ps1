# Weekly dsh-auth cookie check. ASCII-only on purpose.
# DSH locks its Cookies database while running, so this script retries for up to
# 3 hours (every 5 minutes) and only checks once the process is gone.

param([int]$Attempts = 36)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$guard = Join-Path $here 'dsh_cookie_guard.py'
$logDir = Join-Path $env:LOCALAPPDATA 'dsh-cookie-guard'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'cookie-weekly.log'

$py = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path $py)) { $py = 'python' }

function Write-Log([string]$text) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text)
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Host $line
}

function Test-DshRunning {
    return [bool](Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
}

# The DSH plugin list is the switch: turning `dsh-cookie-guard` off in the app
# removes it from dsh.profile.bundles, and this check then does nothing.
function Test-PluginEnabled {
    $profileJson = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json'
    if (-not (Test-Path $profileJson)) { return $false }
    try {
        $cfg = Get-Content $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json
        $bundles = @($cfg.dsh.profile.bundles)
        return ($bundles -contains 'dsh-cookie-guard')
    } catch {
        Write-Log ('cannot read profile manifest: ' + $_.Exception.Message)
        return $false
    }
}

Write-Log 'weekly check started'

if (-not (Test-PluginEnabled)) {
    Write-Log 'plugin dsh-cookie-guard is disabled in the DSH plugin list - nothing to do'
    Write-Log 'weekly check finished'
    exit 0
}

$attempts = $Attempts
$succeeded = $false
for ($i = 1; $i -le $attempts; $i++) {
    if (-not (Test-DshRunning)) {
        Write-Log ("attempt {0}: DSH is closed, running guard" -f $i)
        & $py $guard --block 40 --auto
        $code = $LASTEXITCODE
        Write-Log ("guard exit code: {0}" -f $code)
        if ($code -eq 0) { $succeeded = $true; break }
    } else {
        Write-Log ("attempt {0}: DSH still running, wait 5 minutes" -f $i)
    }
    if ($i -lt $attempts) { Start-Sleep -Seconds 300 }
}

if (-not $succeeded) {
    Write-Log 'giving up for this week: DSH never stayed closed long enough'
}

Write-Log 'weekly check finished'
