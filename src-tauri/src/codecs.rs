//! Optional FFmpeg pack (downloaded on demand into the app's data folder, LGPL build) so every
//! video plays: compatible streams are remuxed to MP4 in seconds; anything else is converted
//! with the Windows Media Foundation H.264 encoder (hardware accelerated). Results are cached.

use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const URL: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip";

pub fn dir(data: &Path) -> PathBuf {
    data.join("ffmpeg")
}

pub fn ffmpeg(data: &Path) -> Option<PathBuf> {
    let p = dir(data).join("ffmpeg.exe");
    p.exists().then_some(p)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub pct: f64,
}

pub async fn install(app: AppHandle, data: PathBuf) -> Result<(), String> {
    let emit = |stage: &str, pct: f64| {
        let _ = app.emit("codecs-progress", Progress { stage: stage.into(), pct });
    };
    let client = reqwest::Client::builder()
        .user_agent("MeowViewer")
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client.get(URL).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Download failed: HTTP {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0) as f64;
    let d = dir(&data);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let zip = d.join("ffmpeg.zip");
    let mut f = std::fs::File::create(&zip).map_err(|e| e.to_string())?;
    let mut got = 0f64;
    let mut last = 0f64;
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        f.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as f64;
        if total > 0.0 && got / total - last > 0.01 {
            last = got / total;
            emit("download", last * 100.0);
        }
    }
    drop(f);
    emit("extract", 100.0);
    let d2 = d.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let tmp = d2.join("x");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let ok = Command::new("tar")
            .arg("-xf")
            .arg(d2.join("ffmpeg.zip"))
            .arg("-C")
            .arg(&tmp)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?
            .success();
        if !ok {
            return Err("Couldn't extract FFmpeg".into());
        }
        for e in walkdir::WalkDir::new(&tmp).into_iter().filter_map(|e| e.ok()) {
            let n = e.file_name().to_string_lossy().to_lowercase();
            if n == "ffmpeg.exe" || n == "ffprobe.exe" {
                std::fs::copy(e.path(), d2.join(&n)).map_err(|e| e.to_string())?;
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_file(d2.join("ffmpeg.zip"));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    if ffmpeg(&data).is_none() {
        return Err("FFmpeg wasn't found in the download".into());
    }
    emit("done", 100.0);
    Ok(())
}

fn probe(data: &Path, path: &str) -> (Option<String>, Option<String>, f64) {
    let Some(_) = ffmpeg(data) else { return (None, None, 0.0) };
    let out = Command::new(dir(data).join("ffprobe.exe"))
        .args(["-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "default=nw=1"])
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(out) = out else { return (None, None, 0.0) };
    let text = String::from_utf8_lossy(&out.stdout);
    let (mut v, mut a, mut dur, mut cur_name) = (None, None, 0.0, None::<String>);
    for line in text.lines() {
        if let Some(n) = line.strip_prefix("codec_name=") {
            cur_name = Some(n.to_string());
        } else if let Some(t) = line.strip_prefix("codec_type=") {
            match t {
                "video" if v.is_none() => v = cur_name.take(),
                "audio" if a.is_none() => a = cur_name.take(),
                _ => {}
            }
        } else if let Some(d) = line.strip_prefix("duration=") {
            dur = d.parse().unwrap_or(0.0);
        }
    }
    (v, a, dur)
}

/// Returns a playable MP4 path for `path` (cached), converting if needed.
pub fn prepare(app: &AppHandle, data: &Path, path: &str) -> Result<String, String> {
    let ff = ffmpeg(data).ok_or("codecs-missing")?;
    let md = std::fs::metadata(path).map_err(|e| e.to_string())?;
    use std::hash::{Hash, Hasher};
    use std::os::windows::fs::MetadataExt;
    let mut h = std::hash::DefaultHasher::new();
    path.to_lowercase().hash(&mut h);
    md.last_write_time().hash(&mut h);
    let cache = data.join("video-cache");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let out = cache.join(format!("{:016x}.mp4", h.finish()));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let (v, a, dur) = probe(data, path);
    let v_ok = matches!(v.as_deref(), Some("h264" | "hevc" | "vp9" | "av1"));
    let a_ok = matches!(a.as_deref(), None | Some("aac" | "mp3" | "opus" | "flac"));
    let tmp = cache.join(format!("{:016x}.part.mp4", h.finish()));
    let mut cmd = Command::new(ff);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-i"]).arg(path);
    cmd.args(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"]);
    if v_ok {
        cmd.args(["-c:v", "copy"]);
        if v.as_deref() == Some("hevc") {
            cmd.args(["-tag:v", "hvc1"]);
        }
    } else {
        cmd.args(["-c:v", "h264_mf", "-b:v", "8M", "-pix_fmt", "nv12"]);
    }
    if a_ok {
        cmd.args(["-c:a", "copy"]);
    } else {
        cmd.args(["-c:a", "aac", "-b:a", "192k"]);
    }
    cmd.args(["-movflags", "+faststart"]).arg(&tmp);
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_us=") {
            if let (Ok(us), true) = (us.parse::<f64>(), dur > 0.0) {
                let _ = app.emit(
                    "video-progress",
                    (path.to_string(), (us / 1e6 / dur * 100.0).clamp(0.0, 100.0), if v_ok { "remux" } else { "convert" }),
                );
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            use std::io::Read;
            let _ = e.read_to_string(&mut err);
        }
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Conversion failed: {}", err.lines().last().unwrap_or("unknown error")));
    }
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    trim_cache(&cache, 4 * 1024 * 1024 * 1024);
    Ok(out.to_string_lossy().into_owned())
}

fn trim_cache(dir: &Path, max: u64) {
    crate::thumbs::trim_cache(dir, max);
}

// ------------------------------------------------------ tracks (VLC-like)

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// "file" (sidecar subtitle), "embedded" (subtitle stream) or "audio".
    pub kind: String,
    /// File path for sidecars; stream index (per type) for embedded tracks.
    pub src: String,
    pub label: String,
}

const SUB_EXT: &[&str] = &["srt", "vtt", "ass", "ssa", "sub"];

/// Sidecar subtitle files next to the video: "movie.srt", "movie.en.srt", "movie.English.vtt"…
pub fn sidecar_subs(path: &str) -> Vec<Track> {
    let p = Path::new(path);
    let (Some(dir), Some(stem)) = (p.parent(), p.file_stem().map(|s| s.to_string_lossy().to_lowercase())) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            let lower = name.to_lowercase();
            let ext = lower.rsplit('.').next().unwrap_or("");
            if SUB_EXT.contains(&ext) && lower.starts_with(&stem) {
                let extra = name[stem.len()..name.len() - ext.len() - 1].trim_matches(['.', '_', '-', ' ']);
                out.push(Track {
                    kind: "file".into(),
                    src: e.path().to_string_lossy().into_owned(),
                    label: if extra.is_empty() { format!("{} ({ext})", "Subtitles") } else { format!("{extra} ({ext})") },
                });
            }
        }
    }
    out
}

/// Embedded subtitle and audio streams (needs the codec pack's ffprobe).
pub fn streams(data: &Path, path: &str) -> Vec<Track> {
    let Some(_) = ffmpeg(data) else { return Vec::new() };
    let out = Command::new(dir(data).join("ffprobe.exe"))
        .args([
            "-v", "error", "-show_entries",
            "stream=codec_type,codec_name,channels:stream_tags=language,title", "-of", "csv=p=0:nk=0",
        ])
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(out) = out else { return Vec::new() };
    let mut tracks = Vec::new();
    let (mut a, mut s) = (0, 0);
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        // key=value pairs, comma separated
        let kv: std::collections::HashMap<&str, &str> =
            line.split(',').filter_map(|p| p.split_once('=')).collect();
        let lang = kv.get("tag:language").copied().unwrap_or("");
        let title = kv.get("tag:title").copied().unwrap_or("");
        let codec = kv.get("codec_name").copied().unwrap_or("");
        let name = [title, lang].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(" · ");
        match kv.get("codec_type").copied() {
            Some("audio") => {
                let ch = kv.get("channels").copied().unwrap_or("");
                tracks.push(Track {
                    kind: "audio".into(),
                    src: a.to_string(),
                    label: format!("{} ({codec}{})", if name.is_empty() { format!("Track {}", a + 1) } else { name }, if ch.is_empty() { String::new() } else { format!(", {ch} ch") }),
                });
                a += 1;
            }
            Some("subtitle") => {
                // Bitmap subtitles (PGS/DVD) can't become text.
                if !matches!(codec, "hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle") {
                    tracks.push(Track {
                        kind: "embedded".into(),
                        src: s.to_string(),
                        label: if name.is_empty() { format!("Embedded {}", s + 1) } else { name },
                    });
                }
                s += 1;
            }
            _ => {}
        }
    }
    tracks
}

/// Extracts embedded subtitle stream `index` as WebVTT text.
pub fn extract_sub(data: &Path, path: &str, index: u32) -> Result<String, String> {
    let ff = ffmpeg(data).ok_or("codecs-missing")?;
    let out = Command::new(ff)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-map", &format!("0:s:{index}"), "-f", "webvtt", "-"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("extract failed").to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Remuxes with a chosen audio track (cached per track).
pub fn with_audio(app: &AppHandle, data: &Path, path: &str, audio: u32) -> Result<String, String> {
    let ff = ffmpeg(data).ok_or("codecs-missing")?;
    use std::hash::{Hash, Hasher};
    let mut h = std::hash::DefaultHasher::new();
    path.to_lowercase().hash(&mut h);
    audio.hash(&mut h);
    let cache = data.join("video-cache");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let out = cache.join(format!("{:016x}-a{audio}.mp4", h.finish()));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let (v, _, _) = probe(data, path);
    let v_ok = matches!(v.as_deref(), Some("h264" | "hevc" | "vp9" | "av1"));
    let tmp = out.with_extension("part.mp4");
    let mut cmd = Command::new(ff);
    cmd.args(["-y", "-v", "error", "-i"]).arg(path).args(["-map", "0:v:0", "-map", &format!("0:a:{audio}")]);
    if v_ok {
        cmd.args(["-c:v", "copy"]);
    } else {
        cmd.args(["-c:v", "h264_mf", "-b:v", "8M"]);
    }
    cmd.args(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]).arg(&tmp);
    let _ = app.emit("video-progress", (path.to_string(), 50.0, "audio"));
    let st = cmd.creation_flags(CREATE_NO_WINDOW).status().map_err(|e| e.to_string())?;
    if !st.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err("Couldn't switch audio track".into());
    }
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().into_owned())
}
