//! Cancellation for long-running jobs (library scan, duplicate scan, export, import, codec download,
//! video conversion, OCR). Each job takes a fresh token by name; `cancel(name)` flips it and kills
//! any external process (FFmpeg) the job registered.

use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

type Tokens = Mutex<HashMap<String, Arc<AtomicBool>>>;
static TOKENS: OnceLock<Tokens> = OnceLock::new();
static PIDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

fn tokens() -> &'static Tokens {
    TOKENS.get_or_init(Default::default)
}
fn pids() -> &'static Mutex<HashMap<String, u32>> {
    PIDS.get_or_init(Default::default)
}

/// A fresh, un-cancelled token for `name` (replaces any previous one).
pub fn token(name: &str) -> Arc<AtomicBool> {
    let t = Arc::new(AtomicBool::new(false));
    tokens().lock().unwrap().insert(name.to_string(), t.clone());
    t
}

pub fn is_cancelled(t: &AtomicBool) -> bool {
    t.load(Ordering::Relaxed)
}

/// Remembers the process a job started so `cancel` can stop it.
pub fn register_pid(name: &str, pid: u32) {
    pids().lock().unwrap().insert(name.to_string(), pid);
}
pub fn clear_pid(name: &str) {
    pids().lock().unwrap().remove(name);
}

pub fn cancel(name: &str) {
    if let Some(t) = tokens().lock().unwrap().get(name) {
        t.store(true, Ordering::SeqCst);
    }
    if let Some(pid) = pids().lock().unwrap().remove(name) {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .status();
    }
}

pub const CANCELLED: &str = "Cancelled";
