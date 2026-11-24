mod actions;
mod cancel;
mod codecs;
mod db;
mod editors;
mod index;
mod media;
mod meta;
mod mkv;
mod ocr;
mod share;
mod shellprops;
mod thumbs;
mod tools;
mod vault;
mod wic;

use db::{Db, FolderNode, Group, Item, Query, TrashItem};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State, UriSchemeContext, UriSchemeResponder};

// ------------------------------------------------------------- helpers

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

thread_local!(static COM: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });

/// Initialises COM (apartment threaded) once per thread.
pub fn com_init() {
    COM.with(|c| {
        if !c.get() {
            unsafe {
                let _ = windows::Win32::System::Com::CoInitializeEx(
                    None,
                    windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
                );
            }
            c.set(true);
        }
    });
}

/// Converts a local wall-clock time (as written in EXIF) to Unix ms, honouring DST for that date.
pub fn local_to_unix_ms(y: u16, mo: u16, d: u16, h: u16, mi: u16, s: u16) -> Option<i64> {
    use windows::Win32::Foundation::SYSTEMTIME;
    use windows::Win32::System::Time::TzSpecificLocalTimeToSystemTime;
    let local = SYSTEMTIME { wYear: y, wMonth: mo, wDay: d, wHour: h, wMinute: mi, wSecond: s, ..Default::default() };
    let mut utc = SYSTEMTIME::default();
    unsafe { TzSpecificLocalTimeToSystemTime(None, &local, &mut utc).ok()? };
    // days_from_civil (Howard Hinnant)
    let (y, m, d) = (utc.wYear as i64, utc.wMonth as i64, utc.wDay as i64);
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + utc.wHour as i64) * 60 + utc.wMinute as i64) * 60_000 + utc.wSecond as i64 * 1000)
}

/// Unix ms → local wall clock as an EXIF date string "YYYY:MM:DD HH:MM:SS".
pub fn unix_ms_to_local(ms: i64) -> Option<String> {
    use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
    let ft = ((ms + 11_644_473_600_000) * 10_000) as u64;
    let ft = FILETIME { dwLowDateTime: ft as u32, dwHighDateTime: (ft >> 32) as u32 };
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    unsafe {
        FileTimeToSystemTime(&ft, &mut utc).ok()?;
        SystemTimeToTzSpecificLocalTime(None, &utc, &mut local).ok()?;
    }
    Some(format!(
        "{:04}:{:02}:{:02} {:02}:{:02}:{:02}",
        local.wYear, local.wMonth, local.wDay, local.wHour, local.wMinute, local.wSecond
    ))
}

/// Case-insensitive "is `p` equal to or inside `dir`".
pub fn path_within(p: &str, dir: &str) -> bool {
    let (p, d) = (p.to_lowercase(), dir.trim_end_matches('\\').to_lowercase());
    p == d || (p.starts_with(&d) && p.as_bytes().get(d.len()) == Some(&b'\\'))
}

pub fn parent_of(p: &str) -> Option<String> {
    Path::new(p).parent().map(|x| x.to_string_lossy().into_owned()).filter(|s| !s.is_empty())
}

pub fn file_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string())
}

// -------------------------------------------------------------- state

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub roots: Vec<String>,
    pub wheel: String,
    pub slideshow_secs: u32,
    pub slideshow_shuffle: bool,
    pub viewer_bg: String,
    pub accent: String,
    pub trash_days: u32,
    pub auto_update: bool,
    pub grid_size: u32,
    pub sort: String,
    pub desc: bool,
    pub filmstrip: bool,
    pub folder_layout: String,
    pub sidebar_collapsed: bool,
    pub theme: String,
    pub ocr: bool,
    pub vault_autolock_min: u32,
    pub video_volume: f64,
    pub video_speed: f64,
    pub onboarded: bool,
    pub video_resume: bool,
    pub video_autonext: bool,
    pub sub_size: u32,
    pub sub_bg: u32,
    pub sub_color: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            roots: Vec::new(),
            wheel: "zoom".into(),
            slideshow_secs: 4,
            slideshow_shuffle: false,
            viewer_bg: "ambient".into(),
            accent: "aurora".into(),
            trash_days: 30,
            auto_update: true,
            grid_size: 180,
            sort: "date".into(),
            desc: true,
            filmstrip: true,
            folder_layout: "tree".into(),
            sidebar_collapsed: false,
            theme: "system".into(),
            ocr: true,
            vault_autolock_min: 5,
            video_volume: 1.0,
            video_speed: 1.0,
            onboarded: false,
            video_resume: true,
            video_autonext: false,
            sub_size: 100,
            sub_bg: 55,
            sub_color: "#ffffff".into(),
        }
    }
}

pub struct Paths {
    pub data: PathBuf,
    pub thumbs: PathBuf,
    pub trash: PathBuf,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Startup {
    pub file: Option<String>,
    pub folder: Option<String>,
}

pub struct AppState {
    pub db: Arc<Db>,
    pub paths: Paths,
    pub settings: Mutex<Settings>,
    pub startup: Mutex<Startup>,
    pub indexer: Arc<index::Indexer>,
    pub thumb_pool: thumbs::Pool,
    pub decode_pool: thumbs::Pool,
    pub vault: vault::Vault,
    pub ocr: Arc<ocr::Ocr>,
}

fn default_roots(app: &AppHandle) -> Vec<String> {
    let p = app.path();
    let mut roots: Vec<PathBuf> = [p.picture_dir(), p.video_dir(), p.download_dir()]
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();
    for var in ["OneDrive", "OneDriveConsumer"] {
        if let Ok(od) = std::env::var(var) {
            let pics = Path::new(&od).join("Pictures");
            if pics.is_dir() {
                roots.push(pics);
            }
        }
    }
    let mut out: Vec<String> = Vec::new();
    for r in roots {
        let s = r.to_string_lossy().into_owned();
        if r.is_dir() && !out.iter().any(|o| o.eq_ignore_ascii_case(&s)) {
            out.push(s);
        }
    }
    out
}

fn parse_args(args: &[String]) -> Startup {
    let mut st = Startup::default();
    let mut it = args.iter().skip(1).peekable();
    while let Some(a) = it.next() {
        if a == "--folder" {
            st.folder = it.next().cloned();
        } else if !a.starts_with("--") {
            let p = Path::new(a);
            if p.is_dir() {
                st.folder = Some(a.clone());
            } else if p.is_file() {
                st.file = Some(a.clone());
            }
        }
    }
    st
}

// ----------------------------------------------------------- protocol
//
//   http://mv.localhost/f?p=<path>          raw file, HTTP range support (video seeking)
//   http://mv.localhost/t?p=<path>&s=<px>   shell thumbnail (cached JPEG)
//   http://mv.localhost/d?p=<path>          full-res decode of non-web formats (HEIC, TIFF, RAW…)

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                if let Some(v) = hex {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(uri: &str, key: &str) -> Option<String> {
    let q = uri.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| pct_decode(v))
    })
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
        .body(body)
        .unwrap()
}

fn not_found(msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

/// Range-capable response over any byte source (plain file, embedded motion video, vault).
fn serve_ranged(
    len: u64,
    mime: &str,
    range: Option<&str>,
    force_range: bool,
    read: impl Fn(u64, u64) -> Result<Vec<u8>, String>,
) -> Response<Vec<u8>> {
    const CHUNK: u64 = 3 * 1024 * 1024;
    let parsed = range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| {
        let (a, b) = r.split_once('-')?;
        Some((a.trim().parse::<u64>().ok()?, b.trim().parse::<u64>().ok()))
    });
    let parsed = parsed.or(if force_range { Some((0, None)) } else { None });
    let Some((start, end)) = parsed else {
        return match read(0, len.saturating_sub(1)) {
            Ok(buf) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(buf)
                .unwrap(),
            Err(e) => not_found(&e),
        };
    };
    if start >= len && len > 0 {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new())
            .unwrap();
    }
    let end = end.unwrap_or(len.saturating_sub(1)).min(len.saturating_sub(1)).min(start + CHUNK - 1);
    match read(start, end) {
        Ok(buf) => Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .header(header::CONTENT_LENGTH, buf.len().to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(buf)
            .unwrap(),
        Err(e) => not_found(&e),
    }
}

fn read_file_range(path: &str, start: u64, end: u64) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; (end + 1 - start) as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn serve_file(path: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let Ok(md) = std::fs::metadata(path) else { return not_found("missing") };
    let is_video = media::kind_of(path) == Some(media::KIND_VIDEO);
    let p = path.to_string();
    serve_ranged(md.len(), media::mime_of(&media::ext_of(path)), range, is_video, move |a, b| read_file_range(&p, a, b))
}

fn protocol(ctx: UriSchemeContext<'_, tauri::Wry>, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let uri = req.uri().to_string();
    let route = req.uri().path().trim_start_matches('/').to_string();
    let Some(path) = query_param(&uri, "p") else {
        responder.respond(not_found("missing p"));
        return;
    };
    let state = app.state::<AppState>();
    match route.as_str() {
        "t" => {
            let size: i32 = query_param(&uri, "s").and_then(|s| s.parse().ok()).unwrap_or(320).clamp(32, 2560);
            let dir = state.paths.thumbs.clone();
            state.thumb_pool.spawn(move || {
                let r = match thumbs::thumbnail(&dir, &path, size) {
                    Ok(jpg) => respond(StatusCode::OK, "image/jpeg", jpg),
                    Err(e) => not_found(&e),
                };
                responder.respond(r);
            });
        }
        "d" => {
            state.decode_pool.spawn(move || {
                let kind = media::kind_of(&path);
                let r = if kind == Some(media::KIND_RAW) {
                    // Embedded preview via the shell is ~50× faster than a full RAW develop.
                    thumbs::shell_image(&path, 4096)
                        .and_then(|(b, w, h)| thumbs::bgra_to_jpeg(&b, w, h, 92))
                        .map(|j| (j, "image/jpeg"))
                } else {
                    let o = media::read_exif(&path, false).orientation;
                    wic::decode_for_view(&path, 8192, o).or_else(|_| {
                        thumbs::shell_image(&path, 2560)
                            .and_then(|(b, w, h)| thumbs::bgra_to_jpeg(&b, w, h, 92))
                            .map(|j| (j, "image/jpeg"))
                    })
                };
                responder.respond(match r {
                    Ok((bytes, mime)) => respond(StatusCode::OK, mime, bytes),
                    Err(e) => not_found(&e),
                });
            });
        }
        "m" => {
            // Embedded motion-photo video.
            let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
            tauri::async_runtime::spawn_blocking(move || {
                let r = match tools::motion_video(&path) {
                    Some((off, len)) => serve_ranged(len, "video/mp4", range.as_deref(), true, |a, b| {
                        read_file_range(&path, off + a, off + b)
                    }),
                    None => not_found("no motion video"),
                };
                responder.respond(r);
            });
        }
        "vt" | "vf" => {
            // Private album: decrypted on the fly, only while unlocked.
            let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
            let app2 = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let st = app2.state::<AppState>();
                let r = if route == "vt" {
                    match st.vault.read_thumb(&path) {
                        Ok(b) => respond(StatusCode::OK, "image/jpeg", b),
                        Err(e) => not_found(&e),
                    }
                } else {
                    let mime = query_param(&uri, "mime").unwrap_or_else(|| "application/octet-stream".into());
                    match st.vault.plain_len(&path) {
                        Ok(len) => {
                            let video = mime.starts_with("video/");
                            serve_ranged(len, &mime, range.as_deref(), video, |a, b| st.vault.read_range(&path, a, b))
                        }
                        Err(e) => not_found(&e),
                    }
                };
                responder.respond(r);
            });
        }
        _ => {
            let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(serve_file(&path, range.as_deref()));
            });
        }
    }
}

// ----------------------------------------------------------- commands

type R<T> = Result<T, String>;

#[tauri::command]
fn get_startup(state: State<AppState>) -> Startup {
    state.startup.lock().unwrap().clone()
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> R<()> {
    let roots_changed = {
        let mut cur = state.settings.lock().unwrap();
        let changed = cur.roots != settings.roots;
        *cur = settings.clone();
        changed
    };
    state.db.kv_set("settings", &serde_json::to_string(&settings).map_err(|e| e.to_string())?)?;
    if roots_changed {
        state.indexer.start(app, state.db.clone(), settings.roots, state.paths.trash.clone());
    }
    Ok(())
}

#[tauri::command]
fn rescan(app: AppHandle, state: State<AppState>) {
    let roots = state.settings.lock().unwrap().roots.clone();
    state.indexer.start(app, state.db.clone(), roots, state.paths.trash.clone());
}

#[tauri::command]
fn index_progress(state: State<AppState>) -> index::Progress {
    state.indexer.progress()
}

#[tauri::command]
async fn query_media(state: State<'_, AppState>, query: Query) -> R<Vec<Item>> {
    state.db.query(&query)
}

#[tauri::command]
async fn list_folders(state: State<'_, AppState>) -> R<Vec<FolderNode>> {
    let roots = index::effective_roots(&state.settings.lock().unwrap().roots);
    state.db.folders(&roots)
}

#[derive(Serialize)]
struct Overview {
    sources: Vec<Group>,
    kinds: Vec<Group>,
    specials: Vec<Group>,
}

#[tauri::command]
async fn album_overview(state: State<'_, AppState>) -> R<Overview> {
    let (sources, kinds, specials) = state.db.groups()?;
    Ok(Overview { sources, kinds, specials })
}

/// Lists media in one folder (for files opened from Explorer), natural-sorted by the UI.
#[tauri::command]
async fn list_dir(state: State<'_, AppState>, dir: String) -> R<Vec<Item>> {
    let rd = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    let mut out: Vec<Item> = Vec::new();
    use std::os::windows::fs::MetadataExt;
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path().to_string_lossy().into_owned();
        let Some(kind) = media::kind_of(&p) else { continue };
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() || md.file_attributes() & media::ATTR_HIDDEN != 0 {
            continue;
        }
        let mtime = (md.last_write_time() as i64 / 10_000) - 11_644_473_600_000;
        paths.push(p.clone());
        out.push((0, p, kind, mtime, false, 0, 0, md.file_size() as i64));
    }
    let favs = state.db.favorites_of(&paths)?;
    for it in out.iter_mut() {
        it.4 = favs.contains(&it.1);
    }
    Ok(out)
}

#[tauri::command]
async fn get_info(state: State<'_, AppState>, path: String) -> R<media::Info> {
    let fav = state.db.media_by_path(&path)?.map(|m| m.2).unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || media::info(&path, fav))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_favorite(app: AppHandle, state: State<AppState>, paths: Vec<String>, value: bool) -> R<()> {
    for p in &paths {
        if state.db.media_by_path(p)?.is_none() {
            index::index_one(&state.db, p);
        }
    }
    state.db.set_favorite(&paths, value)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
fn set_folder_cover(app: AppHandle, state: State<AppState>, folder: String, cover: Option<String>) -> R<()> {
    state.db.set_folder_meta(&folder, Some(cover.as_deref()), None)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
fn set_folder_hidden(app: AppHandle, state: State<AppState>, folder: String, hidden: bool) -> R<()> {
    state.db.set_folder_meta(&folder, None, Some(hidden))?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
fn hidden_folders(state: State<AppState>) -> R<Vec<String>> {
    state.db.hidden_folders()
}

// --------------------------------------------------------------- trash

fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Different drive: copy then delete.
            std::fs::copy(from, to)?;
            std::fs::remove_file(from)
        }
    }
}

#[tauri::command]
async fn trash_files(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> R<usize> {
    let mut n = 0;
    for p in paths {
        let src = PathBuf::from(&p);
        let (kind, size, fav) = state
            .db
            .media_by_path(&p)?
            .unwrap_or((media::kind_of(&p).unwrap_or(0), std::fs::metadata(&p).map(|m| m.len() as i64).unwrap_or(0), false));
        let dest = state.paths.trash.join(format!("{}_{}", now_ms(), file_name(&p)));
        let (s2, d2) = (src.clone(), dest.clone());
        tauri::async_runtime::spawn_blocking(move || move_file(&s2, &d2))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("{}: {e}", file_name(&p)))?;
        state.db.trash_add(&p, &dest.to_string_lossy(), kind, size, fav)?;
        n += 1;
    }
    let _ = app.emit("library-changed", ());
    Ok(n)
}

#[tauri::command]
fn list_trash(state: State<AppState>) -> R<Vec<TrashItem>> {
    state.db.trash_list()
}

#[tauri::command]
async fn restore_trash(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>) -> R<usize> {
    let mut n = 0;
    for id in ids {
        let Some((orig, tp, fav)) = state.db.trash_get(id)? else { continue };
        let mut target = PathBuf::from(&orig);
        if target.exists() {
            let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let ext = target.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
            target.set_file_name(format!("{stem} (restored){ext}"));
        }
        let (a, b) = (PathBuf::from(&tp), target.clone());
        tauri::async_runtime::spawn_blocking(move || move_file(&a, &b))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        state.db.trash_remove(id)?;
        let ts = target.to_string_lossy().into_owned();
        index::index_one(&state.db, &ts);
        if fav {
            state.db.set_favorite(&[ts], true)?;
        }
        n += 1;
    }
    let _ = app.emit("library-changed", ());
    Ok(n)
}

#[tauri::command]
fn delete_trash(state: State<AppState>, ids: Vec<i64>) -> R<usize> {
    let mut n = 0;
    for id in ids {
        if let Some((_, tp, _)) = state.db.trash_get(id)? {
            let _ = std::fs::remove_file(&tp);
            state.db.trash_remove(id)?;
            n += 1;
        }
    }
    Ok(n)
}

fn purge_old_trash(state: &AppState) {
    let days = state.settings.lock().unwrap().trash_days.max(1) as i64;
    if let Ok(ids) = state.db.trash_older_than(now_ms() - days * 86_400_000) {
        for id in ids {
            if let Ok(Some((_, tp, _))) = state.db.trash_get(id) {
                let _ = std::fs::remove_file(&tp);
                let _ = state.db.trash_remove(id);
            }
        }
    }
}

// ---------------------------------------------------------- file ops

#[tauri::command]
fn rename_file(app: AppHandle, state: State<AppState>, path: String, new_name: String) -> R<String> {
    let new_name = new_name.trim();
    if new_name.is_empty() || new_name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("That name isn't allowed".into());
    }
    let src = PathBuf::from(&path);
    let dest = src.with_file_name(new_name);
    if dest.exists() {
        return Err("A file with that name already exists".into());
    }
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    let d = dest.to_string_lossy().into_owned();
    state.db.rename_path(&path, &d, &parent_of(&d).unwrap_or_default(), new_name, &media::ext_of(&d))?;
    let _ = app.emit("library-changed", ());
    Ok(d)
}

#[tauri::command]
async fn rotate_file(path: String, quarters: i32) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let cur = media::read_exif(&path, false).orientation;
        wic::rotate_lossless(&path, cur, quarters).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal(path: String) -> R<()> {
    actions::reveal(&path)
}

#[tauri::command]
fn open_with(path: String) -> R<()> {
    actions::open_with(&path)
}

#[tauri::command]
fn open_external(target: String) -> R<()> {
    actions::shell_open(&target, "open")
}

#[tauri::command]
fn print_file(path: String) -> R<()> {
    actions::shell_open(&path, "print")
}

#[tauri::command]
async fn set_wallpaper(state: State<'_, AppState>, path: String) -> R<()> {
    let dir = state.paths.data.clone();
    tauri::async_runtime::spawn_blocking(move || actions::set_wallpaper(&path, &dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn copy_image(path: String) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        com_init();
        actions::copy_image(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn copy_files(paths: Vec<String>) -> R<()> {
    actions::copy_files(&paths)
}

#[tauri::command]
fn copy_text(text: String) -> R<()> {
    actions::copy_text(&text)
}

#[tauri::command]
fn create_shortcut(app: AppHandle, target: String, name: String, is_folder: bool) -> R<String> {
    let desktop = app.path().desktop_dir().map_err(|e| e.to_string())?;
    actions::create_shortcut(&target, &name, is_folder, &desktop)
}

#[tauri::command]
async fn share_files(window: tauri::WebviewWindow, paths: Vec<String>) -> R<()> {
    let title = if paths.len() == 1 { file_name(&paths[0]) } else { format!("{} items", paths.len()) };
    let p2 = paths.clone();
    let files = tauri::async_runtime::spawn_blocking(move || share::storage_files(&p2).map(SendBox))
        .await
        .map_err(|e| e.to_string())??;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let hwnd_raw = hwnd.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    // StorageFile is agile, so the objects can be handed to the UI thread.
    window
        .run_on_main_thread(move || {
            let files = files;
            let r = share::show(windows::Win32::Foundation::HWND(hwnd_raw as *mut _), files.0, title);
            let _ = tx.send(r);
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// Moves agile WinRT objects across threads (StorageFile, IIterable built from them).
pub struct SendBox<T>(pub T);
unsafe impl<T> Send for SendBox<T> {}
unsafe impl<T> Sync for SendBox<T> {}

#[tauri::command]
fn telegram_send(paths: Vec<String>) -> R<bool> {
    actions::telegram_send(&paths)
}

#[tauri::command]
fn bluetooth_send(paths: Vec<String>) -> R<()> {
    actions::bluetooth_send(&paths)
}

#[tauri::command]
fn email_files(paths: Vec<String>) -> R<bool> {
    actions::email_outlook(&paths)
}

#[tauri::command]
async fn lens_search(path: String) -> R<()> {
    actions::lens_search(path).await
}

#[tauri::command]
fn cache_info(state: State<AppState>) -> u64 {
    thumbs::cache_size(&state.paths.thumbs)
}

#[tauri::command]
fn clear_cache(state: State<AppState>) -> R<()> {
    let _ = std::fs::remove_dir_all(&state.paths.thumbs);
    std::fs::create_dir_all(&state.paths.thumbs).map_err(|e| e.to_string())
}

#[tauri::command]
fn image_size(path: String) -> Option<(u32, u32)> {
    imagesize::size(&path).ok().map(|s| (s.width as u32, s.height as u32))
}


// ------------------------------------------------- metadata, albums, map

#[tauri::command]
fn get_user_meta(state: State<AppState>, path: String) -> R<meta::UserMeta> {
    state.db.user_meta(&path)
}

#[tauri::command]
fn set_user_meta(
    app: AppHandle,
    state: State<AppState>,
    paths: Vec<String>,
    rating: Option<i64>,
    description: Option<String>,
    tags: Option<Vec<String>>,
    add_tags: Option<Vec<String>>,
) -> R<()> {
    for p in &paths {
        if state.db.media_by_path(p)?.is_none() {
            index::index_one(&state.db, p);
        }
    }
    state.db.set_user_meta(&paths, rating, description, tags, add_tags)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
fn all_tags(state: State<AppState>) -> R<Vec<(String, i64)>> {
    state.db.all_tags()
}

#[tauri::command]
async fn set_taken(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, ms: i64) -> R<usize> {
    let mut written = 0;
    for p in paths {
        let p2 = p.clone();
        let ok = tauri::async_runtime::spawn_blocking(move || meta::write_taken(&p2, ms)).await.unwrap_or(false);
        if ok {
            written += 1;
            index::index_one(&state.db, &p);
        }
        state.db.set_taken(&p, ms)?;
    }
    let _ = app.emit("library-changed", ());
    Ok(written)
}

#[tauri::command]
fn set_location(app: AppHandle, state: State<AppState>, paths: Vec<String>, lat: Option<f64>, lon: Option<f64>) -> R<()> {
    state.db.set_location(&paths, lat, lon)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
async fn located(state: State<'_, AppState>) -> R<Vec<meta::Located>> {
    state.db.located()
}

#[tauri::command]
fn list_albums(state: State<AppState>) -> R<Vec<meta::Album>> {
    state.db.albums()
}

#[tauri::command]
fn create_album(app: AppHandle, state: State<AppState>, name: String, smart: Option<String>, paths: Option<Vec<String>>) -> R<i64> {
    let id = state.db.create_album(name.trim(), smart)?;
    if let Some(p) = paths {
        state.db.album_add(id, &p, false)?;
    }
    let _ = app.emit("library-changed", ());
    Ok(id)
}

#[tauri::command]
fn update_album(app: AppHandle, state: State<AppState>, id: i64, name: Option<String>, cover: Option<Option<String>>) -> R<()> {
    state.db.update_album(id, name, cover)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
fn delete_album(app: AppHandle, state: State<AppState>, id: i64) -> R<()> {
    state.db.delete_album(id)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
fn album_items(app: AppHandle, state: State<AppState>, id: i64, paths: Vec<String>, remove: bool) -> R<()> {
    state.db.album_add(id, &paths, remove)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
fn on_this_day(state: State<AppState>) -> R<(i64, Option<String>)> {
    state.db.on_this_day_count()
}

#[tauri::command]
async fn storage_stats(state: State<'_, AppState>) -> R<meta::Stats> {
    state.db.stats()
}

#[tauri::command]
async fn old_screenshots(state: State<'_, AppState>) -> R<Vec<Item>> {
    state.db.old_screenshots()
}

// ----------------------------------------------------------------- OCR

#[tauri::command]
async fn ocr_lines(state: State<'_, AppState>, path: String) -> R<Vec<ocr::Line>> {
    use std::os::windows::fs::MetadataExt;
    let mtime = std::fs::metadata(&path)
        .map(|m| (m.last_write_time() as i64 / 10_000) - 11_644_473_600_000)
        .unwrap_or(0);
    if let Some((m, _, lines)) = state.db.ocr_get(&path)? {
        if m == mtime {
            return serde_json::from_str(&lines).map_err(|e| e.to_string());
        }
    }
    let p2 = path.clone();
    let (text, lines) = tauri::async_runtime::spawn_blocking(move || ocr::recognize(&p2))
        .await
        .map_err(|e| e.to_string())??;
    let json = serde_json::to_string(&lines).map_err(|e| e.to_string())?;
    if state.db.media_by_path(&path)?.is_some() {
        state.db.ocr_put(&path, mtime, text.trim(), &json)?;
    }
    Ok(lines)
}

#[tauri::command]
fn ocr_progress(state: State<AppState>) -> ocr::OcrProgress {
    state.ocr.progress()
}

#[tauri::command]
fn ocr_control(app: AppHandle, state: State<AppState>, run: bool) {
    if run {
        state.ocr.start(app, state.db.clone());
    } else {
        state.ocr.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

// ------------------------------------------------------------- private

#[tauri::command]
fn vault_status(state: State<AppState>) -> (bool, bool) {
    (vault::Vault::is_set_up(&state.db), state.vault.key.lock().unwrap().is_some())
}

#[tauri::command]
async fn vault_setup(state: State<'_, AppState>, pin: String) -> R<()> {
    state.vault.setup(&state.db, &pin)
}

#[tauri::command]
async fn vault_unlock(state: State<'_, AppState>, pin: String) -> R<()> {
    state.vault.unlock(&state.db, &pin)
}

#[tauri::command]
async fn vault_change_pin(state: State<'_, AppState>, old: String, new: String) -> R<()> {
    state.vault.change_pin(&state.db, &old, &new)
}

#[tauri::command]
fn vault_lock(state: State<AppState>) {
    state.vault.lock();
}

#[tauri::command]
async fn vault_list(state: State<'_, AppState>) -> R<Vec<vault::VaultItem>> {
    state.vault.list(&state.db)
}

#[tauri::command]
async fn vault_add(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> R<usize> {
    state.vault.key()?;
    let mut n = 0;
    for p in paths {
        // Drop any plain thumbnails of this file from the shared cache.
        for s in [320, 640, 1280, 4096] {
            if let Some(c) = thumbs::cache_path(&state.paths.thumbs, &p, s) {
                let _ = std::fs::remove_file(c);
            }
        }
        let app2 = app.clone();
        let p2 = p.clone();
        tauri::async_runtime::spawn_blocking(move || {
            com_init();
            let st = app2.state::<AppState>();
            st.vault.add(&st.db, &p2)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {e}", file_name(&p)))?;
        n += 1;
    }
    let _ = app.emit("library-changed", ());
    Ok(n)
}

#[tauri::command]
async fn vault_restore(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> R<usize> {
    let mut n = 0;
    for id in ids {
        state.vault.restore(&state.db, &id)?;
        n += 1;
    }
    let _ = app.emit("library-changed", ());
    Ok(n)
}

#[tauri::command]
fn vault_delete(state: State<AppState>, ids: Vec<String>) -> R<()> {
    state.vault.key()?;
    for id in ids {
        state.vault.remove(&state.db, &id)?;
    }
    Ok(())
}

// --------------------------------------------------------------- tools

#[tauri::command]
async fn motion_info(path: String) -> Option<(u64, u64)> {
    tauri::async_runtime::spawn_blocking(move || tools::motion_video(&path)).await.ok().flatten()
}

#[tauri::command]
async fn find_duplicates(app: AppHandle, state: State<'_, AppState>, similar: bool) -> R<Vec<tools::DupGroup>> {
    let db = state.db.clone();
    let dir = state.paths.thumbs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        com_init();
        tools::find_duplicates(&db, &dir, similar, |d, t| {
            let _ = app.emit("dup-progress", (d, t));
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_images(
    app: AppHandle,
    paths: Vec<String>,
    dest: String,
    format: String,
    max_dim: u32,
    quality: u8,
    keep_dates: bool,
) -> R<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        com_init();
        tools::export(&paths, &dest, &format, max_dim, quality, keep_dates, |i| {
            let _ = app.emit("export-progress", i);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_edited(app: AppHandle, state: State<'_, AppState>, path: String, data: String, mode: String, ext: String) -> R<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.split(',').next_back().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    let backups = state.paths.data.join("originals");
    let out = tools::save_edited(&path, &bytes, &mode, &ext, &backups)?;
    index::index_one(&state.db, &out);
    let _ = app.emit("library-changed", ());
    Ok(out)
}

// -------------------------------------------------------------- codecs

#[tauri::command]
fn codecs_installed(state: State<AppState>) -> bool {
    codecs::ffmpeg(&state.paths.data).is_some()
}

#[tauri::command]
async fn install_codecs(app: AppHandle, state: State<'_, AppState>) -> R<()> {
    codecs::install(app.clone(), state.paths.data.clone()).await
}

#[tauri::command]
async fn prepare_video(app: AppHandle, state: State<'_, AppState>, path: String) -> R<String> {
    let data = state.paths.data.clone();
    tauri::async_runtime::spawn_blocking(move || codecs::prepare(&app, &data, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn video_tracks(state: State<'_, AppState>, path: String) -> R<Vec<codecs::Track>> {
    let data = state.paths.data.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut t = codecs::sidecar_subs(&path);
        let ext = media::ext_of(&path);
        let native = matches!(ext.as_str(), "mkv" | "webm" | "mka" | "mk3d");
        if native {
            // Text subtitles inside MKV/WebM: read natively, no codec pack needed.
            for s in mkv::tracks(&path) {
                let mut label = if s.name.is_empty() { s.language.clone() } else { format!("{} · {}", s.name, s.language) };
                if s.forced {
                    label.push_str(" (forced)");
                }
                t.push(codecs::Track { kind: "embedded".into(), src: format!("mkv:{}", s.number), label });
            }
        }
        // FFmpeg adds audio tracks (and subtitles for other containers).
        t.extend(codecs::streams(&data, &path).into_iter().filter(|x| !(native && x.kind == "embedded")));
        t
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_subtitle(path: String) -> R<String> {
    let md = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if md.len() > 8 * 1024 * 1024 {
        return Err("Subtitle file is too large".into());
    }
    let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
    // UTF-8 (with or without BOM) or UTF-16 LE.
    if raw.starts_with(&[0xFF, 0xFE]) {
        let u: Vec<u16> = raw[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return Ok(String::from_utf16_lossy(&u));
    }
    Ok(String::from_utf8_lossy(raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&raw)).into_owned())
}

#[tauri::command]
async fn extract_subtitle(state: State<'_, AppState>, path: String, src: String) -> R<String> {
    let data = state.paths.data.clone();
    tauri::async_runtime::spawn_blocking(move || match src.strip_prefix("mkv:") {
        Some(n) => mkv::extract(&path, n.parse().map_err(|_| "bad track".to_string())?),
        None => codecs::extract_sub(&data, &path, src.parse().map_err(|_| "bad track".to_string())?),
    })
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn video_with_audio(app: AppHandle, state: State<'_, AppState>, path: String, audio: u32) -> R<String> {
    let data = state.paths.data.clone();
    tauri::async_runtime::spawn_blocking(move || codecs::with_audio(&app, &data, &path, audio))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn find_subtitles(path: String) -> Option<String> {
    // Sidecar .vtt/.srt with the same name → WebVTT text for <track>.
    let base = Path::new(&path);
    for ext in ["vtt", "srt"] {
        let cand = base.with_extension(ext);
        if let Ok(raw) = std::fs::read(&cand) {
            let text = String::from_utf8_lossy(&raw).replace("\r\n", "\n");
            if ext == "vtt" {
                return Some(text);
            }
            let mut out = String::from("WEBVTT\n\n");
            for line in text.lines() {
                if line.contains("-->") {
                    out.push_str(&line.replace(',', "."));
                } else {
                    out.push_str(line);
                }
                out.push('\n');
            }
            return Some(out);
        }
    }
    None
}

#[tauri::command]
fn save_frame(path: String, data: String) -> R<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.split(',').next_back().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    let src = Path::new(&path);
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = src.with_file_name(format!("{stem} frame.png"));
    let mut k = 2;
    while out.exists() {
        out = src.with_file_name(format!("{stem} frame {k}.png"));
        k += 1;
    }
    std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().into_owned())
}

#[tauri::command]
fn cloud_folders() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Ok(p) = std::env::var(var) {
            if Path::new(&p).is_dir() && !out.iter().any(|(_, x)| x.eq_ignore_ascii_case(&p)) {
                out.push(("OneDrive".to_string(), p));
            }
        }
    }
    // Google Drive for desktop mounts a drive letter with "My Drive".
    for letter in b'D'..=b'Z' {
        let p = format!("{}:\\My Drive", letter as char);
        if Path::new(&p).is_dir() {
            out.push(("Google Drive".to_string(), p));
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        let p = Path::new(&home).join("Google Drive");
        if p.is_dir() {
            out.push(("Google Drive".to_string(), p.to_string_lossy().into_owned()));
        }
    }
    out
}

#[tauri::command]
fn removable_drives() -> Vec<String> {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let root = format!("{}:\\", (b'A' + i as u8) as char);
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        // DRIVE_REMOVABLE = 2
        if unsafe { GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr())) } == 2 && Path::new(&root).join("DCIM").is_dir() {
            out.push(root);
        }
    }
    out
}

#[tauri::command]
async fn import_from(app: AppHandle, state: State<'_, AppState>, src: String) -> R<usize> {
    let dest_root = app.path().picture_dir().map_err(|e| e.to_string())?.join("Imports");
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> R<usize> {
        let mut n = 0;
        let cancel = cancel::token("import");
        for e in walkdir::WalkDir::new(&src).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()) {
            if cancel::is_cancelled(&cancel) {
                let _ = app.emit("library-changed", ());
                return Err(format!("{} — {n} imported", cancel::CANCELLED));
            }
            let p = e.path().to_string_lossy().into_owned();
            if media::kind_of(&p).is_none() {
                continue;
            }
            let md = e.metadata().map_err(|e| e.to_string())?;
            let ms = media::read_exif(&p, false).taken.unwrap_or_else(|| {
                use std::os::windows::fs::MetadataExt;
                (md.last_write_time() as i64 / 10_000) - 11_644_473_600_000
            });
            let day = unix_ms_to_local(ms).map(|s| s[..10].replace(':', "-")).unwrap_or_else(|| "Unknown".into());
            let dest = dest_root.join(&day).join(e.file_name());
            if dest.exists() && std::fs::metadata(&dest).map(|m| m.len()).ok() == Some(md.len()) {
                continue; // already imported
            }
            std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::copy(e.path(), &dest).map_err(|e| e.to_string())?;
            index::index_one(&db, &dest.to_string_lossy());
            n += 1;
            let _ = app.emit("import-progress", n);
        }
        let _ = app.emit("library-changed", ());
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn installed_editors() -> Vec<editors::Editor> {
    tauri::async_runtime::spawn_blocking(editors::detect).await.unwrap_or_default()
}

#[tauri::command]
fn open_in_editor(exe: String, paths: Vec<String>) -> R<()> {
    editors::open_in(&exe, &paths)
}

/// Cancels a running job: "scan", "dups", "export", "import", "codecs", "video" or "ocr".
#[tauri::command]
fn cancel_task(state: State<AppState>, name: String) {
    if name == "ocr" {
        state.ocr.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    } else {
        cancel::cancel(&name);
    }
}

// ---------------------------------------------------------------- run

/// Sizes the window to the image for "opened from Explorer" (macOS Preview behaviour).
fn fit_window_to_file(win: &tauri::WebviewWindow, file: &str) {
    let Some(monitor) = win.current_monitor().ok().flatten() else { return };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let (mw, mh) = (work.size.width as f64 / scale, work.size.height as f64 / scale);
    let (iw, ih) = match imagesize::size(file) {
        Ok(s) => {
            let o = media::read_exif(file, false).orientation;
            if (5..=8).contains(&o) { (s.height as f64, s.width as f64) } else { (s.width as f64, s.height as f64) }
        }
        Err(_) => (1280.0, 720.0),
    };
    let max_w = mw * 0.86;
    let max_h = mh * 0.86;
    // Never upscale past 100% device pixels.
    let s = (max_w / iw).min(max_h / ih).min(1.0 / scale);
    let (w, h) = ((iw * s).max(560.0), (ih * s).max(420.0));
    let _ = win.set_size(tauri::LogicalSize::new(w.round(), h.round()));
    let _ = win.center();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let st = parse_args(&argv);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = app.emit("open-request", st);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol("mv", protocol)
        .setup(|app| {
            let handle = app.handle().clone();
            let base = handle.path().app_local_data_dir()?;
            let paths = Paths { thumbs: base.join("thumbs"), trash: base.join("trash"), data: base.clone() };
            std::fs::create_dir_all(&paths.thumbs)?;
            std::fs::create_dir_all(&paths.trash)?;
            let db = Arc::new(Db::open(&base.join("library.db")).map_err(|e| e.to_string())?);

            let mut settings: Settings = db
                .kv_get("settings")
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            if settings.roots.is_empty() && db.kv_get("settings").is_none() {
                settings.roots = default_roots(&handle);
                let _ = db.kv_set("settings", &serde_json::to_string(&settings).unwrap_or_default());
            }
            let args: Vec<String> = std::env::args().collect();
            let startup = parse_args(&args);

            if let Some(win) = app.get_webview_window("main") {
                if let Some(f) = &startup.file {
                    fit_window_to_file(&win, f);
                } else {
                    let _ = win.maximize();
                }
            }

            let roots = settings.roots.clone();
            let state = AppState {
                db: db.clone(),
                paths,
                settings: Mutex::new(settings),
                startup: Mutex::new(startup.clone()),
                indexer: index::Indexer::new(),
                thumb_pool: thumbs::Pool::new(3, true),
                decode_pool: thumbs::Pool::new(2, true),
                vault: vault::Vault::new(base.join("vault")),
                ocr: ocr::Ocr::new(),
            };
            let trash_dir = state.paths.trash.clone();
            let thumbs_dir = state.paths.thumbs.clone();
            let indexer = state.indexer.clone();
            let ocr_job = state.ocr.clone();
            let ocr_on = state.settings.lock().unwrap().ocr;
            app.manage(state);
            purge_old_trash(&handle.state::<AppState>());

            // Failsafe: the window starts hidden (no white flash) and the UI shows it when ready.
            // If the UI ever fails to load, show it anyway so the app never looks like it didn't start.
            let h2 = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(w) = h2.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });

            // Opening a single file should be instant: index the library a little later.
            let delay = if startup.file.is_some() { 2500 } else { 300 };
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                indexer.start(handle.clone(), db.clone(), roots, trash_dir);
                // Read text from photos after the scan settles.
                if ocr_on {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    ocr_job.start(handle, db);
                }
                thumbs::trim_cache(&thumbs_dir, 1536 * 1024 * 1024);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_startup,
            get_settings,
            set_settings,
            rescan,
            index_progress,
            query_media,
            list_folders,
            album_overview,
            list_dir,
            get_info,
            set_favorite,
            set_folder_cover,
            set_folder_hidden,
            hidden_folders,
            trash_files,
            list_trash,
            restore_trash,
            delete_trash,
            rename_file,
            rotate_file,
            reveal,
            open_with,
            open_external,
            print_file,
            set_wallpaper,
            copy_image,
            copy_files,
            copy_text,
            create_shortcut,
            share_files,
            telegram_send,
            bluetooth_send,
            email_files,
            lens_search,
            cache_info,
            clear_cache,
            image_size,
            get_user_meta,
            set_user_meta,
            all_tags,
            set_taken,
            set_location,
            located,
            list_albums,
            create_album,
            update_album,
            delete_album,
            album_items,
            on_this_day,
            storage_stats,
            old_screenshots,
            ocr_lines,
            ocr_progress,
            ocr_control,
            vault_status,
            vault_setup,
            vault_unlock,
            vault_change_pin,
            vault_lock,
            vault_list,
            vault_add,
            vault_restore,
            vault_delete,
            motion_info,
            find_duplicates,
            export_images,
            save_edited,
            codecs_installed,
            install_codecs,
            prepare_video,
            find_subtitles,
            save_frame,
            cloud_folders,
            removable_drives,
            import_from,
            installed_editors,
            cancel_task,
            video_tracks,
            read_subtitle,
            extract_subtitle,
            video_with_audio,
            open_in_editor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MeowViewer");
}
