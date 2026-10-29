# Contrato de importación v1

Un lote describe movimientos para revisar antes de confirmar. El primer productor es el CSV incorporado; sus comandos, permisos, errores, previsualización, deduplicación y resultados se conservan. Validar un lote no autoriza escrituras. CLI/MCP y la interfaz HTTP del propietario siguen pasando por `import-preview`/`import`, el motor de permisos y las propuestas existentes.

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

P15 publica el formato y el productor CSV interno. No agrega una acción pública que acepte JSON arbitrario ni concede capacidades nuevas. Los futuros adaptadores deben integrar previsualización y confirmación mediante acciones explícitas protegidas; el validador no accede a SQLite, red ni permisos. El presupuesto funciona sin conectores.

No se persisten lotes, procedencia ni cobertura y no se requieren migraciones SQL: las identidades usan `transactions.import_key` existente. No se puede demostrar cobertura completa de extractos con este formato en memoria. Persistencia/reanudación, comprobantes/adjuntos, conciliación con movimientos manuales, otras monedas, transferencias automáticas, WASM, OFX/camt.053, JMAP y la API HTTP abierta quedan para sus entregas específicas.
