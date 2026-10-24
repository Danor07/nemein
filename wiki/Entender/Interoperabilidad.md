---
tipo: explicacion
actualizado: 2026-10-24
verificado-en: 1c4cca5
estado: P4a utilizable por CLI y MCP con concesión explícita; P1 y P4b pendientes
---

# Interoperabilidad: contratos primero, adaptadores después

El principio aprobado vive en [ADR-0004](../Decisiones/ADR-0004-interoperabilidad-por-estandares.md). Las elecciones técnicas de esta página son recomendaciones.

**MEDIDO por inspección, sin ejecutar pruebas:** Nemein tiene CLI JSON y MCP stdio. El núcleo usa SQLite y transacciones explícitas; la primera etapa de P4 ya tiene registro interno (ver Modulos/Eventos.md). Algunas escrituras de planificación son sentencias individuales: ahora se envuelven junto al evento en la frontera del motor. Agregar eventos sólo al servidor dejaría afuera CLI y MCP.

## Design by Contract como inspiración

Igor propone tomar como inspiración el diseño por contratos de Bertrand Meyer. Se usa como guía de diseño; no se adopta Eiffel ni una herramienta nueva.

La [introducción oficial de Eiffel](https://www.eiffel.com/values/design-by-contract/introduction/) explica las obligaciones entre quien llama y quien implementa mediante precondiciones, postcondiciones e invariantes. Un esquema JSON describe estructura y restricciones de datos; el contrato de comportamiento describe qué puede pasar con el estado.

**Diseño de P4:** atomicidad, cursores y snapshot internos implementados; concesión de lectura por proceso implementada; política granular P1 pendiente. [Estado medido](../Modulos/Eventos.md).

| Parte del contrato | Ejemplo en Nemein |
|---|---|
| Precondición | La cuenta existe, el importe es válido y el actor está autorizado para la operación. Las condiciones que dependen del estado se comprueban dentro de la transacción correspondiente. |
| Postcondición de éxito | El movimiento y su evento quedan persistidos juntos; el resultado identifica la operación y el hecho. |
| Invariante | Una transferencia interna conserva el total combinado de las cuentas; cada mutación cubierta por P4 y su evento se confirman o revierten juntos. |
| Comportamiento ante fallo | Un rechazo o un fallo de persistencia no deja cambios contables parciales ni un evento de éxito. La auditoría de intentos es independiente. |

Especificar estado previo y posterior, campos que pueden cambiar, efectos permitidos y errores observables. Traducir las propiedades a pruebas y vectores compartidos entre UI, CLI y MCP, también útiles para ADR-0003. Las comprobaciones de seguridad y las validaciones de entradas externas siguen siendo obligatorias en producción, aunque algunas aserciones de desarrollo puedan deshabilitarse.

Una violación de postcondición indica un defecto de implementación; una entrada inválida del usuario debe producir un rechazo claro. No confundir pruebas de contrato con demostración formal de corrección, ni usar verificaciones costosas de toda la base en cada llamada sin evaluar su costo.

## Estándares recomendados

**Alcance actual:** CLI, MCP stdio y archivos. HTTP/OpenAPI y SSE quedan aplazados por indicación de Igor; sus referencias se conservan como investigación, no como tareas activas.

Fuentes primarias consultadas el 24/10/2026. **INFERIDO:** las aplicaciones propuestas son nuestra recomendación.

| Capa | Referencia | Aplicación propuesta |
|---|---|---|
| Contratos | [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) | Entradas, resultados, propuestas y payloads compartidos. Versiones y ejemplos válidos/inválidos; validar fechas sin asumir que format siempre las valida. |
| Eventos | [CloudEvents 1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md), [JSON](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/formats/json-format.md) | Sobre con specversion "1.0", id, source, type; time, subject, dataschema y datacontenttype según perfil. No exige nube ni broker. |
| CLI en flujo | [RFC 7464](https://www.rfc-editor.org/rfc/rfc7464) | Opción json-seq (RS + JSON + LF). JSON por línea puede ser el modo cómodo; documentarlo como convención NDJSON, no como RFC 7464. stdout datos, stderr diagnósticos. |
| Agentes | [MCP y sus versiones](https://modelcontextprotocol.io/specification/versioning) | Mantener stdio, declarar revisiones soportadas y clientes probados. La fuente declara 2026-07-28 como actual; no demuestra soporte del SDK instalado. Revisarlo antes de actualizar. |
| HTTP (aplazado) | [OpenAPI 3.2.1](https://spec.openapis.org/oas/v3.2.1.html), [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) | Contrato de rutas y errores. Evaluar 3.1.x si las herramientas destinatarias no soportan 3.2.1; fijar versión probada. OpenAPI describe, no implementa. |
| SSE (aplazado) | [SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html) | Reutilizar el registro con id/Last-Event-ID. Persistencia y detección de huecos siguen siendo responsabilidad de Nemein. |
| Documentación asíncrona | [AsyncAPI 3.0.0](https://www.asyncapi.com/docs/reference/specification/v3.0.0) | Evaluar al tener transporte externo concreto, con versión compatible. No inventar un binding estándar para la CLI. |
| Fechas y tablas | [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339.txt), [CSV RFC 4180](https://www.rfc-editor.org/rfc/rfc4180.txt) | Instantes con zona, fechas contables separadas; CSV con encabezados, codificación, moneda y signos definidos. RFC 4180 es informativo. |
| Correo | [JMAP Core RFC 8620](https://www.rfc-editor.org/rfc/rfc8620), [Mail RFC 8621](https://www.rfc-editor.org/rfc/rfc8621.txt) | Cualquier proveedor compatible. Descubrir capacidades y verificar alcance real del token: filtrar una carpeta no necesariamente limita la credencial. |
| Bancos | [OFX / FDX](https://financialdataexchange.org/about-fdx/ofx-work-group/), [ISO 20022](https://www.iso20022.org/iso-20022-message-definitions) | OFX/camt.053 con versiones concretas y archivos sanitizados de prueba. No presumir disponibilidad en bancos locales. |

El modelo financiero sigue siendo propio: documentar importe entero PYG, signos, fechas, identificadores, transferencias y conciliación. Estos estándares no definen qué significa asignar presupuesto. Incluir moneda no equivale a implementar multimoneda.

## D33 de Resto-tech: concepto y código

**MEDIDO por lectura el 24/10, sin ejecución:** página conceptual motor-de-eventos; código local facturacion.py (encolar_venta_en_conn, disparar_worker), mesas.py (_cobrar, _encolar_facturacion_post_commit) y demos/demo_facturacion.py (test_outbox_atomicidad).

La función de cobro pasa su conexión existente al INSERT de cola_facturacion. La restricción única evita duplicar una venta en la cola. El worker se dispara después del commit. La prueba inspeccionada verifica visibilidad desde otra conexión antes y después del commit; no se ejecutó aquí.

La advertencia conceptual sobre posible encolado post-commit quedó anterior a este camino del código. Esto no es una auditoría de todo Resto-tech. No se copia su código ni sus reglas fiscales a esta wiki pública.

**INFERIDO:** trasladar la separación, no construir un bus interno: cambios contables síncronos y hechos confirmados disponibles para integración asíncrona. Las tablas actuales siguen siendo la fuente contable; no se propone event sourcing.

- **P4a:** registro durable + lectura por cursor. Imprimir en stdout no prueba que el consumidor procesó un mensaje.
- **P4b:** entrega por destino, confirmaciones, reintentos y deduplicación. Es la parte equivalente a cola + worker de D33. Un lector nunca consume el evento para todos.

CloudEvents define el sobre; no garantiza orden, autorización, entrega o ejecución exactamente una vez.

## Contrato mínimo de P4a

Propuesta a cerrar con fixtures y pruebas:
1. Catálogo de hechos para todas las mutaciones y entradas: importación, transferencias, conciliación y planificación incluidas. Definir agrupación y evitar duplicados por llamadas anidadas.
2. source opaco estable por presupuesto, id estable por evento y secuencia local separada. Versionar cambios incompatibles de payload.
3. Payload mínimo, sin secretos ni rutas locales. Permisos para historia y futuros eventos; montos y comercios sólo cuando corresponda.
4. Mutación + evento en una transacción. Si falla guardar el evento, rollback de la mutación cubierta. Red siempre afuera.
5. Cursor ligado a presupuesto y evento de anclaje (implementado). Restauraciones que pierden o reemplazan el anclaje se rechazan; si conservan el prefijo, el cursor sigue válido. No se detecta toda copia como una generación nueva. Huecos se informan explícitamente; recuperación detallada en Modulos/Eventos.md.
6. Consumidor persiste resultado antes de su cursor y deduplica por source + id. Reintentos pueden repetir: no prometer exactly-once.
7. Snapshot consistente con cursor de corte para empezar sin ventana de pérdida.
8. Migración de presupuestos existentes sin inventar historia anterior; línea de base documentada.
9. Retención explícita; no purgar automáticamente pendientes sin recuperación definida.
10. Compatibilidad aditiva, política de retiro, lotes acotados, backpressure, cierre de pipes y concurrencia multiproceso.

El orden y dependencias viven en [Plan.md](../Plan.md). Contratos y persistencia interna pueden empezar antes de permisos; exponerlos a integraciones requiere autorización. WASM, correo y multinegocio no son requisitos para esta base.
