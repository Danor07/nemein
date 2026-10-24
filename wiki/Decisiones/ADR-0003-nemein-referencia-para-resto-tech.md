---
tipo: decision
numero: ADR-0003
estado: aceptada
fecha: 2026-10-23
decide: Igor
reemplaza: —
relacionadas: [ADR-0001, ADR-0002]
verificado-en: no aplica
---

# ADR-0003 — Nemein es la implementación de referencia; Resto-tech traduce su lógica

## Contexto
El motor de permisos (ADR-0001) y la bandeja de propuestas (ADR-0002) también hacen falta en Resto-tech. Probarlos primero en un POS que usan restaurantes es arriesgado. Nemein tiene un solo usuario, y todas sus entradas (ventana, CLI y MCP) ya pasan por el mismo motor.

## Decisión
1. **Nemein es el laboratorio:** ahí se crea la estructura lógica.
2. **Resto-tech la emula.** No copia y pega el código: traduce la lógica, como hoy Rust traduce el Python.

## Consecuencias
- La lógica que se va a traducir (política, decisión, propuesta, registro) se escribe **separada de lo propio de Nemein**.
- Cada regla tiene **vectores de prueba** (entrada → decisión) que después sirven de oráculo para Resto-tech, como el juez que hoy compara Python con Rust.
- En Resto-tech entra después de la paridad de la migración a Rust: antes no se puede cambiar nada que el juez compare.

## Cómo sabríamos que fue un error
Si al traducir a Resto-tech aparece que la lógica dependía de algo propio de Nemein, como un solo usuario o una sola PC, y hay que rediseñarla en vez de traducirla.
