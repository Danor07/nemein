# Privacidad y datos locales

Nemein guarda el presupuesto en una base SQLite en el equipo. No incluye cuentas de usuario, telemetría, sincronización bancaria ni servicios de nube propios. El servidor HTTP escucha únicamente en 127.0.0.1.

## Archivos personales

En Windows, la ubicación predeterminada es `%LOCALAPPDATA%\PresupuestoCero`. `BUDGET_DATA_DIR` permite elegir otra carpeta. La base y los respaldos diarios contienen los datos financieros completos y no están cifrados por la aplicación. Las copias en el mismo disco no protegen frente a la pérdida del equipo.

No adjuntes bases, extractos, CSV reales ni respaldos al abrir un issue. Para reproducir problemas, usá datos ficticios. `examples/` y la vista previa contienen únicamente ejemplos sintéticos.

El repositorio excluye bases SQLite y archivos WAL/SHM, carpetas de datos, importaciones y exportaciones, respaldos, logs, archivos de entorno y configuración MCP local. Solo se publica el ejemplo MCP con una ruta genérica.

## Agentes

El MCP usa stdio y comparte el presupuesto con la interfaz y la CLI. Permite consultas por defecto; `BUDGET_MCP_WRITE=1` habilita las herramientas de escritura. Activarlo concede al cliente acceso para modificar datos locales.

Si un agente consulta el presupuesto y utiliza un modelo en la nube, puede enviar esa información al proveedor del modelo. Esto depende del agente y su configuración. Revisá los permisos del cliente antes de conectarlo.

## Uso local

La aplicación está pensada para una persona en un equipo de confianza. No ofrece autenticación multiusuario y no debe exponerse mediante un proxy, túnel o servidor público. Otros programas que se ejecutan con tu usuario pueden acceder a los archivos del presupuesto.

Compatibilidad: la carpeta de datos sigue siendo `%LOCALAPPDATA%\PresupuestoCero` para conservar los presupuestos existentes. El identificador de instalación también se mantiene.
