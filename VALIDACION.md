# Verificación — mejoras del 23/10/2026

- Suite completa: 13 pruebas aprobadas, 0 fallos.
- Cliente MCP real: lectura predeterminada, escritura explícita, cuenta y recurrente de prueba, rechazo del segundo registro del mismo vencimiento y consulta del cubo.
- Metas calculadas con disponible real, recurrentes de fin de mes y año bisiesto, pausas, búsqueda y conservación de totales con reintegros y transferencias.
- Flujos HTTP, CSRF, origen y Host, importación CSV, conciliación y respaldos diarios verificados con bases temporales.
- Código fuente y ambos runtimes de escritorio actualizados; ejecutable nativo existente arrancó, sirvió HTTP 200 y Chart.js local, y cerró su motor al terminar.
- CLI comprobada mediante nemein.cmd; configuración MCP de ejemplo incluida en el repositorio.
- Inspección visual del resumen y formulario de metas en el navegador integrado (991 × 810, sin desborde horizontal). No se completó un guardado interactivo allí: el navegador integrado presentó un origen distinto y el servidor lo rechazó. Las mutaciones se verificaron por HTTP directo y MCP; no se relajó el control de origen.
- No se verificaron visualmente 360 × 800, 1440 × 900 ni zoom al 200 %. La comprobación inicial utilizó el ejecutable existente con su runtime actualizado. La compilación para GitHub Releases se verifica por separado.
- Pruebas con datos ficticios; no se modificaron registros financieros personales ni bases de otros proyectos.

## Release v0.1.0 para Windows x64

- Suite de 13 pruebas aprobada sobre el código de la primera release.
- Ejecutable nativo recompilado con las rutas del usuario remapeadas; búsqueda de esas rutas y del identificador personal sin coincidencias en el binario.
- Prueba del ejecutable nuevo con una carpeta de datos temporal: arranque, HTTP 200, gráficos locales, acceso a metas y agentes, y cierre del motor al terminar el padre.
- Instalador NSIS generado con licencia MIT, privacidad, licencia de Node y avisos de las dependencias Rust. Bases SQLite, respaldos y configuración MCP personal excluidos.
- Hash SHA-256 publicado junto al instalador.
- No se ejecutó una instalación mediante el asistente NSIS en el sistema ni se comprobó una instalación en un equipo limpio. El instalador no tiene firma digital. La inspección visual completa sigue pendiente.
## Variante autofirmada de v0.1.0

- Certificado de firma de código autofirmado con sujeto CN=Innova-tech, RSA 3072 y SHA-256; clave privada no exportable en el almacén personal del usuario.
- Ejecutable firmado con sello de tiempo RFC 3161. Windows informa falta de confianza en la raíz, como corresponde a un certificado autofirmado no importado como confiable.
- Una copia temporal con un byte modificado se identifica como HashMismatch; esa copia no se ejecuta ni se distribuye.
- El certificado público exportado no contiene clave privada. No se agrega a los almacenes de raíces de confianza.
- El instalador original y su checksum se conservan. La variante autofirmada tiene nombre y checksums propios; ver SIGNING.md.

## P4a — eventos locales, cursores y seguimiento (24/10/2026)

- Suite actual: 30 pruebas aprobadas, 0 fallos, sobre presupuestos temporales.
- Mutación/evento en una transacción; fallo inducido de INSERT y rollback; agrupación de importaciones y recurrentes.
- Snapshot consistente bajo escrituras concurrentes; páginas y replay; rechazo de cursores incompatibles, ramas divergentes y huecos de historial.
- CLI event-snapshot/events/watch: permiso explícito, opciones, JSON/archivo/stdin, NDJSON y JSON-seq, salida lenta, cancelación y pipe cerrado.
- MCP: herramientas de eventos bajo concesión específica, sin habilitar escritura.
- Salida abrupta de proceso sin cerrar SQLite: operación sin commit no persiste y operación confirmada conserva su evento. No simula corte eléctrico o daño de disco.
- No hay nuevos endpoints HTTP, política granular P1, entrega externa P4b ni instalador nuevo publicado.
- Verificación final de P4a: ejecutable Tauri con runtime actualizado arranca en presupuesto temporal, responde HTTP 200 y sirve Chart.js local. Launcher nemein.cmd help enumera los nuevos comandos. No se recompiló ni publicó un instalador nuevo.
## Descarga MCP — respuesta visible (24/10/2026)

- Reproducción en Tauri con presupuesto temporal: descarga real válida en Descargas; faltaba aviso en la página.
- Se verifica cabecera Content-Disposition y que el JSON desplegable coincide con la descarga. Suite completa 30/30 aprobada.
- Interacción en navegador local: el clic actualiza el estado accesible y la alternativa muestra el JSON. La ventana Tauri corregida arrancó; la herramienta de automatización no pudo completar allí los clics por falta de geometría, por lo que la comprobación del nuevo estado se hizo en el navegador local.
- Fuente y runtimes actualizados; sin recompilación Rust ni nuevo instalador.
## Configuración MCP estable (24/10/2026)

- 32/32 pruebas aprobadas.
- Resolución de instalación y rechazo de target, desktop-resources, árboles Git e instalaciones incompletas.
- Sin instalación: página funcional con aviso y exportación 503 NEMEIN_NOT_INSTALLED.
- Pruebas con instalaciones sintéticas; sin instalación NSIS real ni instalador nuevo en esta etapa. P1/P2 pendientes.
## P1/P2 — permisos y propuestas, versión local 0.2.0 (24/10/2026)

- 48/48 pruebas del comando del proyecto aprobadas, con bases temporales. Incluyen límites, revocación/rotación/versiones, idempotencia, aprobación única, modificación/rechazo, conflictos, archivos offline, paginación y migración concurrente.
- Nueve vectores JSON portables de política y esquema de archivo de propuesta. La evaluación de permisos se comparte entre CLI y MCP.
- Formularios de permisos y propuestas verificados por HTTP directo, con CSRF y controles de origen intactos. El navegador automatizado rechazó el POST por origen; no se completó allí una aceptación interactiva.
- Inspección visual de la nueva pantalla a 360 × 800 y 1441 × 900 efectivos, sin desborde horizontal, incluso con reglas expandidas. Zoom al 200 % y equipo limpio siguen pendientes.
- Ejecutable Tauri 0.2.0 recompilado con el ícono N aprobado. Arranque nativo con presupuesto temporal, HTTP 200, Chart.js local y cierre del motor comprobados.
- Instalador NSIS generado y ejecutado como actualización de la instalación existente. Registro y runtime confirman 0.2.0. Copia SQLite previa conservada; no se ingresaron ni modificaron movimientos financieros personales.
- Ejecutable e instalador firmados con el certificado autofirmado de Innova-tech y sello de tiempo. Windows sigue indicando raíz no confiable; no se agregó confianza al certificado.
- MCP probado desde Node y módulos de la instalación, usando sólo datos temporales: configuración estable, denegación predeterminada, lectura concedida, propuesta aprobada y revocación inmediata.
- La release pública v0.1.0 permanece intacta. No se publicó v0.2.0. Las configuraciones anteriores deben reenlazarse con un token creado manualmente por el propietario.
- HTTP/OpenAPI/SSE, sincronización entre dispositivos, plugins WASM y entrega externa P4b no forman parte de esta entrega.

## Migraciones numeradas y formularios — código 0.2.1 (24/10/2026)

- 58/58 pruebas aprobadas: las 48 anteriores y diez escenarios de migración.
- SQL histórico congelado de los tags v0.1.0 y v0.2.0; actualización de esas bases y del esquema intermedio de eventos, con datos ficticios.
- Preservación de movimientos conciliados, saldos, categorías propias, metas, recurrentes, tokens, reglas, solicitudes, propuestas y cursor/identidad. Sin historia financiera inventada.
- Secuencia 1–5, registro con nombre/hash/fecha, hashes independientes de CRLF/LF y actualización completa bajo una transacción inmediata.
- Reapertura idempotente, prefijo numerado pendiente, tres aperturas concurrentes, rollback de un fallo tardío y posterior reintento. Se rechazan versiones futuras, historial alterado y bases no reconocidas.
- Reproducción real en navegador del POST de conexión con Origin:null causado por Referrer-Policy:no-referrer. Se cambia a same-origin; un clic real crea la conexión y la cabecera enviada conserva el origen local.
- Se mantienen los rechazos de Origin:null, origen ajeno, otro puerto, Host ajeno y CSRF inválido. No se agregan excepciones para WebView ni se elimina la guarda de origen.
- Ejecutable 0.2.1 compilado y comprobado con presupuesto temporal: HTTP 200, Chart.js local y cierre del motor.
- La automatización de ventanas Windows no respondió; el clic se verificó en navegador y el arranque nativo mediante la prueba de escritorio.
- Instalación local 0.2.1 confirmada por registro NSIS y runtime. Firma de aplicación e instalador de Innova-tech con sello de tiempo; raíz autofirmada sin confianza pública automática.
- Presupuesto existente respaldado antes de actualizar. Migración real al esquema 5 verificada comparando huellas de todos los registros previos, sin diferencias.
- MCP de la instalación comprobado con datos temporales: denegación inicial, lectura concedida, aprobación de propuesta y revocación. Arranque y cierre nativo instalado comprobados con presupuesto temporal.
- Archivos del código instalado comparados con el checkout. La release pública 0.2.0 no se modifica y 0.2.1 no se publica en esta etapa.
## Preparación 0.2.2 — privacidad y gates de calidad (24/10/2026)

- Configuración MCP sin token visible, con BUDGET_AGENT_TOKEN_FILE; prioridad del archivo sobre un token heredado. MCP/CLI conservan compatibilidad con la variable anterior.
- Archivos restringidos al usuario y SYSTEM en Windows. ACL efectiva comprobada; creación exclusiva, formato y errores probados. El token permanece como secreto local sin cifrado adicional.
- Configuraciones nuevas requieren runtime 0.2.2; se rechazan LocalCache de MSIX, árboles de desarrollo y enlaces fuera de la instalación. Los clientes se reenlazan desde la instalación normal de Windows.
- ESLint sin advertencias, PBT/fuzzing y mutación ampliada a cuatro módulos. Primer intento 84,11 % rechazado; tras reforzar pruebas, 95,08 % (348/366), sin timeouts ni errores, con umbral 90 % intacto.
- rustfmt y Clippy locales pasan con advertencias tratadas como errores. Ejecución remota del workflow en preparación; no se afirma todavía su aprobación.
- Actualizados csv-parse y zod y corregidas dependencias indirectas afectadas; npm audit informa cero vulnerabilidades.
- Las migraciones SQL numeradas permanecen inalteradas y se conserva el esquema 5. El instalador 0.2.2 se prepara para ejecución desde el Explorador; no se instala de nuevo desde el contexto MSIX de Codex.
