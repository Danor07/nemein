# Nemein: acceso para agentes

Aplicación local de presupuesto personal en guaraníes enteros. Datos reales en %LOCALAPPDATA%\PresupuestoCero; usar BUDGET_DATA_DIR temporal para pruebas, nunca sembrar ejemplos en el presupuesto real.

- Crear una conexión en **Permisos y propuestas**, guardar su configuración y asignar acciones a mano. Sin regla vigente, se niega.
- CLI y MCP requieren BUDGET_AGENT_TOKEN y BUDGET_AGENT_VERSION (1 por defecto). BUDGET_MCP_WRITE y BUDGET_EVENTS_READ ya no autorizan nada.
- CLI: nemein.cmd help. Cada comando acepta JSON, --file o --stdin; stdout JSON, errores en stderr con code y salida no cero.
- Consultar permisos propios con permissions o permisos_conexion (MCP). El catálogo de herramientas no implica autorización.
- snapshot, overview, search, goals, recurring, reports y cube mantienen las validaciones del dominio. Importes enteros; cube permite entre una y tres dimensiones month/day/account/category/payee, con fechas from/to.
- Para solicitudes revisables usar _purpose, _base (cursor del snapshot) y _request_id único; en ejecutar_accion de MCP se llaman purpose, base y request_id.
- Si el resultado es pending, no repetir la mutación: consultar proposal-status {id} o estado_propuesta. Sólo el propietario resuelve desde la bandeja.
- proposal-create prepara un sobre sin abrir la base; guardar .result y entregarlo más tarde con proposal-submit --file. Nunca contiene token. Un archivo viejo puede llegar como conflicto y no se fusiona solo.
- event-snapshot {month} devuelve snapshot, goals, recurring y cursor consistentes. events {after,limit} lee hasta 1000 eventos. watch --after CURSOR admite NDJSON/json-seq y --once (una página). Requieren sus acciones permitidas; persistir cursor después de procesar y deduplicar source + id.
- recurring-post {id,due_date} registra sólo el próximo vencimiento; un reintento del mismo vencimiento falla sin duplicar. Nunca adelantar fechas en bucle sin instrucción humana.
- Para escribir usar el motor protegido, CLI o MCP; no SQLite directamente. La fachada del agente no ofrece administración ni la conexión de base.
- La interfaz local es del propietario de confianza. Estos permisos no aíslan otros programas del mismo usuario del sistema.
- npm test usa presupuestos temporales. Actualizar los runtimes de escritorio al cambiar src, views o public; distribuir código de uso diario mediante instalador, nunca con rutas target.

Fuentes: src/actions.js (catálogo), src/access.js (política y propuestas), docs/permisos-y-propuestas.md (contratos).
Compatibilidad: datos en %LOCALAPPDATA%\PresupuestoCero e identificador local.presupuesto.cero conservados.
