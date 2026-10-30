# API local v1

La primera porción de P9c expone las acciones existentes por HTTP, con los mismos permisos, propuestas, auditoría y reglas del presupuesto que CLI/MCP. Es optativa: iniciá Nemein con `BUDGET_LOCAL_API=1`. Comparte el proceso y puerto de la interfaz, que escucha sólo en `127.0.0.1`. Al desactivarla, UI, CLI y MCP siguen funcionando.

La URL aparece en la salida de arranque como `BUDGET_URL=http://127.0.0.1:PUERTO`. Agregá `/api/v1`. No hay un puerto fijo de API; `PORT` permite fijar el del servidor local. Para desarrollar o probar, usá siempre `BUDGET_DATA_DIR` temporal con datos ficticios. No ejecutes los ejemplos sobre tu presupuesto personal.

## Conexión y seguridad

Creá una conexión desde **Permisos y propuestas**, guardá su configuración y concedé manualmente las acciones necesarias. Las conexiones empiezan sin permisos. Se usa el mismo token P1 que CLI/MCP, exclusivamente en:

```http
Authorization: Bearer TOKEN_DE_CONEXION
Nemein-Connection-Version: 1
Content-Type: application/json
```

El segundo encabezado es opcional y su valor predeterminado es `1`: es la versión de la conexión, independiente de API v1 y de la revisión del catálogo. Renovar el token invalida el anterior; revocar la conexión o cambiar sus reglas afecta las llamadas posteriores. Una lectura iniciada puede terminar después de revocarse.

No se aceptan credenciales por cookies, argumentos ni query string. Ninguna ruta admite query string. `Host` debe coincidir exactamente con `127.0.0.1:PUERTO` del socket. `Origin`, si aparece, debe coincidir exactamente con `http://127.0.0.1:PUERTO`, también para GET. No se confía en encabezados de proxy. No hay CORS ni preflight habilitado; un sitio remoto no tiene una excepción por conocer el token. Es protección contra solicitudes de navegador y DNS rebinding, no aislamiento frente a programas del mismo usuario del sistema.

## Rutas y sobres

| Método y ruta | Contrato |
|---|---|
| `GET /api/v1/openapi.json` | Documento generado, con autenticación |
| `POST /api/v1/{action}` | Acción del catálogo o consulta de conexión ya disponible en CLI/MCP |
| `POST /api/v1/calls` | Lote secuencial de esas mismas llamadas |

El catálogo completo, los argumentos y las acciones de escritura están en [OpenAPI generado](openapi.v1.json). Incluye `permissions` (permisos propios) y `proposal-status` (propuesta propia). No ofrece administración de conexiones, reglas ni resolución de propuestas. Las lecturas de estado y cambios son las acciones `event-snapshot` y `events`.

Una llamada individual envía:

```json
{
  "arguments": { "name": "Grupo ficticio" },
  "base": "CURSOR_OPACO_DEL_SNAPSHOT",
  "request_id": "fixture-group-001",
  "purpose": "Preparar un grupo de prueba"
}
```

`arguments` es obligatorio, incluso si es `{}`. El sobre y los argumentos rechazan campos desconocidos; el núcleo conserva las validaciones semánticas, fechas reales y reglas de dinero. No se convierten tipos. Los esquemas Zod compartidos con las herramientas MCP describen la estructura; los JSON Schema existentes se incluyen en OpenAPI. Donde todavía no existe esquema detallado de resultado, el resultado se declara abierto y se conserva la estructura del núcleo.

Una respuesta correcta es `{ "ok": true, "result": ... }`; un método sin retorno entrega `null`. Un error es:

```json
{
  "ok": false,
  "error": {
    "code": "STATE_CONFLICT",
    "message": "The budget changed. Read a new state before writing."
  }
}
```

El código es el identificador estable; el texto puede cambiar y no debe usarse para decidir. Se ocultan detalles de errores internos de SQLite y del sistema de archivos.

## Estado, cambios y escritura con base

1. `event-snapshot` con `arguments.month` devuelve `{version:1,cursor,snapshot,goals,recurring}` consistente. Es una proyección mensual.
2. `events` con `arguments.after` devuelve `{version:1,events,cursor,hasMore}`. `limit` va de 1 a 1000 (predeterminado 100). Cada elemento tiene `{cursor,event}` y el evento conserva CloudEvents 1.0.
3. Persistí el cursor después de procesar la página y deduplicá por `source + id`. Una página vacía conserva el cursor. Los eventos avisan de operaciones; para detalles se vuelve a leer estado autorizado. [Contrato de eventos y recuperación](eventos.md).
4. Toda acción marcada `write` en el catálogo exige `base`: el cursor observado. El núcleo comprueba esa base dentro de la misma transacción de permisos y escritura. Si cambió, devuelve `STATE_CONFLICT` sin aplicar la acción ni crear la propuesta. Una base inválida devuelve `INVALID_CURSOR`; de otro presupuesto, `CURSOR_MISMATCH`. El cliente solicita un estado nuevo con su permiso de lectura y decide de nuevo; no se fusionan cambios automáticamente.

Usá un `request_id` único para cada escritura y conservá exactamente su acción, argumentos y base al reintentar tras una pérdida de respuesta. Un replay idéntico devuelve el resultado guardado antes de comprobar la base que esa escritura pudo haber avanzado. Usar el ID con otra entrada devuelve `REQUEST_ID_REUSED`. La denegación vigente prevalece sobre el replay. Los reintentos HTTP y los antiguos sin condición CLI/MCP tienen identidades separadas; no intercambies un mismo ID entre transportes con contratos distintos. Las lecturas permitidas ordinarias no guardan una respuesta idempotente; conservan el comportamiento de P2.

Con permiso `ask`, la respuesta correcta contiene `result.status: "pending"`, `proposal_id` y `request_id`. No repitas la mutación para aprobarla: consultá `proposal-status` con `arguments.id`. Sólo el propietario acepta, modifica o rechaza desde la bandeja. Al resolver se vuelven a comprobar permiso y base. Si se retiró el permiso de la respuesta, tampoco se entrega por esta consulta. [Permisos y propuestas](permisos-y-propuestas.md).

## Llamadas agrupadas

```json
{
  "calls": [
    { "id": "state", "action": "event-snapshot", "arguments": { "month": "2026-10" } },
    { "id": "own-permissions", "action": "permissions", "arguments": {} }
  ]
}
```

La respuesta es `{ "results": [{"id":"state","action":"event-snapshot","ok":true,"result":...}, ...] }`, en orden. Un fallo de llamada contiene `ok:false,error` y no detiene las siguientes. **No hay atomicidad de lote ni referencias entre resultados.** Cada acción conserva su propia transacción. Dos escrituras distintas con la misma base pueden producir un éxito y un conflicto; agruparlas no las vuelve compatibles.

El sobre completo y los IDs únicos se comprueban antes de la primera ejecución. Los argumentos y los errores de acción se resuelven por llamada. Un lote válido devuelve HTTP 200 aunque haya errores individuales; inspeccioná todos los resultados. No reintentes automáticamente el lote completo. Perder la respuesta HTTP no demuestra que las acciones no se ejecutaron.

## Versiones, códigos y límites

Versión inicial: **1.0.0**, bajo `/api/v1`. La versión de Nemein y la de los formatos de importación/exportación son independientes. Cambios compatibles agregan campos u opciones y aumentan la versión menor; cambiar rutas, significado, tipos, unidades o códigos incompatiblemente requiere `/api/v2`. Los clientes toleran campos nuevos de respuesta, pero nunca convierten códigos desconocidos en éxito.

Antes de retirar una versión habrá aviso público en esta documentación y notas de versión durante **al menos 90 días y dos versiones estables**, lo que dure más. Actualmente no hay versiones de API deprecadas.

| HTTP individual o error del sobre | Códigos principales |
|---|---|
| 400 | `INVALID_REQUEST`, `INVALID_ARGUMENTS`, `INVALID_JSON`, `INVALID_CURSOR`, `BASE_REQUIRED`, validaciones de dominio |
| 401 | `AUTH_REQUIRED` (incluye token inválido, renovado o revocado) |
| 403 | `INVALID_HOST`, `INVALID_ORIGIN`, `PERMISSION_DENIED` |
| 404 | `API_DISABLED`, `NOT_FOUND`, `PROPOSAL_NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `STATE_CONFLICT`, `PROPOSAL_CONFLICT`, `REQUEST_ID_REUSED`, `VERSION_MISMATCH`, `CURSOR_MISMATCH`, `EVENT_HISTORY_GAP` |
| 413 | `BODY_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 500 | `INTERNAL_ERROR` |

Límites del adaptador: JSON UTF-8 sin compresión, **12.000.000 bytes** por cuerpo y **16 llamadas** por lote. IDs de correlación ASCII únicos de 1 a 100 caracteres; nombres de acción hasta 64. `request_id` acepta letras ASCII, números, `_` y `-`, hasta 100; `purpose` hasta 500; `base` hasta 1024. Encabezados y tiempos quedan sujetos a los límites del servidor HTTP de Node. Se conservan los límites de cada acción (por ejemplo, importación CSV 5 MB/20.000 filas y exportación 5 MB/20.000 filas). No hay tope agregado de bytes de respuesta ni cuotas por conexión en esta porción; para exportar, preferí una llamada por petición.

## Ejemplo con curl y datos ficticios

Con una instancia **de pruebas**, un token P1 de esa instancia y permisos para `event-snapshot`, `events` y `group`, este ejemplo Bash usa `curl` y `jq`. Reemplazá el puerto por el anunciado al arrancar. El archivo de credencial es el que usa tu conexión CLI/MCP y contiene solamente el token; no compartas ese archivo.

```bash
API='http://127.0.0.1:3000/api/v1'
TOKEN="$(cat "$BUDGET_AGENT_TOKEN_FILE")"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $TOKEN" "$API/openapi.json" > openapi.json

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data '{"arguments":{"month":"2026-10"}}' "$API/event-snapshot" > state.json

BASE="$(jq -r '.result.cursor' state.json)"
jq -n --arg base "$BASE" \
  '{arguments:{name:"Grupo ficticio curl"},base:$base,request_id:"curl-fixture-001",purpose:"Probar la API local"}' \
  > write.json
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @write.json "$API/group"

jq -n --arg after "$BASE" '{arguments:{after:$after,limit:10}}' \
  | curl --fail-with-body --silent --show-error \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      --data-binary @- "$API/events"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data '{"calls":[{"id":"p","action":"permissions","arguments":{}},{"id":"s","action":"event-snapshot","arguments":{"month":"2026-10"}}]}' \
  "$API/calls"
```

Si `group` está en preguntar, el tercer paso devuelve una propuesta pendiente y no aparece un cambio financiero hasta que el propietario la acepte. En Windows usá `curl.exe` para distinguirlo de alias de PowerShell; adaptá la sintaxis del shell. Para iniciar una instancia de desarrollo temporal desde PowerShell:

```powershell
$env:BUDGET_DATA_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ("nemein-api-" + [guid]::NewGuid())
$env:BUDGET_LOCAL_API = "1"
$env:PORT = "3000"
npm.cmd start
```

## Generación y alcance

`npm run openapi:generate` reconstruye `docs/openapi.v1.json`. `npm run lint` verifica que coincida exactamente con el catálogo y los esquemas; no se edita endpoint por endpoint. `src/action-schemas.js` comparte los descriptores MCP; los esquemas de `src/contracts/` se incluyen con referencias locales resolubles. El documento servido se genera con las mismas fuentes y no necesita abrir un presupuesto para generarse.

Este diseño adopta estado, cambios y llamadas agrupadas de [JMAP, RFC 8620](https://www.rfc-editor.org/rfc/rfc8620.html); no implementa el protocolo JMAP. La descripción usa [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0.html) y JSON Schema 2020-12.

Quedan para otras porciones: SSE, webhooks P4b, conectores WASM/WIT P3, OFX/camt.053 P8, entrega de propuestas offline por HTTP, cuotas, orígenes configurables y clientes independientes adicionales de P9b. No se agregan migraciones SQL, sincronización remota ni una segunda implementación del dominio. Las escrituras pasan siempre por `forAgent`; el adaptador no recibe conexión SQLite.
