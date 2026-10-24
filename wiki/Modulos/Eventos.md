---
tipo: modulo
actualizado: 2026-10-24
verificado-en: c084aa9 + cambios locales 0.2.0
estado: P4a implementado, integrado con P1
---

# Eventos y lectura consistente

src/events.js registra las operaciones financieras en la misma transacción que sus cambios. src/event-reads.js ofrece eventSnapshot y readEvents. src/access.js agrega los [permisos y propuestas](Permisos-y-propuestas.md).

## Escritura

Una mutación y su evento se confirman o revierten juntos. Importaciones y recurrentes agrupan llamadas internas en un solo evento. Rechazos y rollback no dejan eventos de éxito. Un UPDATE al mismo valor cuenta como operación aplicada; las consultas, backups, políticas y propuestas no producen hechos financieros.

El registro inicial de una base existente empieza vacío y no inventa historia. Tablas contables actuales siguen siendo la fuente; no se implementa event sourcing.

## Snapshot y cursor v1

eventSnapshot({month}) devuelve {version:1,cursor,snapshot,goals,recurring}: presupuesto mensual, metas de ese mes y recurrentes en una misma transacción de lectura. Es una proyección, no una exportación completa.

readEvents({after,limit=100}) devuelve {version:1,events:[{cursor,event}],cursor,hasMore}, hasta 1000 por página. Orden local, cursor por evento; una página vacía conserva el cursor previo. El consumidor guarda su avance después de procesar y deduplica por source + id.

El cursor opaco contiene presupuesto, secuencia e ID de anclaje. Se rechaza si corresponde a otro presupuesto, una posición futura o un evento perdido/reemplazado tras restauración. Un prefijo intacto conserva validez; copiar una base idéntica no genera una identidad nueva. No se soporta fusión de dos escritores en copias independientes.

Los huecos de historia se informan. Un snapshot puede establecer línea de base tras un hueco interior; una cola borrada requiere recuperar la base/historia. No hay purga automática.

Las lecturas normales no se llaman dentro de una transacción financiera no confirmada. La aprobación de una propuesta de consulta usa una transacción administrada por el revisor, sin cambios financieros previos, para conservar respuesta y decisión juntas.

## Acceso

CLI: event-snapshot, events y watch. MCP: snapshot_eventos y eventos. Desde 0.2.0 requieren sus reglas P1; BUDGET_EVENTS_READ ya no habilita acceso.

watch --after CURSOR admite NDJSON/json-seq, límites, intervalo de consulta, cancelación, salida lenta y EPIPE. --once entrega una página. Si leer eventos está en preguntar, devuelve la propuesta y termina: un seguimiento continuo requiere permiso de lectura.

La envoltura del flujo es {version,cursor,event}; event sigue CloudEvents 1.0. Payloads sólo indican operation, no cambios suficientes para reconstruir saldos. Los detalles se consultan con un nuevo snapshot autorizado.

## Errores

INVALID_CURSOR, INVALID_EVENT_LIMIT, CURSOR_MISMATCH, EVENT_HISTORY_GAP y EVENT_READ_IN_TRANSACTION describen errores de posición. P1 agrega AUTH_REQUIRED, VERSION_MISMATCH y PERMISSION_DENIED. No se salta una historia incompatible ni se acepta una propuesta sin intervención humana.

## Validación y pendiente

Pruebas de atomicidad, visibilidad entre conexiones, reapertura, migración, salida abrupta antes/después de commit, snapshot concurrente, replay, restauración y ramas divergentes. CLI/MCP y políticas verificadas con bases temporales.

P4b (entrega durable por destino) espera un adaptador concreto. Sin HTTP nuevo ni sincronización automática.
