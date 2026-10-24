---
tipo: modulo
actualizado: 2026-10-24
verificado-en: c084aa9 + cambios locales 0.2.0
estado: implementado
---

# Permisos y propuestas

P1 implementa ADR-0001; P2 implementa ADR-0002 para el presupuesto local y archivos entregables sin conexión. HTTP de integración, descubrimiento LAN y entrega automática entre equipos siguen fuera del alcance.

## Conectar un cliente

1. Abrir **Permisos y propuestas** y crear una conexión con nombre y versión.
2. Guardar su configuración MCP: el token sólo se muestra al crear o renovar. La descarga POST está protegida por CSRF y vence a los diez minutos.
3. Elegir permitir, preguntar o negar por acción. Sin regla vigente se niega; una acción nueva queda bloqueada.
4. Configurar BUDGET_AGENT_TOKEN y BUDGET_AGENT_VERSION en el cliente de CLI/MCP. Las variables antiguas de escritura y eventos ya no autorizan operaciones.
5. Para revocar, retirar una acción o revocar la conexión. Los procesos comprueban las reglas en cada nueva petición/página, sin necesitar reinicio. Una lectura ya iniciada puede terminar.

Los tokens se almacenan como SHA-256 de 32 bytes aleatorios. El valor original queda sólo en el cliente y, durante la descarga, temporalmente en memoria de la app. Renovar un token invalida el anterior. Cambiar la versión de conexión elimina sus permisos y vuelve incompatibles las propuestas de la versión anterior.

La configuración se exporta sólo si se encuentra una instalación completa compatible con 0.2.0 o posterior. Nunca se usan runtimes de compilación como alternativa.

## Contratos de P1

Código: src/actions.js define las acciones; src/access.js aplica la política en la frontera del motor. La interfaz es el propietario local. CLI/MCP reciben una fachada autenticada sin acceso a SQLite ni administración.

- Precondición de un agente: conexión activa, token y versión válidos, regla para esa acción y versión del contrato.
- Permitir aplica las validaciones del dominio. Límites opcionales: importe absoluto y cuenta de origen/cuenta de la acción; fuera del límite se pregunta o niega.
- Negar tiene prioridad sobre las condiciones y los reintentos.
- Preguntar crea una propuesta con propósito explícito; no cambia los saldos.
- Métodos internos de una operación ya autorizada reutilizan su contexto: no exigen permisos accidentales para cada llamada auxiliar.
- Las mutaciones, el resultado idempotente y su auditoría se confirman en una transacción junto al evento P4.
- Para consultas, permiso y auditoría se verifican primero; el snapshot conserva su propia transacción consistente.
- Los respaldos son una operación asíncrona de mantenimiento: admiten permitir/negar, no aprobación diferida.
- Cada decisión guarda actor, acción, argumentos, regla aplicada y origen humano cuando corresponde. Los errores también se registran.
- El propietario administra desde la interfaz. La fachada de agente no expone crear conexiones, cambiar permisos ni resolver propuestas.
- Los permisos no son un sandbox contra otros programas del mismo usuario de Windows, que ya pueden acceder a los archivos o a la interfaz local de confianza.

El núcleo puro evaluatePolicy recibe actor, acción, argumentos y regla, y devuelve una decisión sin dependencias de SQLite. Los vectores JSON de test/fixtures/permission-vectors.json son el oráculo portable para ADR-0003. La autenticación del token es una etapa separada.

## Contratos de P2

Una propuesta conserva identificador, conexión/versión, request_id, acción/versión de contrato, argumentos originales, propósito y cursor base.

- La escritura propuesta requiere la base obtenida del snapshot consultado. Un archivo viejo puede entregarse: queda marcado como conflicto si la base ya cambió.
- Aceptar vuelve a comprobar estado pendiente, versión/conexión, permiso vigente y base. Si algo cambió, no se aplica.
- Modificar exige motivo y conserva ambas versiones de los argumentos. No rebasa automáticamente una propuesta en conflicto.
- Rechazar exige motivo; no borra la solicitud ni altera movimientos reales.
- Resolución y mutación son atómicas. Un error mantiene la propuesta pendiente y queda auditado.
- Una propuesta respondida no se puede aplicar dos veces.
- request_id identifica un pedido de la conexión: repetirlo con la misma entrada devuelve el resultado guardado; otra entrada con el mismo ID falla.
- La conexión sólo consulta sus propuestas; versiones nuevas no leen respuestas de versiones anteriores. Una respuesta financiera tampoco se entrega si se retiró su permiso.
- La base es conservadora: cualquier mutación del presupuesto puede generar conflicto aunque afecte otra categoría.
- La bandeja pagina de a 50 y muestra pendientes primero; el historial se conserva.

Esto autoriza decisiones y pedidos de registro; no revierte un pago que ocurrió fuera de Nemein ni sustituye conciliación o contabilidad de hechos observados.

## Preparar y entregar sin conexión

proposal-create genera un sobre JSON sin abrir la base ni requerir que el equipo principal esté encendido. Necesita la acción, sus argumentos, el propósito y la base previamente consultada para escrituras. Su estado inicial es undelivered.

Cuando el presupuesto vuelve a estar accesible, el cliente autenticado entrega el sobre con proposal-submit o entregar_propuesta. La entrega queda delivered y nunca aplica la acción automáticamente, incluso si existe una regla de permitir. Al consultar una decisión final, delivery es responded.

El transporte es el archivo elegido por el usuario: no se implementa sincronización automática, DNS-SD ni HTTP. El archivo no contiene token; sí puede contener datos financieros, y debe protegerse. Schema: src/contracts/proposal-file.schema.json.

## Interfaces

CLI: permissions, event-snapshot, todos los comandos de presupuesto, watch, proposal-create, proposal-submit y proposal-status.

MCP conserva herramientas con nombres anteriores y agrega ejecutar_accion, estado_propuesta, entregar_propuesta y permisos_conexion. Las herramientas anunciadas no implican permiso de uso. Para proponer con una herramienta existente se envían _base, _purpose y _request_id; ejecutar_accion acepta base, purpose y request_id separados.

Después de un pedido pending se consulta estado_propuesta/proposal-status. El cliente nunca repite la mutación para simular la aceptación.

## Datos y recuperación

Las tablas agent_connections, agent_rules, agent_audit, agent_requests y agent_proposals viven en la base del presupuesto. La migración es idempotente y transaccional. No cambia saldos existentes ni habilita conexiones antiguas.

Auditoría, propuestas y respuestas pueden contener datos financieros y están incluidas en los backups sin cifrado adicional. Restaurar un backup también recupera las reglas y revocaciones de ese momento: revisar/revocar conexiones antes de reconectar clientes a una base restaurada.

La página muestra las cien decisiones más recientes; conservarlas en SQLite no equivale a exportarlas públicamente. No se purgan automáticamente solicitudes ni auditoría.
