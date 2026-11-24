//! SQLite library index. Two connections (WAL): one for the indexer's writes, one for
//! UI reads, so scanning never blocks scrolling.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

pub struct Db {
    read: Mutex<Connection>,
    write: Mutex<Connection>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS media(
  id       INTEGER PRIMARY KEY,
  path     TEXT NOT NULL UNIQUE,
  folder   TEXT NOT NULL,
  name     TEXT NOT NULL,
  ext      TEXT NOT NULL,
  kind     INTEGER NOT NULL,
  size     INTEGER NOT NULL,
  mtime    INTEGER NOT NULL,
  ctime    INTEGER NOT NULL,
  taken    INTEGER,
  date     INTEGER NOT NULL,
  width    INTEGER,
  height   INTEGER,
  lat      REAL,
  lon      REAL,
  camera   TEXT,
  source   TEXT,
  favorite INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS media_folder ON media(folder);
CREATE INDEX IF NOT EXISTS media_date   ON media(date);
CREATE INDEX IF NOT EXISTS media_ctime  ON media(ctime);
CREATE INDEX IF NOT EXISTS media_fav    ON media(favorite) WHERE favorite = 1;
CREATE INDEX IF NOT EXISTS media_source ON media(source) WHERE source IS NOT NULL;
CREATE TABLE IF NOT EXISTS folder_meta(
  path   TEXT PRIMARY KEY,
  cover  TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS trash(
  id         INTEGER PRIMARY KEY,
  orig_path  TEXT NOT NULL,
  trash_path TEXT NOT NULL,
  kind       INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  favorite   INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_meta(
  path        TEXT PRIMARY KEY,
  rating      INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  tags        TEXT
);
CREATE TABLE IF NOT EXISTS albums(
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  smart   TEXT,
  cover   TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS album_items(
  album_id INTEGER NOT NULL,
  path     TEXT NOT NULL,
  added    INTEGER NOT NULL,
  PRIMARY KEY(album_id, path)
);
CREATE TABLE IF NOT EXISTS ocr(
  path  TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  text  TEXT NOT NULL,
  lines TEXT
);
CREATE TABLE IF NOT EXISTS vault(
  id    TEXT PRIMARY KEY,
  meta  BLOB NOT NULL,
  kind  INTEGER NOT NULL,
  size  INTEGER NOT NULL,
  added INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hashes(
  path  TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  dhash INTEGER NOT NULL
);
"#;

fn open_conn(path: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    c.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;
         PRAGMA cache_size=-8000; PRAGMA busy_timeout=5000;",
    )?;
    Ok(c)
}

/// One indexed file, as written by the indexer.
pub struct MediaRow {
    pub path: String,
    pub folder: String,
    pub name: String,
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
}

/// Compact item sent to the UI: [id, path, kind, date, favorite, width, height, size].
pub type Item = (i64, String, u8, i64, bool, u32, u32, i64);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub view: String,
    pub folder: Option<String>,
    #[serde(default)]
    pub recursive: bool,
    pub kinds: Option<Vec<u8>>,
    pub source: Option<String>,
    pub sort: String,
    pub desc: bool,
    pub search: Option<String>,
    pub album: Option<i64>,
    pub tag: Option<String>,
    pub min_rating: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
    pub direct: i64,
    pub total: i64,
    pub latest: i64,
    pub cover: Option<String>,
    pub hidden: bool,
    pub is_root: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub key: String,
    pub count: i64,
    pub cover: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: i64,
    pub orig_path: String,
    pub trash_path: String,
    pub kind: u8,
    pub size: i64,
    pub trashed_at: i64,
}

const HIDDEN_CLAUSE: &str = "NOT EXISTS (SELECT 1 FROM folder_meta h WHERE h.hidden = 1 AND \
     (m.folder = h.path OR substr(m.folder, 1, length(h.path) + 1) = h.path || '\\'))";

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let w = open_conn(path)?;
        w.execute_batch(SCHEMA)?;
        let r = open_conn(path)?;
        Ok(Self { read: Mutex::new(r), write: Mutex::new(w) })
    }

    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let c = self.read.lock().map_err(|e| e.to_string())?;
        f(&c).map_err(|e| e.to_string())
    }

    pub fn write<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut c = self.write.lock().map_err(|e| e.to_string())?;
        f(&mut c).map_err(|e| e.to_string())
    }

    // ------------------------------------------------------------------ kv

    pub fn kv_get(&self, key: &str) -> Option<String> {
        self.read(|c| {
            c.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional()
        })
        .ok()
        .flatten()
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.write(|c| {
            c.execute(
                "INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
        })
    }

    // ------------------------------------------------------------- indexing

    pub fn known_files(&self) -> Result<HashMap<String, (i64, i64)>, String> {
        self.read(|c| {
            let mut st = c.prepare("SELECT path, mtime, size FROM media")?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))?;
            rows.collect()
        })
    }

    pub fn upsert(&self, rows: &[MediaRow]) -> Result<(), String> {
        if rows.is_empty() {
            return Ok(());
        }
        self.write(|c| {
            let tx = c.transaction()?;
            {
                let mut st = tx.prepare_cached(
                    "INSERT INTO media(path, folder, name, ext, kind, size, mtime, ctime, taken, date,
                                       width, height, lat, lon, camera, source)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                     ON CONFLICT(path) DO UPDATE SET
                       folder = excluded.folder, name = excluded.name, ext = excluded.ext,
                       kind = excluded.kind, size = excluded.size, mtime = excluded.mtime,
                       ctime = excluded.ctime, taken = excluded.taken, date = excluded.date,
                       width = excluded.width, height = excluded.height, lat = excluded.lat,
                       lon = excluded.lon, camera = excluded.camera, source = excluded.source",
                )?;
                for m in rows {
                    st.execute(params![
                        m.path,
                        m.folder,
                        m.name,
                        m.ext,
                        m.kind,
                        m.size,
                        m.mtime,
                        m.ctime,
                        m.taken,
                        m.taken.unwrap_or(m.mtime),
                        m.width,
                        m.height,
                        m.lat,
                        m.lon,
                        m.camera,
                        m.source
                    ])?;
                }
            }
            tx.commit()
        })
    }

    pub fn remove_paths(&self, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        self.write(|c| {
            let tx = c.transaction()?;
            {
                let mut st = tx.prepare_cached("DELETE FROM media WHERE path = ?1")?;
                for p in paths {
                    st.execute([p])?;
                }
            }
            tx.commit()
        })
    }

    /// Removes a deleted path: either a file or a whole folder tree.
    pub fn remove_tree(&self, path: &str) -> Result<usize, String> {
        self.write(|c| {
            c.execute(
                "DELETE FROM media WHERE path = ?1 OR folder = ?1 OR substr(folder, 1, length(?1) + 1) = ?1 || '\\'",
                [path],
            )
        })
    }

    pub fn rename_path(&self, old: &str, new: &str, folder: &str, name: &str, ext: &str) -> Result<(), String> {
        self.write(|c| {
            c.execute(
                "UPDATE media SET path = ?2, folder = ?3, name = ?4, ext = ?5 WHERE path = ?1",
                params![old, new, folder, name, ext],
            )?;
            for t in ["user_meta", "album_items", "ocr", "hashes"] {
                c.execute(&format!("UPDATE OR IGNORE {t} SET path = ?2 WHERE path = ?1"), params![old, new])?;
            }
            Ok(())
        })
    }

    // ---------------------------------------------------------------- reads

    pub fn query(&self, q: &Query) -> Result<Vec<Item>, String> {
        let (date_col, order) = match q.sort.as_str() {
            "modified" => ("m.mtime", "m.mtime"),
            "added" => ("m.ctime", "m.ctime"),
            "name" => ("m.date", "m.name COLLATE NOCASE"),
            "size" => ("m.date", "m.size"),
            "type" => ("m.date", "m.ext"),
            _ => ("m.date", "m.date"),
        };
        let dir = if q.desc { "DESC" } else { "ASC" };
        let mut sql = format!(
            "SELECT m.id, m.path, m.kind, {date_col}, m.favorite, IFNULL(m.width, 0), IFNULL(m.height, 0), m.size
             FROM media m LEFT JOIN user_meta u ON u.path = m.path WHERE 1 = 1"
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        match q.view.as_str() {
            "favorites" => sql.push_str(" AND m.favorite = 1"),
            "recent" => {
                let since = crate::now_ms() - 30 * 86_400_000;
                sql.push_str(" AND m.ctime >= ?");
                args.push(Box::new(since));
            }
            "source" => {
                sql.push_str(" AND m.source = ?");
                args.push(Box::new(q.source.clone().unwrap_or_default()));
            }
            "location" => sql.push_str(" AND m.lat IS NOT NULL"),
            "album" => {
                sql.push_str(" AND m.path IN (SELECT path FROM album_items WHERE album_id = ?)");
                args.push(Box::new(q.album.unwrap_or(0)));
            }
            "tag" => {
                sql.push_str(" AND (',' || IFNULL(u.tags, '') || ',') LIKE ?");
                args.push(Box::new(format!("%,{},%", q.tag.clone().unwrap_or_default())));
            }
            "onthisday" => sql.push_str(
                " AND strftime('%m-%d', m.date / 1000, 'unixepoch', 'localtime') = strftime('%m-%d', 'now', 'localtime')                  AND strftime('%Y', m.date / 1000, 'unixepoch', 'localtime') < strftime('%Y', 'now', 'localtime')",
            ),
            "large" => sql.push_str(" AND m.size >= 50000000"),
            _ => {}
        }
        if let Some(r) = q.min_rating.filter(|r| *r > 0) {
            sql.push_str(" AND IFNULL(u.rating, 0) >= ?");
            args.push(Box::new(r));
        }
        if q.view == "folder" {
            let f = q.folder.clone().unwrap_or_default();
            if q.recursive {
                sql.push_str(" AND (m.folder = ? OR substr(m.folder, 1, length(?) + 1) = ? || '\\')");
                args.push(Box::new(f.clone()));
                args.push(Box::new(f.clone()));
                args.push(Box::new(f));
            } else {
                sql.push_str(" AND m.folder = ?");
                args.push(Box::new(f));
            }
        } else {
            sql.push_str(" AND ");
            sql.push_str(HIDDEN_CLAUSE);
        }
        if let Some(kinds) = q.kinds.as_ref().filter(|k| !k.is_empty()) {
            let list = kinds.iter().map(|k| k.to_string()).collect::<Vec<_>>().join(",");
            sql.push_str(&format!(" AND m.kind IN ({list})"));
        }
        if let Some(s) = q.search.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            for word in s.split_whitespace() {
                let like = format!("%{}%", word.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
                sql.push_str(
                    " AND (m.name LIKE ? ESCAPE '\\' OR m.folder LIKE ? ESCAPE '\\' \
                     OR IFNULL(m.camera, '') LIKE ? ESCAPE '\\' OR IFNULL(m.source, '') LIKE ? ESCAPE '\\' \
                     OR IFNULL(u.tags, '') LIKE ? ESCAPE '\\' OR IFNULL(u.description, '') LIKE ? ESCAPE '\\' \
                     OR EXISTS (SELECT 1 FROM ocr o WHERE o.path = m.path AND o.text LIKE ? ESCAPE '\\'))",
                );
                for _ in 0..7 {
                    args.push(Box::new(like.clone()));
                }
            }
        }
        sql.push_str(&format!(" ORDER BY {order} {dir}, m.id {dir}"));

        self.read(|c| {
            let mut st = c.prepare(&sql)?;
            let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
            let rows = st.query_map(refs.as_slice(), |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get::<_, i64>(4)? != 0,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })?;
            rows.collect()
        })
    }

    /// Folder tree under the library roots with aggregated counts and covers.
    pub fn folders(&self, roots: &[String]) -> Result<Vec<FolderNode>, String> {
        let (direct, meta) = self.read(|c| {
            let mut st = c.prepare(
                "SELECT folder, COUNT(*), MAX(date), path FROM media GROUP BY folder",
            )?;
            let direct: Vec<(String, i64, i64, String)> = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let mut st = c.prepare("SELECT path, cover, hidden FROM folder_meta")?;
            let meta: HashMap<String, (Option<String>, bool)> = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get::<_, i64>(2)? != 0))))?
                .collect::<rusqlite::Result<_>>()?;
            Ok((direct, meta))
        })?;

        let root_of = |p: &str| -> Option<&String> {
            roots
                .iter()
                .filter(|r| crate::path_within(p, r))
                .max_by_key(|r| r.len())
        };

        let mut nodes: HashMap<String, FolderNode> = HashMap::new();
        for (folder, count, latest, cover) in direct {
            let Some(root) = root_of(&folder).cloned() else { continue };
            // Walk up to the root, creating/aggregating every ancestor.
            let mut cur = folder.clone();
            let mut first = true;
            loop {
                let is_root = cur.eq_ignore_ascii_case(&root);
                let parent = if is_root { None } else { crate::parent_of(&cur) };
                let node = nodes.entry(cur.clone()).or_insert_with(|| FolderNode {
                    name: crate::file_name(&cur),
                    path: cur.clone(),
                    parent: parent.clone(),
                    direct: 0,
                    total: 0,
                    latest: 0,
                    cover: None,
                    hidden: false,
                    is_root,
                });
                if first {
                    node.direct = count;
                }
                node.total += count;
                if latest >= node.latest {
                    node.latest = latest;
                    node.cover = Some(cover.clone());
                }
                first = false;
                match parent {
                    Some(p) if !is_root => cur = p,
                    _ => break,
                }
            }
        }
        for (path, (cover, hidden)) in meta {
            if let Some(n) = nodes.get_mut(&path) {
                if cover.is_some() {
                    n.cover = cover;
                }
                n.hidden = hidden;
            }
        }
        let mut out: Vec<FolderNode> = nodes.into_values().collect();
        out.sort_by(|a, b| b.latest.cmp(&a.latest));
        Ok(out)
    }

    /// Counts for the auto albums (by source app) and by type.
    pub fn groups(&self) -> Result<(Vec<Group>, Vec<Group>, Vec<Group>), String> {
        self.read(|c| {
            let hidden = HIDDEN_CLAUSE;
            let mut st = c.prepare(&format!(
                "SELECT m.source, COUNT(*), MAX(m.date), m.path FROM media m
                 WHERE m.source IS NOT NULL AND {hidden} GROUP BY m.source"
            ))?;
            let sources = st
                .query_map([], |r| Ok(Group { key: r.get(0)?, count: r.get(1)?, cover: r.get(3)? }))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut st = c.prepare(&format!(
                "SELECT m.kind, COUNT(*), MAX(m.date), m.path FROM media m WHERE {hidden} GROUP BY m.kind"
            ))?;
            let kinds = st
                .query_map([], |r| {
                    Ok(Group { key: r.get::<_, i64>(0)?.to_string(), count: r.get(1)?, cover: r.get(3)? })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut specials = Vec::new();
            for (key, cond) in [
                ("favorites", "m.favorite = 1"),
                ("location", "m.lat IS NOT NULL"),
            ] {
                let g = c.query_row(
                    &format!(
                        "SELECT COUNT(*), MAX(m.date), m.path FROM media m WHERE {cond} AND {hidden}"
                    ),
                    [],
                    |r| Ok(Group { key: key.into(), count: r.get(0)?, cover: r.get(2)? }),
                )?;
                specials.push(g);
            }
            Ok((sources, kinds, specials))
        })
    }

    pub fn set_favorite(&self, paths: &[String], value: bool) -> Result<(), String> {
        self.write(|c| {
            let tx = c.transaction()?;
            {
                let mut st = tx.prepare_cached("UPDATE media SET favorite = ?2 WHERE path = ?1")?;
                for p in paths {
                    st.execute(params![p, value as i64])?;
                }
            }
            tx.commit()
        })
    }

    pub fn favorites_of(&self, paths: &[String]) -> Result<Vec<String>, String> {
        self.read(|c| {
            let mut st = c.prepare_cached("SELECT 1 FROM media WHERE path = ?1 AND favorite = 1")?;
            let mut out = Vec::new();
            for p in paths {
                if st.exists([p])? {
                    out.push(p.clone());
                }
            }
            Ok(out)
        })
    }

    pub fn set_folder_meta(&self, path: &str, cover: Option<Option<&str>>, hidden: Option<bool>) -> Result<(), String> {
        self.write(|c| {
            c.execute("INSERT OR IGNORE INTO folder_meta(path) VALUES(?1)", [path])?;
            if let Some(cover) = cover {
                c.execute("UPDATE folder_meta SET cover = ?2 WHERE path = ?1", params![path, cover])?;
            }
            if let Some(h) = hidden {
                c.execute("UPDATE folder_meta SET hidden = ?2 WHERE path = ?1", params![path, h as i64])?;
            }
            Ok(())
        })
    }

    pub fn hidden_folders(&self) -> Result<Vec<String>, String> {
        self.read(|c| {
            let mut st = c.prepare("SELECT path FROM folder_meta WHERE hidden = 1 ORDER BY path")?;
            let rows = st.query_map([], |r| r.get(0))?;
            rows.collect()
        })
    }

    pub fn media_by_path(&self, path: &str) -> Result<Option<(u8, i64, bool)>, String> {
        self.read(|c| {
            c.query_row(
                "SELECT kind, size, favorite FROM media WHERE path = ?1",
                [path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
            )
            .optional()
        })
    }

    // ---------------------------------------------------------------- trash

    pub fn trash_add(&self, orig: &str, trash_path: &str, kind: u8, size: i64, fav: bool) -> Result<(), String> {
        self.write(|c| {
            c.execute(
                "INSERT INTO trash(orig_path, trash_path, kind, size, favorite, trashed_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![orig, trash_path, kind, size, fav as i64, crate::now_ms()],
            )?;
            c.execute("DELETE FROM media WHERE path = ?1", [orig])?;
            Ok(())
        })
    }

    pub fn trash_list(&self) -> Result<Vec<TrashItem>, String> {
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT id, orig_path, trash_path, kind, size, trashed_at FROM trash ORDER BY trashed_at DESC",
            )?;
            let rows = st.query_map([], |r| {
                Ok(TrashItem {
                    id: r.get(0)?,
                    orig_path: r.get(1)?,
                    trash_path: r.get(2)?,
                    kind: r.get(3)?,
                    size: r.get(4)?,
                    trashed_at: r.get(5)?,
                })
            })?;
            rows.collect()
        })
    }

    pub fn trash_get(&self, id: i64) -> Result<Option<(String, String, bool)>, String> {
        self.read(|c| {
            c.query_row(
                "SELECT orig_path, trash_path, favorite FROM trash WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
            )
            .optional()
        })
    }

    pub fn trash_remove(&self, id: i64) -> Result<(), String> {
        self.write(|c| c.execute("DELETE FROM trash WHERE id = ?1", [id]).map(|_| ()))
    }

    pub fn trash_older_than(&self, cutoff: i64) -> Result<Vec<i64>, String> {
        self.read(|c| {
            let mut st = c.prepare("SELECT id FROM trash WHERE trashed_at < ?1")?;
            let rows = st.query_map([cutoff], |r| r.get(0))?;
            rows.collect()
        })
    }
}
