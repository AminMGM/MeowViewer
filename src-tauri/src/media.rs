//! File-type detection, EXIF/metadata reading and auto-album (source app) detection.

use crate::db::MediaRow;
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::os::windows::fs::MetadataExt;
use std::path::Path;

pub const KIND_IMAGE: u8 = 0;
pub const KIND_VIDEO: u8 = 1;
pub const KIND_GIF: u8 = 2;
pub const KIND_RAW: u8 = 3;

const IMAGE_EXT: &[&str] = &[
    "jpg", "jpeg", "jfif", "jpe", "png", "webp", "avif", "bmp", "dib", "ico", "tif", "tiff", "heic", "heif",
    "hif", "jxl", "svg", "jxr", "wdp", "hdp", "tga", "psd", "exr", "hdr", "qoi", "dds", "apng",
];
const RAW_EXT: &[&str] = &[
    "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2", "pef", "srw", "x3f",
    "raw", "rwl", "3fr", "erf", "kdc", "mrw", "iiq", "mos", "mef",
];
const VIDEO_EXT: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "asf", "flv", "f4v", "mpg", "mpeg", "m2ts", "mts", "ts",
    "3gp", "3g2", "ogv", "vob", "mxf", "divx", "rm", "rmvb", "m2v", "hevc",
];

// Windows cloud placeholder attributes: reading these would download the file.
const ATTR_OFFLINE: u32 = 0x1000;
const ATTR_RECALL_ON_OPEN: u32 = 0x4_0000;
const ATTR_RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
pub const ATTR_HIDDEN: u32 = 0x2;
pub const ATTR_SYSTEM: u32 = 0x4;

pub fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn kind_of_ext(ext: &str) -> Option<u8> {
    if ext == "gif" {
        Some(KIND_GIF)
    } else if IMAGE_EXT.contains(&ext) {
        Some(KIND_IMAGE)
    } else if RAW_EXT.contains(&ext) {
        Some(KIND_RAW)
    } else if VIDEO_EXT.contains(&ext) {
        Some(KIND_VIDEO)
    } else {
        None
    }
}

pub fn kind_of(path: &str) -> Option<u8> {
    kind_of_ext(&ext_of(path))
}

pub fn is_placeholder(attrs: u32) -> bool {
    attrs & (ATTR_OFFLINE | ATTR_RECALL_ON_OPEN | ATTR_RECALL_ON_DATA_ACCESS) != 0
}

pub fn mime_of(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "jfif" | "jpe" => "image/jpeg",
        "png" | "apng" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" | "dib" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "3gp" => "video/3gpp",
        "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
}

fn filetime_to_ms(ft: u64) -> i64 {
    // FILETIME: 100ns ticks since 1601-01-01.
    (ft as i64 / 10_000) - 11_644_473_600_000
}

// ------------------------------------------------------------------ EXIF

#[derive(Default)]
pub struct Exif {
    pub taken: Option<i64>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub orientation: u16,
    pub fields: Vec<(String, String)>,
}

const EXIF_EXT: &[&str] = &[
    "jpg", "jpeg", "jfif", "jpe", "tif", "tiff", "heic", "heif", "hif", "png", "webp", "avif", "dng", "nef", "nrw",
    "arw", "srf", "sr2", "cr2", "pef", "orf", "rw2", "raf", "srw", "3fr", "erf", "iiq", "mos", "mef", "kdc",
];

fn ascii(f: &exif::Field) -> Option<String> {
    if let exif::Value::Ascii(v) = &f.value {
        let s = v.iter().map(|b| String::from_utf8_lossy(b).into_owned()).collect::<Vec<_>>().join(" ");
        let s = s.trim().trim_matches('\0').trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    } else {
        None
    }
}

fn gps_coord(e: &exif::Exif, tag: exif::Tag, rtag: exif::Tag) -> Option<f64> {
    let f = e.get_field(tag, exif::In::PRIMARY)?;
    let exif::Value::Rational(v) = &f.value else { return None };
    if v.len() < 3 {
        return None;
    }
    let mut d = v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0;
    if !d.is_finite() {
        return None;
    }
    if let Some(r) = e.get_field(rtag, exif::In::PRIMARY).and_then(ascii) {
        if r.starts_with('S') || r.starts_with('W') {
            d = -d;
        }
    }
    Some(d)
}

/// Parses "YYYY:MM:DD HH:MM:SS" (local wall clock) into Unix ms.
fn parse_exif_date(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |a: usize, l: usize| s.get(a..a + l)?.parse::<u16>().ok();
    let (y, mo, d, h, mi, se) = (n(0, 4)?, n(5, 2)?, n(8, 2)?, n(11, 2)?, n(14, 2)?, n(17, 2)?);
    if y < 1900 || mo == 0 || mo > 12 || d == 0 || d > 31 {
        return None;
    }
    crate::local_to_unix_ms(y, mo, d, h, mi, se)
}

pub fn read_exif(path: &str, full: bool) -> Exif {
    let mut out = Exif { orientation: 1, ..Default::default() };
    let ext = ext_of(path);
    if !EXIF_EXT.contains(&ext.as_str()) {
        return out;
    }
    let Ok(file) = File::open(path) else { return out };
    let Ok(e) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else { return out };
    use exif::{In, Tag};
    let get = |t: Tag| e.get_field(t, In::PRIMARY);
    out.taken = get(Tag::DateTimeOriginal)
        .or_else(|| get(Tag::DateTimeDigitized))
        .or_else(|| get(Tag::DateTime))
        .and_then(ascii)
        .and_then(|s| parse_exif_date(&s));
    out.lat = gps_coord(&e, Tag::GPSLatitude, Tag::GPSLatitudeRef);
    out.lon = gps_coord(&e, Tag::GPSLongitude, Tag::GPSLongitudeRef);
    if out.lat == Some(0.0) && out.lon == Some(0.0) {
        out.lat = None;
        out.lon = None;
    }
    out.make = get(Tag::Make).and_then(ascii);
    out.model = get(Tag::Model).and_then(ascii);
    out.orientation = get(Tag::Orientation).and_then(|f| f.value.get_uint(0)).unwrap_or(1) as u16;
    if full {
        for (label, tag) in [
            ("Lens", Tag::LensModel),
            ("Aperture", Tag::FNumber),
            ("Shutter", Tag::ExposureTime),
            ("ISO", Tag::PhotographicSensitivity),
            ("Focal length", Tag::FocalLength),
            ("35mm focal", Tag::FocalLengthIn35mmFilm),
            ("Exposure bias", Tag::ExposureBiasValue),
            ("Flash", Tag::Flash),
            ("White balance", Tag::WhiteBalance),
            ("Metering", Tag::MeteringMode),
            ("Software", Tag::Software),
            ("Artist", Tag::Artist),
            ("Copyright", Tag::Copyright),
            ("Description", Tag::ImageDescription),
            ("Altitude", Tag::GPSAltitude),
        ] {
            if let Some(f) = get(tag) {
                let num = || match &f.value {
                    exif::Value::Rational(r) if !r.is_empty() => Some(r[0].to_f64()),
                    exif::Value::SRational(r) if !r.is_empty() => Some(r[0].to_f64()),
                    v => v.get_uint(0).map(f64::from),
                };
                let short = |x: f64, d: usize| {
                    let s = format!("{x:.d$}");
                    if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s }
                };
                let pretty = match tag {
                    Tag::FNumber => num().map(|x| format!("f/{}", short(x, 1))),
                    Tag::ExposureTime => num().filter(|x| *x > 0.0).map(|x| {
                        if x < 0.5 { format!("1/{} s", (1.0 / x).round()) } else { format!("{} s", short(x, 1)) }
                    }),
                    Tag::FocalLength => num().map(|x| format!("{} mm", short(x, 1))),
                    Tag::PhotographicSensitivity => num().map(|x| format!("ISO {x}")),
                    Tag::GPSAltitude => num().map(|x| format!("{} m", short(x, 0))),
                    Tag::Flash => f.value.get_uint(0).map(|x| if x & 1 == 1 { "Fired".into() } else { "Off".into() }),
                    _ => None,
                };
                let v = pretty.unwrap_or_else(|| f.display_value().with_unit(&e).to_string());
                let v = v.trim().trim_matches('"').trim().to_string();
                if !v.is_empty() && v != "unknown" {
                    out.fields.push((label.to_string(), v));
                }
            }
        }
    }
    out
}

pub fn camera_name(make: &Option<String>, model: &Option<String>) -> Option<String> {
    match (make, model) {
        (Some(mk), Some(md)) => {
            let first = mk.split_whitespace().next().unwrap_or("").to_lowercase();
            if md.to_lowercase().starts_with(&first) { Some(md.clone()) } else { Some(format!("{mk} {md}")) }
        }
        (None, Some(md)) => Some(md.clone()),
        (Some(mk), None) => Some(mk.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------- auto albums

pub fn detect_source(path: &str, name: &str, has_camera: bool) -> Option<String> {
    let p = path.to_lowercase();
    let n = name.to_lowercase();
    let has = |s: &str| p.contains(s);
    let src = if has("\\screenshots\\") || n.starts_with("screenshot") || n.starts_with("screen shot") || n.starts_with("snip") {
        "screenshots"
    } else if has("\\screen recordings\\") || has("\\captures\\") || n.starts_with("screen recording") || n.starts_with("screenrecord") {
        "recordings"
    } else if has("whatsapp") || n.contains("-wa0") {
        "whatsapp"
    } else if has("telegram") {
        "telegram"
    } else if has("instagram") {
        "instagram"
    } else if has("snapchat") {
        "snapchat"
    } else if has("discord") {
        "discord"
    } else if has("\\wallpaper") {
        "wallpapers"
    } else if n.contains("_edited") || n.contains("-edited") || has("\\edited\\") {
        "edited"
    } else if has("\\dcim\\") || has("\\camera roll\\") || has("\\camera\\") || has_camera {
        "camera"
    } else if has("\\downloads\\") {
        "downloads"
    } else {
        return None;
    };
    Some(src.to_string())
}

// ------------------------------------------------------------ build row

pub fn build_row(path: &str, md: &std::fs::Metadata) -> Option<MediaRow> {
    let ext = ext_of(path);
    let kind = kind_of_ext(&ext)?;
    let p = Path::new(path);
    let name = p.file_name()?.to_string_lossy().into_owned();
    let folder = p.parent()?.to_string_lossy().into_owned();
    let mtime = filetime_to_ms(md.last_write_time());
    // Creation time = when the file arrived on this PC (copied, downloaded, saved).
    let ctime = filetime_to_ms(md.creation_time());
    let attrs = md.file_attributes();
    let mut row = MediaRow {
        path: path.to_string(),
        folder,
        name: name.clone(),
        ext: ext.clone(),
        kind,
        size: md.file_size() as i64,
        mtime,
        ctime,
        taken: None,
        width: None,
        height: None,
        lat: None,
        lon: None,
        camera: None,
        source: None,
    };
    let mut has_camera = false;
    if !is_placeholder(attrs) && kind != KIND_VIDEO {
        let ex = read_exif(path, false);
        row.taken = ex.taken;
        row.lat = ex.lat;
        row.lon = ex.lon;
        row.camera = camera_name(&ex.make, &ex.model);
        has_camera = row.camera.is_some();
        if kind != KIND_RAW {
            if let Ok(sz) = imagesize::size(path) {
                let (w, h) = (sz.width as u32, sz.height as u32);
                if (5..=8).contains(&ex.orientation) {
                    row.width = Some(h);
                    row.height = Some(w);
                } else {
                    row.width = Some(w);
                    row.height = Some(h);
                }
            }
        }
    }
    row.source = detect_source(path, &name, has_camera);
    Some(row)
}

// --------------------------------------------------------------- info

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub ext: String,
    pub kind: u8,
    pub size: i64,
    pub mtime: i64,
    pub ctime: i64,
    pub taken: Option<i64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub camera: Option<String>,
    pub source: Option<String>,
    pub favorite: bool,
    pub cloud: bool,
    pub orientation: u16,
    pub fields: Vec<(String, String)>,
}

pub fn info(path: &str, favorite: bool) -> Result<Info, String> {
    let md = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let row = build_row(path, &md).ok_or("Not a media file")?;
    let attrs = md.file_attributes();
    let ex = if is_placeholder(attrs) { Exif { orientation: 1, ..Default::default() } } else { read_exif(path, true) };
    let (mut width, mut height) = (row.width, row.height);
    if width.is_none() && row.kind == KIND_RAW {
        if let Ok(sz) = imagesize::size(path) {
            width = Some(sz.width as u32);
            height = Some(sz.height as u32);
        }
    }
    if width.is_none() {
        if let Some((w, h)) = crate::shellprops::dimensions(path) {
            width = Some(w);
            height = Some(h);
        }
    }
    let mut fields = ex.fields;
    if row.kind == KIND_VIDEO {
        fields.extend(crate::shellprops::video_fields(path));
    }
    Ok(Info {
        path: row.path,
        name: row.name,
        folder: row.folder,
        ext: row.ext,
        kind: row.kind,
        size: row.size,
        mtime: row.mtime,
        ctime: row.ctime,
        taken: row.taken,
        width,
        height,
        lat: row.lat,
        lon: row.lon,
        camera: row.camera,
        source: row.source,
        favorite,
        cloud: is_placeholder(attrs),
        orientation: ex.orientation,
        fields,
    })
}
