# Cero: acceso para agentes

Aplicación local de presupuesto personal en guaraníes enteros. Datos reales en `%LOCALAPPDATA%\PresupuestoCero`; no sembrar ejemplos ahí. Usar BUDGET_DATA_DIR con una carpeta temporal para probar.

- Terminal: `cero.cmd help`. Cada comando acepta JSON, `--file ruta.json` o `--stdin`. Devuelve JSON y sale con código distinto de cero ante un error.
- MCP: copiar `cero-mcp.example.json` como `cero-mcp.json`, completar la ruta absoluta e importarlo en el cliente. Solo lectura por defecto; BUDGET_MCP_WRITE=1 habilita mutaciones cuando el usuario las autoriza.
- Consultar `overview`, `snapshot`, `search`, `goals`, `recurring`, `reports`, `cube`.
- `cube` recibe `{from,to,dimensions}`; dimensiones permitidas: month, day, account, category, payee (1 a 3). Los totales excluyen transferencias y saldos iniciales. Reintegros restan gasto.
- `goal-set` recibe `{category_id,amount,due_date}`; no mueve dinero.
- `recurring-create` recibe `{account_id,category_id,payee,amount,next_date,frequency}`. frequency es weekly, monthly o yearly. Gastos negativos y categoría obligatoria.
- `recurring-post` recibe `{id,due_date}` usando exactamente el próximo vencimiento consultado. Un reintento con el mismo vencimiento falla sin duplicar. Nunca adelantar vencimientos en un bucle sin instrucción del usuario.
- Para cambiar saldos usar el motor, CLI o MCP; no editar SQLite directamente. La interfaz usa las mismas validaciones.
- Pruebas: `npm test` después de `npm ci`.
- Si cambia src, views o public, actualizar también ambos runtimes de escritorio antes de entregar: desktop-resources/runtime y src-tauri/target/release/runtime.
