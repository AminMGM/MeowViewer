//! User metadata (rating, tags, description), albums (manual + smart), locations for the map,
//! editing "date taken", and storage statistics.

use crate::db::Db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserMeta {
    pub rating: i64,
    pub description: String,
    pub tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: i64,
    pub name: String,
    pub smart: Option<String>,
    pub cover: Option<String>,
    pub count: i64,
}

/// [path, lat, lon, kind, date]
pub type Located = (String, f64, f64, u8, i64);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total: i64,
    pub bytes: i64,
    pub by_kind: Vec<(u8, i64, i64)>,
    pub by_source: Vec<(String, i64, i64)>,
    pub old_screenshots: i64,
    pub old_screenshots_bytes: i64,
}

fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().replace(',', " ");
        if !t.is_empty() && !out.iter().any(|o| o.eq_ignore_ascii_case(&t)) {
            out.push(t);
        }
    }
    out
}

impl Db {
    pub fn user_meta(&self, path: &str) -> Result<UserMeta, String> {
        self.read(|c| {
            c.query_row(
                "SELECT rating, IFNULL(description, ''), IFNULL(tags, '') FROM user_meta WHERE path = ?1",
                [path],
                |r| {
                    let tags: String = r.get(2)?;
                    Ok(UserMeta {
                        rating: r.get(0)?,
                        description: r.get(1)?,
                        tags: tags.split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
                    })
                },
            )
            .optional()
            .map(|o| o.unwrap_or_default())
        })
    }

    pub fn set_user_meta(&self, paths: &[String], rating: Option<i64>, description: Option<String>, tags: Option<Vec<String>>, add_tags: Option<Vec<String>>) -> Result<(), String> {
        let tags = tags.map(|t| clean_tags(&t));
        let add = add_tags.map(|t| clean_tags(&t));
        self.write(|c| {
            let tx = c.transaction()?;
            for p in paths {
                tx.execute("INSERT OR IGNORE INTO user_meta(path) VALUES(?1)", [p])?;
                if let Some(r) = rating {
                    tx.execute("UPDATE user_meta SET rating = ?2 WHERE path = ?1", params![p, r.clamp(0, 5)])?;
                }
                if let Some(d) = &description {
                    tx.execute("UPDATE user_meta SET description = ?2 WHERE path = ?1", params![p, d])?;
                }
                if let Some(t) = &tags {
                    tx.execute("UPDATE user_meta SET tags = ?2 WHERE path = ?1", params![p, t.join(",")])?;
                }
                if let Some(a) = &add {
                    let cur: String = tx.query_row("SELECT IFNULL(tags, '') FROM user_meta WHERE path = ?1", [p], |r| r.get(0))?;
                    let mut list: Vec<String> = cur.split(',').filter(|s| !s.is_empty()).map(String::from).collect();
                    list.extend(a.iter().cloned());
                    tx.execute("UPDATE user_meta SET tags = ?2 WHERE path = ?1", params![p, clean_tags(&list).join(",")])?;
                }
            }
            tx.commit()
        })
    }

    /// All tags with usage counts.
    pub fn all_tags(&self) -> Result<Vec<(String, i64)>, String> {
        let rows: Vec<String> = self.read(|c| {
            let mut st = c.prepare("SELECT tags FROM user_meta WHERE tags IS NOT NULL AND tags != ''")?;
            let r = st.query_map([], |r| r.get(0))?;
            r.collect()
        })?;
        let mut map: std::collections::HashMap<String, i64> = Default::default();
        for r in rows {
            for t in r.split(',').filter(|s| !s.is_empty()) {
                *map.entry(t.to_string()).or_default() += 1;
            }
        }
        let mut v: Vec<(String, i64)> = map.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(v)
    }

    // -------------------------------------------------------------- albums

    pub fn albums(&self) -> Result<Vec<Album>, String> {
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT a.id, a.name, a.smart,
                        COALESCE(a.cover, (SELECT i.path FROM album_items i WHERE i.album_id = a.id ORDER BY i.added DESC LIMIT 1)),
                        (SELECT COUNT(*) FROM album_items i WHERE i.album_id = a.id)
                 FROM albums a ORDER BY a.created DESC",
            )?;
            let r = st.query_map([], |r| {
                Ok(Album { id: r.get(0)?, name: r.get(1)?, smart: r.get(2)?, cover: r.get(3)?, count: r.get(4)? })
            })?;
            r.collect()
        })
    }

    pub fn create_album(&self, name: &str, smart: Option<String>) -> Result<i64, String> {
        self.write(|c| {
            c.execute(
                "INSERT INTO albums(name, smart, created) VALUES(?1, ?2, ?3)",
                params![name, smart, crate::now_ms()],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    pub fn update_album(&self, id: i64, name: Option<String>, cover: Option<Option<String>>) -> Result<(), String> {
        self.write(|c| {
            if let Some(n) = name {
                c.execute("UPDATE albums SET name = ?2 WHERE id = ?1", params![id, n])?;
            }
            if let Some(cv) = cover {
                c.execute("UPDATE albums SET cover = ?2 WHERE id = ?1", params![id, cv])?;
            }
            Ok(())
        })
    }

    pub fn delete_album(&self, id: i64) -> Result<(), String> {
        self.write(|c| {
            c.execute("DELETE FROM album_items WHERE album_id = ?1", [id])?;
            c.execute("DELETE FROM albums WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    pub fn album_add(&self, id: i64, paths: &[String], remove: bool) -> Result<(), String> {
        self.write(|c| {
            let tx = c.transaction()?;
            for p in paths {
                if remove {
                    tx.execute("DELETE FROM album_items WHERE album_id = ?1 AND path = ?2", params![id, p])?;
                } else {
                    tx.execute(
                        "INSERT OR IGNORE INTO album_items(album_id, path, added) VALUES(?1, ?2, ?3)",
                        params![id, p, crate::now_ms()],
                    )?;
                }
            }
            tx.commit()
        })
    }

    // ------------------------------------------------------------- map etc

    pub fn located(&self) -> Result<Vec<Located>, String> {
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT m.path, m.lat, m.lon, m.kind, m.date FROM media m
                 WHERE m.lat IS NOT NULL AND m.lon IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM folder_meta h WHERE h.hidden = 1 AND
                   (m.folder = h.path OR substr(m.folder, 1, length(h.path) + 1) = h.path || '\\'))
                 ORDER BY m.date DESC",
            )?;
            let r = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
            r.collect()
        })
    }

    pub fn set_location(&self, paths: &[String], lat: Option<f64>, lon: Option<f64>) -> Result<(), String> {
        self.write(|c| {
            let tx = c.transaction()?;
            for p in paths {
                tx.execute("UPDATE media SET lat = ?2, lon = ?3 WHERE path = ?1", params![p, lat, lon])?;
            }
            tx.commit()
        })
    }

    pub fn set_taken(&self, path: &str, ms: i64) -> Result<(), String> {
        self.write(|c| {
            c.execute("UPDATE media SET taken = ?2, date = ?2 WHERE path = ?1", params![path, ms]).map(|_| ())
        })
    }

    pub fn on_this_day_count(&self) -> Result<(i64, Option<String>), String> {
        self.read(|c| {
            c.query_row(
                "SELECT COUNT(*), MAX(path) FROM media
                 WHERE strftime('%m-%d', date / 1000, 'unixepoch', 'localtime') = strftime('%m-%d', 'now', 'localtime')
                   AND strftime('%Y', date / 1000, 'unixepoch', 'localtime') < strftime('%Y', 'now', 'localtime')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
    }

    pub fn stats(&self) -> Result<Stats, String> {
        self.read(|c| {
            let (total, bytes) = c.query_row("SELECT COUNT(*), IFNULL(SUM(size), 0) FROM media", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
            let mut st = c.prepare("SELECT kind, COUNT(*), SUM(size) FROM media GROUP BY kind")?;
            let by_kind = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
            let mut st = c.prepare(
                "SELECT source, COUNT(*), SUM(size) FROM media WHERE source IS NOT NULL GROUP BY source ORDER BY 3 DESC",
            )?;
            let by_source = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
            let cutoff = crate::now_ms() - 180 * 86_400_000;
            let (old_screenshots, old_screenshots_bytes) = c.query_row(
                "SELECT COUNT(*), IFNULL(SUM(size), 0) FROM media WHERE source = 'screenshots' AND date < ?1",
                [cutoff],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            Ok(Stats { total, bytes, by_kind, by_source, old_screenshots, old_screenshots_bytes })
        })
    }

    pub fn old_screenshots(&self) -> Result<Vec<crate::db::Item>, String> {
        let cutoff = crate::now_ms() - 180 * 86_400_000;
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT id, path, kind, date, favorite, IFNULL(width, 0), IFNULL(height, 0), size FROM media
                 WHERE source = 'screenshots' AND date < ?1 ORDER BY date ASC",
            )?;
            let r = st.query_map([cutoff], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, i64>(4)? != 0, r.get(5)?, r.get(6)?, r.get(7)?))
            })?;
            r.collect()
        })
    }
}

/// Writes DateTimeOriginal in place (JPEG/TIFF; EXIF dates are fixed-length so no padding is
/// needed). Returns false when the file can't be updated losslessly (DB-only change).
pub fn write_taken(path: &str, ms: i64) -> bool {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemAlloc, CLSCTX_INPROC_SERVER};
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
    use windows::Win32::System::Variant::VT_LPSTR;
    let ext = crate::media::ext_of(path);
    let base = match ext.as_str() {
        "jpg" | "jpeg" | "jfif" | "jpe" => "/app1/ifd/exif",
        "tif" | "tiff" => "/ifd/exif",
        _ => return false,
    };
    let Some(s) = crate::unix_ms_to_local(ms) else { return false };
    crate::com_init();
    unsafe {
        let run = || -> windows::core::Result<()> {
            let f: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let dec = f.CreateDecoderFromFilename(&HSTRING::from(path), None, GENERIC_READ | GENERIC_WRITE, WICDecodeMetadataCacheOnDemand)?;
            let frame = dec.GetFrame(0)?;
            let enc = f.CreateFastMetadataEncoderFromFrameDecode(&frame)?;
            let w = enc.GetMetadataQueryWriter()?;
            for tag in [36867u16, 36868] {
                let bytes = format!("{s}\0");
                let mem = CoTaskMemAlloc(bytes.len()) as *mut u8;
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), mem, bytes.len());
                let mut pv = PROPVARIANT {
                    Anonymous: PROPVARIANT_0 {
                        Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                            vt: VT_LPSTR,
                            wReserved1: 0,
                            wReserved2: 0,
                            wReserved3: 0,
                            Anonymous: PROPVARIANT_0_0_0 { pszVal: windows::core::PSTR(mem) },
                        }),
                    },
                };
                let q = HSTRING::from(format!("{base}/{{ushort={tag}}}"));
                let r = w.SetMetadataByName(PCWSTR(q.as_ptr()), &pv);
                let _ = PropVariantClear(&mut pv);
                if tag == 36867 {
                    r?;
                }
            }
            enc.Commit()
        };
        run().is_ok()
    }
}
