#Requires -RunAsAdministrator
<#
game-card-bridge installer (clean reinstall, all fixes).

Run on a center PC that can reach that center's Intercard server:

  irm https://raw.githubusercontent.com/BMA-Dassle/Tools-Website-FT/main/game-card-bridge/install.ps1 -OutFile C:\work\install.ps1
  C:\work\install.ps1 -Center 13 -Secret <GAME_CARD_BRIDGE_SECRET hex>

Centers: 13 = FastTrax FM · 12 = HeadPinz FM · 6 = HeadPinz Naples.
The secret is NEVER committed here - pass the same value that Vercel's
GAME_CARD_BRIDGE_SECRET holds. Idempotent: safe to rerun any time.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('13', '12', '6')][string]$Center,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$Secret,
  [string]$CloudUrl = 'https://fasttraxent.com'
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$centers = @{
  '13' = @{ Name = 'FastTrax FM';    Ip = '10.48.2.2'; Mac = '68EDA47E4B69' }
  '12' = @{ Name = 'HeadPinz FM';    Ip = '10.43.2.2'; Mac = '989096D0F391' }
  '6'  = @{ Name = 'HeadPinz Naples'; Ip = '10.40.2.2'; Mac = '68EDA45A5F59' }
}
$c = $centers[$Center]
$Dir = 'C:\game-card-bridge'
$RawBase = 'https://raw.githubusercontent.com/BMA-Dassle/Tools-Website-FT/main/game-card-bridge'
Write-Host "Installing bridge for $($c.Name) (center $Center, EIS $($c.Ip))" -ForegroundColor Cyan

# -- 0. sanity: can this PC reach the Intercard server? ----------------------
$reach = Test-NetConnection $c.Ip -Port 3044 -WarningAction SilentlyContinue
if (-not $reach.TcpTestSucceeded) {
  Write-Warning "Cannot reach $($c.Ip):3044 from this PC - wrong building/VLAN? EIS loads will fail here."
} else { Write-Host "EIS reachable at $($c.Ip):3044" -ForegroundColor Green }

# -- 1. cleanup: old tasks, services, processes, files ------------------------
Get-ScheduledTask | Where-Object { $_.TaskName -match 'bridge|game.?card' } | ForEach-Object {
  Write-Host "Removing scheduled task '$($_.TaskName)'"
  Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false
}
Get-Service | Where-Object { ($_.Name + $_.DisplayName) -match 'game.?card|gc.?bridge' } | ForEach-Object {
  Write-Host "Stopping service '$($_.Name)'"
  try { Stop-Service $_.Name -Force -ErrorAction Stop } catch {}
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.mjs' } |
  ForEach-Object { Write-Host "Killing node PID $($_.ProcessId)"; try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
if (Test-Path $Dir) { Get-ChildItem $Dir -Exclude 'node.exe' | Remove-Item -Force -Recurse }
New-Item -ItemType Directory -Force $Dir | Out-Null
Write-Host 'Cleanup done.'

# -- 2. Node (installed, or standalone exe - no winget required) --------------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { $NodeExe = $node.Source }
else {
  $NodeExe = Join-Path $Dir 'node.exe'
  if (-not (Test-Path $NodeExe)) {
    Write-Host 'Downloading standalone node.exe (v22 LTS)...'
    Invoke-WebRequest 'https://nodejs.org/dist/v22.14.0/win-x64/node.exe' -OutFile $NodeExe -UseBasicParsing
  }
}
Write-Host "Node: $NodeExe ($(& $NodeExe -v))"

# -- 3. latest bridge files ----------------------------------------------------
foreach ($f in 'server.mjs', 'lib.mjs', 'package.json') {
  Invoke-WebRequest "$RawBase/$f" -OutFile (Join-Path $Dir $f) -UseBasicParsing
}
Write-Host "Bridge files installed in $Dir"

# -- 4. machine env --------------------------------------------------------------
$vars = @{
  INTERCARD_IP     = $c.Ip
  INTERCARD_MAC    = $c.Mac
  GC_CLOUD_URL     = $CloudUrl
  GC_BRIDGE_SECRET = $Secret
  GC_LOCATION_CODE = $Center
}
foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Machine') }
Write-Host 'Machine env set.'

# -- 5. Edge/Chrome local-network policies (belt & suspenders) --------------------
$urls = @('https://fasttraxent.com', 'https://headpinz.com')
foreach ($base in 'Microsoft\Edge', 'Google\Chrome') {
  foreach ($pol in 'InsecurePrivateNetworkRequestsAllowedForUrls', 'LocalNetworkAccessAllowedForUrls') {
    $key = "HKLM:\SOFTWARE\Policies\$base\$pol"
    New-Item -Path $key -Force | Out-Null
    for ($i = 0; $i -lt $urls.Count; $i++) { Set-ItemProperty -Path $key -Name ([string]($i + 1)) -Value $urls[$i] }
  }
}
Write-Host 'Browser local-network policies set (apply on next browser restart).'

# -- 6. auto-start task: SYSTEM, at boot, restarts itself on crash ----------------
$action    = New-ScheduledTaskAction -Execute $NodeExe -Argument (Join-Path $Dir 'server.mjs') -WorkingDirectory $Dir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
             -ExecutionTimeLimit (New-TimeSpan -Days 3650) -StartWhenAvailable -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'game-card-bridge' -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName 'game-card-bridge'
Write-Host 'Task registered and started.'

# -- 7. verify: demand a SUCCESSFUL cloud poll ------------------------------------
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 5
  try {
    $w = (Invoke-RestMethod 'http://127.0.0.1:4599/health' -TimeoutSec 5).worker
    if ($w.enabled -and $w.lastPollAt -and -not $w.lastError) { $ok = $true; break }
    Write-Host "  waiting... lastError=$($w.lastError)"
  } catch { Write-Host '  waiting for bridge to answer...' }
}
$w | ConvertTo-Json -Compress | Write-Host
if ($ok) {
  Write-Host "ALL GOOD - bridge polling clean for center $($w.locationCode) ($($c.Name))." -ForegroundColor Green
  Write-Host 'Restart the kiosk browser (or reboot) so the Game Zone chip reads LOCAL.'
} else {
  Write-Warning 'Bridge up but not polling clean after 60s. Run manually to see errors:'
  Write-Warning "  cd $Dir; & '$NodeExe' server.mjs"
}
