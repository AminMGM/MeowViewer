//! Installed image editors ("Open in Photoshop" etc.), found via App Paths and install folders.

use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone)]
pub struct Editor {
    pub name: String,
    pub exe: String,
}

fn app_path(exe: &str) -> Option<PathBuf> {
    for hive in ["HKLM", "HKCU"] {
        let key = format!(r"{hive}\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
        let out = Command::new("reg").args(["query", &key, "/ve"]).creation_flags(CREATE_NO_WINDOW).output().ok()?;
        if !out.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(line) = text.lines().find(|l| l.contains("REG_SZ") || l.contains("REG_EXPAND_SZ")) {
            if let Some(v) = line.split("REG_").nth(1).and_then(|r| r.split_once(char::is_whitespace)) {
                let p = PathBuf::from(v.1.trim().trim_matches('"'));
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Newest match of `<base>\<dir prefix>*\<exe>`.
fn glob_dir(base: &Path, prefix: &str, exe: &str) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(base)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().to_lowercase().starts_with(&prefix.to_lowercase()))
        .map(|e| e.path().join(exe))
        .filter(|p| p.exists())
        .collect();
    found.sort();
    found.pop()
}

pub fn detect() -> Vec<Editor> {
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    let adobe = Path::new(&pf).join("Adobe");
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let mut out = Vec::new();
    let mut add = |name: &str, p: Option<PathBuf>| {
        if let Some(p) = p {
            out.push(Editor { name: name.into(), exe: p.to_string_lossy().into_owned() });
        }
    };
    add("Photoshop", app_path("Photoshop.exe").or_else(|| glob_dir(&adobe, "Adobe Photoshop", "Photoshop.exe")));
    add("Lightroom Classic", app_path("Lightroom.exe").or_else(|| glob_dir(&adobe, "Adobe Lightroom Classic", "Lightroom.exe")));
    add("Illustrator", app_path("Illustrator.exe").or_else(|| {
        glob_dir(&adobe, "Adobe Illustrator", r"Support Files\Contents\Windows\Illustrator.exe")
    }));
    add(
        "GIMP",
        glob_dir(Path::new(&pf), "GIMP", r"bin\gimp-3.exe")
            .or_else(|| glob_dir(Path::new(&pf), "GIMP", r"bin\gimp-2.10.exe"))
            .or_else(|| glob_dir(Path::new(&local).join("Programs").as_path(), "GIMP", r"bin\gimp-3.exe")),
    );
    add("Affinity Photo", glob_dir(&Path::new(&pf).join("Affinity"), "Photo", "Photo.exe"));
    add("Paint.NET", app_path("paintdotnet.exe").or_else(|| Some(Path::new(&pf).join(r"paint.net\paintdotnet.exe")).filter(|p| p.exists())));
    out
}

pub fn open_in(exe: &str, paths: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    for p in paths {
        cmd.arg(p);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}
