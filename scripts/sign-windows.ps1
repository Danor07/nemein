param(
  [Parameter(Mandatory=$true)][string[]]$FilePath,
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$CertificateThumbprint,
  [string]$SignToolPath,
  [string]$TimestampUrl = 'http://timestamp.digicert.com'
)
$ErrorActionPreference = 'Stop'
if (-not $SignToolPath) {
  $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $SignToolPath = Get-ChildItem -Path (Join-Path $sdk '*\x64\signtool.exe') -File |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $SignToolPath -or -not (Test-Path -LiteralPath $SignToolPath)) {
  throw 'Instalá SignTool del Windows SDK o indicá -SignToolPath.'
}
$certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $CertificateThumbprint)
if (-not $certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) {
  throw 'El certificado no está vigente o no tiene su clave privada en este perfil.'
}
foreach ($file in $FilePath) {
  $resolved = (Resolve-Path -LiteralPath $file).Path
  & $SignToolPath sign /s My /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $resolved
  if ($LASTEXITCODE -ne 0) { throw "No se pudo firmar $resolved" }
  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  if ($signature.SignerCertificate.Thumbprint -ne $CertificateThumbprint -or
      $signature.Status.ToString() -in @('HashMismatch','NotSigned','NotSupported','Incompatible')) {
    throw "La firma requiere revisión: $resolved"
  }
  [pscustomobject]@{File=$resolved;Signer=$signature.SignerCertificate.Subject;WindowsStatus=$signature.Status.ToString();Timestamped=[bool]$signature.TimeStamperCertificate}
}
# Signing never adds a certificate to Windows trusted stores.
# A self-signed certificate can still have WindowsStatus UnknownError/NotTrusted.
