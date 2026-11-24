//! Thumbnails via the Windows shell (IShellItemImageFactory): one API for every format Windows
//! knows (JPEG, HEIC, RAW, video, PSD with codecs…) and it never downloads OneDrive placeholders.
//! Results are cached on disk as small JPEGs. Workers pop newest-first (LIFO) so the tiles the
//! user is looking at right now win over ones scrolled past.

use std::collections::VecDeque;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

use windows::core::HSTRING;
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_RESIZETOFIT};

// ------------------------------------------------------------------ pool

type Job = Box<dyn FnOnce() + Send + 'static>;

#[derive(Clone)]
pub struct Pool {
    q: Arc<(Mutex<VecDeque<Job>>, Condvar)>,
}

impl Pool {
    /// `lifo`: newest job first. Workers initialise COM (STA) once.
    pub fn new(threads: usize, lifo: bool) -> Self {
        let q: Arc<(Mutex<VecDeque<Job>>, Condvar)> = Arc::new((Mutex::new(VecDeque::new()), Condvar::new()));
        for _ in 0..threads {
            let q = q.clone();
            std::thread::Builder::new()
                .stack_size(4 * 1024 * 1024)
                .spawn(move || {
                    crate::com_init();
                    loop {
                        let job = {
                            let (lock, cv) = &*q;
                            let mut g = lock.lock().unwrap();
                            loop {
                                let j = if lifo { g.pop_back() } else { g.pop_front() };
                                if let Some(j) = j {
                                    break j;
                                }
                                g = cv.wait(g).unwrap();
                            }
                        };
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                    }
                })
                .expect("spawn worker");
        }
        Self { q }
    }

    pub fn spawn(&self, f: impl FnOnce() + Send + 'static) {
        let (lock, cv) = &*self.q;
        let mut g = lock.lock().unwrap();
        // A huge backlog means the user flew past thousands of tiles; drop the oldest.
        while g.len() > 600 {
            g.pop_front();
        }
        g.push_back(Box::new(f));
        cv.notify_one();
    }
}

// -------------------------------------------------------------- shell

/// Returns top-down BGRA pixels with straight (non-premultiplied) alpha.
pub fn shell_image(path: &str, size: i32) -> Result<(Vec<u8>, u32, u32), String> {
    unsafe {
        let f: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(path), None).map_err(|e| e.message())?;
        let hbmp = f
            .GetImage(SIZE { cx: size, cy: size }, SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK)
            .map_err(|e| e.message())?;
        let obj = HGDIOBJ(hbmp.0);
        let mut bm = BITMAP::default();
        GetObjectW(obj, size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
        let (w, h) = (bm.bmWidth.max(1) as u32, bm.bmHeight.unsigned_abs().max(1));
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let hdc = GetDC(None);
        let lines = GetDIBits(hdc, hbmp, 0, h, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        ReleaseDC(None, hdc);
        let _ = DeleteObject(obj);
        if lines == 0 {
            return Err("GetDIBits failed".into());
        }
        // Shell bitmaps either have no alpha (all 0) or premultiplied alpha.
        let has_alpha = buf.chunks_exact(4).any(|p| p[3] != 0);
        for p in buf.chunks_exact_mut(4) {
            if !has_alpha {
                p[3] = 255;
            } else if p[3] != 0 && p[3] != 255 {
                let a = p[3] as u32;
                for c in &mut p[..3] {
                    *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        Ok((buf, w, h))
    }
}

/// BGRA → JPEG, compositing transparency over the app's dark tile colour.
pub fn bgra_to_jpeg(bgra: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>, String> {
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for p in bgra.chunks_exact(4) {
        let a = p[3] as u32;
        let bg = 24u32;
        rgb.push(((p[2] as u32 * a + bg * (255 - a)) / 255) as u8);
        rgb.push(((p[1] as u32 * a + bg * (255 - a)) / 255) as u8);
        rgb.push(((p[0] as u32 * a + bg * (255 - a)) / 255) as u8);
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
        .encode(&rgb, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

// -------------------------------------------------------------- cache

pub fn cache_path(dir: &Path, path: &str, size: i32) -> Option<PathBuf> {
    let md = std::fs::metadata(path).ok()?;
    let mut h = DefaultHasher::new();
    path.to_lowercase().hash(&mut h);
    md.last_write_time().hash(&mut h);
    md.file_size().hash(&mut h);
    size.hash(&mut h);
    let key = format!("{:016x}", h.finish());
    Some(dir.join(&key[..2]).join(format!("{key}.jpg")))
}

pub fn thumbnail(cache_dir: &Path, path: &str, size: i32) -> Result<Vec<u8>, String> {
    let cp = cache_path(cache_dir, path, size).ok_or("missing file")?;
    if let Ok(bytes) = std::fs::read(&cp) {
        return Ok(bytes);
    }
    let (bgra, w, h) = shell_image(path, size)?;
    let jpg = bgra_to_jpeg(&bgra, w, h, 82)?;
    if let Some(parent) = cp.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&cp, &jpg);
    Ok(jpg)
}

pub fn cache_size(dir: &Path) -> u64 {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

/// Keeps the cache under `max` bytes by deleting the least recently written files.
pub fn trim_cache(dir: &Path, max: u64) {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), e.into_path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= max {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, p) in files {
        if total <= max * 8 / 10 {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= len;
        }
    }
}
