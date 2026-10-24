# Control de calidad

Todo cambio de comportamiento incluye regresión, propiedades del dominio y entradas adversariales. El código y las pruebas generados por agentes siguen las mismas reglas que cualquier contribución.

## Gate local

npm run quality ejecuta en orden:

1. ESLint recomendado con reglas adicionales, sin advertencias ni configuración inline, y validación del workflow. Es análisis AST de JavaScript; no equivale a un sistema de tipos.
2. Pruebas de regresión y migraciones.
3. Propiedades con fast-check: conservación del dinero, asignación base cero, importaciones CSV e invariantes de permisos.
4. Fuzzing generativo de cursores y solicitudes de agentes sin concesiones.
5. Stryker y un verificador del reporte: mínimo global 90 %, sin mediciones vacías, timeouts, errores ni mutantes sin cobertura.

Las semillas están fijadas en cada propiedad. Un fallo informa seed, path y contraejemplo reducido. No sustituir una propiedad fallida por un ejemplo que la haga pasar.

La mutación cubre src/policy.js, src/agent-config.js, src/credentials.js y scripts/mutation-gate.js. Medición local en Windows: 95,08 %, 348 de 366 mutantes detectados, sin timeouts ni errores. Quedan 18 supervivientes visibles en el reporte; algunos son equivalentes. Este score no representa toda la aplicación.

El primer intento sobre ese alcance dio 84,11 % y fue rechazado. Se agregaron pruebas de formato de credenciales, rutas, fallbacks, enlaces, ACL y ejecución del gate. El recorrido de ancestros usa una lista finita para evitar los mutantes con bucles infinitos. No se redujo el umbral ni se excluyeron operadores.

Al modificar otras decisiones críticas, ampliar la mutación y las propiedades que las verifican. Los cambios de umbrales, exclusiones e invariantes requieren revisión explícita. Los instaladores excluyen las herramientas de desarrollo.

## Aislamiento y reproducibilidad

El workflow quality.yml fija la imagen Linux de Node por digest, las acciones por SHA y las dependencias con npm ci y package-lock.json. El checkout se monta en sólo lectura. La instalación omite scripts generales; sólo se reconstruye el módulo SQLite nativo necesario.

Después de instalar, los tests corren sin red, con raíz de sólo lectura, capacidades eliminadas, usuario sin privilegios, límites de recursos y espacios separados para temporales, mutantes y reportes. Las pruebas usan presupuestos temporales; no se montan datos personales ni credenciales de producción.

El job Windows usa un runner desechable, versiones fijadas de Node y Rust, Cargo.lock, regresiones/PBT/ACL y rustfmt/Clippy con advertencias como errores. La imagen Windows hospedada puede actualizarse: no se promete reproducción binaria bit a bit.

Localmente se comprobaron ESLint, regresiones, PBT, fuzzing, mutación, rustfmt y Clippy. Docker no está disponible en este entorno; su ejecución se comprueba en GitHub antes de aprobar la entrega.

## Revisión y entrega

Un fallo rechaza la validación técnica. Un resultado verde habilita revisión; el workflow no hace merge ni despliega automáticamente.

Para impedir merges con checks fallidos, configurar protección de rama con Quality gate y Native static gate requeridos. La configuración administrativa no se modifica automáticamente.

Los cambios de workflow, generadores, umbrales e invariantes requieren revisión humana. Que el mismo agente genere código y pruebas no proporciona independencia. El fuzzing actual es generativo y acotado, no una campaña guiada por cobertura.

Los reportes de mutación se conservan como artefactos incluso cuando falla el umbral. Un score alto no prueba ausencia de defectos. La auditoría de dependencias se verifica aparte de este gate; las actualizaciones afectadas de csv-parse, zod y dependencias indirectas se validaron con la suite y la auditoría local actual.
