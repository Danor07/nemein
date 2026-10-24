---
tipo: decision
numero: ADR-0001
estado: aceptada
fecha: 2026-10-23
decide: Igor
reemplaza: el interruptor de todo o nada BUDGET_MCP_WRITE=1 (cuando se implemente P1)
relacionadas: [ADR-0002, ADR-0003]
verificado-en: no aplica (decisión de diseño; sin código todavía)
---

# ADR-0001 — Por defecto nada: cada funcionalidad la aprueba el usuario a mano

## Contexto
Hoy Nemein tiene un solo permiso para los agentes: con `BUDGET_MCP_WRITE=1` el MCP puede escribir todo; sin él, nada. **MEDIDO** en `README.md` y `PRIVACIDAD.md`. Igor vio el sistema de permisos de la app de Anthropic, que lista cada acción de un conector y deja elegir una por una entre permitir, preguntar o negar, y es el modelo que tenía en mente.

## Decisión
1. **Por defecto, nada.** Cada módulo WASM, MCP o integración **no es parte del core**: arranca sin poder hacer nada.
2. **El usuario aprueba a mano cada funcionalidad** que permite, acción por acción: permitir, preguntar o negar.
3. **Primero en Nemein, después en Resto-tech** (ver ADR-0003).

## Opciones descartadas
- **Mantener el interruptor de todo o nada:** obliga a darle todo a un agente para que pueda hacer una sola cosa.

## Consecuencias
- Una acción nueva o una extensión nueva nunca empieza habilitada.
- Hace falta una pantalla de permisos clara: si el usuario no entiende qué aprueba, la aprobación no vale.
- Las notas de implementación que Igor aprobó el 23/10:
  - WASM/WASI arranca sin capacidades, y cada permiso es una capacidad que se le entrega;
  - cada pedido dice qué y para qué en lenguaje llano;
  - todo permiso se puede revocar y queda registrado;
  - una versión nueva que pide algo más vuelve a preguntar.

## Cómo sabríamos que fue un error
Si el usuario termina aprobando todo sin leer, porque se le pregunta demasiado: la granularidad estaría mal elegida, no el principio.
