# Conector de ejemplo: Banco Ficticio (CSV)

El banco, su formato y todas las muestras son **inventados**. Sirve para probar el recorrido completo y como plantilla para conectores de bancos reales. Contrato general: [docs/conectores.md](../../../../docs/conectores.md).

## Formato

UTF-8, con BOM opcional. Separador `;`. Un campo puede ir entre comillas `"`, duplicándolas adentro (`""`); un campo entre comillas no admite saltos de línea. Se aceptan finales de línea `\n` o `\r\n` y se ignoran las líneas vacías. Ninguna línea tiene más de 5 campos.

```text
BANCO FICTICIO;EXTRACTO
Cuenta;FIC-0001
Desde;2026-10-01
Hasta;2026-10-31
Fecha;Referencia;Descripción;Débito;Crédito
2026-10-02;R-0002;Mercado del barrio;85000;
2026-10-09;R-0003;"Farmacia; turno noche";42000;
```

- Primera línea: exactamente `BANCO FICTICIO;EXTRACTO`.
- Encabezado, en cualquier orden y sin repetir: `Cuenta` (obligatoria), `Desde` y `Hasta` (las dos o ninguna, inclusivas).
- Fila de columnas: exactamente `Fecha;Referencia;Descripción;Débito;Crédito`.
- Cada movimiento: fecha `AAAA-MM-DD` real; referencia única en el archivo; descripción con texto; un solo importe, en Débito o en Crédito, entero positivo sin signo, separadores ni ceros a la izquierda, hasta 10^12.

## Mapeo al lote v1

| Lote | Origen |
| --- | --- |
| `provenance.source` | `banco-ficticio:` + Cuenta |
| `provenance.connector`, `version` | Manifiesto: `nemein.example.fictitious-bank-csv`, versión del crate |
| `period` | Desde/Hasta, o `null` si faltan |
| `account_id` | `context.account-id`, decidido por el anfitrión |
| `entries[].date` | Fecha |
| `entries[].payee` | Descripción, tal como está escrita |
| `entries[].amount` | −Débito o +Crédito |
| `entries[].category_id` | Siempre `null`: las categorías las resuelve y fija el anfitrión |
| `entries[].id` | `entry_id([id del manifiesto, account-id, Cuenta, Referencia])` |

La identidad no depende de la posición, la descripción, el importe, el período ni la versión: un extracto que se superpone con otro anterior repite las mismas identidades y el anfitrión los marca como duplicados.

## Configuración

Vacía, o una sola línea `cuenta=<Cuenta del extracto>`. Con ella, un extracto de otra cuenta se rechaza con `CONNECTOR_ACCOUNT_MISMATCH`, para no importar en la cuenta local equivocada. Cualquier otra cosa se rechaza con `CONNECTOR_INVALID_CONFIG` antes de leer el archivo.

## Errores

El archivo se rechaza completo ante el primer problema, con el número de línea física cuando corresponde. Códigos: `CONNECTOR_INVALID_CONTEXT`, `CONNECTOR_INVALID_CONFIG`, `CONNECTOR_ACCOUNT_MISMATCH`, `CONNECTOR_ENCODING`, `CONNECTOR_FORMAT`, `CONNECTOR_INVALID_DATE`, `CONNECTOR_INVALID_PERIOD`, `CONNECTOR_OUTSIDE_PERIOD`, `CONNECTOR_INVALID_TEXT`, `CONNECTOR_INVALID_AMOUNT`, `CONNECTOR_DUPLICATE_REFERENCE` y `CONNECTOR_LIMIT` (más de 20.000 movimientos).

El conector comprueba que las fechas existan en el calendario; el rango 1900–2200 y el resto del contrato los vuelve a validar el anfitrión.

## Archivos de prueba

`fixtures/extracto.csv` es la entrada; `fixtures/extracto.batch.json` es la salida exacta con `account-id` `"1"`, y `fixtures/manifest.json` es el manifiesto. Las pruebas Rust comparan esos bytes, tanto en la compilación nativa como en el componente ejecutado con wasmtime. `test/connector-contract.test.js` los valida con `validateImportBatch` y recalcula las identidades en Node.
