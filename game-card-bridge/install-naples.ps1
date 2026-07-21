#Requires -RunAsAdministrator
<#
HEADPINZ NAPLES (center 6) bridge setup.

  irm https://raw.githubusercontent.com/BMA-Dassle/Tools-Website-FT/main/game-card-bridge/install-naples.ps1 -OutFile C:\work\naples.ps1
  C:\work\naples.ps1    # prompts for the secret (Vercel GAME_CARD_BRIDGE_SECRET)

The secret is intentionally NOT in this public repo - paste/type it at the
prompt, or pass -Secret <hex>.
#>
param([Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$Secret)
$installer = Join-Path $PSScriptRoot 'install.ps1'
if (-not (Test-Path $installer)) {
  $installer = Join-Path $env:TEMP 'gc-bridge-install.ps1'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest 'https://raw.githubusercontent.com/BMA-Dassle/Tools-Website-FT/main/game-card-bridge/install.ps1' -OutFile $installer -UseBasicParsing
}
& $installer -Center 6 -Secret $Secret
