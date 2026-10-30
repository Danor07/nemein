# Eventos y cursores

src/events.js registra una mutación financiera y su evento en la misma transacción. Las llamadas internas de importaciones y recurrentes se agrupan; un rollback no deja un evento de éxito. No se reconstruye historia anterior al registro inicial ni se usa event sourcing.

## Contrato de lectura

eventSnapshot({month}) devuelve {version:1,cursor,snapshot,goals,recurring} en una misma transacción de lectura. Es una proyección mensual, no una exportación completa.

readEvents({after,limit=100}) devuelve {version:1,events:[{cursor,event}],cursor,hasMore}. El máximo es 1000 eventos por página. Una página vacía conserva el cursor anterior. El consumidor persiste el cursor después de procesar y deduplica por source + id.

El cursor es opaco y no concede acceso. Identifica el presupuesto, la secuencia y un evento de anclaje. Otro presupuesto, una posición futura, un anclaje perdido o reemplazado y un hueco de historia producen errores explícitos. No se fusionan escritores independientes.

Un snapshot puede establecer una nueva base tras un hueco interior. Una cola de historial borrada requiere recuperar la historia. No hay purga automática.

## CLI y MCP

CLI ofrece event-snapshot, events y watch. MCP ofrece snapshot_eventos y eventos. Requieren los permisos de sus acciones; BUDGET_EVENTS_READ ya no autoriza acceso.

watch --after CURSOR admite NDJSON o JSON-seq, límites, intervalo de consulta, cancelación, salida lenta y pipe cerrado. --once entrega una página. El seguimiento continuo requiere permitir; un pedido en preguntar genera una propuesta y termina.

Cada registro tiene {version,cursor,event}. event usa CloudEvents 1.0; su payload identifica la operación y no contiene cambios suficientes para reconstruir saldos. Para obtener detalles se solicita otro snapshot autorizado. Los esquemas están en src/contracts/.

## Errores y límites

INVALID_CURSOR, INVALID_EVENT_LIMIT, CURSOR_MISMATCH, EVENT_HISTORY_GAP y EVENT_READ_IN_TRANSACTION identifican errores de lectura. AUTH_REQUIRED, VERSION_MISMATCH y PERMISSION_DENIED corresponden al control de acceso.

Las lecturas ordinarias no aceptan una transacción financiera sin confirmar. La aprobación manual de una consulta usa una transacción controlada para guardar respuesta y decisión juntas.

Las pruebas cubren atomicidad, concurrencia del snapshot, replay, restauración, ramas divergentes y recuperación después de una salida abrupta de proceso. No simulan daño físico de disco. La [API local v1](api-local.md) expone `event-snapshot`, `events` y `GET events/stream` (SSE) con el mismo cursor y los mismos permisos. SSE requiere `events: allow` y `Last-Event-ID` desde el primer acceso, vuelve a comprobar permisos durante el flujo y cierra ante salida lenta. El cliente persiste después de procesar y deduplica `source + id`; el aviso no sustituye la recuperación por cursor. La entrega durable a servicios externos sigue pendiente (P4b).
