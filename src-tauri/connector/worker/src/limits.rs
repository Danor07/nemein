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

#[cfg(test)]
mod tests {
    use super::*;

    /// The values `docs/conectores.md` and `src/connector-runner.js` publish,
    /// written out: a changed factor fails here, not only where it is used.
    #[test]
    fn limits_are_the_published_contract() {
        assert_eq!(COMPONENT_MAX, 16_777_216);
        assert_eq!(INPUT_MAX, 5_000_000);
        assert_eq!(CONFIG_MAX, 16_384);
        assert_eq!(ACCOUNT_ID_MAX, 16);
        assert_eq!(HEADER_MAX, 65_536);
        assert_eq!(OUTPUT_MAX, 25_165_824);
        assert_eq!(MANIFEST_MAX, 8_192);
        assert_eq!(MANIFEST_EXTENSIONS_MAX, 8);
        assert_eq!(ERROR_CODE_MAX, 64);
        assert_eq!(ERROR_MESSAGE_MAX, 1_024);
        assert_eq!(DEADLINE_MS, 10_000);
        assert_eq!(MEMORY_BYTES, 268_435_456);
        assert_eq!(GUEST_MEMORY_MAX, 134_217_728);
        assert_eq!(GUEST_TABLE_ELEMENTS_MAX, 100_000);
        assert_eq!(GUEST_INSTANCES_MAX, 32);
        assert_eq!(GUEST_TABLES_MAX, 32);
        assert_eq!(GUEST_MEMORIES_MAX, 4);
        assert_eq!(HOSTCALL_FUEL, 26_214_400);
        assert_eq!(WORKER_THREAD_STACK, 8_388_608);
        assert_eq!(GUEST_STACK_MAX, 524_288);
    }
}
