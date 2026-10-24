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

La mutación cubre src/policy.js, src/agent-config.js, src/credentials.js, src/sqlite-startup.js, public/mcp-download.js y scripts/mutation-gate.js. La medición anterior, sobre cinco módulos en fca6ad5, detectó 397 de 416 mutantes: 95,43 %, con 19 supervivientes, sin timeouts, errores ni mutantes sin cobertura. El reporte conserva los supervivientes para revisión; este score no representa toda la aplicación.

El primer intento sobre los cuatro módulos anteriores dio 84,11 % y fue rechazado. La medición local posterior sobre esos cuatro módulos alcanzó 95,08 % (348/366). Se agregaron pruebas de formato de credenciales, rutas, fallbacks, enlaces, ACL y ejecución del gate. El recorrido de ancestros usa una lista finita para evitar los mutantes con bucles infinitos. No se redujo el umbral ni se excluyeron operadores.

Al modificar otras decisiones críticas, ampliar la mutación y las propiedades que las verifican. Los cambios de umbrales, exclusiones e invariantes requieren revisión explícita. Los instaladores excluyen las herramientas de desarrollo.

## Aislamiento y reproducibilidad

El workflow quality.yml fija la imagen Linux de Node por digest, las acciones por SHA y las dependencias con npm ci y package-lock.json. El checkout se monta en sólo lectura. La instalación omite scripts generales; sólo se reconstruye el módulo SQLite nativo necesario.

Después de instalar, los tests corren sin red, con raíz de sólo lectura, capacidades eliminadas, usuario sin privilegios, límites de recursos y espacios separados para temporales, mutantes y reportes. Las pruebas usan presupuestos temporales; no se montan datos personales ni credenciales de producción.

El job Windows usa un runner desechable, versiones fijadas de Node y Rust, Cargo.lock, regresiones/PBT/ACL y rustfmt/Clippy con advertencias como errores. La imagen Windows hospedada puede actualizarse: no se promete reproducción binaria bit a bit.

Los dos jobs se comprobaron en GitHub sobre fca6ad5: Quality gate y Native static gate aprobados. Docker no está disponible localmente; el aislamiento Linux se validó en ese runner remoto. La primera ejecución Windows encontró un permiso explícito adicional de Administradores y una carrera al activar WAL. Se corrigieron antes de obtener verde, manteniendo las pruebas y el umbral. Los archivos se crean vacíos, se restringe su ACL y sólo entonces se escribe el secreto; WAL reintenta únicamente SQLITE_BUSY durante el arranque, hasta 100 intentos con pausas de 50 ms, restaurando busy_timeout.

## Revisión y entrega

Un fallo rechaza la validación técnica. Un resultado verde habilita revisión; el workflow no hace merge ni despliega automáticamente.

Para impedir merges con checks fallidos, configurar protección de rama con Quality gate y Native static gate requeridos. La configuración administrativa no se modifica automáticamente.

Los cambios de workflow, generadores, umbrales e invariantes requieren revisión humana. Que el mismo agente genere código y pruebas no proporciona independencia. El fuzzing actual es generativo y acotado, no una campaña guiada por cobertura.

Los reportes de mutación se conservan como artefactos incluso cuando falla el umbral. Un score alto no prueba ausencia de defectos. La auditoría de dependencias se verifica aparte de este gate; las actualizaciones afectadas de csv-parse, zod y dependencias indirectas se validaron con la suite y la auditoría local actual.

## Instalación Windows y comportamiento visible

El job Windows construye un NSIS de prueba, lo instala con /S en un runner nuevo y comprueba archivos, registro de desinstalación, destino del acceso del menú Inicio, handshake MCP desde el runtime instalado, credenciales y arranque nativo. El script impide ejecutarlo como instalador local fuera del runner efímero. Este ensayo no publica el paquete y no usa el certificado privado de distribución. La variante autofirmada se verifica por separado.

Las herramientas whoami.exe e icacls.exe se resuelven en SystemRoot/System32, independientemente del PATH o de Git Bash. El evaluador puro niega fallbacks distintos de ask/deny, incluso si una regla antigua evitó la validación de guardado; lo cubren propiedades y una regresión por el llamador real.

El botón MCP anuncia preparación, evita envíos duplicados, conserva el ancho entre estados y permite reintentar un error persistente. Una respuesta HTTP correcta sólo confirma que el archivo fue preparado y que se solicitó guardarlo; no se afirma que el navegador lo escribió en disco. Se conserva la alternativa de ver/copiar y se prueban submit, errores HTTP y de red.
