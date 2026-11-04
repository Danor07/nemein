# Conectores WASM (P3)

Un conector es una función pura: recibe los bytes de un archivo que eligió el propietario y devuelve un [lote de importación v1](importaciones.md). Corre aparte, sin acceso al presupuesto, y su salida nunca escribe por sí misma: el anfitrión la valida y la pasa por la revisión y la confirmación protegida.

**Estado.** Esta primera entrega (P3.1) fija el contrato y demuestra la receta. Nemein todavía **no ejecuta conectores**: el trabajador encerrado y el empaquetado llegan en P3.2; la preparación, revisión y confirmación del lote, junto con la instalación, habilitación, revocación y recuperación, en P3.3; la pantalla y la firma que informa, en P3.4. En Linux los conectores no van a correr hasta tener un encierro equivalente al de Windows.

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
| Memoria y tiempo | 256 MB y 10 s de reloj de pared por archivo, desde la compilación hasta la respuesta (presupuesto heredado de Resto-tech, a medir en P3.2) |
| Componente | A fijar en P3.2 junto con la prueba de compilación patológica. El ejemplo pesa unos 75 KB |

Estos límites forman parte del contrato para quien escribe conectores. Los aplica el trabajador desde P3.2, fuera del componente.

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

## Pruebas y calidad

- Regresión: formato, límites exactos (20.000 movimientos, 160 caracteres, 10^12), fechas, comillas, codificación, contexto, configuración y archivos de oro.
- Propiedades con proptest y semillas fijas: ida y vuelta modelo → CSV → lote, presentación sin efecto (finales de línea, BOM, comillas, líneas vacías), identidad estable ante reordenamiento y ediciones, calendario contra un conteo independiente, JSON contra serde_json y `entry_id` contra SHA-256 de serde_json.
- Fuzzing generativo: bytes arbitrarios y extractos válidos con ediciones de bytes; sólo códigos conocidos y mensajes acotados, o un lote que cumple los invariantes. La inspección se prueba con componentes hostiles escritos a mano: imports de función, instancia, tipo, recurso, módulo y componente; exportaciones de más o con otra versión; binarios corruptos.
- De punta a punta: la receta compila el ejemplo, el componente no tiene imports ni a nivel de componente ni en su núcleo, y wasmtime (`runtime`, `cranelift`, `component-model`, `std`, sin WASI ni `async`) lo ejecuta con un `Linker` vacío y devuelve exactamente el lote de oro.
- Node: [connector-contract.test.js](../test/connector-contract.test.js) valida el lote de oro con `validateImportBatch`, recalcula las identidades desde el CSV y comprueba que el mundo no declara imports. Corre sin Rust en los jobs Linux y Windows existentes.
- Mutación: `cargo-mutants` 27.1.0 sobre el SDK, el ejemplo y la herramienta (`.cargo/mutants.toml`). Cada mutante se juzga sólo con las pruebas de su propio paquete. `scripts/mutation-gate.js --cargo-mutants` aplica el mismo mínimo del 90 % y rechaza Timeout, Failure y una línea base fallida. Los mutantes que no compilan (Unviable) no miden nada y quedan fuera, como en el propio cargo-mutants. El plazo mínimo por mutante es de 300 s, porque la primera prueba de cada copia compila el componente; un timeout rechaza la medición.

Comandos locales: `npm run connector:check` (formato, Clippy nativo y wasm32, pruebas) y, desde `src-tauri/connector`, `cargo mutants --workspace` seguido de `node ../../scripts/mutation-gate.js --cargo-mutants mutants.out/outcomes.json`. En CI, los jobs `Connector component` y `Connector mutation` son requisitos del `Quality gate`.

## Cinco factores

- **Utilidad:** importar extractos de bancos sin formato estándar sin tocar el núcleo.
- **Responsabilidad:** el conector traduce un archivo a un lote; el anfitrión valida, deduplica, pide permisos y confirma.
- **Contrato:** WIT `nemein:connector@1.0.0`, lote v1 y los límites de arriba.
- **Pruebas de frontera:** sin imports, tipado al instanciar, archivos hostiles, oro entre Rust y Node, y mutación.
- **Desconexión:** el presupuesto no depende de esta carpeta. Sin conectores, CSV, OFX y CAMT siguen igual, y en esta entrega nada de la aplicación la usa.
