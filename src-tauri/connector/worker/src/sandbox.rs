//! The Windows enclosure of the worker process.
//!
//! The worker starts suspended in a less-privileged AppContainer (LPAC) with no
//! capabilities, inside a Job object, and only then runs:
//!
//! - **Token**: the AppContainer `Nemein.ConnectorWorker`, with no
//!   capabilities, opted out of `ALL APPLICATION PACKAGES` (LPAC): only
//!   objects that name this SID, or `ALL RESTRICTED APPLICATION PACKAGES` like
//!   System32, are reachable. Windows requires its profile to be registered,
//!   which gives it a folder of its own under `%LOCALAPPDATA%\Packages`; no
//!   other folder of the user is reachable. The supervisor grants read and
//!   execute on the worker binary and its folder, nothing else; never on the
//!   budget's data folder.
//! - **Handles**: exactly two anonymous pipes are inherited (`HANDLE_LIST`),
//!   with an environment block that only carries `LOCALAPPDATA` (Windows
//!   needs it to create the AppContainer process) and `SystemRoot`.
//! - **Job**: `KILL_ON_JOB_CLOSE`, one active process, a committed memory
//!   limit and death on unhandled exceptions. UI restrictions are added when
//!   the worker is in no other job; jobs with UI limits cannot nest, and under
//!   the desktop app the worker already is in Nemein's job, so Win32k lockdown
//!   covers the UI there. The supervisor holds the only handle, so if the
//!   supervisor dies for any reason, the worker dies with it.
//! - **Process policy**: no child processes, plus Chromium's pre-start
//!   mitigations that are compatible with a JIT (dynamic code must stay
//!   allowed for Cranelift). Requires Windows 10 1809 or later.
//!
//! Nothing here falls back: if any step fails, the connector does not run.

use crate::supervise::{memory_verdict, Ending, Worker};
use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, SetHandleInformation, ERROR_SUCCESS, FALSE, HANDLE,
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, S_OK, TRUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::{
    GetEffectiveRightsFromAclW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
    EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, TRUSTEE_IS_SID,
    TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{
    FreeSid, GetTokenInformation, TokenIsAppContainer, ACL, DACL_SECURITY_INFORMATION,
    NO_INHERITANCE, PSECURITY_DESCRIPTOR, PSID, SECURITY_CAPABILITIES, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_GENERIC_EXECUTE, FILE_GENERIC_READ};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
    JobObjectAssociateCompletionPortInformation, JobObjectBasicUIRestrictions,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_UI_RESTRICTIONS,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemServices::{
    JOB_OBJECT_MSG_JOB_MEMORY_LIMIT, JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    DETACHED_PROCESS, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
    PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};
use windows_sys::Win32::System::WindowsProgramming::{
    PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT, PROCESS_CREATION_CHILD_PROCESS_RESTRICTED,
};
use windows_sys::Win32::System::IO::{
    CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED,
};

/// The AppContainer every worker runs in. Its SID is derived from this name.
pub const APPCONTAINER_NAME: &str = "Nemein.ConnectorWorker";

// winbase.h macros that windows-sys does not carry. Each policy is a 4-bit
// field and 1 means "always on".
const MITIGATION_HEAP_TERMINATE: u64 = 1 << 12;
const MITIGATION_BOTTOM_UP_ASLR: u64 = 1 << 16;
const MITIGATION_HIGH_ENTROPY_ASLR: u64 = 1 << 20;
const MITIGATION_WIN32K_SYSTEM_CALL_DISABLE: u64 = 1 << 28;
const MITIGATION_EXTENSION_POINT_DISABLE: u64 = 1 << 32;
const MITIGATION_FONT_DISABLE: u64 = 1 << 48;
const MITIGATION_IMAGE_LOAD_NO_REMOTE: u64 = 1 << 52;
const MITIGATION_IMAGE_LOAD_NO_LOW_LABEL: u64 = 1 << 56;
const MITIGATION_IMAGE_LOAD_PREFER_SYSTEM32: u64 = 1 << 60;

/// The union of `flags`. Every flag set below is built here, so a flag is in a
/// set exactly when it is listed.
fn union<T: Copy + Default + std::ops::BitOr<Output = T>>(flags: &[T]) -> T {
    flags.iter().fold(T::default(), |all, &flag| all | flag)
}

/// Mitigations set before the worker starts, Chromium's JIT-compatible set.
/// Dynamic code stays allowed: Cranelift writes machine code at run time.
/// Strict handle checks are left out: Chromium applies them only after start.
pub fn mitigations() -> u64 {
    union(&[
        MITIGATION_HEAP_TERMINATE,
        MITIGATION_BOTTOM_UP_ASLR,
        MITIGATION_HIGH_ENTROPY_ASLR,
        MITIGATION_WIN32K_SYSTEM_CALL_DISABLE,
        MITIGATION_EXTENSION_POINT_DISABLE,
        MITIGATION_FONT_DISABLE,
        MITIGATION_IMAGE_LOAD_NO_REMOTE,
        MITIGATION_IMAGE_LOAD_NO_LOW_LABEL,
        MITIGATION_IMAGE_LOAD_PREFER_SYSTEM32,
    ])
}

/// UI restrictions, as Chromium applies them to its sandboxed processes.
pub fn ui_restrictions() -> u32 {
    union(&[
        JOB_OBJECT_UILIMIT_DESKTOP,
        JOB_OBJECT_UILIMIT_DISPLAYSETTINGS,
        JOB_OBJECT_UILIMIT_EXITWINDOWS,
        JOB_OBJECT_UILIMIT_GLOBALATOMS,
        JOB_OBJECT_UILIMIT_HANDLES,
        JOB_OBJECT_UILIMIT_READCLIPBOARD,
        JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS,
        JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
    ])
}

/// Limits of the worker's job.
pub fn job_limits() -> u32 {
    union(&[
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        JOB_OBJECT_LIMIT_JOB_MEMORY,
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    ])
}

/// Read and execute: what loading the binary and listing its folder need.
pub fn granted() -> u32 {
    union(&[FILE_GENERIC_READ, FILE_GENERIC_EXECUTE])
}

/// Suspended until it is in the job, with no console and a wide environment.
fn creation_flags() -> u32 {
    union(&[
        EXTENDED_STARTUPINFO_PRESENT,
        CREATE_SUSPENDED,
        DETACHED_PROCESS,
        CREATE_UNICODE_ENVIRONMENT,
    ])
}

fn wide(text: impl AsRef<OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain(Some(0)).collect()
}

fn last_error(step: &str) -> String {
    format!("{step}: error {}", unsafe { GetLastError() })
}

/// A handle closed on drop.
struct Owned(HANDLE);

// Kernel handles may be used and closed from any thread.
unsafe impl Send for Owned {}

impl Owned {
    /// Gives up ownership without closing.
    fn into_raw(self) -> HANDLE {
        let handle = self.0;
        std::mem::forget(self);
        handle
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// Owns `handle`, which `step` returned; a null handle is that step's error.
fn owned(handle: HANDLE, step: &str) -> Result<Owned, String> {
    if handle.is_null() {
        Err(last_error(step))
    } else {
        Ok(Owned(handle))
    }
}

/// The AppContainer SID, freed on drop.
pub struct ContainerSid(PSID);

unsafe impl Send for ContainerSid {}

impl Drop for ContainerSid {
    fn drop(&mut self) {
        unsafe { FreeSid(self.0) };
    }
}

impl ContainerSid {
    pub fn as_psid(&self) -> PSID {
        self.0
    }
}

/// `HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)`.
const PROFILE_EXISTS: i32 = 0x8007_00b7_u32 as i32;

/// The AppContainer SID, registering the profile the first time. Windows
/// refuses to start a process in an AppContainer whose profile was never
/// registered (`CreateProcessW` fails with error 2), so, as Chromium does, the
/// profile is created once per user and its SID derived from then on. The
/// name fixes the SID, so it is the same in every run.
pub fn container_sid() -> Result<ContainerSid, String> {
    profile_sid(APPCONTAINER_NAME)
}

/// The SID of the AppContainer profile `name`, registering it if needed.
pub fn profile_sid(name: &str) -> Result<ContainerSid, String> {
    let name = wide(name);
    let display = wide("Nemein: conectores encerrados");
    let description = wide("Ejecuta conectores WASM de Nemein sin capacidades.");
    let mut sid: PSID = null_mut();
    let created = unsafe {
        CreateAppContainerProfile(
            name.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            null(),
            0,
            &mut sid,
        )
    };
    if created == S_OK {
        return Ok(ContainerSid(sid));
    }
    if created != PROFILE_EXISTS {
        return Err(format!(
            "no se pudo registrar el AppContainer: 0x{:08x}",
            created as u32
        ));
    }
    let derived = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
    if derived != S_OK {
        return Err(format!(
            "no se pudo obtener el AppContainer: 0x{:08x}",
            derived as u32
        ));
    }
    Ok(ContainerSid(sid))
}

fn trustee(sid: &ContainerSid) -> TRUSTEE_W {
    TRUSTEE_W {
        pMultipleTrustee: null_mut(),
        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid.as_psid() as *mut u16,
    }
}

/// The rights `sid` already has on `path` through its DACL.
pub fn effective_rights(path: &Path, sid: &ContainerSid) -> Result<u32, String> {
    let name = wide(path);
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "no se pudo leer los permisos de {}: {status}",
            path.display()
        ));
    }
    let mut rights = 0u32;
    let trustee = trustee(sid);
    let status = unsafe { GetEffectiveRightsFromAclW(dacl, &trustee, &mut rights) };
    unsafe { LocalFree(descriptor) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "no se pudo evaluar los permisos de {}: {status}",
            path.display()
        ));
    }
    Ok(rights)
}

/// Grants read and execute on exactly `path` to `sid`, not inherited by its
/// children. Does nothing when the right is already there.
pub fn grant(path: &Path, sid: &ContainerSid) -> Result<(), String> {
    if effective_rights(path, sid)? & granted() == granted() {
        return Ok(());
    }
    let name = wide(path);
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "no se pudo leer los permisos de {}: {status}",
            path.display()
        ));
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: granted(),
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: NO_INHERITANCE,
        Trustee: trustee(sid),
    };
    let mut updated: *mut ACL = null_mut();
    let status = unsafe { SetEntriesInAclW(1, &entry, dacl, &mut updated) };
    let result = if status != ERROR_SUCCESS {
        Err(format!(
            "no se pudo preparar el permiso de {}: {status}",
            path.display()
        ))
    } else {
        let status = unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                updated,
                null(),
            )
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!(
                "no se pudo otorgar el permiso en {}: {status}",
                path.display()
            ))
        }
    };
    unsafe {
        LocalFree(updated as *mut c_void);
        LocalFree(descriptor);
    }
    result
}

/// A worker running inside the enclosure.
pub struct Enclosed {
    job: Owned,
    process: Owned,
    port: Owned,
    memory: usize,
    ui_restricted: bool,
    stdin: Option<File>,
    stdout: Option<File>,
}

impl Enclosed {
    /// Whether the job carries UI restrictions (it does unless nested).
    pub fn ui_restricted(&self) -> bool {
        self.ui_restricted
    }

    /// Waits up to `ms` for the worker to end by itself and returns its exit
    /// code; `None` if it is still running or the code cannot be read.
    pub fn exit_code(&self, ms: u32) -> Option<u32> {
        if unsafe { WaitForSingleObject(self.process.0, ms) } != WAIT_OBJECT_0 {
            return None;
        }
        let mut code = 0u32;
        if unsafe { GetExitCodeProcess(self.process.0, &mut code) } == FALSE {
            return None;
        }
        Some(code)
    }

    /// The most memory the job committed at once.
    pub fn peak_memory(&self) -> usize {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let read = unsafe {
            QueryInformationJobObject(
                self.job.0,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as _,
                size_of_val(&info) as u32,
                null_mut(),
            )
        };
        if read == FALSE {
            0
        } else {
            info.PeakJobMemoryUsed
        }
    }
}

impl Worker for Enclosed {
    fn take_stdin(&mut self) -> Box<dyn Write + Send> {
        Box::new(self.stdin.take().expect("stdin taken once"))
    }

    fn take_stdout(&mut self) -> Box<dyn Read + Send> {
        Box::new(self.stdout.take().expect("stdout taken once"))
    }

    fn kill(&mut self) {
        unsafe {
            TerminateJobObject(self.job.0, 1);
            WaitForSingleObject(self.process.0, 5_000);
        }
    }

    fn ending(&mut self) -> Ending {
        let reported = self.memory_reported();
        memory_verdict(reported, self.peak_memory(), self.memory)
    }
}

impl Enclosed {
    /// Whether the job posted a memory-limit message; reads every message
    /// already queued, without waiting for more.
    pub fn memory_reported(&self) -> bool {
        let mut reported = false;
        loop {
            let (mut message, mut key, mut overlapped) = (0u32, 0usize, null_mut::<OVERLAPPED>());
            let got = unsafe {
                GetQueuedCompletionStatus(self.port.0, &mut message, &mut key, &mut overlapped, 0)
            };
            if got == FALSE {
                break;
            }
            if message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT
                || message == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT
            {
                reported = true;
            }
        }
        reported
    }
}

fn job(memory: usize) -> Result<(Owned, Owned), String> {
    // Dropping the only handle to the job kills the worker: KILL_ON_JOB_CLOSE.
    let job = owned(
        unsafe { CreateJobObjectW(null(), null()) },
        "CreateJobObjectW",
    )?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = job_limits();
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.JobMemoryLimit = memory;
    let port = owned(
        unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) },
        "CreateIoCompletionPort",
    )?;
    let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
        CompletionKey: null_mut(),
        CompletionPort: port.0,
    };
    let set = |class, info: *const c_void, size: usize| {
        if unsafe { SetInformationJobObject(job.0, class, info, size as u32) } == FALSE {
            Err(last_error("SetInformationJobObject"))
        } else {
            Ok(())
        }
    };
    set(
        JobObjectExtendedLimitInformation,
        &limits as *const _ as _,
        size_of_val(&limits),
    )?;
    set(
        JobObjectAssociateCompletionPortInformation,
        &association as *const _ as _,
        size_of_val(&association),
    )?;
    Ok((job, port))
}

/// Adds UI restrictions unless `process` is already in another job: jobs with
/// UI limits cannot nest. Returns whether they were added.
fn restrict_ui(job: &Owned, process: &Owned) -> Result<bool, String> {
    let mut nested = FALSE;
    if unsafe { IsProcessInJob(process.0, null_mut(), &mut nested) } == FALSE {
        return Err(last_error("IsProcessInJob"));
    }
    if nested != FALSE {
        return Ok(false);
    }
    let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
        UIRestrictionsClass: ui_restrictions(),
    };
    let set = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectBasicUIRestrictions,
            &ui as *const _ as _,
            size_of_val(&ui) as u32,
        )
    };
    if set == FALSE {
        return Err(last_error("SetInformationJobObject(UI)"));
    }
    Ok(true)
}

/// One anonymous pipe as (read end, write end), neither inheritable.
fn pipe() -> Result<(Owned, Owned), String> {
    let (mut read, mut write) = (null_mut(), null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, null(), 0) } == FALSE {
        return Err(last_error("CreatePipe"));
    }
    Ok((Owned(read), Owned(write)))
}

/// Lets the child inherit `handle`. The handle list passes only inheritable
/// handles, so a child end left out of here makes CreateProcessW fail.
fn inheritable(handle: &Owned) -> Result<(), String> {
    if unsafe { SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == FALSE
    {
        return Err(last_error("SetHandleInformation"));
    }
    Ok(())
}

/// Two pipes: (child stdin read, parent stdin write), (parent stdout read,
/// child stdout write). Only the child's ends are ever inheritable.
fn pipes() -> Result<[Owned; 4], String> {
    let (child_in, parent_in) = pipe()?;
    let (parent_out, child_out) = pipe()?;
    inheritable(&child_in)?;
    inheritable(&child_out)?;
    Ok([child_in, parent_in, parent_out, child_out])
}

/// Environment block of the worker, sorted by name as Windows requires:
/// `LOCALAPPDATA`, which `CreateProcessW` needs to find the AppContainer's
/// folder (without it, error 203), and `SystemRoot`, for system DLLs.
fn environment(local_app_data: &OsStr, system_root: &OsStr) -> Vec<u16> {
    let mut block = Vec::new();
    for (name, value) in [
        ("LOCALAPPDATA=", local_app_data),
        ("SystemRoot=", system_root),
    ] {
        block.extend(OsStr::new(name).encode_wide());
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

/// Starts `program args` enclosed, with `memory` bytes of committed memory.
pub fn spawn(program: &Path, args: &[&str], memory: usize) -> Result<Enclosed, String> {
    // Absolute, without the `\\?\` prefix that `canonicalize` adds:
    // CreateProcessW refuses that form as the working directory.
    let program =
        std::path::absolute(program).map_err(|e| format!("{}: {e}", program.display()))?;
    if !program.is_file() {
        return Err(format!("no existe el binario {}", program.display()));
    }
    let folder = program
        .parent()
        .ok_or("el binario no tiene carpeta")?
        .to_path_buf();
    let sid = container_sid()?;
    grant(&folder, &sid)?;
    grant(&program, &sid)?;
    let (job, port) = job(memory)?;
    let [child_in, parent_in, parent_out, child_out] = pipes()?;

    let mut size = 0usize;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 5, 0, &mut size) };
    let mut storage = vec![0u8; size];
    let list = storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if unsafe { InitializeProcThreadAttributeList(list, 5, 0, &mut size) } == FALSE {
        return Err(last_error("InitializeProcThreadAttributeList"));
    }
    struct List(LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for List {
        fn drop(&mut self) {
            unsafe { DeleteProcThreadAttributeList(self.0) };
        }
    }
    let list = List(list);
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: sid.as_psid(),
        Capabilities: null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let lpac: u32 = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    let inherited: [HANDLE; 2] = [child_in.0, child_out.0];
    let children: u32 = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
    let mitigations: u64 = mitigations();
    let attributes: [(usize, *const c_void, usize); 5] = [
        (
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            &capabilities as *const _ as _,
            size_of_val(&capabilities),
        ),
        (
            PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize,
            &lpac as *const _ as _,
            size_of_val(&lpac),
        ),
        (
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited.as_ptr() as _,
            size_of_val(&inherited),
        ),
        (
            PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY as usize,
            &children as *const _ as _,
            size_of_val(&children),
        ),
        (
            PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY as usize,
            &mitigations as *const _ as _,
            size_of_val(&mitigations),
        ),
    ];
    for (attribute, value, size) in attributes {
        if unsafe {
            UpdateProcThreadAttribute(list.0, 0, attribute, value, size, null_mut(), null())
        } == FALSE
        {
            return Err(last_error("UpdateProcThreadAttribute"));
        }
    }

    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = child_in.0;
    startup.StartupInfo.hStdOutput = child_out.0;
    startup.StartupInfo.hStdError = null_mut();
    startup.lpAttributeList = list.0;
    let application = wide(&program);
    let mut command_line: Vec<u16> = wide(format!("\"{}\" {}", program.display(), args.join(" ")));
    let directory = wide(&folder);
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .ok_or("falta LOCALAPPDATA: Windows la necesita para crear el AppContainer")?;
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let environment = environment(&local_app_data, &system_root);
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            TRUE,
            creation_flags(),
            environment.as_ptr() as *const c_void,
            directory.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    };
    if created == FALSE {
        return Err(last_error("CreateProcessW en el AppContainer"));
    }
    let process = Owned(info.hProcess);
    let thread = Owned(info.hThread);
    let ui_restricted = match restrict_ui(&job, &process) {
        Ok(restricted) => restricted,
        Err(error) => {
            unsafe { TerminateProcess(process.0, 1) };
            return Err(error);
        }
    };
    if unsafe { AssignProcessToJobObject(job.0, process.0) } == FALSE {
        let error = last_error("AssignProcessToJobObject");
        unsafe { TerminateProcess(process.0, 1) };
        return Err(error);
    }
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        let error = last_error("ResumeThread");
        unsafe { TerminateJobObject(job.0, 1) };
        return Err(error);
    }
    drop(thread);
    // The child's ends now live only in the child.
    drop(child_in);
    drop(child_out);
    let stdin = unsafe { File::from_raw_handle(parent_in.into_raw() as _) };
    let stdout = unsafe { File::from_raw_handle(parent_out.into_raw() as _) };
    Ok(Enclosed {
        job,
        process,
        port,
        memory,
        ui_restricted,
        stdin: Some(stdin),
        stdout: Some(stdout),
    })
}

/// The supervisor's way to start the worker: this same binary, `worker`.
pub fn spawn_worker(memory: usize) -> Result<Box<dyn Worker>, String> {
    let program = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(Box::new(spawn(&program, &["worker"], memory)?))
}

/// The worker's own check, before reading anything: it must be in an
/// AppContainer and in a Job. Otherwise it refuses to run.
pub fn verify_enclosed() -> Result<(), String> {
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == FALSE {
            return Err(last_error("OpenProcessToken"));
        }
        let token = Owned(token);
        // Both answers start as "no": a query that fails leaves them so.
        let (mut is_container, mut length) = (0u32, 0u32);
        GetTokenInformation(
            token.0,
            TokenIsAppContainer,
            &mut is_container as *mut _ as _,
            4,
            &mut length,
        );
        if is_container == 0 {
            return Err("el trabajador no está dentro de un AppContainer".into());
        }
        let mut in_job = FALSE;
        IsProcessInJob(GetCurrentProcess(), null_mut(), &mut in_job);
        if in_job == FALSE {
            return Err("el trabajador no está dentro de un Job".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_environment_block_is_sorted_and_double_terminated() {
        let block = environment(OsStr::new("C:\\L"), OsStr::new("C:\\W"));
        let expected: Vec<u16> = "LOCALAPPDATA=C:\\L\0SystemRoot=C:\\W\0\0"
            .encode_utf16()
            .collect();
        assert_eq!(block, expected);
    }

    #[test]
    fn a_union_keeps_every_bit_once() {
        assert_eq!(union::<u32>(&[]), 0);
        assert_eq!(union(&[0b0110u32, 0b0011]), 0b0111);
        assert_eq!(union(&[0b1000u64, 0b1000]), 0b1000);
    }

    // Known answers, written from the values winbase.h and winnt.h document,
    // so a shifted or dropped flag fails here even where no run can see it
    // (heap termination cannot be queried from inside the process).
    #[test]
    fn the_flag_sets_are_the_documented_values() {
        // PROCESS_CREATION_MITIGATION_POLICY_*_ALWAYS_ON: 1 << 12, 16, 20,
        // 28, 32, 48, 52, 56 and 60.
        assert_eq!(mitigations(), 0x1111_0001_1011_1000);
        // JOB_OBJECT_UILIMIT_*: all eight classes, 0x01 through 0x80.
        assert_eq!(ui_restrictions(), 0xff);
        // KILL_ON_JOB_CLOSE 0x2000, ACTIVE_PROCESS 0x8, JOB_MEMORY 0x200,
        // DIE_ON_UNHANDLED_EXCEPTION 0x400.
        assert_eq!(job_limits(), 0x2608);
        // FILE_GENERIC_READ 0x120089 | FILE_GENERIC_EXECUTE 0x1200a0.
        assert_eq!(granted(), 0x1200a9);
        // EXTENDED_STARTUPINFO_PRESENT 0x80000, CREATE_SUSPENDED 0x4,
        // DETACHED_PROCESS 0x8, CREATE_UNICODE_ENVIRONMENT 0x400.
        assert_eq!(creation_flags(), 0x8040c);
    }
}
