---
tipo: decision
numero: ADR-0004
estado: aceptada
fecha: 2026-10-24
decide: Igor
reemplaza: —
relacionadas: [ADR-0001, ADR-0002, ADR-0003]
verificado-en: no aplica (decisión de producto)
---

# ADR-0004 — Interoperabilidad por estándares y elección del usuario

## Contexto
Nemein debe formar parte de las herramientas y procesos que cada persona elija. Elegir un workflow o proveedor como centro del producto limitaría esa posibilidad.

## Decisión
**Nemein adopta estándares abiertos para que cada persona pueda incorporarlo a sus herramientas y procesos, con el menor trabajo de adaptación posible.**

- Contratos de datos y operaciones documentados, versionados e implementables sin depender de un proveedor.
- Los adaptadores reutilizan las reglas del mismo núcleo; el transporte no define la lógica contable.
- El usuario elige conexiones y concede capacidades, bajo ADR-0001 y ADR-0002.
- Datos y configuraciones exportables en formatos documentados; credenciales aparte.
- No descartar un transporte sólo porque existe otro: evaluar compatibilidad, costo y necesidades.
- Declarar versión, perfil soportado, ejemplos y pruebas de compatibilidad de cada estándar adoptado.

## Alcance
Igor aprobó este principio. La selección técnica sigue siendo una **propuesta**, desarrollada en [la investigación](../Entender/Interoperabilidad.md) y [el plan](../Plan.md). Este ADR no aprueba automáticamente una API de red o todos los conectores.

## Cómo sabríamos que no se cumple
Si una integración requiere leer tablas privadas, duplicar reglas contables, depender de una marca o romperse sin aviso al actualizar.
