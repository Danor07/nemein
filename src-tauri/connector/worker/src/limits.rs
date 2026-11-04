//! Limits of the connector contract (`docs/conectores.md`). The worker caps
//! sizes; the Node host validates the manifest and the batch in full.

/// Component bytes the host accepts to compile.
pub const COMPONENT_MAX: usize = 16 * 1024 * 1024;
/// The file, the same 5 MB as the import contract.
pub const INPUT_MAX: usize = 5_000_000;
/// Owner configuration, in bytes.
pub const CONFIG_MAX: usize = 16_384;
/// `account-id`: canonical decimal of a safe integer, at most 16 digits.
pub const ACCOUNT_ID_MAX: usize = 16;
/// JSON header of any frame.
pub const HEADER_MAX: usize = 65_536;
/// Batch text: any valid compact v1 batch fits (worst case is about 22.4 MB).
pub const OUTPUT_MAX: usize = 25_165_824;
/// Manifest fields together, in bytes.
pub const MANIFEST_MAX: usize = 8_192;
pub const MANIFEST_EXTENSIONS_MAX: usize = 8;
/// Connector error code and message, in characters.
pub const ERROR_CODE_MAX: usize = 64;
pub const ERROR_MESSAGE_MAX: usize = 1_024;

/// Wall clock for compile, instantiate, `describe`, `parse` and IPC.
pub const DEADLINE_MS: u64 = 10_000;
/// Committed memory of the whole worker process (Job limit).
pub const MEMORY_BYTES: usize = 256 * 1024 * 1024;
/// Linear memory one component may grow to, inside the process limit.
pub const GUEST_MEMORY_MAX: usize = 128 * 1024 * 1024;
/// Table elements, core instances, tables and memories of one component.
pub const GUEST_TABLE_ELEMENTS_MAX: usize = 100_000;
pub const GUEST_INSTANCES_MAX: usize = 32;
pub const GUEST_TABLES_MAX: usize = 32;
pub const GUEST_MEMORIES_MAX: usize = 4;
/// Bytes the host may lift from the guest in one call: the batch limit plus
/// room for the manifest and the error.
pub const HOSTCALL_FUEL: usize = OUTPUT_MAX + 1024 * 1024;
/// Stack of the thread that runs wasm; wasm frames get `GUEST_STACK_MAX` of it.
pub const WORKER_THREAD_STACK: usize = 8 * 1024 * 1024;
/// Native stack for wasm frames.
pub const GUEST_STACK_MAX: usize = 512 * 1024;
