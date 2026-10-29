# Nemein — presupuesto personal local

Nemein toma su nombre de la idea de asignar y distribuir: darle un destino al dinero que ya tenés. Es un software de finanzas personales enfocado en workflows.

Presupuesto base cero en guaraníes enteros, con acceso para agentes mediante CLI y MCP. Interfaz de escritorio Tauri 2, servidor Express con páginas EJS, SQLite mediante better-sqlite3 y gráficos Chart.js locales. Sin usuarios, telemetría, credenciales bancarias ni sincronización bancaria.

Versión experimental. Código abierto bajo licencia MIT.

## Descargar e instalar en Windows

Descargá [Nemein 0.4.0](https://github.com/Danor07/nemein/releases/tag/v0.4.0): el archivo `Nemein-0.4.0-windows-x64-selfsigned-setup.exe`, para Windows x64 con WebView2. Incluye Node.js y sus dependencias.

- **Instalá con doble clic desde el Explorador.** Si el instalador se abre desde una terminal de una app empaquetada (MSIX), como Codex, Windows lo instala dentro de la carpeta privada de esa app: el acceso del menú Inicio no funciona y la desinstalación no aparece en el sistema.
- El ejecutable y el instalador están firmados con un certificado autofirmado de Innova-tech y sello de tiempo. Windows puede mostrar advertencias de editor desconocido o SmartScreen. La descarga no instala el certificado como raíz de confianza. Ver [firma de código](SIGNING.md).
- `SHA256SUMS.txt` permite comprobar el instalador y el certificado público. Los archivos no incluyen presupuestos ni configuraciones personales.

### Novedades de 0.4.0

- Revisiones periódicas con permisos propios, inmutables una vez guardadas ([revisiones](docs/revisiones.md)).
- Respaldos pedidos hacia una carpeta externa con `BUDGET_BACKUP_DIR`, sin bloquear el arranque ([respaldos](docs/respaldos.md)).
- Contrato de importación único v1, con el CSV como primer productor y sin cambios de comportamiento ([importaciones](docs/importaciones.md)).
- Node.js incluido actualizado a 22.23.4 por seguridad, y horas en la zona y el formato del sistema.

### Actualizar

Antes de actualizar, guardá una copia de la carpeta de datos (ver [Dónde están tus datos](#dónde-están-tus-datos)). Las migraciones son numeradas y transaccionales, y conservan los datos de las bases anteriores ([migraciones](docs/migraciones.md)).

- **Desde 0.3.0:** las conexiones siguen siendo compatibles. La migración 6 agrega las revisiones; sus acciones empiezan negadas.
- **Desde 0.2.1 o anterior:** la configuración MCP ya no contiene el token, sino la ruta a una credencial privada. Renová la conexión en **Permisos y propuestas** y volvé a enlazar tu cliente. El generador de configuración MCP rechaza rutas dentro de MSIX; también se corrige el rechazo de formularios con «Origen no permitido».
- **Desde 0.2.2:** las conexiones siguen siendo compatibles. La nueva acción export empieza negada; habilitala expresamente si querés exportar datos.
- **Desde 0.1.0:** las conexiones comienzan sin permisos. Creá una conexión, elegí sus acciones y enlazá tu cliente MCP/CLI. `BUDGET_MCP_WRITE` y `BUDGET_EVENTS_READ` ya no conceden acceso.

Qué cambió en cada versión: en las notas de cada [release](https://github.com/Danor07/nemein/releases).

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

## Qué más hace

- **Resumen**: ingresos, gastos netos, categorías sin cubrir y próximos vencimientos.
- **Metas y pagos**: objetivos por categoría y fecha. El progreso usa fondos disponibles; no crea ahorro ficticio. Recurrentes semanales, mensuales o anuales, con pausa/reactivación y registro explícito de cada vencimiento. Los días 29–31 se ajustan al último día de meses cortos y recuperan su día original en el mes siguiente.
- **Movimientos**: búsqueda por beneficiario/categoría y filtro por cuenta, dentro del mes seleccionado.
- **Reportes**: cruce cuenta × categoría y totales conservados. El motor `cube` permite hasta tres dimensiones (month/day/account/category/payee), con fechas inicial y final. Consulta directamente SQLite con dimensiones permitidas y conserva los totales entre agrupamientos.

No se ejecutan pagos bancarios ni se registran recurrentes automáticamente. Registrar un vencimiento crea un movimiento local y avanza la fecha. Un reintento del mismo vencimiento devuelve error sin duplicar.

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

El CSV es el primer productor del [contrato de importación v1](docs/importaciones.md): JSON Schema 2020-12, procedencia, período declarado y vectores compartidos para futuros conectores. Conserva el flujo actual; validar el formato no concede permisos ni agrega una puerta de escritura JSON.

## Agentes: permisos y propuestas

Las conexiones de agentes comienzan **sin permisos de lectura ni escritura**.

1. Abrí **Permisos y propuestas**.
2. Creá una conexión para tu cliente y guardá la configuración, que contiene la ruta a su credencial privada.
3. Elegí permitir, preguntar o negar por acción. Podés limitar importe absoluto y cuenta.
4. Importá la configuración en tu cliente MCP. Para CLI, usá `BUDGET_AGENT_TOKEN_FILE` y `BUDGET_AGENT_VERSION`.
5. Los pedidos en preguntar aparecen en la bandeja. Podés aceptar, modificar con motivo o rechazar con motivo.

El token se guarda en un archivo privado y no aparece en la configuración ni en la página; renovarlo lo invalida para el cliente anterior. Podés revocar permisos en caliente. Las reglas nuevas o incompatibles quedan negadas hasta revisarlas.

La configuración se descarga desde Nemein instalado. El generador verifica una instalación NSIS completa y rechaza `target`, `desktop-resources`, árboles Git y la carpeta privada de una app MSIX. Sin instalación compatible muestra cómo actualizarla; no exporta rutas de compilación. `NEMEIN_INSTALL_DIR` permite indicar una instalación personalizada.

Para consultar con CLI:

    nemein.cmd permissions
    nemein.cmd event-snapshot --file examples/consulta.json

Para pedir una acción revisable, el JSON incluye `_base` (cursor del snapshot), `_purpose` y un `_request_id` único. El resultado pending contiene `proposal_id`. Consultá:

    nemein.cmd proposal-status --file estado-propuesta.json

Para trabajar sin el equipo principal, `proposal-create` recibe `{action,args,base,purpose,request_id}` y genera un sobre sin abrir la base. Guardá `.result` como archivo JSON. Más tarde, `proposal-submit --file propuesta.json` lo entrega con el token del cliente, sin ejecutarlo. Estados de entrega: undelivered, delivered, responded. No hay transporte HTTP ni sincronización de red automática.

MCP incluye `permisos_conexion`, `ejecutar_accion`, `estado_propuesta` y `entregar_propuesta`. Los nombres anteriores siguen disponibles bajo sus permisos; las escrituras no devuelven implícitamente un snapshot que no haya sido autorizado. Otros comandos de CLI: overview, search, goals, goal-set, goal-remove, recurring, recurring-create, recurring-post, recurring-toggle, cube, category y group; sus parámetros están en [AGENTS.md](AGENTS.md).

El detalle de contratos, conflictos, reintentos, límites y recuperación está en [Permisos y propuestas](docs/permisos-y-propuestas.md). Los tokens y los archivos de propuestas son privados. Estas reglas no aíslan programas que ya tienen acceso a los archivos del mismo usuario de Windows.

### Eventos locales para workflows

Snapshot consistente, lectura paginada y seguimiento por terminal. Concedé event-snapshot y events a tu conexión y configurá su credencial antes de ejecutar:

    nemein.cmd event-snapshot --file examples/consulta.json
    nemein.cmd watch --after CURSOR --format ndjson

Guardá el snapshot junto con su cursor. Persistí el cursor después de procesar cada evento y deduplicá por source + id. watch vuelve a comprobar permisos en cada página. Para seguimiento continuo se requiere permitir; una consulta en preguntar se revisa desde la bandeja. Se admiten NDJSON y JSON-seq; no se agregan transportes HTTP.

Contratos y límites: [Eventos](docs/eventos.md).

### Exportación financiera para otros workflows

La acción export y la herramienta MCP exportar_presupuesto preparan JSON financiero o CSV de movimientos en UTF-8, con cursor consistente y permiso propio, negado por defecto. El JSON excluye credenciales, permisos y auditoría; no reemplaza un respaldo SQLite. La respuesta contiene content para que el cliente lo guarde, hasta 20.000 filas o 5 MB. El CSV conserva texto literal: en una planilla, importá los campos textuales como texto. [Formato, límites y ejemplos](docs/exportaciones.md).

## Dónde están tus datos

En Windows, por defecto:

- Base: `%LOCALAPPDATA%\PresupuestoCero\budget.db`.
- Copias: `%LOCALAPPDATA%\PresupuestoCero\backups\budget-AAAA-MM-DD.db`.

La carpeta conserva el nombre `PresupuestoCero` para mantener los presupuestos existentes; el identificador de instalación también se mantiene. La variable `BUDGET_DATA_DIR` permite elegir otra carpeta, tanto para escritorio como para servidor, CLI y MCP. Todos deben usar la misma carpeta para compartir el presupuesto.

La base usa WAL y claves foráneas. Se respalda con la API de backup de SQLite (no se copia solamente el archivo mientras el WAL está abierto). Se hace una copia al primer arranque de cada día; mientras la app permanece abierta se comprueba cada hora. Por defecto se guardan las últimas 30 copias diarias, preservando el primer estado respaldado ese día. La CLI permite respaldar con la ventana cerrada y `BUDGET_BACKUP_DIR` permite elegir un destino externo. [Configurar una tarea diaria, verificar y recuperar](docs/respaldos.md).

Para restaurar: cerrá escritorio, servidor, CLI y MCP; guardá una copia de la carpeta de datos completa; reemplazá budget.db con la copia elegida y retirá los archivos budget.db-wal y budget.db-shm anteriores antes de volver a abrir. No combines archivos WAL de una base con otra. Las copias en el mismo disco no protegen contra pérdida del equipo. Restaurar una copia restaura también los permisos y revocaciones de ese momento: revisalos antes de reconectar clientes.

Más detalle en [PRIVACIDAD.md](PRIVACIDAD.md).

## Desarrollar

Requisitos: Node.js 22.23.4 (versión de compilación en `.node-version`), Rust y las herramientas C++ de Visual Studio para Tauri en Windows; WebView2 instalado. El paquete de escritorio incluye su propio Node y las dependencias: el usuario final no necesita Node instalado. La preparación rechaza otras versiones antes de modificar el runtime generado.

```powershell
npm ci
npm run desktop:dev
```

Para generar el instalador:

```powershell
npm run desktop:build
```

La preparación incluye las licencias de Node y las dependencias Rust. Si tu instalación de Node no trae un archivo LICENSE junto al ejecutable, indicá su ubicación con `NODE_LICENSE_PATH` antes de compilar. Las dependencias Rust deben estar disponibles en la caché local de Cargo; podés prepararla con `cargo fetch --manifest-path src-tauri/Cargo.toml`. El instalador NSIS queda en `src-tauri/target/release/bundle/nsis/`, y después de compilar podés abrir `Abrir Nemein.cmd`. [Node empaquetado, seguridad y compatibilidad MCP](docs/runtime.md).

También se puede usar como aplicación web local con `npm start`. La consola imprime la URL en 127.0.0.1 con un puerto libre; nunca escucha en la red local. La ventana Tauri inicia y termina su servidor local automáticamente. `node scripts/preview.js` abre una vista previa con datos ficticios en `.preview-data/`, separada del presupuesto real.

Pruebas: `npm test` corre las de regresión, propiedades y fuzzing con bases temporales; `npm run quality` agrega ESLint y mutación. Qué cubre cada una y sus límites: [Control de calidad](docs/calidad.md).

En Windows PowerShell 5, preferí pasar JSON por archivo para evitar el escape de comillas: `node src/cli.js snapshot --file examples/consulta.json`. También se admite `--stdin`.

## Contribuir

Preparación del entorno, estructura del código y criterios para cambios: [CONTRIBUTING.md](CONTRIBUTING.md). La documentación de contratos está en `docs/`.

## Licencia

MIT. Ver [LICENSE](LICENSE). Las dependencias mantienen sus respectivas licencias.
