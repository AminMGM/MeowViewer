//! On-device text recognition (Windows.Media.Ocr — built into Windows, offline, free).
//! A low-priority background job reads text from library photos so search finds words inside
//! screenshots/photos; the viewer uses the stored word boxes for "Live Text" selection.

use crate::db::Db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;

/// A recognised line: text + word boxes as fractions of the image (x, y, w, h).
#[derive(Serialize, Deserialize, Clone)]
pub struct Line {
    pub text: String,
    pub words: Vec<(String, f32, f32, f32, f32)>,
}

pub struct Ocr {
    pub running: AtomicBool,
    pub stop: AtomicBool,
    pub done: AtomicU64,
    pub total: AtomicU64,
}

const OCR_EXT: &[&str] = &["jpg", "jpeg", "jfif", "png", "webp", "bmp", "heic", "heif", "tif", "tiff", "avif"];

pub fn recognize(path: &str) -> Result<(String, Vec<Line>), String> {
    crate::com_init();
    let o = crate::media::read_exif(path, false).orientation;
    let max = OcrEngine::MaxImageDimension().unwrap_or(2600).min(2600);
    let (rgba, w, h) = crate::wic::decode_rgba(path, max, o)?;
    let gray: Vec<u8> = rgba
        .chunks_exact(4)
        .map(|p| ((p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8) as u8)
        .collect();
    drop(rgba);
    let run = || -> windows::core::Result<(String, Vec<Line>)> {
        let dw = DataWriter::new()?;
        dw.WriteBytes(&gray)?;
        let buf = dw.DetachBuffer()?;
        let bmp = SoftwareBitmap::CreateCopyFromBuffer(&buf, BitmapPixelFormat::Gray8, w as i32, h as i32)?;
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let res = engine.RecognizeAsync(&bmp)?.join()?;
        let mut lines = Vec::new();
        let mut text = String::new();
        for line in res.Lines()? {
            let lt = line.Text()?.to_string();
            let mut words = Vec::new();
            for wd in line.Words()? {
                let r = wd.BoundingRect()?;
                words.push((
                    wd.Text()?.to_string(),
                    r.X / w as f32,
                    r.Y / h as f32,
                    r.Width / w as f32,
                    r.Height / h as f32,
                ));
            }
            text.push_str(&lt);
            text.push('\n');
            lines.push(Line { text: lt, words });
        }
        Ok((text, lines))
    };
    run().map_err(|e| e.message())
}

impl Db {
    pub fn ocr_get(&self, path: &str) -> Result<Option<(i64, String, String)>, String> {
        self.read(|c| {
            c.query_row("SELECT mtime, text, IFNULL(lines, '[]') FROM ocr WHERE path = ?1", [path], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()
        })
    }

    pub fn ocr_put(&self, path: &str, mtime: i64, text: &str, lines: &str) -> Result<(), String> {
        self.write(|c| {
            c.execute(
                "INSERT INTO ocr(path, mtime, text, lines) VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, text = excluded.text, lines = excluded.lines",
                params![path, mtime, text, lines],
            )
            .map(|_| ())
        })
    }

    fn ocr_pending(&self, limit: i64) -> Result<Vec<(String, i64)>, String> {
        let exts = OCR_EXT.iter().map(|e| format!("'{e}'")).collect::<Vec<_>>().join(",");
        self.read(|c| {
            let mut st = c.prepare(&format!(
                "SELECT m.path, m.mtime FROM media m LEFT JOIN ocr o ON o.path = m.path
                 WHERE m.kind = 0 AND m.ext IN ({exts}) AND m.size < 60000000
                   AND (o.path IS NULL OR o.mtime != m.mtime)
                 ORDER BY (m.source = 'screenshots') DESC, m.date DESC LIMIT ?1"
            ))?;
            let r = st.query_map([limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
            r.collect()
        })
    }

    fn ocr_counts(&self) -> (u64, u64) {
        let exts = OCR_EXT.iter().map(|e| format!("'{e}'")).collect::<Vec<_>>().join(",");
        self.read(|c| {
            c.query_row(
                &format!(
                    "SELECT (SELECT COUNT(*) FROM media WHERE kind = 0 AND ext IN ({exts}) AND size < 60000000),
                            (SELECT COUNT(*) FROM ocr)"
                ),
                [],
                |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64)),
            )
        })
        .unwrap_or((0, 0))
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OcrProgress {
    pub running: bool,
    pub done: u64,
    pub total: u64,
}

impl Ocr {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            running: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            done: AtomicU64::new(0),
            total: AtomicU64::new(0),
        })
    }

    pub fn progress(&self) -> OcrProgress {
        OcrProgress {
            running: self.running.load(Ordering::Relaxed),
            done: self.done.load(Ordering::Relaxed),
            total: self.total.load(Ordering::Relaxed),
        }
    }

    /// Runs through un-read photos at background CPU/IO priority until done or stopped.
    pub fn start(self: &Arc<Self>, app: AppHandle, db: Arc<Db>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        self.stop.store(false, Ordering::SeqCst);
        let me = self.clone();
        std::thread::Builder::new()
            .name("ocr".into())
            .spawn(move || {
                unsafe {
                    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
                    let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
                }
                crate::com_init();
                let mut last = std::time::Instant::now();
                'outer: loop {
                    let (total, done) = db.ocr_counts();
                    me.total.store(total, Ordering::Relaxed);
                    me.done.store(done, Ordering::Relaxed);
                    let batch = db.ocr_pending(50).unwrap_or_default();
                    if batch.is_empty() {
                        break;
                    }
                    for (path, mtime) in batch {
                        if me.stop.load(Ordering::Relaxed) {
                            break 'outer;
                        }
                        let (text, lines) = recognize(&path).unwrap_or_default();
                        let json = serde_json::to_string(&lines).unwrap_or_else(|_| "[]".into());
                        let _ = db.ocr_put(&path, mtime, text.trim(), &json);
                        me.done.fetch_add(1, Ordering::Relaxed);
                        if last.elapsed().as_secs() >= 2 {
                            let _ = app.emit("ocr-progress", me.progress());
                            last = std::time::Instant::now();
                        }
                    }
                }
                me.running.store(false, Ordering::SeqCst);
                let _ = app.emit("ocr-progress", me.progress());
            })
            .ok();
    }
}
