param([Parameter(Mandatory=$true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'This installer smoke test runs only on an ephemeral GitHub Windows runner.'
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$installedRoot = Join-Path $env:LOCALAPPDATA 'Nemein'
if (Test-Path -LiteralPath $installedRoot) { throw 'Runner already has Nemein; this must be a fresh installation.' }
$setup = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -PassThru
if (-not $setup.WaitForExit(180000)) { Stop-Process -Id $setup.Id -Force; throw 'Silent installation exceeded three minutes.' }
if ($setup.ExitCode -ne 0) { throw "NSIS exited with $($setup.ExitCode)" }
$exe = Join-Path $installedRoot 'nemein.exe'
foreach ($required in @($exe, (Join-Path $installedRoot 'uninstall.exe'), (Join-Path $installedRoot 'runtime/node.exe'))) {
  if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing installed file: $required" }
}
$entry = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nemein'
if ([IO.Path]::GetFullPath($entry.InstallLocation.Trim('"')) -ne [IO.Path]::GetFullPath($installedRoot)) { throw 'Uninstall registry path mismatch.' }
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$links = @(Get-ChildItem -LiteralPath $programs -Filter 'Nemein.lnk' -File -Recurse)
if (!$links.Count) { throw 'Start menu shortcut is missing.' }
$shell = New-Object -ComObject WScript.Shell
$validLink = $false
foreach ($link in $links) {
  $target = $shell.CreateShortcut($link.FullName).TargetPath
  if ([IO.Path]::GetFullPath($target) -eq [IO.Path]::GetFullPath($exe) -and (Test-Path -LiteralPath $target -PathType Leaf)) { $validLink = $true }
}
if (!$validLink) { throw 'Start menu shortcut does not point to the installed executable.' }
& node scripts/smoke-installed-mcp.mjs $installedRoot
if ($LASTEXITCODE -ne 0) { throw 'Installed MCP smoke failed.' }
& node --test test/credentials.test.js
if ($LASTEXITCODE -ne 0) { throw 'Windows credential tests failed after installation.' }
$nativeData = Join-Path $env:RUNNER_TEMP ('nemein-native-' + [guid]::NewGuid().ToString('N'))
& "$PSScriptRoot/smoke-desktop.ps1" -ExecutablePath $exe -DataDir $nativeData
Write-Output 'CLEAN INSTALL OK: silent NSIS, Windows registry, Start menu target, installed MCP, credentials, and native startup.'
