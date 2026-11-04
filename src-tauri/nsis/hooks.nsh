; Hooks of the Nemein NSIS installer (tauri.conf.json, bundle.windows.nsis).

; The connector worker registers its AppContainer profile the first time it
; runs (docs/conectores.md). Uninstalling deletes it, with its folder under
; %LOCALAPPDATA%\Packages. Best effort: an absent profile is not an error. If
; an update deletes it too, the worker registers it again on its next run.
!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'userenv::DeleteAppContainerProfile(w "Nemein.ConnectorWorker") i .r0'
  DetailPrint "DeleteAppContainerProfile: $0"
!macroend
