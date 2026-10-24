---
tipo: decision
numero: ADR-0002
estado: aceptada
fecha: 2026-10-23
decide: Igor
reemplaza: —
relacionadas: [ADR-0001, ADR-0003]
verificado-en: no aplica (decisión de diseño; sin código todavía)
---

# ADR-0002 — Un solo punto escribe; los demás proponen, y él responde desde una bandeja

## Contexto
Para usar Nemein desde más de un dispositivo, o para que un agente pida cambios, hace falta decidir quién escribe. En Resto-tech hay momentos limpios para unir lo de varios puestos, como el cierre de caja. En un presupuesto personal no existe un momento así.

## Decisión
1. **Un «pull request contable»:** quien no es el que escribe manda una **propuesta**, y el único que escribe la **acepta, la modifica o la rechaza**.
2. **Las propuestas llegan a una bandeja** en la interfaz del que escribe. **No se atan a ningún momento**, tampoco a la conciliación bancaria («¿qué ganaríamos?», Igor).
3. **Proponer no depende de que el equipo principal esté encendido;** la respuesta llega cuando lo esté.
4. Una acción en estado «preguntar» del motor de permisos (ADR-0001) es una propuesta.

## Opciones descartadas
- **Atar las propuestas a la conciliación bancaria:** agrega una dependencia sin ganar nada.
- **Sincronizar con fusión automática (CRDT):** con plata, una fusión automática puede dejar un saldo mal sin que nadie lo vea (recomendación de Claude, ver `Plan.md`).

## Consecuencias
- Cada propuesta necesita su base (lo que veía quien la hizo) para detectar conflictos al aceptarla.
- Hay que resolver la entrega cuando el principal está apagado. La recomendación está en `Plan.md` (P2): consulta periódica como base y avisos sólo para acelerar.
- Encaja con lo que Resto-tech ya hace en chico: el mozo propone una cancelación y el cajero la aprueba.
- Para sucursales de Resto-tech: los hechos (ventas, arqueos) no se rechazan, se observan; las decisiones (precios, carta) siguen el flujo de propuesta.

## Cómo sabríamos que fue un error
Si las propuestas se acumulan sin respuesta y el usuario termina escribiendo por otro lado para no esperar.
