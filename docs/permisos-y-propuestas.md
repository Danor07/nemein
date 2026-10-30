# Permisos y propuestas

Las interfaces CLI y MCP comparten el catálogo de src/actions.js y la política de src/access.js. La versión 0.2.0 requiere un token por conexión; las variables antiguas BUDGET_MCP_WRITE y BUDGET_EVENTS_READ no conceden acceso.

La [API local v1](api-local.md), optativa con `BUDGET_LOCAL_API=1`, comparte esa fachada protegida. Usa Bearer y añade una condición de base obligatoria para las escrituras, comprobada dentro de la transacción del motor. No habilita permisos ni administración de conexiones. Las condiciones antiguas de CLI/MCP se conservan; no se intercambian IDs de reintento entre solicitudes con y sin esa condición.

## Conectar un cliente

En **Permisos y propuestas**, creá una conexión y guardá su configuración. La credencial se guarda en un archivo privado; renovarla invalida el token anterior. Elegí permitir, preguntar o negar para cada acción. Sin una regla vigente, el pedido se niega.

La exportación MCP requiere Nemein instalado, versión 0.2.2 o posterior. CLI usa BUDGET_AGENT_TOKEN_FILE y BUDGET_AGENT_VERSION; la variable BUDGET_AGENT_TOKEN se conserva por compatibilidad. La descarga está protegida por CSRF y disponible durante diez minutos.

## Política

Una petición requiere conexión activa, token y versiones compatibles. Las reglas pueden limitar el importe absoluto y la cuenta de la acción; en transferencias, la cuenta corresponde al origen. Fuera del límite se pregunta o se niega. Una negación prevalece sobre las condiciones y los reintentos.

Los permisos se comprueban en cada petición y página del historial. Una lectura ya iniciada puede terminar después de una revocación. Cambiar la versión de la conexión retira sus permisos.

La ventana local representa al propietario. Los permisos no aíslan procesos que ya pueden acceder a los archivos del mismo usuario del sistema.

La función pura evaluatePolicy recibe actor, acción, argumentos y regla. Sus casos de referencia están en test/fixtures/permission-vectors.json; la autenticación del token se verifica por separado.

## Propuestas

Una acción en preguntar crea una propuesta con propósito explícito y conserva argumentos, identificador de solicitud, conexión, versiones y cursor base. No altera el presupuesto al recibirse.

- Aceptar comprueba de nuevo conexión, permiso, estado pendiente y base actual.
- Modificar exige un motivo y conserva los argumentos originales y finales.
- Rechazar exige un motivo y conserva el registro.
- Una base distinta produce conflicto; se necesita una nueva propuesta. Cualquier mutación puede cambiar esa base.
- La resolución y la mutación son atómicas. Un fallo mantiene la propuesta pendiente.
- Un request_id repetido con la misma entrada devuelve el resultado guardado; usarlo con otra entrada falla. Una propuesta respondida no se aplica dos veces.

El cliente sólo consulta propuestas de su conexión y versión. Si se retira el permiso de la respuesta, su contenido deja de entregarse.

CLI recibe _base, _purpose y _request_id junto con los argumentos. Las herramientas MCP anteriores aceptan esos mismos campos; ejecutar_accion usa action, arguments, base, purpose y request_id.

Después de un resultado pending, consultá proposal-status {id} o estado_propuesta. No repitas una mutación para intentar aprobarla.

## Archivos sin conexión

proposal-create prepara un sobre sin abrir SQLite ni necesitar token. Para escrituras requiere un cursor base obtenido previamente. Guardá el campo result como archivo JSON y entregalo con proposal-submit --file o entregar_propuesta.

La entrega nunca aplica la acción automáticamente, incluso con una regla de permitir. delivery pasa de undelivered a delivered y, al consultar una decisión final, a responded. Un archivo antiguo puede recibirse con conflicto.

El esquema está en src/contracts/proposal-file.schema.json. El archivo no incluye token, pero puede contener datos financieros. No hay sincronización automática entre equipos.

## Persistencia

Las conexiones, reglas, decisiones, solicitudes y propuestas se guardan en SQLite. Los tokens se generan con 32 bytes aleatorios y se almacenan como hashes SHA-256. Las escrituras autorizadas, su resultado idempotente, auditoría y evento se confirman juntos. Las consultas comprueban permiso y auditoría antes de leer. Los respaldos asíncronos admiten permitir o negar; no aprobación diferida.

El esquema usa [migraciones numeradas](migraciones.md), transaccionales e idempotentes. Restaurar un backup restaura también los permisos y revocaciones de ese momento: revisalos antes de reconectar clientes. La interfaz muestra las cien decisiones recientes y pagina las propuestas de a cincuenta; los registros anteriores permanecen en la base.

Estos controles autorizan registros locales. No ejecutan pagos bancarios ni revierten hechos ocurridos fuera de Nemein.
