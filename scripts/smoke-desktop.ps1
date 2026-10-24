param([string]$ExecutablePath, [string]$DataDir)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$executable = if ($ExecutablePath) { $ExecutablePath } else { Join-Path $projectRoot 'src-tauri\target\release\nemein.exe' }
if (!(Test-Path -LiteralPath $executable)) { throw 'Todavía no existe el ejecutable compilado.' }
$env:BUDGET_DATA_DIR = if ($DataDir) { $DataDir } else { Join-Path $projectRoot '.desktop-smoke' }
$appProcess = Start-Process -FilePath $executable -WorkingDirectory (Split-Path $executable) -WindowStyle Hidden -PassThru
$child = $null
try {
  for ($attempt=0; $attempt -lt 40; $attempt++) {
    $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($appProcess.Id) AND name='node.exe'"
    if ($child) { break }
    if ($appProcess.HasExited) { throw 'El ejecutable terminó antes de iniciar su motor.' }
    Start-Sleep -Milliseconds 500
  }
  if (!$child) { throw 'No apareció el motor Node incluido.' }
  $listener = $null
  for ($attempt=0; $attempt -lt 20; $attempt++) {
    $listener = Get-NetTCPConnection -OwningProcess $child.ProcessId -State Listen -ErrorAction SilentlyContinue
    if ($listener) { break }
    Start-Sleep -Milliseconds 500
  }
  if (!$listener -or $listener.LocalAddress -ne '127.0.0.1') { throw 'El motor no escucha exclusivamente en localhost.' }
  $url = 'http://127.0.0.1:' + $listener.LocalPort
  $response = Invoke-WebRequest -UseBasicParsing -Uri $url
  if ($response.StatusCode -ne 200 -or !$response.Content.Contains('Por presupuestar')) { throw 'La pantalla inicial no respondió correctamente.' }
  $charts = Invoke-WebRequest -UseBasicParsing -Uri ($url + '/static/chart.js')
  if ($charts.StatusCode -ne 200) { throw 'No se encontró Chart.js local.' }
  if (!$response.Content.Contains('Metas y pagos') -or !$response.Content.Contains('Agentes y terminal')) { throw 'Faltan las funcionalidades de la release.' }
  Write-Output "ARRANQUE NATIVO OK: Tauri PID $($appProcess.Id), Node incluido PID $($child.ProcessId), HTTP 200, Chart.js local."
} finally {
  if (!$appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force }
  Start-Sleep -Seconds 2
  if ($child -and (Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $child.ProcessId -Force
    throw 'El motor no se cerró al terminar el padre.'
  }
}
