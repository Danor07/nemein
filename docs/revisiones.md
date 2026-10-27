# Revisiones periódicas con evidencia (P13, contrato 1)

La revisión reúne datos de Nemein; una IA externa elegida por el usuario puede redactar el informe. Nemein no incluye proveedor ni programador propio. La base guarda el paquete exacto y el texto; abrirlos no los marca como revisados.

## Acciones y permisos

| CLI / acción MCP | Entrada | Resultado |
|---|---|---|
| `review-package` | `{from,to,as_of}` con fechas ISO reales | Paquete versión 1 calculado en una transacción de lectura |
| `review-save` | `{id,package,report,generator}` | `{id,created_at}`; el identificador estable permite reintentos |
| `review-list` | `{offset}` opcional, entero no negativo | Hasta 50 entradas, offset y total |
| `review-get` | `{id}` | Informe, paquete, autor autenticado, redactor declarado y fechas |

MCP usa `ejecutar_accion` con el nombre de acción y `arguments`; CLI acepta JSON, `--file` y `--stdin`. Cada acción requiere su permiso propio, negado por defecto. El permiso de preparar y consultar paquetes advierte que los datos salen hacia la IA elegida por el usuario. La conexión que lee determina su destino real; Nemein no elige ni llama a un proveedor. La identidad de quien guarda se obtiene de la conexión, mientras que `generator` declara quién redactó (por ejemplo, modelo y versión).

`review-save` admite «preguntar» con `_purpose`, `_base` y `_request_id` según el protocolo existente. Su `_base` es la base de la propuesta financiera vigente; `package.cursor` identifica el corte del informe. Un resultado `pending` se resuelve en la bandeja y no se reenvía como otra mutación. Marcar como revisado es exclusivo del propietario mediante `owner()` y no existe como acción para agentes.

## Paquete versión 1

- `version: 1`, `currency: "PYG"`, `unit: "integer"`.
- `period: {from,to}` para métricas y evidencia; `as_of` para saldos y metas. Se exige `from <= to <= as_of <= hoy` del equipo. `time_zone` declara la zona del runtime; las fechas contables son días locales, sin conversión a UTC. `cursor` corresponde al mismo snapshot de lectura.
- `recorded`: cuentas y saldos hasta el corte, última conciliación por cuenta hasta ese corte (o null), `ready`, categorías, métricas del período, desglose por categoría y metas con fondos reales. Las asignaciones de meses futuros siguen reservadas en «Por presupuestar». La configuración actual de metas/categorías se aplica al corte: no se reconstruye una configuración que luego se borró o cambió.
- `projected.upcoming`: próximo vencimiento de cada recurrente activo, incluidos atrasados. Es la configuración conocida en el cursor, no un historial reconstruido ni una expansión futura; P14 ampliará esto.
- `coverage: "not_declared"`: no se afirma que el extracto esté completo.
- `evidence`: IDs, fechas, cuentas, categorías, beneficiarios, importes y tipo de los movimientos del período. Máximo 5000 movimientos y 2 MB UTF-8 por paquete; importes fuera del rango entero seguro de JSON se rechazan.

El contrato de `snapshot` existente mantiene sus saldos de todas las fechas. La revisión reutiliza el cálculo financiero con un corte explícito. Transferencias y pagos de tarjeta no se suman como gastos; reintegros reducen el gasto de su categoría. La evidencia permite localizar movimientos; el paquete completo permite inspeccionar categorías y cifras.

## Guardado y revisión

El guardado recalcula el paquete dentro de su transacción y exige igualdad de datos y cursor. En esta primera versión, si cambió el presupuesto mientras la IA redactaba, responde `REVIEW_STALE`: obtener otro paquete y revisar la redacción antes de guardar. Esto impide persistir cifras alteradas como si las hubiese calculado Nemein, sin agregar firmas ni otro registro de paquetes. Un reintento de un informe ya guardado con el mismo ID, autor y contenido devuelve el resultado original aunque el presupuesto haya cambiado; contenido diferente produce `REVIEW_ID_REUSED`.

Un informe guardado es inmutable salvo su `reviewed_at`. Se conserva el corte original y se muestra su fecha. `report` puede estar vacío si falla la IA y admite hasta 100000 bytes UTF-8; `generator` entre 1 y 160 caracteres no vacíos; IDs de 1 a 100 letras ASCII, dígitos, guion o guion bajo. El texto se presenta escapado, sin HTML, Markdown ni enlaces activos. Las cifras calculadas, lo previsto y las sugerencias están separados.

La migración 006 crea sólo la tabla `reviews`. Guardar y marcar revisión no están en `eventOperations`, no generan `budget.changed` y no mueven el cursor financiero. La auditoría de permisos continúa funcionando. El backup SQLite incluye las revisiones; la exportación financiera P9a conserva su contrato y no incluye informes de IA.

## Programación externa

Completar primero el [respaldo P5](respaldos.md). El workflow del usuario ejecuta `review-package`, pasa el resultado a su IA y llama a `review-save`; conserva un ID de ejecución para reintentar. Si la IA falla, guarda el paquete con `report: ""`. Consultar `review-get` requiere otro permiso. Para probar sin IA, la ventana ofrece «Guardar paquete».

En el Programador de tareas, usar `powershell.exe` y una línea como esta, adaptada al workflow **ya elegido por el usuario**:

```powershell
-NoProfile -NonInteractive -File "C:\Mis workflows\revision-financiera.ps1"
```

Ese archivo es del usuario y llama a la CLI instalada con su conexión; no se incluye un adaptador nuevo en Nemein. Elegir frecuencia, habilitar ejecución posterior a una programación omitida y evitar instancias simultáneas. Requiere equipo encendido, datos accesibles y disponibilidad de la IA. No se crea una tarea automáticamente ni se promete recuperar períodos omitidos. Comparaciones entre revisiones, cobertura de extractos y adaptador de referencia quedan para una ampliación basada en el uso.
