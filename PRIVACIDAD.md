# Privacidad y datos locales

Nemein guarda el presupuesto en SQLite en el equipo. No incluye telemetría, cuentas de nube, sincronización bancaria ni servicios propios remotos. La interfaz HTTP escucha sólo en 127.0.0.1; no se agregó una API HTTP para integraciones.

## Archivos personales

La ubicación predeterminada es %LOCALAPPDATA%\PresupuestoCero. BUDGET_DATA_DIR permite elegir otra carpeta. Base y respaldos contienen información financiera completa y no están cifrados por la aplicación. Las copias en el mismo disco no protegen contra pérdida del equipo.

No adjuntes bases, extractos, propuestas, configuraciones de cliente ni CSV reales a un issue. Los ejemplos y pruebas usan datos ficticios. Git excluye bases, WAL/SHM, respaldos, datos locales y configuración MCP personal.

## Conexiones y permisos desde 0.2.0

CLI y MCP requieren una conexión creada en la aplicación, mediante BUDGET_AGENT_TOKEN y BUDGET_AGENT_VERSION. Cada acción empieza negada. El propietario elige permitir, preguntar o negar, con límites opcionales por importe y cuenta.

BUDGET_MCP_WRITE y BUDGET_EVENTS_READ ya no conceden permisos. Las configuraciones anteriores deben volver a enlazarse. Los agentes no administran sus propias reglas.

Los tokens originales sólo se muestran al crear o renovar una conexión. La base almacena su SHA-256; el cliente guarda el token en su configuración privada. La descarga con token requiere CSRF y queda disponible diez minutos en memoria de esa sesión. Revocar una conexión o cambiar permisos se comprueba en pedidos nuevos; una consulta ya iniciada puede terminar.

La configuración apunta a la instalación estable compatible de Nemein, conservando la carpeta de presupuesto seleccionada. No se exportan rutas de compilación.

## Auditoría, eventos y propuestas

Los eventos P4 conservan identificadores, hora y tipo de operación, sin copiar argumentos, montos ni comercios. El snapshot sí contiene información financiera.

La auditoría P1 registra actor, acción, argumentos y regla aplicada. Las propuestas P2 conservan argumentos originales/finales, propósito, decisiones y respuestas. Estos registros pueden contener datos financieros y forman parte de los respaldos. No hay purga automática por ahora.

Los archivos de propuestas preparados sin conexión no contienen token, pero pueden incluir información financiera. Su entrega es manual mediante CLI/MCP; no se sincronizan ni envían a servicios externos automáticamente.

Restaurar un respaldo recupera también las reglas y revocaciones que existían en ese momento. Antes de reconectar clientes a una base restaurada, revisar o revocar esas conexiones.

## Uso local y agentes en la nube

La aplicación está pensada para una persona en un equipo de confianza. La interfaz es del propietario local; no es un portal multiusuario y no debe exponerse por un túnel, proxy o servidor público. Otros programas con acceso a los archivos de ese usuario pueden eludir la política; los permisos de Nemein no son un sandbox del sistema operativo.

Un cliente MCP o una terminal pueden guardar o reenviar lo consultado. Si el agente usa un modelo en la nube, sus consultas pueden llegar al proveedor elegido por el usuario. El cursor es una posición de lectura, no una contraseña.

Compatibilidad: carpeta de datos e identificador de instalación anteriores se conservan para no perder presupuestos.

## Configuración MCP sin token visible (código en desarrollo)

La configuración usa BUDGET_AGENT_TOKEN_FILE y guarda únicamente la ruta a connection.env. CLI y MCP leen el archivo directamente; éste prevalece sobre un token heredado en el entorno. La credencial se conserva en un directorio privado: permisos del usuario y SYSTEM en Windows, y archivo 0600 en otros sistemas. La interfaz no muestra el valor. El token sigue siendo un secreto local accesible a procesos del mismo usuario; no está cifrado. No compartir ese archivo. Las configuraciones anteriores contienen el token; para adoptar el formato nuevo hay que renovar y reenlazar la conexión desde la versión actualizada. La versión 0.2.2 incorpora este formato; para actualizar una instalación 0.2.1 hay que instalar el paquete nuevo desde el Explorador y renovar la configuración.

Las rutas MSIX LocalCache se rechazan como instalaciones NSIS estables en el código nuevo. Instalar desde el Explorador fuera de Codex; una comprobación hecha desde Codex no sustituye la verificación fuera de su contexto MSIX.
