<#
  Nomyx agent installer (Windows).

  Run in an ELEVATED PowerShell from the folder containing
  nomyx-agent-win-x64.exe and your config.json:

      Right-click PowerShell -> Run as Administrator, then:

      .\install.ps1                  # runs as NetworkService (least privilege) - default
      .\install.ps1 -RunAs System    # only if a specific check genuinely needs SYSTEM

  SECURITY MODEL — read before using -RunAs System
  -------------------------------------------------
  The agent executes whatever shell/PowerShell commands are listed in
  config.json, at the privilege of the account it runs as. It is therefore a
  "confused deputy": anyone who can WRITE config.json can run arbitrary code as
  that account. This installer mitigates that two ways:

    1. It runs the agent as the low-privilege NetworkService account by default,
       not SYSTEM. NetworkService can read perf counters, WMI, the LocalMachine
       certificate store (expiry), and reach the network to POST results, which
       covers the common checks. Use -RunAs System only when a check needs it,
       and understand that a writable config.json then becomes a local
       privilege-escalation path.

    2. It locks the install directory and config.json down to Administrators and
       SYSTEM only (the run account gets read-only). A normal user cannot edit
       what the agent runs.
#>

[CmdletBinding()]
param(
  [ValidateSet("NetworkService", "LocalService", "System")]
  [string]$RunAs = "NetworkService"
)

$ErrorActionPreference = "Stop"

# --- Require elevation ------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "This installer must be run from an elevated (Administrator) PowerShell."
}

$Dest = "C:\Program Files\Nomyx Agent"
$Exe  = "nomyx-agent-win-x64.exe"

if (-not (Test-Path $Exe))          { throw "$Exe not found in this folder." }
if (-not (Test-Path "config.json")) { throw "config.json not found in this folder - create one first." }

# Map the friendly choice to the real account and run level.
switch ($RunAs) {
  "System"       { $RunUser = "NT AUTHORITY\SYSTEM";          $RunLevel = "Highest" }
  "LocalService" { $RunUser = "NT AUTHORITY\LOCAL SERVICE";   $RunLevel = "Limited" }
  default        { $RunUser = "NT AUTHORITY\NETWORK SERVICE"; $RunLevel = "Limited" }
}

# --- Install files ----------------------------------------------------------
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Force $Exe          "$Dest\nomyx-agent.exe"
Copy-Item -Force "config.json" "$Dest\config.json"

# --- Lock down ACLs ---------------------------------------------------------
# Disable inheritance, drop all existing rules, then grant only:
#   Administrators + SYSTEM -> Full control
#   run account            -> read (config) / read & execute (dir + exe)
function Set-LockedAcl {
  param(
    [string]$Path,
    [string]$ReadAccount,
    [string]$ReadRights   # "Read" or "ReadAndExecute"
  )
  $isDir = (Get-Item -LiteralPath $Path).PSIsContainer
  $inherit = if ($isDir) { "ContainerInherit,ObjectInherit" } else { "None" }

  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)         # protect from inheritance, drop inherited rules
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }

  $admins = New-Object Security.AccessControl.FileSystemAccessRule(
    "BUILTIN\Administrators", "FullControl", $inherit, "None", "Allow")
  $system = New-Object Security.AccessControl.FileSystemAccessRule(
    "NT AUTHORITY\SYSTEM", "FullControl", $inherit, "None", "Allow")
  $runner = New-Object Security.AccessControl.FileSystemAccessRule(
    $ReadAccount, $ReadRights, $inherit, "None", "Allow")

  $acl.AddAccessRule($admins)
  $acl.AddAccessRule($system)
  $acl.AddAccessRule($runner)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

Set-LockedAcl -Path $Dest                 -ReadAccount $RunUser -ReadRights "ReadAndExecute"
Set-LockedAcl -Path "$Dest\nomyx-agent.exe" -ReadAccount $RunUser -ReadRights "ReadAndExecute"
Set-LockedAcl -Path "$Dest\config.json"   -ReadAccount $RunUser -ReadRights "Read"

# --- Scheduled task ---------------------------------------------------------
# At startup, restart on failure, no time limit, running as the chosen account.
$action   = New-ScheduledTaskAction      -Execute "$Dest\nomyx-agent.exe" -WorkingDirectory $Dest
$trigger  = New-ScheduledTaskTrigger     -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
              -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal  -UserId $RunUser -LogonType ServiceAccount -RunLevel $RunLevel

Register-ScheduledTask -TaskName "NomyxAgent" -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "NomyxAgent"

Write-Host ""
Write-Host "Nomyx agent installed as scheduled task 'NomyxAgent', running at startup as $RunUser."
Write-Host "Install dir and config.json are locked to Administrators/SYSTEM (run account is read-only)."
if ($RunAs -eq "System") {
  Write-Warning "Running as SYSTEM. config.json must never be writable by non-admins (this installer enforces that, but do not relax it)."
}
Write-Host ""
Write-Host "Status:    Get-ScheduledTask -TaskName NomyxAgent | Get-ScheduledTaskInfo"
Write-Host "Uninstall: Unregister-ScheduledTask -TaskName NomyxAgent -Confirm:`$false"