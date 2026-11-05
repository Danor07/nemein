param([Parameter(Mandatory=$true)][string]$InstallerPath)
# Installs the published 0.4.0 installer, seeds fictitious data with its runtime, installs
# the candidate over it and checks that the migration keeps every row, connection and rule.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'This upgrade smoke runs only on an ephemeral GitHub Windows runner.'
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$installedRoot = Join-Path $env:LOCALAPPDATA 'Nemein'
if (Test-Path -LiteralPath (Join-Path $installedRoot 'nemein.exe')) { throw 'Runner already has Nemein installed.' }
$previous = Join-Path $env:RUNNER_TEMP 'Nemein-0.4.0-windows-x64-selfsigned-setup.exe'
Invoke-WebRequest -Uri 'https://github.com/Danor07/nemein/releases/download/v0.4.0/Nemein-0.4.0-windows-x64-selfsigned-setup.exe' -OutFile $previous
if ((Get-FileHash -LiteralPath $previous).Hash -ne '0B4048BF89A8A94AADDBC6A91395F67C822473FFE05ED14559A8D189A8D03242') { throw 'The downloaded 0.4.0 installer does not match its published SHA256.' }

function Install-Nemein($path, $version) {
  $setup = Start-Process -FilePath $path -ArgumentList '/S' -WindowStyle Hidden -PassThru
  if (-not $setup.WaitForExit(180000)) { Stop-Process -Id $setup.Id -Force; throw 'Silent installation exceeded three minutes.' }
  if ($setup.ExitCode -ne 0) { throw "NSIS exited with $($setup.ExitCode)" }
  $installed = (Get-Item -LiteralPath (Join-Path $installedRoot 'nemein.exe')).VersionInfo.ProductVersion
  if ($installed -ne $version) { throw "Expected Nemein $version installed, found $installed." }
}

$data = Join-Path $env:LOCALAPPDATA 'PresupuestoCero'
$state = Join-Path $env:RUNNER_TEMP 'nemein-upgrade-state.json'
Install-Nemein $previous '0.4.0'
& node scripts/smoke-upgrade.mjs seed $installedRoot $data $state
if ($LASTEXITCODE -ne 0) { throw 'Seeding with the 0.4.0 runtime failed.' }
if (Get-Process -Name nemein, nemein-connector -ErrorAction SilentlyContinue) { throw 'Nemein processes are still running before the upgrade.' }
Install-Nemein $installer (Get-Content package.json | ConvertFrom-Json).version
foreach ($required in @((Join-Path $installedRoot 'runtime/node.exe'), (Join-Path $installedRoot 'nemein-connector.exe'))) {
  if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing file after the upgrade: $required" }
}
& node scripts/smoke-upgrade.mjs verify $installedRoot $data $state
if ($LASTEXITCODE -ne 0) { throw 'The upgraded runtime did not keep the 0.4.0 data.' }
Remove-Item -LiteralPath $state
$uninstall = Start-Process -FilePath (Join-Path $installedRoot 'uninstall.exe') -ArgumentList '/S' -WindowStyle Hidden -PassThru
if (-not $uninstall.WaitForExit(180000)) { Stop-Process -Id $uninstall.Id -Force; throw 'Silent uninstallation exceeded three minutes.' }
Write-Output 'UPGRADE INSTALL OK: published 0.4.0, fictitious data, candidate installed over it, migration 7 with every row, connection and rule kept.'
