---
tipo: plan
actualizado: 2026-10-24
verificado-en: 3408a3d
---

# Plan de Nemein — qué se hace y en qué orden

> **Cómo se usa.** Es **estado actual**: se tilda y se reescribe; la historia va a `Bitacora/`. Las decisiones viven sólo en `Decisiones/`: este plan las enlaza, no las copia. Cada propuesta dice **qué**, **cómo, más o menos** y **de qué depende**. El «cómo» es una guía para empezar, no un diseño cerrado: el diseño fino se escribe al arrancar cada una.

## Las reglas que mandan sobre todo el plan

- **La plata es un entero en guaraníes**, nunca decimales (ya es así en el código).
- **Todo local:** el servidor escucha sólo en 127.0.0.1; sin cuentas, sin telemetría, sin nube propia (`PRIVACIDAD.md`).
- **Por defecto, nada** (ADR-0001): ninguna extensión hace algo que el usuario no aprobó a mano.
- **Lo sugerido no se acepta solo:** toda importación o propuesta pasa por una revisión.
- **Lógica separable y con vectores** (ADR-0003): lo que se traduce después a Resto-tech no se mezcla con lo propio de Nemein.

## Lo hecho

| | Qué | Dónde |
|---|---|---|
| ✅ | Presupuesto base cero, cuentas, transferencias y tarjetas, importación CSV con revisión, conciliación, metas, recurrentes, reportes y cubo, CLI y MCP | `README.md` · `VALIDACION.md` |
| ✅ | Renombre a Nemein, conservando los datos y los accesos anteriores | `46d9b71` |
| ✅ | v0.1.0 para Windows x64 (pre-release), con instalador NSIS, checksum y variante autofirmada | `VALIDACION.md` · `SIGNING.md` |

## Las propuestas, en orden

| # | Qué | Depende de | Estado |
|---|---|---|---|
| P0 | Cerrar lo pendiente de la v0.1.0 | — | pendiente |
| P1 | Motor de permisos (ADR-0001) | — | decidido, sin empezar |
| P2 | Bandeja de propuestas (ADR-0002) | P1 | decidido, sin empezar |
| P3 | Formatos bancarios como plugins WASM | P1 | propuesta |
| P4 | Tabla de eventos y `nemein watch` | — | propuesta |
| P5 | Respaldo con la app cerrada y en otro disco | — | propuesta |
| P6 | Presupuestos separados por negocio | — | propuesta |
| P7 | Leer avisos de pago por JMAP | P1, P6 | propuesta |
| P8 | Importar OFX o CAMT.053 | P3 | sólo si un banco lo exporta |

### P0 — Cerrar lo pendiente de la v0.1.0
- **Qué:** lo que `VALIDACION.md` dejó sin verificar.
- **Cómo, más o menos:**
  - mirar las pantallas a 360 × 800 (celular), 1440 × 900 y con zoom al 200 %, con datos ficticios (`node scripts/preview.js`);
  - instalar con el asistente NSIS en un equipo limpio (la VM de pruebas sirve), abrir, cargar un movimiento, cerrar y volver a abrir;
  - anotar el resultado en `VALIDACION.md`.

### P1 — Motor de permisos (decidido: ADR-0001)
- **Qué:** reemplazar el interruptor de todo o nada `BUDGET_MCP_WRITE=1` por una política acción por acción.
- **Cómo, más o menos:**
  1. **El catálogo de acciones:** los comandos de la CLI y las herramientas del MCP, cada uno con nombre y con si lee o escribe.
  2. **Tres estados por acción:** permitir, preguntar o negar. Lo que no está en la política, se niega.
  3. **Reglas que miran los argumentos:** por ejemplo, «registrar un gasto de hasta Gs. 100.000, sola; más que eso, preguntar».
  4. **La política es un dato:** una tabla en la base, editable en una pantalla de permisos.
  5. **Una sola guarda en el motor** (`src/core.js` o un módulo propio), por donde pasan la ventana, la CLI y el MCP. Nunca pantalla por pantalla.
  6. **Cada decisión queda registrada:** quién pidió, qué acción, con qué argumentos, qué se decidió y si lo decidió una regla o una persona.
  7. **Cada pedido dice qué y para qué en lenguaje llano.** Todo permiso se puede revocar, y una versión nueva de una extensión que pide algo más vuelve a preguntar.
  8. **Vectores de prueba:** actor, acción, argumentos y política dan una decisión. Es el oráculo para traducirlo a Resto-tech (ADR-0003).

### P2 — Bandeja de propuestas (decidido: ADR-0002)
- **Qué:** un «pull request contable». Quien no es el que escribe manda una propuesta, y el único que escribe la acepta, la modifica o la rechaza desde una bandeja. Una acción en «preguntar» del motor (P1) es una propuesta.
- **Cómo, más o menos:**
  1. **Cada propuesta lleva:** un identificador único, la acción con sus argumentos y su **base**, o sea lo que veía quien la hizo.
  2. **Al aceptar, se compara la base con el estado actual.** Si cambió, es un conflicto que se muestra; no se fusiona solo.
  3. **Tres salidas, y nada se borra:** aceptada, modificada (quedan la versión propuesta y la final) o rechazada con su motivo.
  4. **En el que propone, tres estados:** sin entregar, entregada y respondida.
  5. **Entrega** (recomendación, sin decidir):
     - mDNS/DNS-SD para encontrar al que escribe en la red local;
     - el que propone consulta cada cierto tiempo, con reintentos cada vez más espaciados;
     - opcionalmente, una conexión abierta (Server-Sent Events) para que llegue al instante.

     **La corrección nunca depende de un aviso:** los avisos sólo lo hacen más rápido. El «se apagó» no se puede recibir: con un corte de luz no hay despedida, sólo se deduce por falta de respuesta.
  6. **Los hechos no se rechazan, se observan:** un movimiento que ya pasó no se «rechaza»; se le agrega una observación.

### P3 — Formatos bancarios como plugins WASM
- **Qué:** sacar del core el mapeo de cada banco. Un plugin recibe el archivo y devuelve movimientos en un JSON estándar.
- **Cómo, más o menos:**
  - **sólo WebAssembly:** el aislamiento de Node (`vm`) no es una barrera de seguridad, y su propia documentación lo aclara;
  - el plugin tiene **una sola capacidad**: leer el archivo que se le pasa. Sin red, sin acceso a la base. Es el primer caso real del motor (P1);
  - el core valida lo que devuelve con las mismas reglas de hoy, y la importación sigue pasando por la revisión existente;
  - los plugins se pueden compartir porque no pueden hacer daño fuera de su caja.

### P4 — Tabla de eventos y `nemein watch`
- **Qué:** que un tablero o un script local se entere cuando algo cambia.
- **Cómo, más o menos:**
  - cada cambio del motor escribe una fila en una tabla de eventos, **en la misma transacción** (el patrón outbox, D33 de Resto-tech);
  - `nemein watch` lee esa tabla por número y emite JSON por stdout.
  - **No sirven los avisos de cambio de SQLite:** funcionan sólo dentro de una misma conexión, y la ventana, la CLI y el MCP son procesos distintos.

### P5 — Respaldo con la app cerrada y en otro disco
- **Qué:** hoy no se respalda con la app cerrada, y las copias quedan en el mismo disco.
- **Cómo, más o menos:**
  - **una tarea del Programador de tareas de Windows** que corra `nemein backup` una vez por día, sin ningún proceso de fondo;
  - **un destino elegible:** un USB, o una carpeta que ya se sincroniza con la nube (como D49 de Resto-tech). Siempre con la API de backup de SQLite.

### P6 — Presupuestos separados por negocio
- **Qué:** que la plata de un negocio no se mezcle con la personal.
- **Cómo, más o menos:**
  - una carpeta de datos propia por presupuesto (`BUDGET_DATA_DIR`, ya existe), y elegir cuál abrir desde la interfaz;
  - **categorías de arranque para un negocio:** ingresos, impuestos, costos fijos y equipos;
  - **reservar el IVA en cada ingreso:** con IVA del 10 % incluido, el impuesto es el precio dividido por 11.

### P7 — Leer avisos de pago por JMAP
- **Qué:** que los pagos que llegan por correo se carguen sin depender de una IA.
- **Cómo, más o menos:**
  - JMAP es la API estándar de Fastmail;
  - **un token de API sólo de lectura,** que pega el usuario y que queda fuera del repo;
  - **sólo una carpeta:** una regla del correo lleva los avisos a «Pagos», y sólo esa se lee;
  - **cuándo leer:** al abrir la app y cada hora mientras está abierta. La casilla es la cola, así que no hace falta webhook ni ningún servidor público;
  - **una regla fija por remitente,** y el número de operación como llave, para que nada se cargue dos veces;
  - **lo que la regla no entiende va a «por revisar»,** nunca se adivina;
  - **la conciliación mensual contra el banco** es el control.

### P8 — Importar OFX o CAMT.053
- **Qué:** los formatos estándar de extracto (OFX, e ISO 20022 `camt.053`).
- **Cómo, más o menos:** como un plugin más de P3. **Sólo si algún banco que usemos los exporta;** casi todos los bancos paraguayos dan Excel, PDF o CSV.

## No recomendado (recomendaciones de Claude; Igor no las decidió)

- **Un proceso de fondo siempre prendido:** contradice «liviano». Para lo programado alcanza con el Programador de tareas (P5).
- **Importar solo lo que cae en una carpeta:** contradice «lo sugerido no se acepta solo». A lo sumo, proponerlo al abrir la app.
- **Sincronizar dispositivos con CRDTs:** fusionan los conflictos solos, y con plata eso puede dejar un saldo mal sin que nadie lo vea. Además choca con la conciliación, que congela lo conciliado. Si hace falta otro dispositivo, uno escribe y los demás proponen (P2).
- **Una API REST con OpenAPI para Nemein:** la CLI con JSON y el MCP por stdio ya cubren a agentes y scripts sin abrir un puerto.
