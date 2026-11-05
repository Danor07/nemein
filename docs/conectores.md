# Conectores WASM (P3)

Un conector es una función pura: recibe los bytes de un archivo que eligió el propietario y devuelve un [lote de importación v1](importaciones.md). Corre aparte, sin acceso al presupuesto, y su salida nunca escribe por sí misma: el anfitrión la valida y la pasa por la revisión y la confirmación protegida.

**Estado.** P3.1 fijó el contrato y la receta. P3.2 agregó el trabajador encerrado `nemein-connector`, su empaquetado y el ejecutor de Node (`src/connector-runner.js`). P3.3 agregó el flujo:
- instalación, habilitación y revocación por el propietario;
- preparación, revisión y confirmación protegida del lote;
- recuperación sin revivir habilitaciones.

P3.4 agrega la pantalla **Conectores** y la firma Ed25519 que informa. En Linux los conectores no corren hasta tener un encierro equivalente al de Windows: la pantalla lo dice, y el binario y el ejecutor responden `UNSUPPORTED_PLATFORM`.

## Mundo WIT

Fuente única: [world.wit](../src-tauri/connector/sdk/wit/world.wit), paquete `nemein:connector@1.0.0`.

```wit
world connector {
  export api;
}

interface api {
  record manifest { id: string, version: string, name: string, description: string, extensions: list<string> }
  record context { config: string, account-id: string }
  record error { code: string, message: string }
  describe: func() -> manifest;
  parse: func(input: list<u8>, ctx: context) -> result<string, error>;
}
```

El mundo **no tiene imports**: el componente no puede leer archivos, el reloj, la red, aleatoriedad ni el presupuesto. Sólo ve `input` y `ctx`. Decir que no tiene capacidades no es exacto: entregarle el archivo financiero es la capacidad que el propietario aprueba al habilitarlo. Instalar y habilitar son pasos separados y revocables (P3.3).

Los tipos y las funciones están dentro de la interfaz exportada `api`, no en el nivel del mundo. El Component Model trata los tipos declarados en un mundo como **imports de tipo**: con `describe` y `parse` exportados directamente, el componente importaba `manifest`, `context` y `error` como alias `(type (eq …))`. No son funciones, pero entonces «sin imports» dejaría de ser una regla simple y habría que distinguir imports de tipo de imports de recursos. Con la interfaz exportada, el componente tiene cero imports y exporta exactamente `nemein:connector/api@1.0.0`. Las firmas de `describe` y `parse` son las acordadas.

`describe` también ejecuta código del conector, así que corre bajo el mismo encierro y plazo que `parse`. Un pánico del conector es una trampa de WebAssembly; el anfitrión la trata como un error, sin lote parcial.

## Contexto

| Campo | Regla |
| --- | --- |
| `config` | Configuración que el propietario guardó para el conector, hasta 16.384 bytes. Su formato es del conector, que debe rechazar lo que no entiende. Vacía si no hay. |
| `account-id` | Cuenta local de destino, decidida por el anfitrión: representación decimal canónica de un entero seguro positivo (1 a 9007199254740991, sin signo, espacios ni ceros a la izquierda). El lote debe declarar exactamente ese `account_id`; el anfitrión rechaza otro (P3.3). |

El SDK lee `account-id` con `account_id()`, que rechaza en lugar de normalizar.

## Manifiesto e identidad

| Campo | Regla |
| --- | --- |
| `id` | Palabras ASCII en minúscula unidas por `.` o `-`, hasta 160 caracteres. |
| `version` | 1 a 80 caracteres con contenido. |
| `name` | 1 a 80 caracteres con contenido. |
| `description` | Hasta 500 caracteres. |
| `extensions` | Hasta 8, de 1 a 16 letras minúsculas o dígitos, sin punto. Sólo orientan el selector de archivos. |

El manifiesto es declarativo. La identidad verificada de un conector es el SHA-256 de los bytes del componente junto con su manifiesto, comprobada sobre los mismos bytes que recibe el trabajador; el nombre de la carpeta no alcanza como prueba. `provenance` del lote también es declarativa: el anfitrión exige `provenance.connector = manifest.id` y `provenance.version = manifest.version`, y rechaza el lote si difieren o si `describe` devuelve otro manifiesto que el aprobado. Un cambio de bytes es otro conector y vuelve a pedir aprobación.

## Resultado, errores y límites

`parse` devuelve el texto JSON del lote v1, compacto y en UTF-8, o un `error`. El anfitrión limita los bytes antes de parsear, valida con `validateImportBatch`, compara cuenta y procedencia, y recién entonces lo ofrece para revisar. Un error rechaza el archivo completo.

| Límite | Valor |
| --- | --- |
| Archivo de entrada | 5.000.000 bytes, como el contrato de importación |
| Movimientos por lote | 20.000 |
| Salida | 25.165.824 bytes (24 MiB). Cualquier lote v1 válido escrito de forma compacta cabe: el peor caso, con descripciones de 160 caracteres de control escapados, ronda 22,4 MB |
| `config` | 16.384 bytes |
| `error.code` | `[A-Z][A-Z0-9_]*`, hasta 64 caracteres |
| `error.message` | 1 a 1.024 caracteres; no debe repetir el archivo más allá de lo necesario para ubicar el problema |
| Componente | 16.777.216 bytes (16 MiB). El ejemplo pesa unos 75 KB |
| Manifiesto | Sus campos suman hasta 8.192 bytes, con hasta 8 extensiones; además, las reglas de cada campo de arriba |
| Tiempo | 10 s de reloj de pared por ejecución, desde que se crea el proceso: compilación, instanciación, `describe`, `parse` e IPC |
| Memoria del proceso | 256 MiB comprometidos para todo el trabajador (límite del Job) |
| Memoria del componente | 128 MiB de memoria lineal, 100.000 elementos de tabla, 32 instancias, 32 tablas y 4 memorias; pila de wasm de 512 KiB |
| Bytes que el anfitrión levanta por llamada | 26.214.400 (el tope de salida más 1 MiB); un resultado más grande falla dentro del componente |

Estos límites forman parte del contrato para quien escribe conectores. Desde P3.2 los aplican el trabajador y el ejecutor de Node, fuera del componente.

## Identidad de los movimientos

Cada productor documenta cómo obtiene `entries[].id`. El SDK ofrece `entry_id(parts)`: SHA-256 en hexadecimal minúscula del arreglo JSON compacto de `parts`, los mismos bytes que `JSON.stringify(parts)` en JavaScript. Las partes deben incluir un espacio de nombres que no cambie entre versiones, la cuenta de destino y la referencia estable de la fuente.

**Nunca** entran en la identidad el hash del componente, la versión del conector o del contrato, el período, la posición de la fila, el locale ni la moneda. Así una versión nueva reconoce lo que importó una anterior. Las claves históricas de CSV, OFX y CAMT (`importIdentity`) no cambian.

## SDK, ejemplo y receta

La carpeta [src-tauri/connector](../src-tauri/connector) es un workspace Cargo aparte del shell de escritorio, con su propio `Cargo.lock` y Rust 1.99.1 fijado en `rust-toolchain.toml`:

| Crate | Responsabilidad |
| --- | --- |
| `nemein-connector-sdk` | Tipos del WIT (wit-bindgen 0.63, sin `async`), `export!`, `Batch` en JSON compacto, `account_id`, `entry_id`. Sólo depende de `wit-bindgen` y `sha2`. |
| `nemein-example-bank-csv` | [Conector de ejemplo](../src-tauri/connector/examples/fictitious-bank-csv/README.md) para el CSV de un banco inventado. |
| `nemein-connector-tools` | `nemein-componentize`: compila, envuelve y comprueba. No ejecuta conectores. |

El anexo llamaba `nemein-connector` al crate del SDK. Ese nombre quedó para el binario trabajador (decisión 2), así que el SDK es `nemein-connector-sdk`.

Receta, desde `src-tauri/connector`:

```sh
cargo run --locked -p nemein-connector-tools -- build nemein-example-bank-csv salida.wasm
cargo run --locked -p nemein-connector-tools -- check salida.wasm
```

`build` compila el paquete para `wasm32-unknown-unknown` con el perfil `guest` (pánicos que abortan, LTO), remapea las rutas del registro de Cargo y envuelve el módulo con `wit-component`, **sin WASI ni adaptadores**. Rechaza un módulo núcleo con imports antes de envolverlo y verifica el componente resultante: cero imports y exactamente la exportación del mundo. Imprime `{"bytes":…,"sha256":"…"}`. `wrap` envuelve un núcleo ya compilado y `check` sólo verifica. No se usa `cargo component`, que suele producir `wasm32-wasip1` con imports de WASI.

**Reproducibilidad.** Las rutas absolutas del registro de Cargo quedaban en las cadenas de pánico; `build` las remapea con `--remap-path-prefix`, porque `trim-paths` todavía no es estable en 1.99.1. Con la misma versión de Rust, el mismo `Cargo.lock` y el mismo sistema operativo, el componente tiene los mismos bytes aunque cambien la carpeta del checkout o `CARGO_HOME`. El CI lo comprueba compilando dos veces y comparando con `cmp`. No se promete igualdad entre Linux y Windows.

La comprobación estática lee nombres sin compilar ni ejecutar. Los tipos de las funciones los comprueba wasmtime al instanciar con enlaces tipados: un componente con el nombre correcto y tipos falsos pasa `check` pero no se instancia.

## Trabajador encerrado (P3.2)

`nemein-connector` es un solo binario Rust (`src-tauri/connector/worker`) con dos papeles:

- **Supervisor** (sin argumentos). Node le escribe una trama de solicitud por stdin y **deja stdin abierto** hasta recibir la respuesta. El supervisor crea al trabajador encerrado, le pasa la solicitud, espera una trama de respuesta dentro del plazo y la reenvía por stdout. Mata al trabajador en todos los casos. Cerrar stdin antes de la respuesta cancela la ejecución: el supervisor mata al trabajador y termina sin escribir nada (código 1).
- **Trabajador** (`worker`). Antes de leer nada comprueba que está dentro de un AppContainer y de un Job; si no, responde `SANDBOX_UNAVAILABLE`. Después compila el componente con wasmtime y llama a `describe` y, si corresponde, a `parse`.

El supervisor no interpreta lo que dice el trabajador más allá de los largos de trama. El ejecutor de Node trata toda respuesta como no confiable y vuelve a comprobar, fuera del encierro, el manifiesto, el manifiesto aprobado, el lote v1 (`validateImportBatch`), la cuenta y la procedencia.

### Tramas

Las tramas van por stdin y stdout:

```text
"NMC" versión:u8=1 tipo:u8 ('Q' solicitud, 'R' respuesta) largo:u32le encabezado(JSON) cantidad:u8 (largo:u32le bloque)*
```

- **Solicitud:** encabezado `{"op":"describe"|"parse","config":"…","account_id":"…"}`; bloques: el componente y el archivo (vacío para `describe`).
- **Respuesta:** encabezado `{"status":"ok","manifest":{…}}` con el lote como único bloque en `parse`; `{"status":"connector_error","manifest":{…},"error":{"code","message"}}`; o `{"status":"host_error","code":"…","message":"…"}`.

Cada largo se compara con su tope antes de leer un solo byte de ese campo: encabezado de 64 KiB, componente, archivo y lote. Los campos se leen a medida que llegan, así que quien declara un largo enorme o deja de escribir no hace reservar más que el tope. Del lado de Node, el lector incremental además rechaza bytes después de la trama. [frames.json](../src-tauri/connector/worker/fixtures/frames.json) tiene vectores que prueban las dos implementaciones: Node codifica solicitudes que Rust decodifica, y al revés con las respuestas.

### Encierro (Windows 10 1809 o posterior)

| Pieza | Qué hace |
| --- | --- |
| Token | AppContainer menos privilegiado (LPAC) `Nemein.ConnectorWorker`, sin capacidades. Sólo alcanza objetos que nombran su SID o `ALL RESTRICTED APPLICATION PACKAGES`, como System32. Windows no crea procesos en un AppContainer sin perfil registrado (`CreateProcessW` falla con el error 2), así que el supervisor registra el perfil la primera vez, como Chromium, y después sólo deriva el mismo SID. El registro se serializa con un mutex por usuario (`Local\Nemein.ConnectorWorker.Registration`): en CI, dos primeras ejecuciones simultáneas hicieron fallar el registro (`0x8007000a`) y un `CreateProcessW` concurrente encontró el perfil a medio registrar (error 2). El perfil le da al trabajador una carpeta propia bajo `%LOCALAPPDATA%\Packages`: es lo único que puede escribir, y desde ahí no alcanza nada del usuario. |
| Permisos de archivos | El supervisor otorga lectura y ejecución a ese SID sólo sobre `nemein-connector.exe` y su carpeta, sin herencia, y nunca sobre la carpeta de datos. Si el permiso ya está, no toca nada. Nemein se instala en `%LOCALAPPDATA%\Nemein`, y el usuario es dueño de esa carpeta, así que no hace falta elevación. |
| Job | `KILL_ON_JOB_CLOSE`, un solo proceso activo, 256 MiB comprometidos y muerte ante excepciones no manejadas. El supervisor tiene el único handle: si muere por cualquier motivo, muere el trabajador. Las restricciones de UI se agregan cuando el trabajador no está en otro Job, porque los Jobs con restricciones de UI no se pueden anidar; dentro de la aplicación de escritorio ya está en el Job de Nemein, y ahí la UI la cubre el bloqueo de Win32k. |
| Proceso | Se crea suspendido, se asigna al Job y recién entonces corre. Sin procesos hijos (`CHILD_PROCESS_RESTRICTED`), sin consola (`DETACHED_PROCESS`), con un entorno que sólo tiene `LOCALAPPDATA` y `SystemRoot`, y la carpeta del binario como directorio de trabajo. Sin `LOCALAPPDATA`, `CreateProcessW` no encuentra la carpeta del AppContainer y falla con el error 203. |
| Handles | Hereda exactamente dos caños anónimos, los de stdin y stdout, mediante `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. |
| Mitigaciones | El conjunto de Chromium compatible con un JIT: terminación ante corrupción del heap, ASLR ascendente y de alta entropía, Win32k deshabilitado, sin puntos de extensión, sin fuentes no del sistema, sin imágenes remotas ni de baja integridad, y System32 primero. No se prohíbe el código dinámico, porque Cranelift escribe código máquina. |
| Runtime de C | Enlazado estático (`+crt-static`), porque dentro del AppContainer `vcruntime140.dll` puede no estar disponible. |

**Wasmtime** compila sin WASI, `async`, hilos, GC ni caché; además se apagan memory64, multi-memory, relaxed SIMD, aritmética ancha, páginas a medida, cambio de pila y llamadas de cola. Antes de compilar, `wasmparser` cuenta los imports de nivel superior de cualquier clase: `component_type().imports()` de wasmtime no lista los imports de tipo, y el contrato no admite ninguno. Instancia con un `Linker` vacío y enlaces tipados del mundo, usa un `Store` nuevo por ejecución con los límites de arriba, y corre wasm en un hilo con pila explícita de 8 MiB.

### Cierre en cadena

- **Fin de stdin o caída de Node:** el supervisor ve EOF, mata al trabajador y termina.
- **Caída o muerte del supervisor:** se cierra el único handle del Job y `KILL_ON_JOB_CLOSE` mata al trabajador.
- **Cierre o caída de la ventana:** Tauri pone a Node en un Job propio con `KILL_ON_JOB_CLOSE` que no admite escapar. Al terminar Nemein por cualquier motivo, mueren Node y todo lo que haya iniciado. Node no lanza procesos antes de que cargue la ventana, así que asignarlo justo después de crearlo no deja nada afuera.

### Errores

El ejecutor de Node responde con un `Error` con `code`:

- **`CONNECTOR_<código>` para los fallos del anfitrión:**
  - `REQUEST_INVALID`, `COMPONENT_INVALID`, `COMPONENT_HAS_IMPORTS`, `COMPONENT_WRONG_WORLD`, `CONNECTOR_TRAP`;
  - `MANIFEST_TOO_LARGE`, `ERROR_TOO_LARGE`, `OUTPUT_TOO_LARGE`;
  - `TIMEOUT`, `MEMORY_LIMIT`, `WORKER_CRASHED`, `WORKER_PROTOCOL`, `SANDBOX_UNAVAILABLE`, `UNSUPPORTED_PLATFORM`.
- **Además:**
  - `CONNECTOR_UNAVAILABLE`: no hay binario configurado o no se encontró;
  - `CONNECTOR_REQUEST_INVALID`: la solicitud no pasa los topes ni el `account-id` canónico, y no se lanza nada;
  - `CONNECTOR_SUPERVISOR_FAILED`: el supervisor no pudo iniciarse aunque el binario existe, dejó de leer antes de recibir la solicitud completa o terminó sin responder;
  - `CONNECTOR_PROTOCOL`: el supervisor respondió algo que no es una trama válida, o bytes de más;
  - `CONNECTOR_MANIFEST_INVALID` y `CONNECTOR_MANIFEST_MISMATCH`: el manifiesto no cumple las reglas o no es el aprobado;
  - `CONNECTOR_ACCOUNT_MISMATCH` y `CONNECTOR_PROVENANCE_MISMATCH`: el lote declara otra cuenta, u otra procedencia que el manifiesto;
  - los códigos `IMPORT_*` del contrato v1.
- **Errores del propio conector:** salen como `CONNECTOR_REJECTED`, con su código en `connectorCode` y su mensaje. Así un conector no puede hacer pasar su código por un fallo del anfitrión.

El ejecutor también tiene un plazo de respaldo de 15 s (los 10 s del supervisor más 5): si el supervisor quedara trabado, lo mata y responde `CONNECTOR_TIMEOUT`. Gana el primer desenlace. Con una respuesta válida cierra stdin; ante cualquier error, además, mata al supervisor, y con él cae el Job del trabajador.

`nemein-connector.exe` es un binario de subsistema GUI: nunca abre una ventana de consola, lo lance quien lo lance, y stdin y stdout siguen siendo los caños que recibe. Node lanza al supervisor con un entorno que sólo tiene `LOCALAPPDATA` y `SystemRoot`. En Windows, libuv agrega las variables que Windows necesita para crear procesos, como `PATH`, `TEMP` y `USERPROFILE`. El supervisor no las usa: el trabajador recibe un bloque propio con `LOCALAPPDATA` y `SystemRoot`. La sonda comprueba desde adentro que no ve otras variables que esas y las carpetas temporales que Windows le da al AppContainer, y que cada ruta apunta a la carpeta propia del AppContainer.

### Empaquetado

- `npm run desktop:prepare` ejecuta [prepare-connector.js](../scripts/prepare-connector.js), que compila sólo el binario de producción (`--release --locked --bin nemein-connector`, nunca la feature de prueba) y lo copia a `src-tauri/binaries/nemein-connector-<triple>`.
- Tauri lo empaqueta como `externalBin`, junto a `nemein.exe`, y le pasa a Node su ruta en `NEMEIN_CONNECTOR_BIN`.
- El desinstalador borra el perfil del AppContainer, y con él su carpeta bajo `%LOCALAPPDATA%\Packages` (`DeleteAppContainerProfile`, en el hook [hooks.nsh](../src-tauri/nsis/hooks.nsh)). Si un perfil ya no existe, no es un error. Si una actualización lo borra, el supervisor lo vuelve a registrar en el primer uso. El smoke del instalador comprueba que el conector instalado registró el perfil y que la desinstalación silenciosa no deja ni el registro ni la carpeta.
- En Linux, el chequeo del shell usa un archivo de relleno: los conectores no corren ahí.

## Flujo y administración (P3.3)

El código está en `src/connectors.js`. El presupuesto le entrega sólo su dominio de importación: proyectar el lote con categorías y duplicados, insertar filas, y validar cuentas y categorías. Así, las reglas monetarias siguen en un solo lugar (`src/core.js`), y CSV, extractos y conectores comparten la misma inserción.

### Dónde vive cada cosa

| Qué | Dónde | Por qué |
| --- | --- | --- |
| Componente | `connectors/<sha256>/component.wasm`, en la carpeta de datos | Direccionado por contenido: el hash es la identidad. |
| Inventario y habilitación | `connectors/inventory.json` | Fuera del SQLite: un respaldo restaurado no trae habilitaciones. |
| Lote preparado | Tabla `connector_batches` (migración 007) | El lote y su resultado se confirman en la misma transacción que los movimientos. |
| Instalar, habilitar y revocar | Auditoría (`agent_audit`), como acciones del propietario | La habilitación se ata a su fila de auditoría. |

El inventario guarda, por conector:
- el hash, el manifiesto que devolvió `describe` y el tamaño;
- la fecha de instalación;
- `enablement`: `null`, o un testigo aleatorio con la secuencia de su fila de auditoría.

Un inventario que no cumple esa forma, porque el JSON está roto, tiene campos de más o de menos o repite un hash, falla cerrado con `CONNECTOR_INVENTORY_INVALID`. Así no se ejecuta ningún conector y no se sobrescribe el archivo.

### Administración del propietario

- **Instalar** recibe el componente en base64 canónico, de hasta 16 MiB. Ejecuta `describe` dentro del encierro, fuera de toda transacción, guarda el componente bajo su hash y lo deja **deshabilitado**. Reinstalar los mismos bytes es el mismo conector: vuelve a escribir el componente, así que repara uno cambiado en disco sin tocar su habilitación. Una versión nueva es otro hash y necesita su propia habilitación.
- **Habilitar** comprueba que el componente en disco sigue teniendo el hash aprobado; si no, falla sin escribir una fila que permita. Después escribe la fila de auditoría `connector-enable` con el hash y un testigo aleatorio, y por último guarda en el inventario el testigo y la secuencia de esa fila.
- **Revocar** escribe primero el inventario, para que la revocación valga aunque falle la auditoría, y después la audita.

Las tres operaciones exigen al propietario con la misma guarda que las conexiones (`OWNER_REQUIRED`). No están en la fachada del agente ni en la CLI, el MCP o la API local.

**Una habilitación vale sólo si este historial la registró.** Tienen que cumplirse las cuatro condiciones:
1. el inventario es de este presupuesto (la identidad de `event_identity`);
2. existe la fila de auditoría de esa secuencia;
3. esa fila es `connector-enable` del propietario, con ese hash y ese testigo;
4. no hay una revocación posterior del mismo conector, aunque después se copie de vuelta un inventario anterior a ella.

Cada paso deja su fila: `connector-install` con el hash y el manifiesto, `connector-enable` con el hash y el testigo, y `connector-revoke` con el hash. Un fallo deja una fila `error` con lo pedido y su motivo.

### Acciones públicas

| Acción | Tipo | Argumentos |
| --- | --- | --- |
| `connectors` | lectura | ninguno: hash, manifiesto, tamaño y si está habilitado o invalidado |
| `connector-prepare` | asíncrona: sólo permitir o negar | `hash`, `account_id`, `content_base64`, `config` opcional y `category_id` opcional |
| `connector-import` | escritura: permitir, preguntar o negar | `id`, `batch_sha256` |

Como no admite una aprobación diferida, `connector-prepare` no acepta una regla de preguntar. Las reglas pueden limitar la cuenta de la preparación. `actionVersion` no cambia: las acciones nuevas empiezan negadas.

### Preparar

1. Se validan la cuenta, la configuración (16 KiB), el archivo en base64 canónico (5.000.000 bytes) y la categoría por defecto. No se acepta un base64 con relleno no canónico ni con caracteres de más.
2. El conector tiene que estar habilitado, y su componente en disco tiene que tener el hash aprobado (si no, `CONNECTOR_ARTIFACT_CHANGED`). Esos mismos bytes son los que recibe el trabajador, junto con el manifiesto aprobado.
3. El conector corre **fuera de toda transacción**. Si se revocó o cambió mientras corría, no se guarda nada.
4. El lote se vuelve a validar (contrato v1 y cuenta), aunque el ejecutor ya lo hizo.
5. **Las categorías que devuelve el conector se ignoran.** Un gasto toma la categoría de la memoria del presupuesto o la categoría por defecto que eligió el propietario, igual que en CSV. Sin ninguna de las dos, la preparación falla.
6. Se guarda el lote con esas categorías fijas, el hash del componente, el del archivo, la configuración, la cuenta y el actor. Vence en 24 h.
7. La respuesta incluye `id`, `batch_sha256`, el vencimiento, el conector y las filas con su marca de duplicado.

Hay un tope de 4 lotes sin confirmar por actor y de 64 MiB entre todos, contados en bytes (`CONNECTOR_BATCH_LIMIT`). Cada preparación borra los lotes vencidos y los confirmados hace más de 30 días.

### Confirmar

`connector-import` confirma **el lote guardado**, nunca filas que mande quien llama. Lo hace dentro de la transacción inmediata que `src/events.js` abre para cada cambio del presupuesto, y vuelve a comprobar todo:
- el lote existe y es del mismo actor (si no, `CONNECTOR_BATCH_UNKNOWN`, sin revelar si existe);
- `batch_sha256` es el del lote revisado, y el lote guardado todavía tiene ese hash (si no, `CONNECTOR_BATCH_MISMATCH`);
- no venció (`CONNECTOR_BATCH_EXPIRED`);
- el conector sigue habilitado y su componente no cambió;
- el contrato v1 se cumple y la cuenta de la fila es la que declara el lote revisado (`CONNECTOR_ACCOUNT_MISMATCH`);
- la inserción vuelve a validar la cuenta y cada categoría. Las categorías no se recalculan desde una memoria que pudo cambiar.

Los duplicados se omiten por `import_key`. El resultado `{added, duplicates}` se guarda en la misma transacción. Un reintento con el mismo hash devuelve ese resultado sin volver a importar, y el lote queda sin filas.

Un agente con preguntar crea una propuesta. Al aceptarla, el propietario confirma el lote de ese agente. El agente no puede confirmar lotes del propietario, ni el propietario confirmar directamente los de un agente.

El hash del conector **no entra en la identidad de los movimientos**: el `import_key` es el `entry_id` del lote. Una versión nueva del conector sobre el mismo extracto encuentra los mismos movimientos como duplicados.

### Recuperación

Los respaldos siguen siendo sólo el SQLite: no incluyen `connectors/`. Casos:
- **Restaurar una copia anterior a la habilitación:** el inventario dice habilitado, pero esa fila de auditoría no existe o es otra. El conector queda deshabilitado y la lista lo muestra como invalidado.
- **Restaurar una copia posterior a la habilitación:** es el mismo estado y la habilitación vale. Si después se revocó, la revocación está en el inventario y sigue vigente.
- **Copiar `connectors/` junto a otro presupuesto:** la identidad no coincide y nada vale ahí. La primera operación del propietario rebinda el inventario a ese presupuesto y borra explícitamente esas habilitaciones.

La recuperación soportada se hace en una carpeta nueva y vacía, sin copiar `connectors/`, y después se reinstalan los conectores, que quedan deshabilitados. Para recuperar sobre una carpeta existente hay que revocar primero sus conectores o borrar `connectors/inventory.json`. Ver [Respaldos](respaldos.md).

### Ubicar el binario

El ejecutor usa `NEMEIN_CONNECTOR_BIN`, que define el shell de escritorio. La CLI y el MCP instalados corren el `node.exe` de `<instalación>\runtime`, así que buscan `nemein-connector.exe` en la carpeta de instalación.

## Pantalla y firma (P3.4)

### Pantalla

**Conectores**, en el menú, es del propietario: la ventana local, con el mismo CSRF y el mismo control de origen que el resto. No está en la API local, la CLI ni el MCP. Muestra:
- **Dónde no corren.** Fuera de Windows, un aviso dice que los conectores no corren hasta tener un encierro equivalente. Ahí la pantalla no ofrece instalar ni preparar: sólo lista y revoca.
- **Instalados.** Por cada conector: nombre, versión, descripción, si está habilitado o si su habilitación no es de este historial, la firma con la huella de su clave, el identificador, el hash, el tamaño y la fecha.
- **Instalar.** El componente (`.wasm`, hasta 16 MiB) y, si hay, su archivo de firma. El navegador codifica el archivo en base64 (`FileReader`) y lo envía en JSON con `fetch`. Sólo esa ruta acepta un cuerpo de ese tamaño; las demás conservan el tope de 8 MB.
- **Habilitar y revocar.** Sin una firma válida, habilitar pide marcar «Entiendo que no tiene una firma válida y lo habilito igual».
- **Importar.** Se elige un conector habilitado, la cuenta, la categoría inicial para gastos sin memoria, el archivo del banco y, si el conector la pide, la configuración. La preparación guarda el lote y responde sólo su identificador.
- **Revisar y confirmar.** La revisión es una página propia (`?view=connectors&batch=<id>`) que lee el lote guardado: no vuelve a ejecutar el conector y se puede recargar. Muestra cuenta, vencimiento y cada fila con su categoría y si ya está en el presupuesto. Confirmar envía el `id` y el `batch_sha256` que se vieron. Un lote ya confirmado muestra su resultado.

Un inventario dañado, o un lote que no existe o es de otro actor, se muestran como mensaje: la página no falla.

### Firma

La firma dice que **el dueño de una clave Ed25519 firmó exactamente estos bytes**. No dice quién es esa persona: todavía no hay catálogo de autores ni continuidad de clave entre versiones. Por eso informa y no bloquea.

El archivo de firma es JSON, de hasta 4 KiB, con exactamente estos campos:

```json
{
  "format": "nemein-connector-signature",
  "version": 1,
  "algorithm": "ed25519",
  "component_sha256": "<sha256 del componente>",
  "public_key": "<32 bytes en base64 canónico>",
  "signature": "<64 bytes en base64 canónico>"
}
```

**Lo firmado** son los bytes de dominio de Nemein, `nemein:connector-signature:v1` seguido de un salto de línea, y a continuación los 32 bytes del SHA-256 del componente. Es la misma idea que el espacio de nombres de las firmas de SSH (`PROTOCOL.sshsig`): una firma de Nemein no vale como firma de otra cosa, y la firma de otro producto sobre el mismo hash no vale aquí.

Estados que muestra la pantalla:
- **Firma válida**, con la huella de la clave: el SHA-256 de los 32 bytes de la clave pública.
- **Firma inválida**, con su motivo: de otro componente, o no corresponde a estos bytes con esa clave.
- **Sin firma.**

Reglas:
- Un archivo de firma que no cumple el formato se rechaza al instalar, antes de ejecutar nada.
- Una firma bien formada pero inválida se guarda y se informa.
- Reinstalar los mismos bytes con otra firma reemplaza la guardada. Reinstalarlos sin firma la conserva.
- La firma nunca toca la habilitación, que es de los bytes.
- La fila de auditoría de instalar y la de habilitar registran el estado de la firma en ese momento.
- Sin una firma válida, `enableConnector` exige `acknowledge_unsigned: true` (`CONNECTOR_SIGNATURE_UNACKNOWLEDGED`).

Para autores, sin dependencias nuevas:

```sh
node scripts/connector-sign.js keygen clave.pem
node scripts/connector-sign.js sign componente.wasm clave.pem componente.firma.json
```

`keygen` escribe una clave PKCS#8 legible sólo por su dueño, donde el sistema lo permite, y muestra la huella de la clave pública. Ningún comando sobrescribe un archivo. Nemein nunca necesita la clave privada.

### Auditoría de los archivos

La auditoría guarda los argumentos de cada solicitud. Para `connector-prepare` guarda, en lugar del `content_base64`, su SHA-256 y su tamaño en bytes. Ese hash es el mismo `input_hash` del lote preparado, así que la fila sigue identificando el archivo sin guardar su contenido. La importación CSV no cambia: sigue guardando su `content`.

## Pruebas y calidad

- Regresión: formato, límites exactos (20.000 movimientos, 160 caracteres, 10^12), fechas, comillas, codificación, contexto, configuración y archivos de oro.
- Propiedades con proptest y semillas fijas: ida y vuelta modelo → CSV → lote, presentación sin efecto (finales de línea, BOM, comillas, líneas vacías), identidad estable ante reordenamiento y ediciones, calendario contra un conteo independiente, JSON contra serde_json y `entry_id` contra SHA-256 de serde_json.
- Fuzzing generativo: bytes arbitrarios y extractos válidos con ediciones de bytes; sólo códigos conocidos y mensajes acotados, o un lote que cumple los invariantes. La inspección se prueba con componentes hostiles escritos a mano: imports de función, instancia, tipo, recurso, módulo y componente; exportaciones de más o con otra versión; binarios corruptos.
- De punta a punta: la receta compila el ejemplo, el componente no tiene imports ni a nivel de componente ni en su núcleo, y wasmtime (`runtime`, `cranelift`, `component-model`, `std`, sin WASI ni `async`) lo ejecuta con un `Linker` vacío y devuelve exactamente el lote de oro.
- Node: [connector-contract.test.js](../test/connector-contract.test.js) valida el lote de oro con `validateImportBatch`, recalcula las identidades desde el CSV y comprueba que el mundo no declara imports. Corre sin Rust en los jobs Linux y Windows existentes.
- Mutación: `cargo-mutants` 27.1.0 sobre el SDK, el ejemplo y la herramienta (`.cargo/mutants.toml`). Cada mutante se juzga sólo con las pruebas de su propio paquete. `scripts/mutation-gate.js --cargo-mutants` aplica el mismo mínimo del 90 % y rechaza Timeout, Failure y una línea base fallida. Los mutantes que no compilan (Unviable) no miden nada y quedan fuera, como en el propio cargo-mutants. Pero si ningún mutante de un paquete se midió, el verificador rechaza la corrida: así quedaban fuera, en silencio, el SDK, el ejemplo y la herramienta cuando una opción de Cargo no aplicaba a esos paquetes. El plazo mínimo por mutante es de 300 s, porque la primera prueba de cada copia compila el componente; un timeout rechaza la medición.

### Pruebas del flujo (P3.3)

Las pruebas usan un sustituto del trabajador dentro del proceso (`test/helpers/connector-budget.js`), así que corren en cualquier sistema. El sustituto rechaza las solicitudes que rechazaría el trabajador, con la misma validación (`validateRequest`):
- **Regresión** (`test/connectors.test.js`):
  - instalación por hash, deshabilitada e idempotente;
  - la fila de auditoría exacta de cada paso y de cada fallo, también uno sin mensaje;
  - sólo el propietario administra, y el código que corre durante la solicitud de un agente tampoco puede hacerlo;
  - habilitar y revocar tocan sólo su conector, cada habilitación con su testigo;
  - un inventario copiado de vuelta después de revocar no revive el conector;
  - un componente cambiado sin cambiar de tamaño, y su reparación al reinstalar;
  - base64 acotado por su largo antes de decodificarlo;
  - configuración en su tope de bytes y uno más, hashes con caracteres alrededor;
  - un lote que declara otra cuenta, y una fila guardada movida a otra cuenta;
  - la preparación fuera de transacciones, con los bytes y el manifiesto aprobados;
  - categorías del conector ignoradas y categorías revisadas fijas;
  - confirmación única con reintentos;
  - una confirmación distinta de lo revisado y un lote guardado alterado;
  - un conector revocado, cambiado en disco o revocado mientras corre;
  - el vencimiento exacto;
  - una versión nueva que no duplica movimientos;
  - los topes y la purga, con el tope en bytes entre actores en su borde exacto;
  - agentes con permitir, preguntar y propuestas;
  - recuperación desde copias anteriores y posteriores, y una carpeta copiada a otro presupuesto;
  - un inventario dañado.
- **Propiedades:**
  - la habilitación contra un oráculo escrito aparte, con cada hecho correcto casi siempre, así que los fallos de un solo factor son frecuentes;
  - el hash canónico del lote;
  - base64 canónico;
  - el inventario válido, con sus bordes, frente a cualquier campo dañado;
  - la confirmación con duplicados al azar.
- **Fuzzing:** un conector mentiroso con lotes editados al azar, argumentos de confirmación arbitrarios e inventarios dañados. El resultado tiene que ser un lote válido o un rechazo, nunca un error de tipo, y con un inventario dañado no corre ningún conector.
- **Migración 007:** actualización desde el esquema 6 con datos, reversión ante una tabla en conflicto y reapertura.
- **Mutación:** el alcance `connectors` de Stryker mide este módulo, la inserción compartida y la administración del propietario, con mínimo del 90 % y sin timeouts. La medición está en [Control de calidad](calidad.md#conectores-wasm-p33).

### Pruebas de la pantalla y la firma (P3.4)

- **Pantalla por HTTP** (`test/connectors-http.test.js`):
  - el menú y el aviso de plataforma; fuera de Windows no hay formularios;
  - el valor por defecto sigue a la plataforma;
  - el recorrido completo: instalar sin firma y con firma, habilitar con y sin la confirmación, preparar, revisar, confirmar, revisar de nuevo un lote confirmado, ver duplicados y revocar;
  - el tope propio de la instalación frente al de las demás rutas;
  - CSRF, origen, errores en JSON, un lote ajeno, un inventario dañado y una preparación que el conector rechaza.
- **Script de la página** (`test/connectors-ui.test.js`), con un documento mínimo en `vm`: lo que envía, el base64 que arma el navegador, un archivo vacío o ilegible, los topes y sus bordes, los mensajes, los errores del servidor y de la red, que el botón vuelve a habilitarse y que cada envío termina dentro de un plazo.
- **Firma:**
  - regresión (`test/connector-signature.test.js`): los bytes de dominio, una firma sin dominio o con el de otro producto, otra clave, una clave que no es un punto de la curva, cada campo del formato y su tope en bytes, claves que no son Ed25519, y la herramienta de autores con sus códigos de salida;
  - propiedad: una firma vale para su componente y su clave, y un bit cambiado en el componente, la clave o la firma la invalida;
  - propiedad: otra clave sobre el mismo componente vale sólo con esa clave;
  - fuzzing: cualquier archivo subido se informa sin lanzar, y su análisis sólo rechaza con `CONNECTOR_REQUEST_INVALID`.
- **Flujo** (`test/connectors.test.js`): la confirmación explícita, también con valores que no son `true`; firmas ajenas que se guardan e informan; reinstalar con otra firma o sin ella; un inventario anterior a las firmas y uno con la firma dañada; la revisión del lote sólo para su actor; y la auditoría con hash y tamaño.

### Pruebas del trabajador encerrado

- **Tramas y protocolo:** pruebas unitarias de cada largo en su tope y uno más, tramas truncadas, bytes de más y JSON con campos desconocidos. [frames.json](../src-tauri/connector/worker/fixtures/frames.json) tiene los vectores compartidos con Node.
- **Ejecución:** el ejemplo devuelve el lote de oro dentro de wasmtime. El componente hostil prueba cada modo: trampa, bucle, crecimiento de memoria, lote enorme o inválido, mentiras de procedencia y de cuenta, errores enormes y reservas del anfitrión. También se prueban componentes con imports de tipo, otro mundo y memory64.
- **Supervisor**, con el trabajador de prueba sin encierro, en cualquier sistema: cuelgue, trabajador que no lee, salida y truncado, respuesta enorme o basura, cancelación, encierro no disponible, y un plazo que cuenta el arranque. Además `describe` trabado y compilación patológica.
- **Encierro real**, sólo en Windows (`tests/sandbox.rs` y `tests/enclosed_hostile.rs`):
  - lote de oro encerrado;
  - la sonda nativa, con control positivo: lectura, escritura, red, procesos y entorno, con los nombres de las variables que ve. También informa desde adentro el token (AppContainer, LPAC, cero capacidades), los límites de su Job y cada política de mitigación, y se comparan con los valores documentados. LPAC se reconoce por el atributo `WIN://NOALLAPPPKG` del token, como hacen las herramientas de James Forshaw: `TokenIsLessPrivilegedAppContainer` falla en windows-2022 y el atributo no está en los encabezados del SDK, así que es comportamiento observado. En windows-2022, el intento de red no devuelve un error: el proceso encerrado termina ahí con el código 65 (`ERROR_NETWORK_ACCESS_DENIED`). La prueba acepta esa salida o un rechazo, y en los dos casos comprueba que no llegó ninguna conexión al puerto de escucha;
  - límite de memoria informado como `MEMORY_LIMIT`;
  - el trabajador se niega a correr fuera del encierro;
  - matar al supervisor o cerrar stdin termina al trabajador;
  - permisos sólo sobre el binario y su carpeta, sin herencia;
  - solicitudes enormes o truncadas;
  - los componentes hostiles encerrados.
- **Cadena desde Node** (`test/connector-chain.test.js`, en el job de Windows): matar a Node termina al supervisor y al trabajador.
- **Ejecutor de Node:**
  - regresión con un supervisor falso. El falso deja su pid y la solicitud que recibió, y termina solo a los 8 s, así que un ejecutor roto falla una aserción en lugar de colgar la suite;
  - propiedades: ida y vuelta de solicitudes con un decodificador independiente, cualquier partición de una respuesta, largos declarados y manifiestos;
  - fuzzing de respuestas reales mutadas.
- **Mutación:**
  - cargo-mutants mide las partes portables del trabajador (`frame`, `protocol`, `execute`, `supervise`, `limits`) en su propio job, `Connector worker mutation`, con [mutants-worker.toml](../src-tauri/connector/.cargo/mutants-worker.toml) y la feature de prueba, que Cargo rechaza para los demás paquetes;
  - `sandbox.rs` y `main.rs` se miden en Windows con [mutants-windows.toml](../src-tauri/connector/.cargo/mutants-windows.toml), en cuatro shards que el verificador juzga como una sola corrida. Las banderas se arman con una sola función de unión, para que reemplazar `|` por `^` no deje mutantes equivalentes, y pruebas de respuesta conocida fijan cada conjunto en su valor documentado;
  - Stryker mide `src/connector-runner.js` en el alcance `connector-runner`;
  - pruebas de respuesta conocida fijan cada tope de `limits.rs` y los límites del `Store`, comprobados con el propio `ResourceLimiter`;
  - las pruebas ubican los binarios junto a su propio ejecutable, porque cargo-mutants reutiliza un `target/` ya compilado.

Comandos locales: `npm run connector:check` (formato, Clippy nativo y wasm32, pruebas) y, desde `src-tauri/connector`, `cargo mutants --workspace` seguido de `node ../../scripts/mutation-gate.js --cargo-mutants mutants.out/outcomes.json`. En CI, los jobs `Connector component`, `Connector mutation`, `Connector worker mutation`, `Connector sandbox (Windows)` y `Connector enclosure mutation` son requisitos del `Quality gate`.

## Cinco factores

- **Utilidad:** importar extractos de bancos sin formato estándar sin tocar el núcleo.
- **Responsabilidad:** el conector traduce un archivo a un lote; el anfitrión valida, deduplica, pide permisos y confirma.
- **Contrato:** WIT `nemein:connector@1.0.0`, lote v1 y los límites de arriba.
- **Pruebas de frontera:** sin imports, tipado al instanciar, archivos hostiles, oro entre Rust y Node, componentes hostiles dentro del encierro real, sonda nativa con control positivo, cierre en cadena y mutación.
- **Desconexión:** el presupuesto no depende de esta carpeta. Sin conectores, CSV, OFX y CAMT siguen igual. Si falta el binario o el sistema no es Windows, el ejecutor falla cerrado con un código propio, y la pantalla lo dice en lugar de ofrecer instalar.
