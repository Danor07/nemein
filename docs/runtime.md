# Node de compilación y compatibilidad MCP

Para esta entrega se conserva Node 22 y SDK MCP 1.x. `.node-version` fija **22.23.4** para compilar; `package.json` declara la línea 22 desde ese parche. La CI Windows lee ese archivo y la CI Linux fija la imagen oficial del mismo parche por digest. El SDK instalado por el lockfile es `@modelcontextprotocol/sdk` **1.32.1**, cuyo requisito de Node es `>=18`; se verifica con las pruebas MCP reales de Nemein.

## Corrección de seguridad

Node 22.23.4 es una [release de seguridad del 21/10/2026](https://nodejs.org/en/blog/release/v22.23.4). El [aviso oficial](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) incluye la corrección del decodificador Brotli CVE-2026-111497. Cambiar sólo `package.json` no cambia el `node.exe` del instalador.

`scripts/prepare-desktop.js` copia **el ejecutable que lo está ejecutando**. Por eso comprueba la versión exacta antes de modificar el runtime generado y conserva `.node-version` junto al binario. `scripts/smoke-installed-mcp.mjs` consulta la versión del `node.exe` instalado y la compara con la fijada por el repositorio antes de probar el MCP.

Seleccionar Node 22.23.4 en el entorno de compilación y ejecutar `npm ci`, `npm run quality` y `npm run desktop:prepare`. Una distribución portátil oficial también sirve: agregar su carpeta al `PATH` de esa terminal antes de invocar npm. Su `LICENSE` acompaña al ejecutable; no copiar sólo `node.exe` ni usar el Node de otra herramienta por accidente. Cambiar ese PATH local no actualiza otros programas ni la instalación personal de Nemein.

No se publica una release ni se instala Nemein por preparar el runtime. Un instalador ya publicado conserva el Node con el que se construyó; se necesita una compilación posterior para distribuir el parche.

## Qué implica MCP Servers v2

La [release 2.0.0 de servidores de referencia](https://github.com/modelcontextprotocol/servers/releases/tag/v2.0.0) migra esos servidores de TypeScript al SDK v2 y eleva su mínimo a Node 24. Nemein implementa su propio servidor con el SDK 1.x; no depende de `server-filesystem`, `server-memory`, `server-everything` ni `server-sequential-thinking`. El requisito de esos paquetes no cambia por sí solo el runtime del protocolo ni del servidor de Nemein.

Una migración de Nemein a SDK v2 debe evaluarse junto con un Node 24 **con parche de seguridad vigente**, la compatibilidad del módulo SQLite y los contratos/errores CLI y MCP. No se cambia el major sólo para corregir Brotli en esta entrega. Instalar servidores de referencia externos requiere respetar su propio runtime, separado del Node incluido en Nemein.
