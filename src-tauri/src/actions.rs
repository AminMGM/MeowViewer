//! OS integrations: Explorer, Open with, print, wallpaper, clipboard, desktop shortcuts,
//! Telegram / Bluetooth / e-mail hand-off and Google Lens.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER};
use windows::Win32::UI::Shell::{IShellLinkW, ShellExecuteW, ShellLink};
use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_SETDESKWALLPAPER, SW_SHOWNORMAL,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn shell_open(target: &str, verb: &str) -> Result<(), String> {
    crate::com_init();
    let r = unsafe {
        ShellExecuteW(
            None,
            &HSTRING::from(verb),
            &HSTRING::from(target),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if r.0 as isize > 32 { Ok(()) } else { Err(format!("Windows couldn't {verb} this item")) }
}

pub fn reveal(path: &str) -> Result<(), String> {
    Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{path}\""))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn open_with(path: &str) -> Result<(), String> {
    Command::new("rundll32.exe")
        .raw_arg(format!("shell32.dll,OpenAs_RunDLL {path}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn set_wallpaper(path: &str, data_dir: &Path) -> Result<(), String> {
    let ext = crate::media::ext_of(path);
    let file = if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "bmp") {
        path.to_string()
    } else {
        let o = crate::media::read_exif(path, false).orientation;
        let (rgba, w, h) = crate::wic::decode_rgba(path, 7680, o)?;
        let rgb: Vec<u8> = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 95)
            .encode(&rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;
        let dest = data_dir.join("wallpaper.jpg");
        std::fs::write(&dest, out).map_err(|e| e.to_string())?;
        dest.to_string_lossy().into_owned()
    };
    let mut wide: Vec<u16> = file.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            Some(wide.as_mut_ptr() as *mut _),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
        .map_err(|e| e.message())
    }
}

// ------------------------------------------------------------ clipboard

pub fn copy_image(path: &str) -> Result<(), String> {
    let kind = crate::media::kind_of(path).ok_or("Not a media file")?;
    let bmp = if kind == crate::media::KIND_VIDEO {
        None
    } else {
        let o = crate::media::read_exif(path, false).orientation;
        let decoded = crate::wic::decode_rgba(path, 8192, o).or_else(|_| {
            crate::thumbs::shell_image(path, 2560).map(|(bgra, w, h)| {
                let rgba = bgra.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
                (rgba, w, h)
            })
        })?;
        Some(crate::wic::rgba_to_bmp(&decoded.0, decoded.1, decoded.2)?)
    };
    let _clip = clipboard_win::Clipboard::new_attempts(10).map_err(|e| e.to_string())?;
    clipboard_win::raw::empty().map_err(|e| e.to_string())?;
    if let Some(bmp) = bmp {
        clipboard_win::raw::set_bitmap_with(&bmp, clipboard_win::options::NoClear).map_err(|e| e.to_string())?;
    }
    clipboard_win::raw::set_file_list_with(&[path], clipboard_win::options::NoClear).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn copy_files(paths: &[String]) -> Result<(), String> {
    let _clip = clipboard_win::Clipboard::new_attempts(10).map_err(|e| e.to_string())?;
    clipboard_win::raw::empty().map_err(|e| e.to_string())?;
    clipboard_win::raw::set_file_list_with(paths, clipboard_win::options::NoClear).map_err(|e| e.to_string())
}

pub fn copy_text(text: &str) -> Result<(), String> {
    clipboard_win::set_clipboard_string(text).map_err(|e| e.to_string())
}

// ------------------------------------------------------------ shortcut

pub fn create_shortcut(target: &str, name: &str, is_folder: bool, desktop: &Path) -> Result<String, String> {
    crate::com_init();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let args = if is_folder { format!("--folder \"{target}\"") } else { format!("\"{target}\"") };
    let safe: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    let lnk = desktop.join(format!("{safe}.lnk"));
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
        link.SetPath(&HSTRING::from(exe.as_os_str())).map_err(|e| e.message())?;
        link.SetArguments(&HSTRING::from(args)).map_err(|e| e.message())?;
        link.SetIconLocation(&HSTRING::from(exe.as_os_str()), 0).map_err(|e| e.message())?;
        link.SetDescription(&HSTRING::from(format!("Open {name} in MeowViewer"))).map_err(|e| e.message())?;
        let pf: IPersistFile = link.cast().map_err(|e| e.message())?;
        pf.Save(&HSTRING::from(lnk.as_os_str()), true).map_err(|e| e.message())?;
    }
    Ok(lnk.to_string_lossy().into_owned())
}

// ------------------------------------------------------------- sending

fn reg_default(key: &str) -> Option<String> {
    let out = Command::new("reg").args(["query", key, "/ve"]).creation_flags(CREATE_NO_WINDOW).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("REG_SZ") || l.contains("REG_EXPAND_SZ"))?;
    let value = line.split("REG_").nth(1)?.split_once(char::is_whitespace)?.1.trim().to_string();
    Some(value)
}

fn telegram_exe() -> Option<String> {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let p = Path::new(&appdata).join("Telegram Desktop").join("Telegram.exe");
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    // The tg:// handler points at the installed Telegram Desktop.
    for key in [r"HKCU\Software\Classes\tg\shell\open\command", r"HKCR\tg\shell\open\command"] {
        if let Some(cmd) = reg_default(key) {
            let exe = if let Some(rest) = cmd.strip_prefix('"') {
                rest.split('"').next().unwrap_or("").to_string()
            } else {
                cmd.split_whitespace().next().unwrap_or("").to_string()
            };
            if exe.to_lowercase().ends_with(".exe") && Path::new(&exe).exists() {
                return Some(exe);
            }
        }
    }
    None
}

/// Microsoft Store Telegram: returns its AppUserModelID (PackageFamilyName!AppId).
fn telegram_store_aumid() -> Option<String> {
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "$p = Get-AppxPackage *TelegramDesktop* | Select-Object -First 1; if ($p) { $id = (Get-AppxPackageManifest $p).Package.Applications.Application | Select-Object -First 1 -ExpandProperty Id; \"$($p.PackageFamilyName)!$id\" }",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    s.contains('!').then_some(s)
}

fn quote_args(paths: &[String]) -> String {
    paths.iter().map(|p| format!("\"{p}\"")).collect::<Vec<_>>().join(" ")
}

/// Opens Telegram's "send to…" chat picker with the files attached (desktop or Store install).
/// Returns false when Telegram isn't installed (the caller falls back to the share sheet).
pub fn telegram_send(paths: &[String]) -> Result<bool, String> {
    if let Some(exe) = telegram_exe() {
        let mut cmd = Command::new(exe);
        cmd.arg("-sendpath");
        for p in paths {
            cmd.arg(p);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(true);
    }
    let Some(aumid) = telegram_store_aumid() else { return Ok(false) };
    crate::com_init();
    unsafe {
        use windows::Win32::UI::Shell::{ApplicationActivationManager, IApplicationActivationManager, AO_NONE};
        let m: IApplicationActivationManager =
            CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER).map_err(|e| e.message())?;
        m.ActivateApplication(&HSTRING::from(aumid), &HSTRING::from(format!("-sendpath {}", quote_args(paths))), AO_NONE)
            .map_err(|e| e.message())?;
    }
    Ok(true)
}

/// Bluetooth File Transfer wizard with the files already attached — the same thing Explorer's
/// "Send to → Bluetooth device" does (it passes the paths to fsquirt.exe).
pub fn bluetooth_send(paths: &[String]) -> Result<(), String> {
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let mut cmd = Command::new(Path::new(&sys).join("System32").join("fsquirt.exe"));
    for p in paths {
        cmd.arg(p);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Classic Outlook: new mail with attachments. Returns false when Outlook isn't installed.
pub fn email_outlook(paths: &[String]) -> Result<bool, String> {
    let key = r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\OUTLOOK.EXE";
    let Some(exe) = reg_default(key) else { return Ok(false) };
    let exe = exe.trim_matches('"').to_string();
    if !Path::new(&exe).exists() {
        return Ok(false);
    }
    for p in paths {
        Command::new(&exe).arg("/a").arg(p).spawn().map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// Uploads a downscaled JPEG to Google Lens and opens the results page in the browser.
pub async fn lens_search(path: String) -> Result<(), String> {
    let jpeg = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let kind = crate::media::kind_of(&path).ok_or("Not a media file")?;
        let (bgra_or_rgba, w, h, is_bgra) = if kind == crate::media::KIND_VIDEO {
            let (b, w, h) = crate::thumbs::shell_image(&path, 1280)?;
            (b, w, h, true)
        } else {
            let o = crate::media::read_exif(&path, false).orientation;
            match crate::wic::decode_rgba(&path, 1600, o) {
                Ok((r, w, h)) => (r, w, h, false),
                Err(_) => {
                    let (b, w, h) = crate::thumbs::shell_image(&path, 1600)?;
                    (b, w, h, true)
                }
            }
        };
        let bgra: Vec<u8> = if is_bgra {
            bgra_or_rgba
        } else {
            bgra_or_rgba.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0], p[3]]).collect()
        };
        crate::thumbs::bgra_to_jpeg(&bgra, w, h, 88)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Upload from the user's own browser (with their Google session): a local page holds the
    // image and auto-submits it to Lens. Uploading from the app creates a session that isn't
    // tied to the user's account, and Google then shows "Image not found".
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
    let html = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Google Lens · MeowViewer</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#111116;color:#ddd;font:16px 'Segoe UI',sans-serif">
<div>Opening Google Lens…</div>
<form id="f" method="POST" enctype="multipart/form-data" action="https://lens.google.com/v3/upload?hl=en&re=df&st={st}&ep=gsbubb">
<input type="file" name="encoded_image" id="i" hidden></form>
<script>
const b = atob("{b64}"); const u = new Uint8Array(b.length);
for (let k = 0; k < b.length; k++) u[k] = b.charCodeAt(k);
const dt = new DataTransfer(); dt.items.add(new File([u], "image.jpg", {{ type: "image/jpeg" }}));
document.getElementById("i").files = dt.files; document.getElementById("f").submit();
</script></body></html>"#,
        st = crate::now_ms()
    );
    let file = std::env::temp_dir().join(format!("meowviewer-lens-{}.html", crate::now_ms()));
    std::fs::write(&file, html).map_err(|e| e.to_string())?;
    shell_open(&file.to_string_lossy(), "open")?;
    let f2 = file.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let _ = std::fs::remove_file(f2);
    });
    Ok(())
}
