# Verificación — mejoras del 23/10/2026

- Suite completa: 13 pruebas aprobadas, 0 fallos.
- Cliente MCP real: lectura predeterminada, escritura explícita, cuenta y recurrente de prueba, rechazo del segundo registro del mismo vencimiento y consulta del cubo.
- Metas calculadas con disponible real, recurrentes de fin de mes y año bisiesto, pausas, búsqueda y conservación de totales con reintegros y transferencias.
- Flujos HTTP, CSRF, origen y Host, importación CSV, conciliación y respaldos diarios verificados con bases temporales.
- Código fuente y ambos runtimes de escritorio actualizados; ejecutable nativo existente arrancó, sirvió HTTP 200 y Chart.js local, y cerró su motor al terminar.
- CLI comprobada mediante cero.cmd; configuración MCP de ejemplo incluida en el repositorio.
- Inspección visual del resumen y formulario de metas en el navegador integrado (991 × 810, sin desborde horizontal). No se completó un guardado interactivo allí: el navegador integrado presentó un origen distinto y el servidor lo rechazó. Las mutaciones se verificaron por HTTP directo y MCP; no se relajó el control de origen.
- No se verificaron visualmente 360 × 800, 1440 × 900 ni zoom al 200 %. No se recompiló el instalador NSIS antiguo; la entrega local usa el ejecutable existente con su runtime actualizado.
- Pruebas con datos ficticios; no se modificaron registros financieros personales ni bases de otros proyectos.
