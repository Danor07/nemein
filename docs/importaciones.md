# Contrato de importación v1

Un lote describe movimientos para revisar antes de confirmar. Los productores incorporados son CSV, OFX y CAMT.053; sus comandos, permisos, previsualización, deduplicación y resultados comparten el mismo recorrido. Validar un lote no autoriza escrituras. CLI/MCP y la interfaz HTTP del propietario siguen pasando por `import-preview`/`import`, el motor de permisos y las propuestas existentes.

Esquema: [import-batch.v1.schema.json](../src/contracts/import-batch.v1.schema.json), JSON Schema 2020-12, `$id: urn:nemein:schema:import-batch:1`. `version: 1` identifica el formato; un cambio incompatible tendrá otro número y esquema. Los campos desconocidos se rechazan. Ajv compila en modo estricto, sin coerción, eliminación de propiedades ni valores por defecto.

```json
{
  "version": 1,
  "provenance": {
    "source": "fixture:bank:account-a",
    "connector": "fixture.csv",
    "version": "1.0.0"
  },
  "period": { "from": "2024-02-01", "to": "2024-02-29" },
  "currency": "PYG",
  "amount_unit": "integer",
  "account_id": 1,
  "entries": [
    {
      "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "date": "2024-02-29",
      "payee": "Café",
      "amount": -85000,
      "category_id": 1
    }
  ]
}
```

Todos los datos del ejemplo son ficticios; la identidad de ejemplo no corresponde a una transacción real.

| Campo | Regla v1 |
| --- | --- |
| `provenance` | Fuente lógica, identificador de conector y versión de conector; textos con contenido de hasta 512, 160 y 80 caracteres respectivamente. Sin tokens ni secretos. La procedencia es declarada, no autentica a nadie. |
| `period` | Obligatorio: `null` si se desconoce o `{from,to}` inclusivos. Las fechas deben ser reales, entre 1900 y 2200, y `from <= to`. Todas las entradas deben estar dentro. No deducir cobertura del primer/último movimiento. |
| `currency`, `amount_unit` | Sólo `PYG` y `integer`: guaraníes enteros, sin cambio de moneda. |
| `account_id` | Cuenta local de destino resuelta por el anfitrión: entero positivo seguro en JSON. |
| `entries` | Entre 0 y 20.000 movimientos. Cero permite extractos vacíos y CSV con sólo encabezados. |
| `entries[].id` | Identidad estable SHA-256, 64 caracteres hexadecimales minúsculos. Única dentro del lote. |
| `entries[].date` | Fecha real `YYYY-MM-DD`, entre 1900 y 2200. |
| `entries[].payee` | Texto con contenido, hasta 160 caracteres. |
| `entries[].amount` | Número JSON entero distinto de cero; −10^12 a 10^12 inclusivos. Negativo gasto, positivo ingreso. No strings, separadores, símbolos ni fracciones. |
| `entries[].category_id` | Entero positivo seguro en JSON o `null`. Cuenta/categoría existentes y categoría obligatoria para gastos se comprueban en el núcleo al confirmar. |

Los tipos y límites del esquema son sólo parte del contrato. [validateImportBatch](../src/import-contract.js) agrega fechas reales, orden/cobertura del período e identidades únicas. Recibe un objeto ya parseado y devuelve ese mismo lote sin modificarlo; falla completo, nunca omite entradas inválidas. Un anfitrión futuro debe limitar bytes antes de parsear JSON y nunca ejecutar el contenido recibido. El CSV conserva su límite actual de 5 MB antes de parsearlo.

## Identidad y reintentos

Cada productor debe documentar cómo obtiene `id`: hash de una identidad que incluya fuente/cuenta e identificador original estable. No agregar versión de conector, período ni posición absoluta de fila a la identidad; esos cambios no deben duplicar hechos. Dos movimientos legítimos idénticos necesitan identidades distintas. Una identidad ya guardada se considera duplicada, no una orden de actualizar importes. La identidad no demuestra autenticidad.

El CSV conserva exactamente su algoritmo anterior: SHA-256 UTF-8 de `JSON.stringify([Number(account_id), date, payee.toLocaleLowerCase("es"), amount]) + "#" + occurrence`, con ocurrencia desde 1 entre filas canónicamente iguales. Declara `provenance: {source:"csv",connector:"nemein.csv",version:"1"}` y `period:null`; no inventa nombre de banco ni cobertura. Cambiar textos o importes cambia la identidad. La ambigüedad entre extractos parciales con movimientos idénticos del mismo día permanece; revisarlos antes de confirmar.

El productor CSV construye el lote después del mapeo, validación del dominio y resolución de categorías por memoria/configuración. La proyección de sus entradas mantiene exactamente `{headers,rows}` con `date,payee,amount,category_id,import_key,duplicate`. `duplicate` lo calcula el núcleo contra la base; ningún productor puede afirmarlo en el lote. La confirmación vuelve a producir/validar dentro de una transacción; registra movimientos, memoria, mapeo y eventos de forma atómica. No se reciben filas de una vista previa como autorización.

## Errores

El validador lanza un `Error` con `code`. El código es la salida estable para pruebas de conformidad; el mensaje explica la causa. Primero valida estructura, luego período, luego entradas en orden (fecha, cobertura, identidad).

| Código | Causa |
| --- | --- |
| `IMPORT_INVALID_BATCH` | Versión, campos, tipos, límites o formato del esquema incorrectos. |
| `IMPORT_INVALID_DATE` | Una fecha de período o movimiento no existe o está fuera de 1900–2200. |
| `IMPORT_INVALID_PERIOD` | Período invertido. |
| `IMPORT_OUTSIDE_PERIOD` | Movimiento fuera del período declarado. |
| `IMPORT_DUPLICATE_ID` | Dos entradas del mismo lote repiten identidad. |

No hay una lista de errores dentro de un lote v1 ni importaciones parciales. Los productores futuros deben informar sus errores de lectura fuera del lote. Los errores de lectura/mapeo CSV y su presentación por CLI/MCP/HTTP se conservan; estos códigos no los sustituyen. Los errores y decisiones de permisos, propuestas y conflictos siguen sus contratos existentes.

## Conformidad y límites de esta entrega

[Vectores compartidos](../test/fixtures/import-vectors.json): `valid` contiene `{name,batch}` y `invalid` contiene `{name,code,batch}`. Un conector futuro puede probar su salida contra el esquema y la semántica anteriores; un validador compatible debe aceptar todos los válidos y rechazar cada inválido con el código indicado. Ejecución de referencia: `node --test test/import-contract.test.js`. Propiedades y fuzzing usan semillas fijas; `npm run quality` incluye la mutación de decisiones nuevas en `stryker.import.config.mjs`, mínimo 90 %, sin timeouts, errores ni falta de cobertura.

P15 publica el formato y el productor CSV interno; P8 incorpora OFX y CAMT.053 como productores puros. No agrega una acción pública que acepte lotes JSON arbitrarios ni concede capacidades nuevas. El validador y los parsers no acceden a SQLite, red ni permisos. El presupuesto funciona sin conectores.

No se persisten lotes, procedencia ni cobertura y no se requieren migraciones SQL: las identidades usan `transactions.import_key` existente. No se puede demostrar cobertura completa de extractos con este formato en memoria. Persistencia/reanudación, comprobantes/adjuntos, conciliación con movimientos manuales, otras monedas, transferencias automáticas, WASM y JMAP quedan fuera de esta entrega.

## Extractos estándar (P8, primera entrega)

En la pantalla de importación, elegí el formato, archivo, cuenta local de destino y categoría inicial. OFX/CAMT no necesitan mapear columnas. La vista previa y el botón de confirmación son los mismos del CSV; al confirmar se vuelve a parsear y validar dentro de la transacción existente. Un error de lectura, fila o identidad repetida rechaza el archivo completo, sin movimientos, memoria, mapeo ni eventos parciales. Un identificador ya registrado en otra importación aparece como duplicado y se omite, incluso si el banco cambió su descripción o importe. No se actualiza el movimiento existente. Importar un extracto no toca el mapeo CSV guardado de la cuenta.

CLI/MCP y API local mantienen `import-preview` e `import`, con `account_id`, `content` y `config`. `config.format` admite `csv` (predeterminado), `ofx` o `camt053`; un formato desconocido se rechaza. Para enviar bytes originales, usar `config.content_encoding: "base64"` y `content` en base64 canónico. La UI lo hace para ambos formatos estándar. CLI lee el JSON de `--file` o `--stdin`, no un extracto crudo. Ejemplo ficticio del sobre, preparando `content` con los bytes de un archivo local:

```js
const request = {
  account_id: 1,
  content: bytes.toString("base64"),
  config: { format: "ofx", content_encoding: "base64", category_id: 1 },
};
// nemein.cmd import-preview --file solicitud.json
// Revisar antes de pedir import con el mismo sobre y los metadatos de propuesta.
```

El lote se produce en `src/statement-import.js`; categorías por memoria/configuración, permisos, propuestas, deduplicación contra SQLite y confirmación siguen a cargo del anfitrión. No hay dependencias nuevas, WASM, conectores de bancos ni cambios de esquemas/acciones públicas. CSV conserva sus claves históricas mediante `importIdentity` compartido, así como sus errores de fila.

### Perfil admitido

- OFX 1.x SGML (`OFXHEADER:100`, `DATA:OFXSGML`, sin seguridad/compresión) con hojas cerradas u omitidas, y OFX 2.x XML. Una sola cuenta/extracto bancario `STMTRS` o de tarjeta `CCSTMTRS` por archivo. Se exige `ACCTID`; se consideran `BANKID`, `BRANCHID` y `ACCTTYPE` al identificar la fuente. `DTPOSTED` conserva su día escrito sin conversión horaria; `TRNAMT` determina el signo; descripción desde `NAME`, `PAYEE/NAME` o `MEMO`, en ese orden. En OFX 1.x el cuerpo empieza en `<OFX>`, haya o no línea en blanco tras el encabezado. `DTSTART`/`DTEND` se conservan como período declarado, o `null` si faltan ambos.
- OFX 1.x respeta `ENCODING:USASCII` con `CHARSET:1252`, `ISO-8859-1` o `NONE` (ASCII estricto), y `ENCODING:UTF-8`/`UNICODE` para UTF-8. Un charset desconocido o bytes inválidos falla explícitamente. Texto Unicode ya decodificado con caracteres no ASCII y encabezado de charset legado se rechaza: enviar bytes/base64. XML admite UTF-8 y rechaza otras codificaciones declaradas.
- CAMT usa el espacio de nombres `urn:iso:std:iso:20022:tech:xsd:camt.053.001.NN`, con prefijo o predeterminado, un `BkToCstmrStmt/Stmt` y cuenta `IBAN` u `Othr/Id` con emisor opcional. Produce **una entrada por `Ntry`**, sin repartir ni recalcular totales de sus operaciones internas. Cada `Ntry` debe tener estado `BOOK` en `Sts` o `Sts/Cd`; un movimiento pendiente, informativo o sin estado rechaza el archivo. `Amt/@Ccy` debe ser PYG; si existe `Acct/Ccy`, también. `CRDT` suma y `DBIT` resta, incluso en reversiones: no se invierte el signo otra vez. Se exige fecha contable `BookgDt/Dt` o `DtTm`, conservando su día escrito; no se sustituye por fecha valor. `FrToDt` se conserva si existe; no se infiere cobertura de las entradas.
- CAMT toma la descripción de `AddtlNtryInf`; si falta, de una única `NtryDtls/TxDtls`: nombre del acreedor/deudor según el signo (directo o bajo `Pty`), `AddtlTxInf` o textos `RmtInf/Ustrd`. Sin descripción o con detalle ambiguo se rechaza; no se inventa un beneficiario. Extractos con varias cuentas deben separarse fuera de Nemein. No se valida el XSD completo ni se promete admitir toda extensión de un banco.
- Sólo guaraníes enteros distintos de cero dentro del límite v1. La notación estándar `120.00` es exacta y se acepta; cualquier fracción no nula, exponente o separador local se rechaza, aunque `Number` pudiera redondearla. Nunca se cambia moneda ni escala a centavos. OFX con `CURRENCY`/`ORIGCURRENCY` se rechaza por requerir interpretación adicional.

### Identidad y seguridad

Con referencia externa, `id` es SHA-256 UTF-8 de `JSON.stringify([format, account_id, sourceHash, externalId])`. `sourceHash` es SHA-256 del identificador de cuenta del extracto: OFX `[BANKID,BRANCHID,ACCTID,ACCTTYPE]`, CAMT `[IBAN u Othr/Id, Othr/Issr o ""]`. No contiene posición de fila, versión de parser, descripción, importe ni período. OFX usa `FITID`; CAMT usa `AcctSvcrRef` de `Ntry` o, si falta, `NtryRef`. Referencias repetidas dentro del archivo producen `IMPORT_DUPLICATE_ID`, incluso si sus importes difieren.

Si no hay referencia, se reutiliza **el algoritmo histórico CSV documentado arriba**, contando ocurrencias entre las filas sin referencia. Es una identidad por contenido, no una referencia bancaria: cambiar descripción/importe cambia la clave, y extractos parciales con hechos idénticos siguen siendo ambiguos. Revisarlos antes de confirmar. No se inventan referencias ni se agregan identidades aleatorias.

El parser es puro, acotado y no resuelve recursos externos. Máximos: **5.000.000 bytes originales**, base64 de hasta 6.666.668 caracteres antes de decodificar, **20.000 entradas**, **64 niveles**, **250.000 elementos** y **4.096 caracteres por etiqueta**. Tokeniza incrementalmente; los bucles recorren secuencias finitas y no usan cursores como condición de avance. Se rechazan DOCTYPE, declaraciones de entidades, referencias numéricas o propias, CDATA y comentarios. Sólo se decodifican, una vez, las cinco entidades predefinidas de XML (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`). En OFX 1.x SGML no hay DTD posible, así que un `&` suelto se conserva como texto. No se elimina contenido para hacer pasar un archivo. Cierre incompleto, múltiples raíces, campos únicos repetidos o estructura ambigua fallan antes de producir el lote.

Los errores de productor llevan `code`: `IMPORT_FORMAT`, `IMPORT_CHARSET`, `IMPORT_LIMIT`, `IMPORT_UNSAFE_XML`, `IMPORT_INVALID_STATEMENT`, `IMPORT_CURRENCY`, `IMPORT_AMOUNT` y `IMPORT_INVALID_DATE`. Los errores por entrada agregan `Fila N` y preservan `cause`/`code`; después se aplican los códigos del contrato v1. La UI conserva su presentación de mensajes y los transportes su sobre de errores existente.

### Pruebas y revisión

Las muestras de `test/fixtures/statements.js` son ficticias y escritas a mano. Regresión en `test/statement-import.test.js`, flujo protegido en `test/statement-workflow.test.js`, lector UI en `test/import-ui.test.js` (DOM simulado, sin afirmar revisión visual) y CLI/MCP/HTTP en `test/import-transports.test.js`. Propiedades y fuzzing de extractos usan semillas fijas. Un worker prueba etiquetas/base64 patológicos con un plazo de 2,5 s y termina siempre en `finally`; una prueba adicional verifica la guarda con un worker bloqueado intencionalmente. Así una regresión o mutante que bloquee esos casos falla como aserción antes del plazo externo de Stryker. Esto no sustituye medir los mutantes: `npm run mutation:import` mantiene el umbral 90 y el gate rechaza Timeout, error y NoCoverage. En esta entrega la ejecución de mutación y el commit quedan a cargo del revisor por instrucción expresa.

Los cinco factores: utilidad (extractos sin mapear columnas), responsabilidad (parser puro → contrato; anfitrión → dominio), contrato (v1 y errores anteriores), pruebas de frontera (regresión/PBT/fuzz/alcance de mutación) y desconexión (CSV y presupuesto siguen operando sin usar estos formatos). No hay persistencia nueva ni dependencias opcionales que condicionen abrir el presupuesto.

Referencias de formato: [OFX Banking 2.3, FDX](https://financialdataexchange.org/common/Uploaded%20files/OFX%20files/OFX%20Banking%20Specification%20v2.3.pdf) y [Bank-to-Customer Cash Management, ISO 20022](https://www.iso20022.org/sites/default/files/documents/messages/mdr_part_2/ISO20022_MDRPart2_BankToCustomerCashManagement_2018_2019_v1_0.pdf). El perfil anterior delimita lo implementado, no sustituye esas especificaciones.
