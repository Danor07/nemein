---
tipo: modulo
actualizado: 2026-10-24
verificado-en: 1c4cca5 + cambios locales P4
estado: P4a utilizable por CLI y MCP con concesión explícita de lectura
---

# Registro y lectura interna de eventos

Código: src/events.js, src/event-reads.js y frontera de openBudget en src/core.js. Payload: src/contracts/budget-changed.schema.json. Pruebas: test/events.test.js y test/event-reads.test.js.

**MEDIDO:** 30/30 pruebas pasan. Registro, cursores, snapshot, lectura por CLI/MCP y watch funcionan con la concesión explícita descrita abajo. P1 sigue pendiente. HTTP sigue fuera del alcance.

## Contrato de escritura

- Precondiciones: validaciones existentes dentro de la transacción. P1 sigue pendiente.
- Postcondición: una operación que escribe confirma sus cambios y un evento juntos, preservando su retorno original.
- Invariante: fallo al insertar evento revierte la operación completa; misma conexión y bloqueo de escritura antes de validar el estado.
- Rechazos y rollback no dejan eventos de éxito.
- Sin escrituras SQLite no hay evento. Un UPDATE al mismo valor cuenta como escritura: se informa operación aplicada, no necesariamente diferencia de valores.
- Importaciones y recurrentes agrupan llamadas anidadas en un evento. Previsualizaciones, respaldos y migraciones no generan eventos de dominio.

## Catálogo

createAccount, addTransaction, allocate, transfer, reconcile (confirmación), importCsv, categorize, createGroup, createCategory, deleteTransaction, setGoal, removeGoal, createRecurring, postRecurring y toggleRecurring.

Una nueva mutación debe añadirse al catálogo y sus pruebas. SQL directo elude esta frontera y no es interfaz soportada para agentes.

## Contrato de lectura v1

### eventSnapshot({ month })

Devuelve { version: 1, cursor, snapshot, goals, recurring }.

- El snapshot tiene el mismo formato mensual de budget.snapshot; goals se calcula para ese mismo mes y recurring incluye las programaciones actuales.
- Es una proyección mensual para consultas; no es una exportación completa ni un backup.
- La primera lectura fija el estado SQLite y la posición del registro. Todas las consultas siguientes se ejecutan en la misma transacción de lectura, incluso si otro proceso confirma cambios entre ellas.
- El cursor representa todos los eventos confirmados hasta ese corte. Los cambios posteriores se consultan con readEvents.
- Sin month se usa el mes elegido por snapshot y se reutiliza para las metas.

### readEvents({ after, limit = 100 })

after es obligatorio y se obtiene de eventSnapshot o de una lectura anterior. limit debe ser entero entre 1 y 1000. Devuelve:

    { version: 1, events: [{ cursor, event }], cursor, hasMore }

- Entrega eventos posteriores a after, en orden local. Cada evento lleva una posición para reanudar después de procesarlo.
- El cursor de la página es el último entregado; una página vacía conserva after.
- hasMore refleja el corte de esa lectura; false no significa que nunca habrá eventos nuevos.
- La misma lectura puede repetirse. El consumidor persiste primero su resultado y después el cursor; deduplica por source + id.
- Los eventos son señales para refrescar consultas: contienen operation, no deltas suficientes para reconstruir el presupuesto.
- Ambas lecturas rechazan invocaciones dentro de una transacción ya abierta: nunca devuelven cursores que apunten a escrituras aún sin confirmar.
- Leer no crea eventos ni cambia el presupuesto.

### Identidad y restauración

El cursor v1 codifica source, secuencia e ID del último evento. El consumidor lo trata como token opaco. Es una posición, **no una credencial**, firma o barrera de seguridad.

Se valida su forma, presupuesto, secuencia no futura y coincidencia del evento de anclaje. Al restaurar un backup que perdió el anclaje, o crear otra rama que reutiliza su número con otro UUID, el cursor se rechaza. Si la historia hasta ese punto sigue intacta, el cursor sigue siendo válido; no se detecta toda copia/restauración como un cambio de generación.

Una copia idéntica de la base conserva source e historia. No se soportan dos escritores independientes sincronizando copias: cada consumidor debe conservar la relación con su presupuesto de origen.

No hay purga automática. Durante lectura se detectan huecos entre el cursor y la página, y también borrado de la cola mediante el máximo de AUTOINCREMENT. Un snapshot nuevo puede establecer una línea de base tras un hueco interior, porque ya contiene el estado actual; una cola borrada requiere recuperar el historial/base. Ediciones SQL arbitrarias o reescrituras de sqlite_sequence no están soportadas.

### Errores estables

| code | Qué hacer |
|---|---|
| INVALID_CURSOR | Token mal formado o versión no soportada: obtener nuevo snapshot. |
| INVALID_EVENT_LIMIT | Corregir límite. |
| CURSOR_MISMATCH | Otro presupuesto, posición futura o anclaje cambiado/perdido: reconstruir proyección desde snapshot actual. |
| EVENT_HISTORY_GAP | Historia incompleta: no saltar eventos silenciosamente; recuperar base o establecer línea de base si snapshot lo permite. |
| EVENT_READ_IN_TRANSACTION | Terminar la transacción llamadora antes de leer. |

## Persistencia y privacidad

event_identity guarda source opaco por presupuesto; budget_events guarda secuencia, UUID y sobre CloudEvents 1.0. Su payload operation está descrito en JSON Schema 2020-12. Sin argumentos originales, montos, comercios, rutas ni credenciales. Horarios y tipos siguen siendo metadatos sensibles. El snapshot contiene datos financieros y requiere autorización al exponerse a terceros.

Migración idempotente sin historia inventada; conserva datos y user_version contable. Reabrir conserva identidades. Las nuevas lecturas no requieren otra migración.

## Verificación y pendiente

**MEDIDO:** rollback, fallo inducido de INSERT, visibilidad entre conexiones, reapertura, migración, catálogo y agrupación; paginación, replay, posición por evento, rechazo de tokens/límites, otro presupuesto, restauración real de backup y rama divergente; concurrencia durante snapshot de movimientos/metas/recurrentes; detección de huecos; lectura sin escrituras.

Las pruebas de schema existentes comprueban catálogo/payload; no certifican toda la especificación. Se ejecutó la prueba de salida abrupta sin cierre de SQLite; ver el alcance de esa prueba más abajo.

Pendiente: política granular P1 y entrega P4b. [Plan](../Plan.md).

## Acceso por terminal y MCP

P4a tiene acceso local explícito: event-snapshot, events y watch requieren BUDGET_EVENTS_READ=1. La comprobación ocurre antes de abrir la base desde CLI y también en la ejecución compartida de comandos. El permiso de escritura MCP no concede lectura del historial. Con ese permiso específico, MCP registra snapshot_eventos y eventos.

Es una concesión por proceso/presupuesto, no la política granular P1. Para revocarla desde la configuración externa, detener/reiniciar los procesos sin la variable. La comprobación se repite por página; editar variables de otro shell no altera el entorno de un proceso ya iniciado.

watch ofrece NDJSON y JSON-seq con el mismo registro version/cursor/event. Valida opciones, limita páginas, espera la escritura antes de seguir, admite cancelación y termina sin error ante EPIPE. No persiste el avance por el consumidor ni confirma efectos externos. --once entrega una sola página; una página completa puede tener eventos pendientes.

Consultar los ejemplos y parámetros en [README](../../README.md#eventos-locales-para-workflows). Schema de registro: src/contracts/event-stream.schema.json; el validador debe registrar también el schema del payload por su $id.

La prueba de interrupción usa process.exit antes de cerrar SQLite, dentro o después de la transacción; comprueba recuperación del WAL y atomicidad. No simula corte de energía o fallos del disco.

Pendiente de P4: política granular P1 y entrega durable por destino P4b cuando exista un adaptador real. No se agregaron interfaces HTTP.
