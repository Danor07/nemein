# Conectores WASM (P3)

Un conector es una función pura: recibe los bytes de un archivo que eligió el propietario y devuelve un [lote de importación v1](importaciones.md). Corre aparte, sin acceso al presupuesto, y su salida nunca escribe por sí misma: el anfitrión la valida y la pasa por la revisión y la confirmación protegida.

**Estado.** P3.1 fijó el contrato y la receta. P3.2 agrega el trabajador encerrado `nemein-connector`, su empaquetado y el ejecutor de Node que lo usa (`src/connector-runner.js`); todavía no hay flujo en la aplicación que lo llame. La preparación, revisión y confirmación del lote, junto con la instalación, habilitación, revocación y recuperación, llegan en P3.3; la pantalla y la firma que informa, en P3.4. En Linux los conectores no corren hasta tener un encierro equivalente al de Windows: el binario y el ejecutor responden `UNSUPPORTED_PLATFORM`.

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
| Token | AppContainer menos privilegiado (LPAC) `Nemein.ConnectorWorker`, sin capacidades. Sólo alcanza objetos que nombran su SID o `ALL RESTRICTED APPLICATION PACKAGES`, como System32. Windows no crea procesos en un AppContainer sin perfil registrado (`CreateProcessW` falla con el error 2), así que el supervisor registra el perfil la primera vez, como Chromium, y después sólo deriva el mismo SID. El perfil le da al trabajador una carpeta propia bajo `%LOCALAPPDATA%\Packages`: es lo único que puede escribir, y desde ahí no alcanza nada del usuario. |
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
- En Linux, el chequeo del shell usa un archivo de relleno: los conectores no corren ahí.

## Pruebas y calidad

- Regresión: formato, límites exactos (20.000 movimientos, 160 caracteres, 10^12), fechas, comillas, codificación, contexto, configuración y archivos de oro.
- Propiedades con proptest y semillas fijas: ida y vuelta modelo → CSV → lote, presentación sin efecto (finales de línea, BOM, comillas, líneas vacías), identidad estable ante reordenamiento y ediciones, calendario contra un conteo independiente, JSON contra serde_json y `entry_id` contra SHA-256 de serde_json.
- Fuzzing generativo: bytes arbitrarios y extractos válidos con ediciones de bytes; sólo códigos conocidos y mensajes acotados, o un lote que cumple los invariantes. La inspección se prueba con componentes hostiles escritos a mano: imports de función, instancia, tipo, recurso, módulo y componente; exportaciones de más o con otra versión; binarios corruptos.
- De punta a punta: la receta compila el ejemplo, el componente no tiene imports ni a nivel de componente ni en su núcleo, y wasmtime (`runtime`, `cranelift`, `component-model`, `std`, sin WASI ni `async`) lo ejecuta con un `Linker` vacío y devuelve exactamente el lote de oro.
- Node: [connector-contract.test.js](../test/connector-contract.test.js) valida el lote de oro con `validateImportBatch`, recalcula las identidades desde el CSV y comprueba que el mundo no declara imports. Corre sin Rust en los jobs Linux y Windows existentes.
- Mutación: `cargo-mutants` 27.1.0 sobre el SDK, el ejemplo y la herramienta (`.cargo/mutants.toml`). Cada mutante se juzga sólo con las pruebas de su propio paquete. `scripts/mutation-gate.js --cargo-mutants` aplica el mismo mínimo del 90 % y rechaza Timeout, Failure y una línea base fallida. Los mutantes que no compilan (Unviable) no miden nada y quedan fuera, como en el propio cargo-mutants. El plazo mínimo por mutante es de 300 s, porque la primera prueba de cada copia compila el componente; un timeout rechaza la medición.

### Pruebas del trabajador encerrado

- **Tramas y protocolo:** pruebas unitarias de cada largo en su tope y uno más, tramas truncadas, bytes de más y JSON con campos desconocidos. [frames.json](../src-tauri/connector/worker/fixtures/frames.json) tiene los vectores compartidos con Node.
- **Ejecución:** el ejemplo devuelve el lote de oro dentro de wasmtime. El componente hostil prueba cada modo: trampa, bucle, crecimiento de memoria, lote enorme o inválido, mentiras de procedencia y de cuenta, errores enormes y reservas del anfitrión. También se prueban componentes con imports de tipo, otro mundo y memory64.
- **Supervisor**, con el trabajador de prueba sin encierro, en cualquier sistema: cuelgue, trabajador que no lee, salida y truncado, respuesta enorme o basura, cancelación, encierro no disponible, y un plazo que cuenta el arranque. Además `describe` trabado y compilación patológica.
- **Encierro real**, sólo en Windows (`tests/sandbox.rs` y `tests/enclosed_hostile.rs`):
  - lote de oro encerrado;
  - la sonda nativa, con control positivo: lectura, escritura, red, procesos y entorno, con los nombres de las variables que ve. También informa desde adentro el token (AppContainer, LPAC, cero capacidades), los límites de su Job y cada política de mitigación, y se comparan con los valores documentados;
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
  - cargo-mutants mide las partes portables del trabajador (`frame`, `protocol`, `execute`, `supervise`, `limits`) dentro de `Connector mutation`;
  - `sandbox.rs` y `main.rs` se miden en Windows con [mutants-windows.toml](../src-tauri/connector/.cargo/mutants-windows.toml), en cuatro shards que el verificador juzga como una sola corrida. Las banderas se arman con una sola función de unión, para que reemplazar `|` por `^` no deje mutantes equivalentes, y pruebas de respuesta conocida fijan cada conjunto en su valor documentado;
  - Stryker mide `src/connector-runner.js` en el alcance `connector-runner`.

Comandos locales: `npm run connector:check` (formato, Clippy nativo y wasm32, pruebas) y, desde `src-tauri/connector`, `cargo mutants --workspace` seguido de `node ../../scripts/mutation-gate.js --cargo-mutants mutants.out/outcomes.json`. En CI, los jobs `Connector component`, `Connector mutation`, `Connector sandbox (Windows)` y `Connector enclosure mutation` son requisitos del `Quality gate`.

## Cinco factores

- **Utilidad:** importar extractos de bancos sin formato estándar sin tocar el núcleo.
- **Responsabilidad:** el conector traduce un archivo a un lote; el anfitrión valida, deduplica, pide permisos y confirma.
- **Contrato:** WIT `nemein:connector@1.0.0`, lote v1 y los límites de arriba.
- **Pruebas de frontera:** sin imports, tipado al instanciar, archivos hostiles, oro entre Rust y Node, componentes hostiles dentro del encierro real, sonda nativa con control positivo, cierre en cadena y mutación.
- **Desconexión:** el presupuesto no depende de esta carpeta. Sin conectores, CSV, OFX y CAMT siguen igual. En P3.2 nada de la aplicación llama al ejecutor; si falta el binario o el sistema no es Windows, el ejecutor falla cerrado con un código propio.
