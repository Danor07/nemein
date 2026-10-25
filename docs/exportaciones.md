# Exportaciones financieras para workflows

Implementación P9a, todavía sin release propia. CLI y MCP comparten la acción `export` y sus validaciones. No se agregan endpoints HTTP ni sincronización automática.

## Permiso y alcance

La acción `export` comienza negada, incluso si la conexión ya tiene permiso de snapshot, reportes o backup. El propietario puede permitirla, pedir revisión o negarla en Permisos y propuestas. Autoriza sacar todos los datos financieros que cubre el formato elegido. Revocar la conexión se comprueba en cada pedido nuevo.

La exportación usa una transacción de lectura: cursor y tablas pertenecen al mismo corte. Una escritura concurrente queda para la siguiente exportación y aparece después de ese cursor. Una exportación no crea movimientos ni eventos financieros; su solicitud sí queda en la auditoría de acceso. Si se pide revisión, la respuesta financiera aprobada también queda en la propuesta.

No incluye tokens, conexiones, permisos, auditoría, propuestas, mapeos bancarios ni memoria de categorización. Los datos exportados siguen siendo privados: cuentas, importes y beneficiarios sí forman parte del contenido.

## Solicitudes y respuesta común

CLI:

```text
nemein.cmd export --file examples/export-json.json
nemein.cmd export --file examples/export-csv.json
```

También acepta JSON por stdin. El lanzador del repositorio es para desarrollo; para uso diario, usá el Node y el cli.js de la instalación estable.

MCP:

```json
{"name":"exportar_presupuesto","arguments":{"format":"json"}}
```

El formato predeterminado es json. La única opción propia es `format`, con json o csv. Las rutas de destino y los nombres de tablas se rechazan. Los metadatos habituales de revisión se envían por los canales existentes.

La CLI conserva su sobre `{ok,result}`. El resultado de exportar tiene:

| Campo | Significado |
| --- | --- |
| version | Versión 1 del contrato |
| source | Identidad del presupuesto |
| cursor | Posición opaca del mismo corte de lectura |
| exported_at | Hora UTC de preparación |
| currency / amount_unit | PYG / integer: guaraníes enteros |
| format / media_type | json con application/json, o csv con text/csv;charset=utf-8;header=present |
| filename | Nombre sugerido y estable, sin datos personales |
| row_count | Filas exportadas; en JSON suma las filas de sus nueve conjuntos |
| content | Texto UTF-8 que el cliente puede guardar |

`content` es una cadena dentro de la respuesta de CLI/MCP. No es una ruta ni un archivo escrito automáticamente. Si la respuesta es pending, todavía no hay exportación: consultá el estado de la propuesta después de la revisión.

Contratos JSON Schema 2020-12: [resultado](../src/contracts/export-result.schema.json) y [documento financiero](../src/contracts/budget-export.schema.json). Se validan al preparar la salida, en modo estricto.

## JSON: documento financiero

Nombre sugerido: `nemein-budget-v1.json`.

Incluye los metadatos y `data`, con estos conjuntos:

- accounts, groups y categories: identificadores, nombres y relaciones.
- allocations: mes, categoría e importe asignado.
- transactions: identificador, cuenta, fecha, beneficiario, importe, categoría, tipo, liquidación, conciliación y vínculo de transferencia.
- reconciliations: cuenta, fecha y saldo conciliado.
- goals: categoría, objetivo y fecha.
- recurring y recurring_occurrences: regla vigente y vencimientos ya registrados.

Los identificadores se conservan dentro del presupuesto identificado por source. Las fechas son AAAA-MM-DD; el mes es AAAA-MM. Los importes son enteros con signo, sin separadores, conversiones ni redondeos. JSON rechaza enteros fuera del rango exacto interoperable de JavaScript, en lugar de aproximarlos. Se leen los enteros SQLite con safeIntegers antes de convertirlos. [RFC 8259 §6](https://www.rfc-editor.org/rfc/rfc8259.html#section-6), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/integer.md).

Los movimientos opening representan saldos iniciales. Los transfer conservan las dos patas y su transfer_key; no son dos gastos. Una ocurrencia puede conservar el identificador de un movimiento borrado: es el registro del vencimiento, no una promesa de que ese movimiento siga presente.

No es un archivo de restauración completa y no se importa automáticamente sobre otro presupuesto. Para restaurar Nemein se usa el respaldo SQLite. La prueba de ida y vuelta verifica serialización y conservación de datos; no implementa una migración entre aplicaciones.

## CSV: movimientos

Nombre sugerido: `nemein-transactions-v1.csv`.

Encabezado fijo:

```csv
"id","account_id","date","payee","amount","category_id","kind","cleared","reconciled","transfer_key"
```

Orden: fecha e identificador ascendentes. Separador coma; todos los campos entre comillas dobles; comillas internas duplicadas; registros CRLF y final CRLF. Codificación UTF-8, sin BOM. Los saltos de línea y espacios del texto se conservan. Perfil documentado por [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180.html).

Una categoría o vínculo nulo se representa como campo vacío. cleared y reconciled son 0 o 1. Los tipos son normal, opening y transfer. No se agregan nombres duplicados ni valores calculados que alteren el total.

Es un CSV para intercambio de datos. Los campos textuales se conservan literalmente; al abrirlo en una planilla, importalos como texto para evitar que se interpreten como fórmulas. Las comillas CSV no desactivan fórmulas. [OWASP](https://owasp.org/www-community/attacks/CSV_Injection).

Este CSV incluye saldos iniciales y transferencias. No debe confirmarse directamente como extracto bancario sobre el presupuesto original: duplicaría datos. El importador bancario existente tiene otro contrato.

## Guardar con PowerShell desde una instalación estable

Partí del JSON de configuración que descargaste para una conexión con el permiso export. El archivo de credencial permanece en su ubicación privada.

```powershell
$connection = (Get-Content -Raw -LiteralPath './nemein-mcp.json' | ConvertFrom-Json).mcpServers.nemein
$env:BUDGET_DATA_DIR = $connection.env.BUDGET_DATA_DIR
$env:BUDGET_AGENT_TOKEN_FILE = $connection.env.BUDGET_AGENT_TOKEN_FILE
$env:BUDGET_AGENT_VERSION = $connection.env.BUDGET_AGENT_VERSION
$cli = Join-Path (Split-Path -Parent $connection.args[0]) 'cli.js'
$responseText = '{"format":"json"}' | & $connection.command $cli export --stdin
if ($LASTEXITCODE -ne 0) { throw 'La exportación falló; revisá el error de la CLI.' }
$response = $responseText | ConvertFrom-Json
if ($response.result.status -eq 'pending') { throw 'La solicitud espera revisión; todavía no hay contenido para guardar.' }
$outputFile = Join-Path $PWD $response.result.filename
[IO.File]::WriteAllText($outputFile, $response.result.content, [Text.UTF8Encoding]::new($false))
```


## Límites y errores

Hasta 20.000 filas y 5.000.000 bytes UTF-8. En JSON, el límite de filas es acumulado entre conjuntos. En CSV cuenta movimientos. Ambos límites incluyen el extremo y se rechaza el exceso sin entregar contenido parcial.

| Código | Causa |
| --- | --- |
| INVALID_EXPORT_OPTIONS | Formato u opción no admitida |
| INVALID_ARGUMENTS | Solicitud que no es un objeto JSON en CLI o guarda de acceso |
| EXPORT_UNSAFE_NUMBER | Entero SQLite que no admite conversión exacta |
| EXPORT_INVALID_VALUE | Dato o metadato fuera del contrato |
| EXPORT_TOO_LARGE | Exceso de filas o bytes |
| EVENT_READ_IN_TRANSACTION | Lectura externa dentro de una transacción sin confirmar |
| EVENT_HISTORY_GAP | Historia sin el corte consistente requerido |
| AUTH_REQUIRED / VERSION_MISMATCH / PERMISSION_DENIED | Conexión o permiso no vigentes |

P9b queda pendiente: declarar revisiones soportadas de acciones y errores para clientes independientes y ampliar otros formatos si aparece un consumidor concreto. Idiomas y monedas configurables siguen fuera de esta entrega.
