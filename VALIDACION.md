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