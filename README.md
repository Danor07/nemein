# Nemein — presupuesto personal local

Nemein toma su nombre de la idea de asignar y distribuir: darle un destino al dinero que ya tenés.

Primera versión pública experimental. Código abierto bajo licencia MIT. Presupuesto base cero en guaraníes, con acceso para agentes mediante CLI y MCP.

Aplicación de presupuesto base cero en guaraníes enteros. Interfaz de escritorio Tauri 2, servidor Express con páginas EJS, SQLite mediante better-sqlite3 y gráficos Chart.js locales. Sin usuarios, telemetría, credenciales bancarias ni sincronización bancaria.


## Descargar para Windows

La primera versión pública experimental está en [GitHub Releases](https://github.com/Danor07/nemein/releases/tag/v0.1.0). Descargá el instalador para Windows x64; incluye Node.js y sus dependencias. Requiere WebView2. El instalador original no tiene firma. También se ofrece una variante `selfsigned`, firmada con un certificado autofirmado de Innova-tech; Windows no confía en él automáticamente. Ver [firma de código](SIGNING.md).

Los archivos de la release incluyen `SHA256SUMS.txt` para verificar la integridad. El instalador y el código fuente no contienen bases de datos ni configuración personal.

## Abrir y desarrollar

Requisitos de desarrollo: Node.js 22+, Rust y las herramientas C++ de Visual Studio para Tauri en Windows; WebView2 instalado. El paquete de escritorio incluye su propio Node y las dependencias: no requiere Node instalado para el usuario final.

```powershell
npm ci
npm run desktop:dev
```

Para generar el instalador:

```powershell
npm run desktop:build
```

La preparación incluye las licencias de Node y las dependencias Rust. Si tu instalación de Node no trae un archivo LICENSE junto al ejecutable, indicá su ubicación con `NODE_LICENSE_PATH` antes de compilar. Las dependencias Rust deben estar disponibles en la caché local de Cargo; podés prepararla con `cargo fetch --manifest-path src-tauri/Cargo.toml`.

El instalador NSIS queda en `src-tauri/target/release/bundle/nsis/`. También se puede usar como aplicación web local:

```powershell
npm start
```

La consola imprime la URL en 127.0.0.1 con un puerto libre. Nunca escucha en la red local. La ventana Tauri inicia y termina su servidor local automáticamente.

## Dónde están tus datos

En Windows, por defecto:

- Base: `%LOCALAPPDATA%\PresupuestoCero\budget.db`.
- Copias: `%LOCALAPPDATA%\PresupuestoCero\backups\budget-AAAA-MM-DD.db`.

La variable `BUDGET_DATA_DIR` permite elegir otra carpeta, tanto para escritorio como para servidor, CLI y MCP. Todos deben usar la misma carpeta para compartir el presupuesto.

La base usa WAL y claves foráneas. Se respalda con la API de backup de SQLite (no se copia solamente el archivo mientras el WAL está abierto). Se hace una copia al primer arranque de cada día; mientras la app permanece abierta se comprueba cada hora. Se guardan las últimas 30 copias diarias. No se hacen copias cuando la aplicación está cerrada. La copia de hoy preserva el primer estado respaldado ese día.

Para restaurar: cerrá escritorio, servidor, CLI y MCP; guardá una copia de la carpeta de datos completa; reemplazá budget.db con la copia elegida y retirá los archivos budget.db-wal y budget.db-shm anteriores antes de volver a abrir. No combines archivos WAL de una base con otra. Las copias en el mismo disco no protegen contra pérdida del equipo.

## Primer uso

1. En **Cuentas y categorías**, agregá una cuenta y su saldo inicial a una fecha concreta.
2. En **Presupuesto**, asigná importes a categorías. El encabezado Por presupuestar queda en cero cuando todo el dinero disponible tiene un destino; se pone rojo si asignás de más.
3. Cargá gastos manualmente o importá el CSV semanal. No importes movimientos anteriores ya incluidos en el saldo inicial.
4. Conciliá con el extracto del banco.

Importes manuales y por CLI: `85000`, sin separadores ni decimales. Se muestran como `Gs. 85.000`. Negativos para gastos, positivos para ingresos. Los ingresos sin categoría alimentan Por presupuestar; un reintegro positivo con categoría restaura el saldo de esa categoría.

La disponibilidad de una categoría es la suma de asignaciones y actividad hasta el mes seleccionado. Los saldos negativos también pasan al mes siguiente. Las asignaciones de meses futuros ya reservan dinero, para evitar asignarlo dos veces.

### Tarjetas y transferencias

La deuda inicial de una tarjeta se ingresa con signo negativo y reduce Por presupuestar. Las compras se categorizan como gastos. El pago de la tarjeta se registra como transferencia desde la cuenta bancaria, sin duplicar gastos. Este modelo reserva dinero para cubrir toda la deuda y no reproduce el sistema especial de categorías de pago de YNAB, cuotas ni intereses automáticos.

### Conciliación

Elegí cuenta, fecha de extracto y saldo bancario real. Marcá los movimientos que aparecen en ese extracto. Los ya conciliados se suman automáticamente hasta esa fecha. **Calcular diferencia** no cambia datos. Solo se puede **Confirmar conciliación** cuando la diferencia es cero. Los seleccionados pasan a liquidados y conciliados; no pueden borrarse. Se puede corregir su categoría sin alterar fecha ni importe.

## Mapear el CSV de tu banco por primera vez

1. Exportá CSV en UTF-8, con encabezados. Si el banco entrega Excel, guardalo como CSV UTF-8.
2. Abrí **Importar CSV**, elegí la cuenta de destino y pulsá **Cargar mapeo guardado**.
3. Seleccioná el archivo. Elegí su separador: coma, punto y coma o tabulación.
4. Asociá las columnas **fecha**, **beneficiario/descripción** e **importe** con sus encabezados reales.
5. Indicá fecha dd/mm/aaaa o aaaa-mm-dd, y miles sin separador, con punto o con coma.
6. Elegí una categoría inicial para los gastos de beneficiarios desconocidos. Los conocidos usan su categoría recordada.
7. Pulsá **Revisar importación**. Comprobá importes, fechas, categorías y duplicados, y luego **Confirmar importación**.
8. Ajustá categorías en **Movimientos → Cambiar categoría**. Se recordarán para próximas importaciones.

Todos los importes y beneficiarios de los ejemplos son ficticios. `examples/banco-ejemplo.csv` usa punto y coma, fecha dd/mm/aaaa y miles con punto.

```csv
Fecha;Descripción;Importe
01/10/2026;Salario;5.000.000
02/10/2026;Supermercado;-185.000
```

Se requiere una sola columna con importes firmados. Si tu banco separa Débito y Crédito, prepará una columna Importe = Crédito - Débito antes de importar. No se aceptan fracciones de guaraní ni símbolos monetarios en las celdas.

La importación valida el archivo completo antes de guardar. Límite: 5 MB y 20.000 filas. El mapeo se guarda por cuenta después de confirmar. La vista previa vence a los 30 minutos y al cerrar la aplicación.

Los positivos del CSV se clasifican inicialmente como ingresos; los reintegros se pueden recategorizar después. Las filas de transferencias y pagos de tarjeta deben excluirse del CSV y registrarse con el formulario de transferencias. Las operaciones manuales no se fusionan automáticamente con importaciones.

La deduplicación compara cuenta + fecha + beneficiario + importe + número de ocurrencia dentro del archivo. Reimportar el mismo extracto no duplica registros y dos filas idénticas en el mismo extracto se conservan. Si dos extractos parciales contienen distintas operaciones idénticas del mismo día, sin identificador bancario no se pueden distinguir: revisá esos casos antes de confirmar. No cambies los textos ni importes de un archivo ya importado esperando que actualice operaciones.

## CLI para agentes

Los comandos usan el mismo motor y validaciones que la interfaz. El resultado es JSON; los errores van a stderr con código de salida no cero.

```powershell
npm run cli -- help
node src/cli.js snapshot '{"month":"2026-10"}'
node src/cli.js account '{"name":"Efectivo","type":"efectivo","balance":100000,"date":"2026-10-01"}'
node src/cli.js transaction '{"account_id":1,"date":"2026-10-16","payee":"Mercado","amount":-25000,"category_id":1}'
node src/cli.js allocate '{"month":"2026-10","category_id":1,"amount":300000}'
node src/cli.js reports '{"month":"2026-10"}'
```

Otros comandos: `transfer`, `import`, `reconcile`, `backup`. El importador recibe `{account_id,content,config}`; config contiene `date,payee,amount,delimiter,dateFormat,thousands,category_id`. La conciliación recibe `{account_id,date,balance,ids,commit}`; `commit:false` solo calcula y `commit:true` confirma cuando la diferencia es cero.

## MCP local propio

`src/mcp.js` ofrece MCP por stdio, sin puerto externo. Consulta presupuesto y reportes por defecto. Para habilitar registro de movimientos y asignaciones, configurá explícitamente `BUDGET_MCP_WRITE=1`.

Ejemplo de configuración para un cliente MCP que use command/args/env:

```json
{
  "mcpServers": {
    "nemein": {
      "command": "node",
      "args": [
        "RUTA_ABSOLUTA_AL_PROYECTO/src/mcp.js"
      ],
      "env": {
        "BUDGET_DATA_DIR": "RUTA_A_TU_CARPETA_DE_DATOS"
      }
    }
  }
}
```

Usá la ruta real de Node o la copia que genera `desktop:prepare` en `desktop-resources/runtime/node.exe`. No se configura automáticamente ningún cliente.

Los datos quedan locales; si conectás un agente que usa un modelo en la nube, lo que ese agente consulte puede enviarse a su proveedor.

## Validación

```powershell
npm test
```

Pruebas con bases temporales: dinero entero y fechas, acumulación y sobreasignación, transferencias y tarjeta, importaciones atómicas/deduplicación/memoria, conciliación y bloqueo, integridad y retención de backups, SSR/CSRF/Host/origen, flujo HTTP completo, reportes y reintegros.

`node scripts/preview.js` abre una vista previa con datos ficticios en `.preview-data/`, separada del presupuesto real.

## Estructura

- `src/core.js`: dominio, validación, migración inicial, SQLite y backups.
- `src/server.js`: HTTP local, formularios y páginas SSR.
- `views/`, `public/`: interfaz y gráficos sin CDN.
- `src/cli.js`, `src/mcp.js`: acceso de agentes al mismo motor.
- `src-tauri/`: ventana nativa y ciclo de vida del proceso Node.
- `scripts/prepare-desktop.js`: empaqueta Node, módulos nativos y archivos locales.

Para detalles sobre almacenamiento y agentes, consultá [PRIVACIDAD.md](PRIVACIDAD.md).

En Windows PowerShell 5, preferí pasar JSON por archivo para evitar el escape de comillas: `node src/cli.js snapshot --file examples/consulta.json`. También se admite `--stdin`.

## Mejoras del 23/10/2026

Después de compilar con `npm run desktop:build`, podés abrir `Abrir Nemein.cmd` en Windows. El código fuente está en el repositorio y el instalador está en GitHub Releases. Los datos personales quedan fuera de ambos.

- **Resumen**: ingresos, gastos netos, categorías sin cubrir y próximos vencimientos.
- **Metas y pagos**: objetivos por categoría y fecha. El progreso usa fondos disponibles; no crea ahorro ficticio. Recurrentes semanales, mensuales o anuales, con pausa/reactivación y registro explícito de cada vencimiento. Los días 29–31 se ajustan al último día de meses cortos y recuperan su día original en el mes siguiente.
- **Movimientos**: búsqueda por beneficiario/categoría y filtro por cuenta, dentro del mes seleccionado.
- **Reportes**: cruce cuenta × categoría y totales conservados. El motor `cube` permite hasta tres dimensiones (month/day/account/category/payee), con fechas inicial y final. Consulta directamente SQLite con dimensiones permitidas y conserva los totales entre agrupamientos.
- **Agentes y terminal**: configuración MCP descargable y CLI con `nemein.cmd`. Copiá `nemein-mcp.example.json` como `nemein-mcp.json`, reemplazá la ruta genérica por la ruta absoluta del proyecto e importalo en tu cliente. El archivo local queda excluido de Git.

Comandos nuevos: overview, search, goals, goal-set, goal-remove, recurring, recurring-create, recurring-post, recurring-toggle, cube, category y group. Consultá AGENTS.md para parámetros.

No se ejecutan pagos bancarios ni se registran recurrentes automáticamente. Registrar un vencimiento crea un movimiento local y avanza la fecha. Un reintento del mismo vencimiento devuelve error sin duplicar.

## Licencia

MIT. Ver [LICENSE](LICENSE). Las dependencias mantienen sus respectivas licencias.

Compatibilidad: la carpeta de datos sigue siendo `%LOCALAPPDATA%\PresupuestoCero` para conservar los presupuestos existentes. El identificador de instalación también se mantiene.

## Eventos locales para workflows

Esta versión del código agrega snapshot consistente, lectura paginada y seguimiento por terminal. El instalador v0.1.0 publicado todavía no contiene estos cambios.

Habilitá la lectura para el proceso que conectás al presupuesto:

```powershell
$env:BUDGET_EVENTS_READ = '1'
$cut = (.\nemein.cmd event-snapshot --file examples/consulta.json | ConvertFrom-Json).result
.\nemein.cmd watch --after $cut.cursor
```

Conservá la proyección de $cut junto con su cursor. El snapshot reúne el presupuesto mensual, metas y recurrentes en un mismo corte. Cada cambio posterior aparece en el flujo aunque se haya registrado mientras se armaba ese snapshot.

- event-snapshot recibe {month}; devuelve {version,cursor,snapshot,goals,recurring}.
- events recibe {after,limit}; devuelve {version,events:[{cursor,event}],cursor,hasMore}. Límite predeterminado 100, máximo 1000.
- watch acepta JSON, --file, --stdin o flags: --after CURSOR, --limit 100, --poll-ms 1000, --format ndjson|json-seq, --once.
- --once entrega como máximo una página y termina; puede haber más eventos. Reanudar con el cursor del último registro entregado.
- El modo continuo consulta cada segundo cuando está al día (intervalo entre 100 y 60000 ms); procesa páginas pendientes sin esa espera. Sólo se ejecuta mientras el usuario o su herramienta lo mantiene abierto.
- Cada registro es {version:1,cursor,event}. JSON-seq usa RS + JSON + LF según RFC 7464; el sobre event es CloudEvents 1.0, y la envoltura con cursor es el contrato propio de Nemein.
- stdout contiene sólo registros; errores JSON con code en stderr y salida no cero. Ctrl+C detiene el seguimiento. Un pipe cerrado (EPIPE) termina normalmente.
- El consumidor guarda su cursor después de persistir lo procesado y deduplica por source + id. Los eventos indican qué operación ocurrió; para consultar saldos o detalles se usa otro snapshot.
- Un cursor no es una credencial. Cursores incompatibles o historia incompleta producen errores explícitos; ver [el contrato](wiki/Modulos/Eventos.md).

BUDGET_EVENTS_READ=1 es una concesión específica para leer el historial y snapshots de ese presupuesto en ese proceso. No habilita escritura. Quitar la variable de la configuración del cliente y reiniciar sus procesos revoca la concesión; la política granular P1 sigue pendiente.

En MCP, esa misma variable agrega las herramientas snapshot_eventos y eventos. El seguimiento continuo es un comando de terminal; no imprime registros sueltos dentro del protocolo MCP. BUDGET_MCP_WRITE sigue controlando escritura por separado.

Los contratos JSON están en src/contracts/. No se agregan endpoints HTTP ni servicios de nube.
