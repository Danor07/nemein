---
tipo: plan
actualizado: 2026-10-24
verificado-en: 1c4cca5
---

# Plan de Nemein — qué se hace y en qué orden

> **Cómo se usa.** Es **estado actual**: se tilda y se reescribe; la historia va a `Bitacora/`. Las decisiones viven sólo en `Decisiones/`: este plan las enlaza, no las copia. Cada propuesta dice **qué**, **cómo, más o menos** y **de qué depende**. El «cómo» es una guía para empezar, no un diseño cerrado: el diseño fino se escribe al arrancar cada una.

## Las reglas que mandan sobre todo el plan

- **La plata es un entero en guaraníes**, nunca decimales (ya es así en el código).
- **Todo local:** el servidor escucha sólo en 127.0.0.1; sin cuentas, sin telemetría, sin nube propia (`PRIVACIDAD.md`).
- **Por defecto, nada** (ADR-0001): ninguna extensión hace algo que el usuario no aprobó a mano.
- **Lo sugerido no se acepta solo:** toda importación o propuesta pasa por una revisión.
- **Lógica separable y con vectores** (ADR-0003): lo que se traduce después a Resto-tech no se mezcla con lo propio de Nemein.

- **Interoperabilidad por estándares:** [ADR-0004](Decisiones/ADR-0004-interoperabilidad-por-estandares.md). [Investigación y propuestas técnicas](Entender/Interoperabilidad.md).

## Lo hecho

| | Qué | Dónde |
|---|---|---|
| ✅ | Presupuesto base cero, cuentas, transferencias y tarjetas, importación CSV con revisión, conciliación, metas, recurrentes, reportes y cubo, CLI y MCP | `README.md` · `VALIDACION.md` |
| ✅ | Renombre a Nemein, conservando los datos y los accesos anteriores | `46d9b71` |
| ✅ | v0.1.0 para Windows x64 (pre-release), con instalador NSIS, checksum y variante autofirmada | `VALIDACION.md` · `SIGNING.md` |

## Propuestas y dependencias

Los números son identificadores, no una secuencia obligatoria. **Siguiente: P1 (permisos granulares) → P2 (bandeja de propuestas).** P4a ya es utilizable con concesión explícita. P4b se implementará cuando exista un destino concreto. P2 cubre las acciones que necesiten aprobación. P0 mantiene sus verificaciones pendientes. P3, P7 y P8 son adaptadores opcionales.

Registrar hechos internamente puede empezar antes de P1; exponerlos a integraciones no concede acceso automáticamente.

| # | Qué | Depende de | Estado |
|---|---|---|---|
| P0 | Cerrar lo pendiente de la v0.1.0 | — | pendiente |
| P1 | Motor de permisos (ADR-0001) | — | decidido, sin empezar |
| P2 | Bandeja de propuestas (ADR-0002) | P1 | decidido, sin empezar |
| P3 | Formatos bancarios como plugins WASM | P1 | propuesta |
| P4 | Contratos, registro y `nemein watch` | concesión local explícita; P1 para granularidad | P4a utilizable con concesión explícita; P4b pendiente |
| P5 | Respaldo con la app cerrada y en otro disco | — | propuesta |
| P6 | Presupuestos separados por negocio | — | propuesta |
| P7 | Leer avisos de pago por JMAP | P1; P2 si propuesta remota | propuesta |
| P8 | Importar OFX o camt.053 | contrato de importación | según archivos disponibles |
| P9 | Portabilidad mediante CLI, MCP y archivos | contratos comunes | propuesta; HTTP aplazado |

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
     - el transporte entre dispositivos queda por definir; SSE/HTTP está aplazado y no forma parte del alcance actual.

     **La corrección nunca depende de un aviso:** los avisos sólo lo hacen más rápido. El «se apagó» no se puede recibir: con un corte de luz no hay despedida, sólo se deduce por falta de respuesta.
  6. **Los hechos no se rechazan, se observan:** un movimiento que ya pasó no se «rechaza»; se le agrega una observación.

### P3 — Formatos bancarios como plugins WASM
- **Qué:** sacar del core el mapeo de cada banco. Un plugin recibe el archivo y devuelve movimientos en un JSON estándar.
- **Cómo, más o menos:**
  - **sólo WebAssembly:** el aislamiento de Node (`vm`) no es una barrera de seguridad, y su propia documentación lo aclara;
  - el plugin tiene **una sola capacidad**: leer el archivo que se le pasa. Sin red, sin acceso a la base. Es el primer caso real del motor (P1);
  - el core valida lo que devuelve con las mismas reglas de hoy, y la importación sigue pasando por la revisión existente;
  - definir primero el contrato JSON Schema de importación. WASM no es requisito para importadores incorporados; limitar memoria, tiempo y salida, y validar semántica. El aislamiento no garantiza por sí solo que un plugin sea seguro.

### P4 — Contratos, registro transaccional y lectura reanudable

**P4a implementado para uso local con concesión explícita:** registro, cursores, snapshot, lectura por CLI/MCP y watch; [contratos, evidencia y límites](Modulos/Eventos.md). Pendientes política granular P1 y entrega por destino P4b. [Fundamento](Entender/Interoperabilidad.md).

**P4a — implementado con límites documentados**
- Empezar por contratos de comportamiento inspirados en [Design by Contract](Entender/Interoperabilidad.md#design-by-contract-como-inspiración): precondiciones, postcondiciones e invariantes por operación, con casos de éxito, rechazo y fallo. JSON Schema complementa esos contratos describiendo los datos.
- Catálogo de hechos y JSON Schema 2020-12; sobre CloudEvents 1.0.2 (specversion "1.0"), identidad estable y secuencia local separadas.
- Migración del registro y evento en la misma transacción que cada mutación del motor, incluidas sentencias individuales y llamadas anidadas. Nunca registrar desde la ruta HTTP después del commit.
- **Implementado:** CLI event-snapshot, events y watch --after; MCP snapshot_eventos y eventos. Requieren BUDGET_EVENTS_READ=1 independientemente del permiso de escritura. JSON por línea o json-seq RFC 7464; el consumidor persiste su cursor después de procesar. Revocar la concesión externa requiere reiniciar el proceso sin esa variable; no sustituye P1.
- **Implementado internamente:** snapshot mensual + metas + recurrentes en una transacción de lectura con su cursor; páginas reanudables y acotadas; detección de presupuesto ajeno, anclaje perdido/divergente y huecos. Sin purga automática. Restauraciones que conservan el prefijo leído mantienen el cursor; no se promete detectar toda copia como una generación nueva.
- Persistencia y pruebas internas antes de P1; exposición a integraciones después de P1 o con autorización explícita y acotada equivalente. No convertir el permiso global de escritura en permiso para leer todo el historial.
- **Aceptación:** rollback sin evento huérfano; visibilidad conjunta desde otra conexión después del commit; reinicio sin pérdida; replay/deduplicación; aislamiento entre presupuestos; revocación; consumidor lento; restauración/cursor inválido; cobertura UI/CLI/MCP.
- Bases temporales. El registro no sustituye tablas contables ni auditoría de permisos.

**P4b — entrega por destino cuando exista un adaptador**
- Depende de P4a y P1; P2 para acciones que necesiten aprobación.
- Estado por destino: pendiente, intento, confirmado/error; reintentos espaciados y acotados, pausa y recuperación manual.
- Red afuera de la transacción; un destino caído no bloquea el presupuesto ni los demás. Deduplicación/idempotencia acordadas con el receptor; no prometer exactly-once.
- Separación D33: fila durable en la transacción, worker después. Sin bus interno ni framework genérico anticipado.

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
  - JMAP Core RFC 8620 y Mail RFC 8621: cualquier proveedor compatible; descubrir capacidades;
  - credenciales fuera del repo con el mínimo alcance soportado; filtrar una carpeta no necesariamente limita el token;
  - **sólo una carpeta:** una regla del correo lleva los avisos a «Pagos», y sólo esa se lee;
  - **cuándo leer:** al abrir la app y cada hora mientras está abierta. La casilla es la cola, así que no hace falta webhook ni ningún servidor público;
  - **una regla fija por remitente,** y el número de operación como llave, para que nada se cargue dos veces;
  - **lo que la regla no entiende va a «por revisar»,** nunca se adivina;
  - **la conciliación mensual contra el banco** es el control.

### P8 — Importar OFX o CAMT.053
- **Qué:** los formatos estándar de extracto (OFX, e ISO 20022 `camt.053`).
- **Cómo, más o menos:** con el contrato común de importación, como adaptador incorporado o plugin P3. Fijar versiones y probar muestras sanitizadas; disponibilidad por banco pendiente de verificar. No requiere WASM.

### P9 — Portabilidad mediante CLI, MCP y archivos

**Propuesta, sin implementar.** Contrato común de acciones, resultados y errores, con versiones y exportación de configuraciones sin secretos.
- Mantener CLI y MCP stdio; declarar revisiones soportadas y probar clientes independientes, sin duplicar validaciones del dominio.
- Exportaciones CSV/JSON documentadas, con signos, unidades y fechas; pruebas de ida y vuelta con datos ficticios. Backup SQLite no sustituye formato público.
- **Alcance indicado por Igor:** HTTP/OpenAPI queda aplazado, junto con SSE como transporte de integración. No es requisito de P4 ni del principio de interoperabilidad. Reconsiderarlo sólo si aparece una necesidad concreta; no equivale a retirar el servidor local existente de la interfaz.
- Design by Contract es inspiración para el comportamiento del núcleo; no implica adoptar Eiffel ni crear un framework de contratos.

## Recomendaciones revisadas (no son decisiones de Igor)

- **Un proceso de fondo siempre prendido:** contradice «liviano». Para lo programado alcanza con el Programador de tareas (P5).
- **Vigilar una carpeta:** puede preparar propuestas; detectar un archivo no equivale a aceptar movimientos. Respetar permisos y revisión.
- **Sincronizar dispositivos con CRDTs:** fusionan los conflictos solos, y con plata eso puede dejar un saldo mal sin que nadie lo vea. Además choca con la conciliación, que congela lo conciliado. Si hace falta otro dispositivo, uno escribe y los demás proponen (P2).
- **HTTP/OpenAPI:** aplazado por indicación de Igor; alcance vigente en P9.
