[CmdletBinding()]
param(
  [string]$CodexHome = $env:CODEX_HOME,
  [string]$TaskName = 'Codex WhatsApp Relay',
  [switch]$RestartTest
)

$ErrorActionPreference = 'Stop'
$expectedAccounts = @('personal', 'business-cbe', 'business-irl')

if ([string]::IsNullOrWhiteSpace($CodexHome)) {
  throw 'Set CODEX_HOME or pass -CodexHome.'
}

$cacheRoot = Join-Path $CodexHome 'plugins\cache\personal\whatsapp-relay'
$pluginRoot = Get-ChildItem -LiteralPath $cacheRoot -Directory |
  Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName 'scripts\controller-daemon.mjs')
  } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $pluginRoot) {
  throw "No complete WhatsApp relay plugin exists under $cacheRoot"
}

$task = Get-ScheduledTask -TaskName $TaskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
if (-not $task.Settings.Hidden) {
  throw "Scheduled task '$TaskName' must be hidden."
}
if ($taskInfo.LastTaskResult -ne 0) {
  throw "Scheduled task '$TaskName' last result is $($taskInfo.LastTaskResult)."
}

$accountsFile = Join-Path $pluginRoot 'data\accounts.json'
$accounts = Get-Content -Raw -LiteralPath $accountsFile | ConvertFrom-Json
foreach ($accountId in $expectedAccounts) {
  $account = $accounts.accounts | Where-Object { $_.id -eq $accountId }
  if (-not $account -or -not $account.enabled) {
    throw "Required WhatsApp account '$accountId' is absent or disabled."
  }

  $credsFile = Join-Path $pluginRoot "data\accounts\$accountId\auth\creds.json"
  $backupFile = Join-Path $pluginRoot "data\accounts\$accountId\auth\creds.last-good.json"
  foreach ($file in @($credsFile, $backupFile)) {
    if (-not (Test-Path -LiteralPath $file)) {
      throw "Credential safety file is missing for '$accountId': $file"
    }
    $text = Get-Content -Raw -LiteralPath $file
    if ([string]::IsNullOrWhiteSpace($text)) {
      throw "Credential safety file is empty for '$accountId': $file"
    }
    $null = $text | ConvertFrom-Json
  }
}

function Get-RelayProcesses {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'node.exe' -and
      $_.CommandLine -like '*controller-daemon.mjs*'
    }
}

$managers = @(Get-RelayProcesses)
if ($managers.Count -ne 1) {
  throw "Expected one persistent relay manager. Found $($managers.Count)."
}

if ($RestartTest) {
  $beforePid = $managers[0].ProcessId
  $processModule = (New-Object Uri (Join-Path $pluginRoot 'scripts\controller-process.mjs')).AbsoluteUri
  & node.exe --input-type=module -e "const m=await import('$processModule'); await m.stopControllerDaemon();"
  Start-ScheduledTask -TaskName $TaskName

  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    $managers = @(Get-RelayProcesses)
  } while (($managers.Count -ne 1 -or $managers[0].ProcessId -eq $beforePid) -and (Get-Date) -lt $deadline)

  if ($managers.Count -ne 1 -or $managers[0].ProcessId -eq $beforePid) {
    throw 'Relay restart verification failed.'
  }
}

$connectionDeadline = (Get-Date).AddSeconds(30)
do {
  $accounts = Get-Content -Raw -LiteralPath $accountsFile | ConvertFrom-Json
  $disconnectedAccounts = @(
    $expectedAccounts | Where-Object {
      $accountId = $_
      $account = $accounts.accounts | Where-Object { $_.id -eq $accountId }
      -not $account -or $account.lastStatus -ne 'connected'
    }
  )
  if ($disconnectedAccounts.Count -eq 0) {
    break
  }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $connectionDeadline)

if ($disconnectedAccounts.Count -gt 0) {
  throw "Relay accounts failed to connect: $($disconnectedAccounts -join ', ')"
}

[pscustomobject]@{
  PluginRoot = $pluginRoot
  ScheduledTask = $TaskName
  Hidden = $task.Settings.Hidden
  LastTaskResult = $taskInfo.LastTaskResult
  ManagerPid = $managers[0].ProcessId
  Accounts = ($expectedAccounts -join ', ')
  RestartVerified = [bool]$RestartTest
}
