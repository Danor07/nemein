//! The AppContainer profile: registered the first time, derived afterwards,
//! with the same SID. Windows only. A profile of its own, named after this
//! process, so parallel runs never see each other's.
#![cfg(windows)]

use nemein_connector::sandbox;
use windows_sys::Win32::Security::EqualSid;
use windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile;

#[test]
fn the_profile_is_registered_once_and_keeps_its_sid() {
    let name = format!("Nemein.ConnectorWorker.Test.{}", std::process::id());
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let _ = unsafe { DeleteAppContainerProfile(wide.as_ptr()) };
    let registered = sandbox::profile_sid(&name).expect("registers the profile");
    let derived = sandbox::profile_sid(&name).expect("derives the same SID");
    let same = unsafe { EqualSid(registered.as_psid(), derived.as_psid()) };
    let removed = unsafe { DeleteAppContainerProfile(wide.as_ptr()) };
    assert_ne!(same, 0, "the same SID both times");
    assert_eq!(removed, 0, "the profile existed: 0x{:08x}", removed as u32);
}
