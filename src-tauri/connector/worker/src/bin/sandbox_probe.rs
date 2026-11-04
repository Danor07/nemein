//! Native probe for the enclosure tests (`--features test-worker` only).
//!
//! `connector-sandbox-probe <file> <folder> <port>` tries what a connector must
//! never do and prints one JSON line: read a fictitious file, write into a
//! folder, connect to a local TCP port, start a process, and count the
//! environment variables it can see. Run enclosed, every attempt must fail; run
//! without the enclosure (the positive control), every attempt must succeed.
//!
//! On Windows it also reports, from inside, what the enclosure applied: the
//! token (AppContainer, LPAC, capability count), the limits of its immediate
//! job, and the raw flag word of each process mitigation policy. A value that
//! cannot be read is -1, which no test accepts.

use std::io::Write;

/// `text` as a JSON string.
fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn outcome(ok: bool) -> &'static str {
    if ok {
        "allowed"
    } else {
        "denied"
    }
}

#[cfg(windows)]
mod enclosure {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenCapabilities, TokenIsAppContainer, TokenSecurityAttributes,
        TOKEN_INFORMATION_CLASS, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicUIRestrictions, JobObjectExtendedLimitInformation, QueryInformationJobObject,
        JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessMitigationPolicy, OpenProcessToken, ProcessASLRPolicy,
        ProcessChildProcessPolicy, ProcessExtensionPointDisablePolicy, ProcessFontDisablePolicy,
        ProcessImageLoadPolicy, ProcessSystemCallDisablePolicy, PROCESS_MITIGATION_POLICY,
    };

    fn token_u32(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> i64 {
        let (mut value, mut length) = (0u32, 0u32);
        let read = unsafe {
            GetTokenInformation(
                token,
                class,
                &mut value as *mut _ as *mut c_void,
                4,
                &mut length,
            )
        };
        if read == 0 {
            -1
        } else {
            i64::from(value)
        }
    }

    /// TOKEN_GROUPS starts with its count; the buffer is sized by a first call.
    fn capability_count(token: HANDLE) -> i64 {
        let mut length = 0u32;
        unsafe { GetTokenInformation(token, TokenCapabilities, null_mut(), 0, &mut length) };
        if length < 4 {
            return -1;
        }
        let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
        let read = unsafe {
            GetTokenInformation(
                token,
                TokenCapabilities,
                buffer.as_mut_ptr() as *mut c_void,
                length,
                &mut length,
            )
        };
        if read == 0 {
            -1
        } else {
            i64::from(buffer[0] as u32)
        }
    }

    // `TokenSecurityAttributes` answers in the kernel's layout (ntseapi.h),
    // whose names are UNICODE_STRINGs, not the CLAIM_* structures of the SDK.
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }

    #[repr(C)]
    struct TokenSecurityAttributeV1 {
        name: UnicodeString,
        value_type: u16,
        reserved: u16,
        flags: u32,
        value_count: u32,
        values: *const c_void,
    }

    #[repr(C)]
    struct TokenSecurityAttributesInformation {
        version: u16,
        reserved: u16,
        attribute_count: u32,
        attributes: *const TokenSecurityAttributeV1,
    }

    /// TOKEN_SECURITY_ATTRIBUTE_TYPE_UINT64.
    const ATTRIBUTE_UINT64: u16 = 2;

    /// The `WIN://NOALLAPPPKG` security attribute, which is how Windows marks
    /// a less privileged AppContainer (observed; not in the SDK headers).
    /// `TokenIsLessPrivilegedAppContainer` fails on windows-2022.
    fn no_all_application_packages(token: HANDLE) -> i64 {
        let mut length = 0u32;
        unsafe { GetTokenInformation(token, TokenSecurityAttributes, null_mut(), 0, &mut length) };
        if length == 0 {
            return -1;
        }
        let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
        let read = unsafe {
            GetTokenInformation(
                token,
                TokenSecurityAttributes,
                buffer.as_mut_ptr() as *mut c_void,
                length,
                &mut length,
            )
        };
        if read == 0 {
            return -1;
        }
        let info = unsafe { &*(buffer.as_ptr() as *const TokenSecurityAttributesInformation) };
        if info.attribute_count == 0 || info.attributes.is_null() {
            return 0;
        }
        let attributes =
            unsafe { std::slice::from_raw_parts(info.attributes, info.attribute_count as usize) };
        for attribute in attributes {
            let name = if attribute.name.buffer.is_null() {
                String::new()
            } else {
                String::from_utf16_lossy(unsafe {
                    std::slice::from_raw_parts(
                        attribute.name.buffer,
                        usize::from(attribute.name.length) / 2,
                    )
                })
            };
            if name.eq_ignore_ascii_case("WIN://NOALLAPPPKG")
                && attribute.value_type == ATTRIBUTE_UINT64
                && attribute.value_count >= 1
                && !attribute.values.is_null()
            {
                return unsafe { *(attribute.values as *const u64) } as i64;
            }
        }
        0
    }

    pub fn token() -> String {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return r#"{"appcontainer":-1,"lpac":-1,"capabilities":-1}"#.into();
        }
        let line = format!(
            r#"{{"appcontainer":{},"lpac":{},"capabilities":{}}}"#,
            token_u32(token, TokenIsAppContainer),
            no_all_application_packages(token),
            capability_count(token)
        );
        unsafe { CloseHandle(token) };
        line
    }

    /// The immediate job of this process: a null handle names it.
    pub fn job() -> String {
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let read = unsafe {
            QueryInformationJobObject(
                null_mut(),
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut c_void,
                size_of_val(&limits) as u32,
                null_mut(),
            )
        };
        let (flags, processes, memory) = if read == 0 {
            (-1, -1, -1)
        } else {
            let basic = &limits.BasicLimitInformation;
            (
                i64::from(basic.LimitFlags),
                i64::from(basic.ActiveProcessLimit),
                limits.JobMemoryLimit as i64,
            )
        };
        let mut ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: 0,
        };
        let read = unsafe {
            QueryInformationJobObject(
                null_mut(),
                JobObjectBasicUIRestrictions,
                &mut ui as *mut _ as *mut c_void,
                size_of_val(&ui) as u32,
                null_mut(),
            )
        };
        let ui = if read == 0 {
            -1
        } else {
            i64::from(ui.UIRestrictionsClass)
        };
        format!(
            r#"{{"limits":{flags},"active_processes":{processes},"memory":{memory},"ui":{ui}}}"#
        )
    }

    fn policy(class: PROCESS_MITIGATION_POLICY) -> i64 {
        // Every policy queried here is a single 32-bit flag word.
        let mut flags = 0u32;
        let read = unsafe {
            GetProcessMitigationPolicy(
                GetCurrentProcess(),
                class,
                &mut flags as *mut _ as *mut c_void,
                4,
            )
        };
        if read == 0 {
            -1
        } else {
            i64::from(flags)
        }
    }

    pub fn mitigations() -> String {
        format!(
            r#"{{"aslr":{},"win32k":{},"extension_points":{},"fonts":{},"image_load":{},"child_process":{}}}"#,
            policy(ProcessASLRPolicy),
            policy(ProcessSystemCallDisablePolicy),
            policy(ProcessExtensionPointDisablePolicy),
            policy(ProcessFontDisablePolicy),
            policy(ProcessImageLoadPolicy),
            policy(ProcessChildProcessPolicy)
        )
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [file, folder, port] = args.as_slice() else {
        std::process::exit(2);
    };
    // Each field is written and flushed as soon as it is known: if an attempt
    // kills the probe, the fields before it still reach the test.
    let mut stdout = std::io::stdout().lock();
    let mut emit = |field: String| {
        let _ = stdout.write_all(field.as_bytes());
        let _ = stdout.flush();
    };
    let mut names: Vec<String> = std::env::vars_os()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect();
    names.sort();
    // Names only, never values; quoted as JSON.
    let variables = names
        .iter()
        .map(|n| json_string(n))
        .collect::<Vec<_>>()
        .join(",");
    emit(format!(
        r#"{{"environment":{},"variables":[{variables}]"#,
        names.len()
    ));
    // The values of the only paths Windows may hand an AppContainer.
    let paths = ["LOCALAPPDATA", "TEMP", "TMP"]
        .iter()
        .filter_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| format!("\"{name}\":{}", json_string(&value)))
        })
        .collect::<Vec<_>>()
        .join(",");
    emit(format!(r#","paths":{{{paths}}}"#));
    #[cfg(windows)]
    {
        emit(format!(r#","token":{}"#, enclosure::token()));
        emit(format!(r#","job":{}"#, enclosure::job()));
        emit(format!(r#","mitigations":{}"#, enclosure::mitigations()));
    }
    let read = std::fs::read(file).is_ok();
    emit(format!(r#","read":"{}""#, outcome(read)));
    let write = std::fs::write(
        std::path::Path::new(folder).join("probe-wrote-here.txt"),
        b"x",
    )
    .is_ok();
    emit(format!(r#","write":"{}""#, outcome(write)));
    let process = std::process::Command::new("cmd.exe")
        .args(["/c", "exit", "0"])
        .status()
        .is_ok();
    emit(format!(r#","process":"{}""#, outcome(process)));
    let network =
        std::net::TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap_or(1))).is_ok();
    emit(format!(r#","network":"{}"}}"#, outcome(network)));
}
