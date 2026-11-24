//! Library indexer: an incremental scan of the library roots (only changed files are re-read)
//! plus a file-system watcher that keeps the index live.

use crate::db::{Db, MediaRow};
use crate::media;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::os::windows::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub scanning: bool,
    pub found: u64,
    pub indexed: u64,
}

pub struct Indexer {
    scanning: AtomicBool,
    rescan_requested: AtomicBool,
    found: AtomicU64,
    indexed: AtomicU64,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

const SKIP_DIRS: &[&str] = &[
    "node_modules", "$recycle.bin", "system volume information", ".git", ".thumbnails", "appdata",
    "__pycache__", ".cache", "thumbs", "cache",
];

fn skip_dir(e: &walkdir::DirEntry) -> bool {
    if e.depth() == 0 || !e.file_type().is_dir() {
        return false;
    }
    let name = e.file_name().to_string_lossy().to_lowercase();
    if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
        return true;
    }
    e.metadata()
        .map(|m| m.file_attributes() & (media::ATTR_HIDDEN | media::ATTR_SYSTEM) != 0)
        .unwrap_or(false)
}

/// Removes roots that are inside other roots so nothing is scanned twice.
pub fn effective_roots(roots: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in roots {
        if !std::path::Path::new(r).is_dir() {
            continue;
        }
        if roots.iter().any(|o| o != r && crate::path_within(r, o) && !o.eq_ignore_ascii_case(r)) {
            continue;
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(r)) {
            out.push(r.clone());
        }
    }
    out
}

impl Indexer {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            scanning: AtomicBool::new(false),
            rescan_requested: AtomicBool::new(false),
            found: AtomicU64::new(0),
            indexed: AtomicU64::new(0),
            watcher: Mutex::new(None),
        })
    }

    pub fn progress(&self) -> Progress {
        Progress {
            scanning: self.scanning.load(Ordering::Relaxed),
            found: self.found.load(Ordering::Relaxed),
            indexed: self.indexed.load(Ordering::Relaxed),
        }
    }

    /// Starts a background scan (coalesces repeated requests) and (re)starts the watcher.
    pub fn start(self: &Arc<Self>, app: AppHandle, db: Arc<Db>, roots: Vec<String>, exclude: PathBuf) {
        if self.scanning.swap(true, Ordering::SeqCst) {
            self.rescan_requested.store(true, Ordering::SeqCst);
            return;
        }
        let me = self.clone();
        std::thread::Builder::new()
            .name("indexer".into())
            .spawn(move || {
                loop {
                    let roots = effective_roots(&roots);
                    me.restart_watcher(app.clone(), db.clone(), &roots, exclude.clone());
                    me.scan(&app, &db, &roots, &exclude);
                    if !me.rescan_requested.swap(false, Ordering::SeqCst) {
                        break;
                    }
                }
                me.scanning.store(false, Ordering::SeqCst);
                let _ = app.emit("index-progress", me.progress());
                let _ = app.emit("library-changed", ());
            })
            .expect("spawn indexer");
    }

    fn scan(&self, app: &AppHandle, db: &Db, roots: &[String], exclude: &PathBuf) {
        self.found.store(0, Ordering::Relaxed);
        self.indexed.store(0, Ordering::Relaxed);
        let known = db.known_files().unwrap_or_default();
        let mut seen: HashSet<String> = HashSet::with_capacity(known.len());
        let mut batch: Vec<MediaRow> = Vec::with_capacity(256);
        let mut last_emit = std::time::Instant::now();

        for root in roots {
            let walker = walkdir::WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
                !skip_dir(e) && !e.path().starts_with(exclude)
            });
            for entry in walker.filter_map(|e| e.ok()) {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = entry.path().to_string_lossy().into_owned();
                if media::kind_of(&path).is_none() {
                    continue;
                }
                let Ok(md) = entry.metadata() else { continue };
                if md.file_attributes() & (media::ATTR_HIDDEN | media::ATTR_SYSTEM) != 0 {
                    continue;
                }
                self.found.fetch_add(1, Ordering::Relaxed);
                let mtime = (md.last_write_time() as i64 / 10_000) - 11_644_473_600_000;
                let size = md.file_size() as i64;
                let unchanged = known.get(&path).is_some_and(|&(m, s)| m == mtime && s == size);
                seen.insert(path.clone());
                if unchanged {
                    continue;
                }
                if let Some(row) = media::build_row(&path, &md) {
                    batch.push(row);
                    self.indexed.fetch_add(1, Ordering::Relaxed);
                }
                if batch.len() >= 250 {
                    let _ = db.upsert(&batch);
                    batch.clear();
                }
                if last_emit.elapsed() > Duration::from_millis(700) {
                    let _ = db.upsert(&batch);
                    batch.clear();
                    let _ = app.emit("index-progress", self.progress());
                    let _ = app.emit("library-changed", ());
                    last_emit = std::time::Instant::now();
                }
            }
        }
        let _ = db.upsert(&batch);
        let gone: Vec<String> = known.into_keys().filter(|p| !seen.contains(p)).collect();
        let _ = db.remove_paths(&gone);
    }

    fn restart_watcher(&self, app: AppHandle, db: Arc<Db>, roots: &[String], exclude: PathBuf) {
        let (tx, rx) = channel::<notify::Result<notify::Event>>();
        let watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        });
        let Ok(mut watcher) = watcher else { return };
        for r in roots {
            let _ = watcher.watch(std::path::Path::new(r), RecursiveMode::Recursive);
        }
        // Replacing the watcher drops the old one, which closes the old channel and ends its thread.
        *self.watcher.lock().unwrap() = Some(watcher);

        std::thread::Builder::new()
            .name("watcher".into())
            .spawn(move || {
                let mut pending: HashSet<PathBuf> = HashSet::new();
                loop {
                    match rx.recv_timeout(Duration::from_millis(1200)) {
                        Ok(Ok(ev)) => {
                            for p in ev.paths {
                                if !p.starts_with(&exclude) {
                                    pending.insert(p);
                                }
                            }
                        }
                        Ok(Err(_)) => {}
                        Err(RecvTimeoutError::Timeout) => {
                            if pending.is_empty() {
                                continue;
                            }
                            apply_changes(&db, pending.drain().collect());
                            let _ = app.emit("library-changed", ());
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .ok();
    }
}

fn apply_changes(db: &Db, paths: Vec<PathBuf>) {
    let mut rows = Vec::new();
    for p in paths {
        let s = p.to_string_lossy().into_owned();
        match std::fs::metadata(&p) {
            Ok(md) if md.is_file() => {
                if md.file_attributes() & (media::ATTR_HIDDEN | media::ATTR_SYSTEM) != 0 {
                    continue;
                }
                if let Some(row) = media::build_row(&s, &md) {
                    rows.push(row);
                }
            }
            Ok(md) if md.is_dir() => {
                // A folder moved/copied in: index everything inside.
                for e in walkdir::WalkDir::new(&p).into_iter().filter_entry(|e| !skip_dir(e)).filter_map(|e| e.ok()) {
                    if e.file_type().is_file() {
                        let es = e.path().to_string_lossy().into_owned();
                        if let Ok(m) = e.metadata() {
                            if let Some(row) = media::build_row(&es, &m) {
                                rows.push(row);
                            }
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(_) => {
                let _ = db.remove_tree(&s);
            }
        }
    }
    let _ = db.upsert(&rows);
}

/// Indexes one file right away (used when the viewer favourites a file outside a scan).
pub fn index_one(db: &Db, path: &str) {
    if let Ok(md) = std::fs::metadata(path) {
        if let Some(row) = media::build_row(path, &md) {
            let _ = db.upsert(&[row]);
        }
    }
}
