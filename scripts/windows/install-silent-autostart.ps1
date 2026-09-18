[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$CodexHome = $env:CODEX_HOME,
  [string]$TaskName = 'Codex WhatsApp Relay'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($CodexHome)) {
  throw 'Set CODEX_HOME or pass -CodexHome.'
}

$resolvedCodexHome = [IO.Path]::GetFullPath($CodexHome)
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$serviceRoot = [IO.Path]::GetFullPath((Join-Path $resolvedCodexHome '..\services\whatsapp-relay'))
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeExe = [IO.Path]::GetFullPath($nodeCommand.Source)

if ($PSCmdlet.ShouldProcess($serviceRoot, 'Install the silent WhatsApp relay service')) {
  New-Item -ItemType Directory -Path $serviceRoot -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $serviceRoot 'logs') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'ensure-relay.mjs') -Destination $serviceRoot -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'launch-hidden.vbs') -Destination $serviceRoot -Force
  Set-Content -LiteralPath (Join-Path $serviceRoot 'node-path.txt') -Value $nodeExe -NoNewline
  Set-Content -LiteralPath (Join-Path $serviceRoot 'codex-home.txt') -Value $resolvedCodexHome -NoNewline
}

$launcher = Join-Path $serviceRoot 'launch-hidden.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction `
  -Execute $wscript `
  -Argument ('"' + $launcher + '"') `
  -WorkingDirectory $serviceRoot
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$healthTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet `
  -Hidden `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Limited
$task = New-ScheduledTask `
  -Action $action `
  -Trigger @($logonTrigger, $healthTrigger) `
  -Settings $settings `
  -Principal $principal `
  -Description 'Silently ensures one Codex WhatsApp relay manager owns personal, business-cbe, and business-irl.'

if ($PSCmdlet.ShouldProcess($TaskName, 'Register and start the hidden scheduled task')) {
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

Write-Output "Installed hidden WhatsApp relay service at $serviceRoot"
Write-Output "Scheduled task: $TaskName"
