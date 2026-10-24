# Migraciones de SQLite

Al abrir un presupuesto, src/core.js llama a src/migrations.js antes de construir las funciones del dominio. Los módulos de planificación, eventos y permisos ya no crean ni alteran tablas.

## Secuencia inicial

| Versión de esquema | Archivo | Cambio |
|---|---|---|
| 1 | 001-budget.sql | Cuentas, categorías, movimientos y tablas del presupuesto |
| 2 | 002-planning.sql | Metas y recurrentes |
| 3 | 003-events.sql | Identidad y registro de eventos |
| 4 | 004-agent-access.sql | Conexiones, reglas, auditoría, solicitudes y propuestas |
| 5 | 005-audit-policy.sql | Regla aplicada en la auditoría |

La versión de esquema es independiente de la versión de la aplicación. schema_migrations guarda número, nombre, SHA-256 y fecha de incorporación. PRAGMA user_version guarda la última versión de esquema completada.

Los hashes normalizan CRLF a LF para que el mismo archivo SQL funcione desde checkouts de Windows y otros sistemas.

## Actualizar bases existentes

Las releases 0.1.0 y 0.2.0 usaban user_version=1, aunque tenían tablas diferentes. Para adoptarlas:

- Se conserva el esquema contable existente y sus datos; no se vuelve a sembrar categorías.
- Se incorporan las tablas que faltan y se registra la secuencia numerada.
- Si la columna de auditoría policy ya existe, se conserva.
- Se mantienen tokens, reglas, solicitudes, propuestas, eventos, secuencias y cursores.
- Un historial de eventos con su identidad perdida se rechaza; no recibe una identidad inventada.

Una base nueva debe estar vacía y en versión 0. Una base con tablas desconocidas y sin versión no se adopta como presupuesto.

Toda la actualización pendiente se ejecuta bajo una transacción inmediata. Se verifica el esquema resultante antes de confirmar. Si falla una etapa, también se revierten las tablas, registros y cambios de versión de las etapas anteriores de ese intento. No se hacen operaciones de red dentro de esa transacción.

La apertura concurrente queda serializada: otro proceso comprueba el registro después de adquirir el bloqueo y no repite lo ya confirmado.

## Agregar una migración

1. Agregar un archivo SQL con el siguiente número en src/migrations/.
2. Agregarlo al final de la lista explícita en src/migrations.js.
3. Actualizar la validación del esquema para las tablas o columnas que cambien.
4. Probar una base nueva, una actualización con datos previos, la reapertura y un fallo con rollback.

Los archivos ya distribuidos son inmutables: las correcciones se hacen con otro número. El registro debe ser continuo y coincidir en nombre y hash. Una discrepancia detiene la apertura con MIGRATION_HISTORY_MISMATCH.

La aplicación rechaza una base con user_version mayor al admitido mediante SCHEMA_TOO_NEW. Un esquema incompleto o no reconocido produce SCHEMA_INCOMPATIBLE.

## Respaldo y compatibilidad

Conservá un backup antes de actualizar. No hay migraciones descendentes automáticas. Para volver a una versión anterior, cerrá todos los procesos y restaurá una copia compatible siguiendo PRIVACIDAD.md. Las releases antiguas anteriores a este control no pueden adquirir retroactivamente la comprobación de versiones futuras.

La tabla registra cuándo se incorporó el esquema al sistema numerado; para bases antiguas esa fecha no es la fecha histórica en que se creó cada tabla.

## Pruebas

test/fixtures/migrations/ contiene SQL congelado extraído de los tags v0.1.0 y v0.2.0. Las pruebas crean bases temporales con esos esquemas, insertan datos ficticios y comparan los registros antes y después de actualizar.

Se comprueban saldos, conciliación, categorías propias, metas, recurrentes, permisos, propuestas, identidad/cursor, reapertura, actualización desde un prefijo numerado, errores tardíos, versión futura, registro alterado y procesos concurrentes. Las pruebas no abren el presupuesto personal.
