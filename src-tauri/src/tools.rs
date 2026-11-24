//! Motion photos, duplicate / similar finder, batch export, saving edited images.

use crate::db::Db;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;

// ------------------------------------------------------------ motion

/// Samsung / Google / Pixel "motion photos" append an MP4 after the JPEG (or HEIC) data.
/// Returns (offset, length) of the embedded video by walking top-level MP4 boxes.
pub fn motion_video(path: &str) -> Option<(u64, u64)> {
    let ext = crate::media::ext_of(path);
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "heic" | "heif") {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    let n = data.len();
    // Search the second half first (fast path), then everything after the first 1 KB.
    let find = |from: usize| -> Option<usize> {
        let mut i = from;
        while i + 12 <= n {
            if &data[i + 4..i + 8] == b"ftyp" {
                let brand = &data[i + 8..i + 12];
                if [b"mp42", b"isom", b"mp41", b"qt  ", b"avc1", b"heic"].iter().any(|b| brand == *b) && brand != b"heic" {
                    return Some(i);
                }
            }
            i += 1;
        }
        None
    };
    let start = find(n / 3).or_else(|| find(1024))?;
    // Walk boxes to find where the MP4 ends (Samsung appends an SEF trailer after it).
    let mut p = start;
    let mut saw_moov = false;
    while p + 8 <= n {
        let size = u32::from_be_bytes(data[p..p + 4].try_into().ok()?) as u64;
        let kind = &data[p + 4..p + 8];
        if !kind.iter().all(|c| c.is_ascii_alphanumeric() || *c == b' ') {
            break;
        }
        let size = if size == 1 && p + 16 <= n {
            u64::from_be_bytes(data[p + 8..p + 16].try_into().ok()?)
        } else if size == 0 {
            (n - p) as u64
        } else {
            size
        };
        if size < 8 || p as u64 + size > n as u64 {
            break;
        }
        if kind == b"moov" {
            saw_moov = true;
        }
        p += size as usize;
    }
    (saw_moov && p > start + 1024).then_some((start as u64, (p - start) as u64))
}

// -------------------------------------------------------- duplicates

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub kind: String,
    pub paths: Vec<String>,
    pub size: i64,
}

fn quick_hash(path: &str, size: u64) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let mut f = std::fs::File::open(path).ok()?;
    let mut h = std::hash::DefaultHasher::new();
    size.hash(&mut h);
    if size <= 4 * 1024 * 1024 {
        let mut b = Vec::with_capacity(size as usize);
        f.read_to_end(&mut b).ok()?;
        b.hash(&mut h);
    } else {
        use std::io::{Seek, SeekFrom};
        let mut b = vec![0u8; 256 * 1024];
        for pos in [0, size / 2, size - 256 * 1024] {
            f.seek(SeekFrom::Start(pos)).ok()?;
            f.read_exact(&mut b).ok()?;
            b.hash(&mut h);
        }
    }
    Some(h.finish())
}

/// 64-bit difference hash from a 9×8 grayscale downscale of the (cached) thumbnail.
fn dhash(thumb_dir: &std::path::Path, path: &str) -> Option<u64> {
    let jpg = crate::thumbs::thumbnail(thumb_dir, path, 320).ok()?;
    let img = image::load_from_memory_with_format(&jpg, image::ImageFormat::Jpeg).ok()?;
    let small = image::imageops::resize(&img.to_luma8(), 9, 8, image::imageops::FilterType::Triangle);
    let mut h = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            h <<= 1;
            if small.get_pixel(x, y)[0] > small.get_pixel(x + 1, y)[0] {
                h |= 1;
            }
        }
    }
    Some(h)
}

pub fn find_duplicates(db: &Db, thumb_dir: &std::path::Path, similar: bool, progress: impl Fn(u64, u64)) -> Result<Vec<DupGroup>, String> {
    let cancel = crate::cancel::token("dups");
    let rows: Vec<(String, i64, i64, u8)> = db.read(|c| {
        let mut st = c.prepare("SELECT path, size, mtime, kind FROM media ORDER BY date DESC")?;
        let r = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        r.collect()
    })?;
    let mut groups = Vec::new();

    // Exact: same size, then same content hash.
    let mut by_size: HashMap<i64, Vec<&(String, i64, i64, u8)>> = HashMap::new();
    for r in &rows {
        by_size.entry(r.1).or_default().push(r);
    }
    let mut exact_seen = std::collections::HashSet::new();
    for (size, list) in by_size.iter().filter(|(_, l)| l.len() > 1) {
        if crate::cancel::is_cancelled(&cancel) {
            return Err(crate::cancel::CANCELLED.into());
        }
        let mut by_hash: HashMap<u64, Vec<String>> = HashMap::new();
        for r in list {
            if let Some(h) = quick_hash(&r.0, *size as u64) {
                by_hash.entry(h).or_default().push(r.0.clone());
            }
        }
        for (_, paths) in by_hash.into_iter().filter(|(_, p)| p.len() > 1) {
            exact_seen.extend(paths.iter().cloned());
            groups.push(DupGroup { kind: "exact".into(), paths, size: *size });
        }
    }

    if similar {
        let imgs: Vec<&(String, i64, i64, u8)> = rows.iter().filter(|r| r.3 != 1 && !exact_seen.contains(&r.0)).collect();
        let total = imgs.len() as u64;
        let cached: HashMap<String, (i64, u64)> = db.read(|c| {
            let mut st = c.prepare("SELECT path, mtime, dhash FROM hashes")?;
            let r = st.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get::<_, i64>(2)? as u64))))?;
            r.collect()
        })?;
        let mut hashes: Vec<(u64, &str, i64)> = Vec::with_capacity(imgs.len());
        let mut new_rows = Vec::new();
        for (i, r) in imgs.iter().enumerate() {
            if crate::cancel::is_cancelled(&cancel) {
                save_hashes(db, &mut new_rows);
                return Err(crate::cancel::CANCELLED.into());
            }
            let h = match cached.get(&r.0) {
                Some((m, h)) if *m == r.2 => Some(*h),
                _ => {
                    let h = dhash(thumb_dir, &r.0);
                    if let Some(h) = h {
                        new_rows.push((r.0.clone(), r.2, h));
                    }
                    h
                }
            };
            if let Some(h) = h {
                hashes.push((h, &r.0, r.1));
            }
            if i % 50 == 0 {
                progress(i as u64, total);
            }
            if new_rows.len() >= 200 {
                save_hashes(db, &mut new_rows);
            }
        }
        save_hashes(db, &mut new_rows);
        // Group by Hamming distance ≤ 5 (bucket on the top 16 bits to keep it fast,
        // plus a full pass inside each bucket).
        let mut used = vec![false; hashes.len()];
        let mut buckets: HashMap<u16, Vec<usize>> = HashMap::new();
        for (i, h) in hashes.iter().enumerate() {
            buckets.entry((h.0 >> 48) as u16).or_default().push(i);
        }
        for idxs in buckets.values() {
            for (a_i, &a) in idxs.iter().enumerate() {
                if used[a] {
                    continue;
                }
                let mut g = vec![a];
                for &b in &idxs[a_i + 1..] {
                    if !used[b] && (hashes[a].0 ^ hashes[b].0).count_ones() <= 5 {
                        g.push(b);
                    }
                }
                if g.len() > 1 {
                    for &i in &g {
                        used[i] = true;
                    }
                    let size = g.iter().map(|&i| hashes[i].2).sum();
                    groups.push(DupGroup { kind: "similar".into(), paths: g.iter().map(|&i| hashes[i].1.to_string()).collect(), size });
                }
            }
        }
        progress(total, total);
    }
    groups.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(groups)
}

fn save_hashes(db: &Db, rows: &mut Vec<(String, i64, u64)>) {
    let _ = db.write(|c| {
        let tx = c.transaction()?;
        for (p, m, h) in rows.iter() {
            tx.execute(
                "INSERT INTO hashes(path, mtime, dhash) VALUES(?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, dhash = excluded.dhash",
                params![p, m, *h as i64],
            )?;
        }
        tx.commit()
    });
    rows.clear();
}

// ------------------------------------------------------------ export

pub const EXPORT_FORMATS: &[&str] = &["jpg", "png", "webp", "tiff", "bmp", "gif"];

/// Converts/resizes images. `dest` empty = a "Converted" folder next to each original.
/// Returns the number written.
pub fn export(
    paths: &[String],
    dest: &str,
    format: &str,
    max_dim: u32,
    quality: u8,
    keep_dates: bool,
    progress: impl Fn(usize),
) -> Result<usize, String> {
    let format = if EXPORT_FORMATS.contains(&format) { format } else { "jpg" };
    let mut n = 0;
    let cancel = crate::cancel::token("export");
    for (i, p) in paths.iter().enumerate() {
        if crate::cancel::is_cancelled(&cancel) {
            return Err(format!("{} — {n} of {} exported", crate::cancel::CANCELLED, paths.len()));
        }
        progress(i);
        if crate::media::kind_of(p) == Some(crate::media::KIND_VIDEO) {
            continue;
        }
        let o = crate::media::read_exif(p, false).orientation;
        let Ok((rgba, w, h)) = crate::wic::decode_rgba(p, if max_dim == 0 { 16384 } else { max_dim }, o) else { continue };
        let dir = if dest.is_empty() {
            std::path::Path::new(p).parent().map(|d| d.join("Converted")).unwrap_or_default()
        } else {
            std::path::PathBuf::from(dest)
        };
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stem = std::path::Path::new(p).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let mut out = dir.join(format!("{stem}.{format}"));
        let mut k = 1;
        while out.exists() {
            out = dir.join(format!("{stem} ({k}).{format}"));
            k += 1;
        }
        let bytes = encode(&rgba, w, h, format, quality)?;
        std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
        if keep_dates {
            copy_mtime(p, &out);
        }
        n += 1;
    }
    progress(paths.len());
    Ok(n)
}

pub fn encode(rgba: &[u8], w: u32, h: u32, format: &str, quality: u8) -> Result<Vec<u8>, String> {
    use image::ImageEncoder;
    let mut out = Vec::new();
    let rgb = || -> Vec<u8> { rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect() };
    let e = |e: image::ImageError| e.to_string();
    match format {
        "png" => image::codecs::png::PngEncoder::new(&mut out).write_image(rgba, w, h, image::ExtendedColorType::Rgba8).map_err(e)?,
        "webp" => image::codecs::webp::WebPEncoder::new_lossless(&mut out)
            .write_image(rgba, w, h, image::ExtendedColorType::Rgba8)
            .map_err(e)?,
        "tiff" => image::codecs::tiff::TiffEncoder::new(std::io::Cursor::new(&mut out))
            .write_image(rgba, w, h, image::ExtendedColorType::Rgba8)
            .map_err(e)?,
        "bmp" => image::codecs::bmp::BmpEncoder::new(&mut out).write_image(&rgb(), w, h, image::ExtendedColorType::Rgb8).map_err(e)?,
        "gif" => {
            let frame = image::Frame::new(image::RgbaImage::from_raw(w, h, rgba.to_vec()).ok_or("bad image")?);
            image::codecs::gif::GifEncoder::new(&mut out).encode_frame(frame).map_err(e)?
        }
        _ => image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(30, 100))
            .encode(&rgb(), w, h, image::ExtendedColorType::Rgb8)
            .map_err(e)?,
    }
    Ok(out)
}

fn copy_mtime(from: &str, to: &std::path::Path) {
    if let Ok(m) = std::fs::metadata(from).and_then(|m| m.modified()) {
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(to) {
            let _ = f.set_modified(m);
        }
    }
}

/// The original JPEG's EXIF (APP1) segment with Orientation reset to 1 (pixels are already upright).
fn exif_segment(path: &str) -> Option<Vec<u8>> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 4 <= data.len() && data[i] == 0xFF {
        let marker = data[i + 1];
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        if marker == 0xE1 && data.get(i + 4..i + 10) == Some(b"Exif\0\0") {
            let mut seg = data[i..i + 2 + len].to_vec();
            reset_orientation(&mut seg[10..]);
            return Some(seg);
        }
        if marker == 0xDA {
            break;
        }
        i += 2 + len;
    }
    None
}

fn reset_orientation(tiff: &mut [u8]) {
    if tiff.len() < 8 {
        return;
    }
    let le = &tiff[0..2] == b"II";
    let rd16 = |b: &[u8], o: usize| if le { u16::from_le_bytes([b[o], b[o + 1]]) } else { u16::from_be_bytes([b[o], b[o + 1]]) };
    let rd32 = |b: &[u8], o: usize| {
        if le { u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) } else { u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) }
    };
    let ifd = rd32(tiff, 4) as usize;
    if ifd + 2 > tiff.len() {
        return;
    }
    let n = rd16(tiff, ifd) as usize;
    for k in 0..n {
        let e = ifd + 2 + k * 12;
        if e + 12 > tiff.len() {
            return;
        }
        if rd16(tiff, e) == 0x0112 {
            let v = if le { 1u16.to_le_bytes() } else { 1u16.to_be_bytes() };
            tiff[e + 8] = v[0];
            tiff[e + 9] = v[1];
        }
    }
}

/// Inserts an APP1 segment right after SOI of a JPEG.
fn with_exif(jpeg: &[u8], seg: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(jpeg.len() + seg.len());
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(seg);
    out.extend_from_slice(&jpeg[2..]);
    out
}

/// Saves editor output. `mode`: "copy" writes "<name> (edited).ext" next to the original;
/// "overwrite" keeps a backup of the original in the app's data folder first.
/// JPEG output keeps the original EXIF (camera, date, GPS); every output keeps the original's date.
pub fn save_edited(path: &str, bytes: &[u8], mode: &str, out_ext: &str, backup_dir: &std::path::Path) -> Result<String, String> {
    let src = std::path::Path::new(path);
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = crate::media::ext_of(path);
    let same = ext == out_ext || (out_ext == "jpg" && matches!(ext.as_str(), "jpeg" | "jfif" | "jpe"));
    let target = if mode == "overwrite" && same {
        std::fs::create_dir_all(backup_dir).map_err(|e| e.to_string())?;
        use std::os::windows::fs::MetadataExt;
        let md = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let b = backup_dir.join(format!("{}_{}", md.last_write_time(), crate::file_name(path)));
        std::fs::copy(path, &b).map_err(|e| e.to_string())?;
        src.to_path_buf()
    } else {
        let mut t = src.with_file_name(format!("{stem} (edited).{out_ext}"));
        let mut k = 2;
        while t.exists() {
            t = src.with_file_name(format!("{stem} (edited {k}).{out_ext}"));
            k += 1;
        }
        t
    };
    let data = if out_ext == "jpg" { exif_segment(path).map(|seg| with_exif(bytes, &seg)) } else { None };
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    std::fs::write(&target, data.as_deref().unwrap_or(bytes)).map_err(|e| e.to_string())?;
    if let Some(m) = mtime {
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&target) {
            let _ = f.set_modified(m);
        }
    }
    Ok(target.to_string_lossy().into_owned())
}
