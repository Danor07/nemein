# Firma de código

Nemein ofrece en la release v0.1.0 dos variantes de Windows: el instalador original sin firma y una variante identificada como `selfsigned`, firmada por un certificado autofirmado con sujeto `CN=Innova-tech`.

El certificado fue emitido por el propio editor. No acredita una verificación de identidad por una autoridad certificadora ni otorga confianza pública automática. Windows puede mantener el aviso de editor no reconocido o de SmartScreen. La descarga incluye el certificado público y checksums propios para esa variante.

El ejecutable de Nemein y su instalador se firman con SHA-256 y sello de tiempo RFC 3161. Los binarios de terceros incluidos en el paquete conservan sus firmas originales, si las tienen.

## Clave y confianza

La clave privada permanece en el almacén personal del usuario que firma, con política no exportable. No se incluye en el código, instalador, certificado público ni archivos de la release. Reutilizarla en este mismo perfil de Windows permite firmar otros programas del mismo editor.

No se agrega el certificado a los almacenes de confianza durante la compilación, instalación o ejecución. El archivo `.cer` contiene únicamente el certificado público. No hace falta importarlo para consultar sus datos.

## Firmar en Windows

Requiere un certificado de firma de código con su clave privada en `Cert:\CurrentUser\My` y SignTool del Windows SDK. La huella del certificado selecciona la clave local; no es una contraseña.

```powershell
.\scripts\sign-windows.ps1 -FilePath .\ruta\nemein.exe -CertificateThumbprint HUELLA_DEL_CERTIFICADO
```

Si se firma antes de empaquetar con Tauri, utilizá `tauri bundle --no-binary-patching --no-sign` para conservar la firma del ejecutable ya construido. Firmá después el instalador resultante. Cambiar el ejecutable o instalador después de firmarlo invalida su firma.

El script informa el estado de Windows, que puede ser `UnknownError` o `NotTrusted` para un certificado autofirmado. No debe describirse ese estado como confianza pública validada.

## Verificación y distribución

- Conservá las descargas originales; publicá la variante autofirmada con otro nombre y un archivo de checksums propio.
- Comprobá que el ejecutable empaquetado conserve la misma firma que el ejecutable firmado antes de empaquetar.
- Comprobá el firmante y el hash del instalador después de firmarlo y después de subirlo.
- No subas archivos PFX, contraseñas ni claves privadas. El certificado público puede compartirse.

Las instrucciones de almacenamiento de datos están en [PRIVACIDAD.md](PRIVACIDAD.md).
