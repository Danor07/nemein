---
tipo: mapa
actualizado: 2026-10-24
verificado-en: c084aa9 + cambios locales 0.2.0
---

# Mapa de Nemein

> **Para qué existe esta wiki.** Para registrar qué se decide y qué se hace en Nemein, y para que Igor y quien programe entiendan **todo**. Si una página no se puede explicar con palabras propias, está mal escrita, no mal leída.
>
> **Nemein también es el laboratorio de Resto-tech** (ADR-0003): lo que se construye acá, como el motor de permisos o la bandeja de propuestas, después se traduce a Resto-tech, como hoy Rust traduce el Python. Por eso su lógica tiene que quedar separable y con vectores de prueba.

## Dónde está cada cosa

| Carpeta | Qué guarda | Regla |
|---|---|---|
| `Plan.md` | qué se hace y en qué orden: las propuestas, con cómo hacerlas más o menos | es **estado actual**: se tilda y se reescribe |
| `Decisiones/` | una decisión por archivo (ADR-0001, ADR-0002…) | no se borra: si cambia, una nueva la **reemplaza** y se enlazan |
| `Modulos/` | una página por parte del código (`core`, `server`, `cli`, `mcp`…) cuando haga falta | **estado actual**: se reescribe para decir la verdad de hoy |
| `Entender/` | explicaciones para aprender | con ejemplos de NUESTRO código, no genéricos |
| `Bitacora/` | qué pasó, un archivo por semana | sólo se agrega; nunca se corrige lo viejo |

**Fuentes que no se copian acá:**
- cómo se usa: `README.md`;
- qué datos guarda y dónde: `PRIVACIDAD.md`;
- cómo trabajan los agentes en el repo: `AGENTS.md`;
- qué se verificó en cada entrega: `VALIDACION.md`;
- la firma del instalador: `SIGNING.md`.

## Reglas de toda página

1. **`verificado-en:`** en el encabezado: el commit contra el que se comprobó lo que dice la página. Sin eso, la página es una opinión.
2. **Nivel de certeza** en cada afirmación importante: **MEDIDO** (se corrió y se vio), **INFERIDO** (se dedujo, no se corrió) o **SUPUESTO**.
3. **Estado actual ≠ historia.** Lo que cambió va a la bitácora; la página de estado se reescribe.
4. **Una decisión vive en UN lugar.** El plan y los módulos la enlazan, no la copian; así no se contradicen.
5. **Esta wiki es pública** (el repo es público). Nunca datos personales, montos reales ni rutas del equipo de Igor.

## Ahora (24/10)

- **v0.1.0 publicada** como pre-release en GitHub, con instalador NSIS, su checksum y una variante autofirmada (ver `VALIDACION.md` y `SIGNING.md`).
- **Decidido por Igor:** ADR-0001 (permisos: por defecto nada), ADR-0002 (bandeja de propuestas) y ADR-0003 (Nemein como referencia para Resto-tech).
- **MEDIDO en 0.2.0 local:** [permisos por acción y bandeja de propuestas](Modulos/Permisos-y-propuestas.md), integrados con CLI, MCP y eventos. HTTP como transporte de integración sigue aplazado.
- **Siguiente:** ver `Plan.md`.

## Interoperabilidad

- **Decidido por Igor:** [ADR-0004](Decisiones/ADR-0004-interoperabilidad-por-estandares.md), estándares para que cada usuario elija su workflow.
- **Propuesta técnica:** [investigación de estándares y D33](Entender/Interoperabilidad.md). Orden y dependencias en [Plan.md](Plan.md).