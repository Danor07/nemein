#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
struct Backend(Mutex<Child>);

/// Windows: a job with KILL_ON_JOB_CLOSE holding Node. This process keeps the
/// only handle, so when the window closes or this process dies for any reason,
/// Node and everything it started (connector supervisor and worker) end too.
/// The job forbids breakaway, and its descendants stay inside it.
#[cfg(target_os = "windows")]
mod tree {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Tree(HANDLE);
    // A kernel handle; closing it from another thread is fine.
    unsafe impl Send for Tree {}
    unsafe impl Sync for Tree {}

    impl Drop for Tree {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    pub fn contain(child: &std::process::Child) -> Result<Tree, String> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("CreateJobObjectW".into());
            }
            let tree = Tree(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of_val(&limits) as u32;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                size,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0
            {
                return Err("no se pudo asociar Node a su Job".into());
            }
            Ok(tree)
        }
    }
}
fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let runtime = if cfg!(debug_assertions) {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../desktop-resources/runtime")
            } else {
                app.path().resource_dir()?.join("runtime")
            };
            // Node cannot resolve Windows extended-length main-script paths.
            let runtime_text = runtime.to_string_lossy().into_owned();
            let runtime = std::path::PathBuf::from(
                runtime_text.strip_prefix(r"\\?\").unwrap_or(&runtime_text),
            );
            let node = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
            let mut cmd = Command::new(node);
            // The connector worker ships next to this executable (externalBin).
            let connector = std::env::current_exe()?.with_file_name(if cfg!(windows) {
                "nemein-connector.exe"
            } else {
                "nemein-connector"
            });
            cmd.arg("src/server.js")
                .current_dir(&runtime)
                .env("BUDGET_DESKTOP", "1")
                .env("NEMEIN_CONNECTOR_BIN", connector)
                .env("PORT", "0")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            let mut child = cmd.spawn()?;
            // Node starts no process before the window loads, so assigning it
            // right after spawning leaves nothing outside the job.
            #[cfg(target_os = "windows")]
            match tree::contain(&child) {
                Ok(tree) => {
                    app.manage(tree);
                }
                Err(e) => {
                    let _ = child.kill();
                    return Err(format!("No se pudo contener el servidor local: {e}").into());
                }
            }
            let stdout = child
                .stdout
                .take()
                .ok_or("No se pudo abrir el servidor local")?;
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    match line {
                        Ok(s) if s.starts_with("BUDGET_URL=") => {
                            let _ = tx.send(s.trim_start_matches("BUDGET_URL=").to_owned());
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            });
            let url = match rx.recv_timeout(Duration::from_secs(30)) {
                Ok(u) => u,
                Err(e) => {
                    let _ = child.kill();
                    return Err(format!("No se pudo iniciar el presupuesto: {e}").into());
                }
            };
            let parsed: tauri::Url = url.parse()?;
            if parsed.host_str() != Some("127.0.0.1") {
                let _ = child.kill();
                return Err("Servidor no local".into());
            }
            let origin = parsed.origin().ascii_serialization();
            app.manage(Backend(Mutex::new(child)));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("Nemein · Presupuesto personal")
                .inner_size(1360.0, 900.0)
                .min_inner_size(800.0, 620.0)
                .on_navigation(move |u| u.origin().ascii_serialization() == origin)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("No se pudo iniciar Nemein");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Backend>() {
                if let Ok(mut child) = state.0.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
