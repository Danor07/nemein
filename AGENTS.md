# Nemein: acceso para agentes

Aplicación local de presupuesto personal en guaraníes enteros. Datos reales en `%LOCALAPPDATA%\PresupuestoCero`; no sembrar ejemplos ahí. Usar BUDGET_DATA_DIR con una carpeta temporal para probar.

- Terminal: `nemein.cmd help`. Cada comando acepta JSON, `--file ruta.json` o `--stdin`. Devuelve JSON y sale con código distinto de cero ante un error.
- MCP: copiar `nemein-mcp.example.json` como `nemein-mcp.json`, completar la ruta absoluta e importarlo en el cliente. Solo lectura por defecto; BUDGET_MCP_WRITE=1 habilita mutaciones cuando el usuario las autoriza.
- Consultar `overview`, `snapshot`, `search`, `goals`, `recurring`, `reports`, `cube`.
- `cube` recibe `{from,to,dimensions}`; dimensiones permitidas: month, day, account, category, payee (1 a 3). Los totales excluyen transferencias y saldos iniciales. Reintegros restan gasto.
- `goal-set` recibe `{category_id,amount,due_date}`; no mueve dinero.
- `recurring-create` recibe `{account_id,category_id,payee,amount,next_date,frequency}`. frequency es weekly, monthly o yearly. Gastos negativos y categoría obligatoria.
- `recurring-post` recibe `{id,due_date}` usando exactamente el próximo vencimiento consultado. Un reintento con el mismo vencimiento falla sin duplicar. Nunca adelantar vencimientos en un bucle sin instrucción del usuario.
- Para cambiar saldos usar el motor, CLI o MCP; no editar SQLite directamente. La interfaz usa las mismas validaciones.
- Pruebas: `npm test` después de `npm ci`.
- Si cambia src, views o public, actualizar también ambos runtimes de escritorio antes de entregar: desktop-resources/runtime y src-tauri/target/release/runtime.

Compatibilidad: la carpeta de datos sigue siendo `%LOCALAPPDATA%\PresupuestoCero` para conservar los presupuestos existentes. El identificador de instalación también se mantiene.

## Eventos P4

- Lectura opt-in: BUDGET_EVENTS_READ=1 para event-snapshot, events y watch en CLI, o snapshot_eventos y eventos en MCP. No se habilita con BUDGET_MCP_WRITE.
- event-snapshot recibe {month} y devuelve proyección consistente con cursor. events recibe {after,limit}; límite máximo 1000.
- watch --after CURSOR [--format ndjson|json-seq] [--once] sigue cambios por stdout. --once entrega una página. Persistir el cursor sólo después de procesar cada registro; deduplicar por source + id.
- El cursor es posición, no permiso. Restauración o huecos pueden exigir nuevo snapshot. Ver wiki/Modulos/Eventos.md.
- Esta concesión es por proceso/presupuesto; detener y reiniciar sin la variable para revocarla desde la configuración del cliente. P1 granular sigue pendiente.