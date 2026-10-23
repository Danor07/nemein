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
            cmd.arg("src/server.js")
                .current_dir(&runtime)
                .env("BUDGET_DESKTOP", "1")
                .env("PORT", "0")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            let mut child = cmd.spawn()?;
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
                .title("Cero · Presupuesto personal")
                .inner_size(1360.0, 900.0)
                .min_inner_size(800.0, 620.0)
                .on_navigation(move |u| u.origin().ascii_serialization() == origin)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("No se pudo iniciar Presupuesto Cero");
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
