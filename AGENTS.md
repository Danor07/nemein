# Nemein: acceso para agentes

Aplicación local de presupuesto personal en guaraníes enteros. Datos reales en %LOCALAPPDATA%\PresupuestoCero; usar BUDGET_DATA_DIR temporal para pruebas, nunca sembrar ejemplos en el presupuesto real.

- Crear una conexión en **Permisos y propuestas**, guardar su configuración y asignar acciones a mano. Sin regla vigente, se niega.
- CLI y MCP usan BUDGET_AGENT_TOKEN_FILE y BUDGET_AGENT_VERSION (1 por defecto). BUDGET_MCP_WRITE y BUDGET_EVENTS_READ ya no autorizan nada.
- CLI: nemein.cmd help. Cada comando acepta JSON, --file o --stdin; stdout JSON, errores en stderr con code y salida no cero.
- Consultar permisos propios con permissions o permisos_conexion (MCP). El catálogo de herramientas no implica autorización.
- export {format: "json"|"csv"} devuelve metadatos y content; no escribe archivos. Requiere export por separado, no hereda snapshot/backup. JSON financiero sin credenciales ni auditoría; CSV literal para intercambio. Consultar docs/exportaciones.md.
- snapshot, overview, search, goals, recurring, reports y cube mantienen las validaciones del dominio. Importes enteros; cube permite entre una y tres dimensiones month/day/account/category/payee, con fechas from/to.
- Para solicitudes revisables usar _purpose, _base (cursor del snapshot) y _request_id único; en ejecutar_accion de MCP se llaman purpose, base y request_id.
- Si el resultado es pending, no repetir la mutación: consultar proposal-status {id} o estado_propuesta. Sólo el propietario resuelve desde la bandeja.
- proposal-create prepara un sobre sin abrir la base; guardar .result y entregarlo más tarde con proposal-submit --file. Nunca contiene token. Un archivo viejo puede llegar como conflicto y no se fusiona solo.
- event-snapshot {month} devuelve snapshot, goals, recurring y cursor consistentes. events {after,limit} lee hasta 1000 eventos. watch --after CURSOR admite NDJSON/json-seq y --once (una página). Requieren sus acciones permitidas; persistir cursor después de procesar y deduplicar source + id.
- recurring-post {id,due_date} registra sólo el próximo vencimiento; un reintento del mismo vencimiento falla sin duplicar. Nunca adelantar fechas en bucle sin instrucción humana.
- Para escribir usar el motor protegido, CLI o MCP; no SQLite directamente. La fachada del agente no ofrece administración ni la conexión de base.
- La interfaz local es del propietario de confianza. Estos permisos no aíslan otros programas del mismo usuario del sistema.
- npm test usa presupuestos temporales. Actualizar los runtimes de escritorio al cambiar src, views o public; distribuir código de uso diario mediante instalador, nunca con rutas target.

Migraciones: src/migrations.js y src/migrations/. Agregar cambios con un número nuevo; no editar SQL ya distribuido. Actualizar la validación y probar bases antiguas, reapertura y rollback. Ver docs/migraciones.md.

Fuentes: src/actions.js (catálogo), src/access.js (política y propuestas), docs/permisos-y-propuestas.md (contratos).
Compatibilidad: datos en %LOCALAPPDATA%\PresupuestoCero e identificador local.presupuesto.cero conservados.

## Crecimiento modular

Nemein es un proyecto open-source construido por disfrute y utilidad personal. La utilidad de una función puede incluir aprender o experimentar; su incorporación estable debe mantener sostenible el proyecto.

Fórmula de integración: **U × R × C × P × D = 1**, con cada factor binario (0 o 1): utilidad concreta, responsabilidad única, contrato explícito, pruebas de frontera y desconexión segura. Si falta un factor, reducir el alcance o mantener el experimento aislado hasta resolverlo. No es una puntuación comercial ni una estimación numérica de calidad.

- Mantener un monolito modular como punto de partida. Cada función declara el módulo responsable, entradas/salidas, dependencias permitidas y acciones afectadas. No crear servicios, buses o frameworks genéricos sin un problema concreto que lo justifique.
- Dirigir las dependencias desde adaptadores (UI, CLI/MCP, importadores y conectores) hacia casos de uso y dominio. Evitar ciclos. El dominio no debe depender de un proveedor, una IA o un capturador móvil.
- Conservar una sola implementación de reglas monetarias y permisos. Adaptadores e IA preparan datos o propuestas; los cambios financieros pasan por las acciones protegidas existentes o nuevas acciones explícitas. Ningún conector escribe directamente en la base.
- Probar contratos, errores, reintentos y fronteras modificadas según el control de calidad. Revisar la dirección de dependencias y la ausencia de cálculos monetarios duplicados antes de integrar.
- Poder desactivar un conector, proveedor de IA o programador sin inutilizar el presupuesto ni borrar su evidencia. Las funciones centrales declaran su comportamiento ante dependencias opcionales ausentes; no se exige que cada función central sea un plugin.
- En cada entrega, explicar brevemente los cinco factores y registrar sólo decisiones que cambien límites o contratos. Evitar refactorizaciones generales para incorporar una función acotada.

## Calidad obligatoria

Ejecutar npm run quality antes de entregar cambios. Incluir Property-Based Testing, fuzzing adversarial y ampliar la mutación para las decisiones modificadas. Análisis estático sin advertencias; no reducir umbrales ni excluir invariantes para obtener verde. Código, pruebas y configuración de CI requieren revisión. Ver [Control de calidad](docs/calidad.md).
