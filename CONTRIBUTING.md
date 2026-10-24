# Contribuir a Nemein

Nemein es una aplicación local de presupuesto personal, con licencia MIT. Las contribuciones pueden incluir correcciones, pruebas, documentación o integraciones.

## Preparar el entorno

Se necesita Node.js 22 o posterior. Para la ventana de Windows también se necesitan Rust, las herramientas C++ de Visual Studio y WebView2.

    npm ci
    npm test
    npm start

Para desarrollar la ventana: npm run desktop:dev. Para generar el instalador: npm run desktop:build.

Usá una carpeta temporal mediante BUDGET_DATA_DIR. Nunca pruebes cambios sobre un presupuesto real ni incluyas bases, extractos, tokens o capturas con información personal en issues o pull requests.

## Cambiar el código

- El dinero se representa en guaraníes enteros. Conservá las validaciones y las transacciones del dominio.
- Las operaciones del presupuesto deben pasar por el motor compartido; CLI y MCP no escriben SQLite por su cuenta.
- Las conexiones nuevas no tienen permisos. Una acción o versión incompatible debe permanecer bloqueada hasta que el propietario la autorice.
- Las propuestas requieren revisión explícita. Un conflicto no se fusiona automáticamente.
- Las integraciones actuales usan CLI, MCP stdio y archivos. Un transporte HTTP nuevo requiere una decisión previa sobre su alcance.
- Conservá el funcionamiento local, los recursos sin CDN, los controles de origen y CSRF, y el acceso por teclado.
- Probá el comportamiento que cambia con datos ficticios. Explicá en el pull request el problema, el resultado y las comprobaciones realizadas.

## Orientarse en el repositorio

| Ruta | Responsabilidad |
|---|---|
| src/core.js y src/planning.js | Presupuesto, validaciones y planificación |
| src/migrations.js y src/migrations/ | Migraciones numeradas de SQLite |
| src/actions.js y src/access.js | Catálogo de acciones, permisos y propuestas |
| src/events.js y src/event-reads.js | Registro transaccional, snapshot y cursores |
| src/cli.js y src/mcp.js | Interfaces para herramientas externas |
| src/server.js, views/ y public/ | Interfaz local |
| src-tauri/ y scripts/prepare-desktop.js | Ventana y empaquetado |
| test/ y src/contracts/ | Pruebas, vectores y esquemas JSON |

Contratos: [permisos y propuestas](docs/permisos-y-propuestas.md) y [eventos](docs/eventos.md). Uso e instalación: [README](README.md). Datos y límites de confianza: [PRIVACIDAD](PRIVACIDAD.md). Firma del instalador: [SIGNING](SIGNING.md).

Cambios de esquema: seguir [Migraciones](docs/migraciones.md). Los archivos SQL distribuidos son inmutables; agregar otro número y probar actualizaciones con datos previos.
