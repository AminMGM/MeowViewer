//! Private album: files are moved into an encrypted vault (XChaCha20-Poly1305, 1 MB chunks so
//! video can stream/seek without decrypting everything). A random data key is wrapped by a key
//! derived from the PIN with Argon2id, so changing the PIN never re-encrypts files.
//! Encrypted file names/paths and thumbnails live in the DB/vault folder; nothing is readable
//! while locked.

use crate::db::Db;
use argon2::Argon2;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const CHUNK: usize = 1 << 20;
const TAG: usize = 16;
const MAGIC: &[u8; 8] = b"MEOWVLT1";
// header: MAGIC(8) | nonce prefix(16) | plain size(8)
const HEADER: usize = 32;

pub struct Vault {
    pub key: Mutex<Option<[u8; 32]>>,
    pub dir: PathBuf,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultMeta {
    pub name: String,
    pub orig_path: String,
    pub taken: i64,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultItem {
    pub id: String,
    pub kind: u8,
    pub size: i64,
    pub added: i64,
    pub meta: VaultMeta,
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("system RNG");
    b
}

fn derive(pin: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    Argon2::default().hash_password_into(pin.as_bytes(), salt, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn seal(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    let nonce = rand_bytes::<24>();
    let c = XChaCha20Poly1305::new(key.into());
    let mut out = nonce.to_vec();
    out.extend(c.encrypt(&xn(&nonce), data).map_err(|_| "encrypt failed")?);
    Ok(out)
}

fn open(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 24 + TAG {
        return Err("corrupt".into());
    }
    let c = XChaCha20Poly1305::new(key.into());
    c.decrypt(&xn(&data[..24]), &data[24..]).map_err(|_| "Wrong PIN".to_string())
}

fn xn(b: &[u8]) -> XNonce {
    XNonce::try_from(b).expect("24-byte nonce")
}

fn chunk_nonce(prefix: &[u8; 16], i: u64) -> [u8; 24] {
    let mut n = [0u8; 24];
    n[..16].copy_from_slice(prefix);
    n[16..].copy_from_slice(&i.to_le_bytes());
    n
}

impl Vault {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self { key: Mutex::new(None), dir }
    }

    pub fn is_set_up(db: &Db) -> bool {
        db.kv_get("vault_key").is_some()
    }

    pub fn setup(&self, db: &Db, pin: &str) -> Result<(), String> {
        if Self::is_set_up(db) {
            return Err("Private album already has a PIN".into());
        }
        if pin.len() < 4 {
            return Err("Use at least 4 digits".into());
        }
        let salt = rand_bytes::<16>();
        let data_key = rand_bytes::<32>();
        let wrapped = seal(&derive(pin, &salt)?, &data_key)?;
        db.kv_set("vault_salt", &hex(&salt))?;
        db.kv_set("vault_key", &hex(&wrapped))?;
        *self.key.lock().unwrap() = Some(data_key);
        Ok(())
    }

    pub fn unlock(&self, db: &Db, pin: &str) -> Result<(), String> {
        let salt = unhex(&db.kv_get("vault_salt").ok_or("No PIN set")?)?;
        let wrapped = unhex(&db.kv_get("vault_key").ok_or("No PIN set")?)?;
        let key = open(&derive(pin, &salt)?, &wrapped)?;
        let mut k = [0u8; 32];
        k.copy_from_slice(&key);
        *self.key.lock().unwrap() = Some(k);
        Ok(())
    }

    pub fn change_pin(&self, db: &Db, old: &str, new: &str) -> Result<(), String> {
        if new.len() < 4 {
            return Err("Use at least 4 digits".into());
        }
        self.unlock(db, old)?;
        let k = self.key()?;
        let salt = rand_bytes::<16>();
        db.kv_set("vault_salt", &hex(&salt))?;
        db.kv_set("vault_key", &hex(&seal(&derive(new, &salt)?, &k)?))?;
        Ok(())
    }

    pub fn lock(&self) {
        *self.key.lock().unwrap() = None;
    }

    pub fn key(&self) -> Result<[u8; 32], String> {
        self.key.lock().unwrap().ok_or_else(|| "Private album is locked".to_string())
    }

    fn file(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.mvv"))
    }
    fn thumb(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.mvt"))
    }

    /// Encrypts `src` into the vault and deletes the original.
    pub fn add(&self, db: &Db, src: &str) -> Result<(), String> {
        let key = self.key()?;
        let md = std::fs::metadata(src).map_err(|e| e.to_string())?;
        let kind = crate::media::kind_of(src).ok_or("Not a media file")?;
        let id = hex(&rand_bytes::<12>());
        let ex = crate::media::read_exif(src, false);
        let (w, h) = imagesize::size(src).map(|s| (s.width as u32, s.height as u32)).unwrap_or((0, 0));
        let meta = VaultMeta {
            name: crate::file_name(src),
            orig_path: src.to_string(),
            taken: ex.taken.unwrap_or_else(|| {
                use std::os::windows::fs::MetadataExt;
                (md.last_write_time() as i64 / 10_000) - 11_644_473_600_000
            }),
            width: w,
            height: h,
        };
        // Thumbnail first (needs the plain file).
        let thumb = crate::thumbs::shell_image(src, 320).and_then(|(b, w, h)| crate::thumbs::bgra_to_jpeg(&b, w, h, 82));
        if let Ok(t) = thumb {
            std::fs::write(self.thumb(&id), seal(&key, &t)?).map_err(|e| e.to_string())?;
        }
        // Chunked encryption.
        let prefix = rand_bytes::<16>();
        let cipher = XChaCha20Poly1305::new((&key).into());
        let mut input = std::fs::File::open(src).map_err(|e| e.to_string())?;
        let tmp = self.dir.join(format!("{id}.tmp"));
        {
            let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
            out.write_all(MAGIC).map_err(|e| e.to_string())?;
            out.write_all(&prefix).map_err(|e| e.to_string())?;
            out.write_all(&md.len().to_le_bytes()).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; CHUNK];
            let mut i = 0u64;
            loop {
                let mut n = 0;
                while n < CHUNK {
                    let r = input.read(&mut buf[n..]).map_err(|e| e.to_string())?;
                    if r == 0 {
                        break;
                    }
                    n += r;
                }
                if n == 0 {
                    break;
                }
                let ct = cipher
                    .encrypt(&xn(&chunk_nonce(&prefix, i)), &buf[..n])
                    .map_err(|_| "encrypt failed")?;
                out.write_all(&ct).map_err(|e| e.to_string())?;
                i += 1;
                if n < CHUNK {
                    break;
                }
            }
            out.flush().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, self.file(&id)).map_err(|e| e.to_string())?;
        let meta_enc = seal(&key, &serde_json::to_vec(&meta).map_err(|e| e.to_string())?)?;
        db.write(|c| {
            c.execute(
                "INSERT INTO vault(id, meta, kind, size, added) VALUES(?1, ?2, ?3, ?4, ?5)",
                params![id, meta_enc, kind, md.len() as i64, crate::now_ms()],
            )?;
            c.execute("DELETE FROM media WHERE path = ?1", [src])?;
            Ok(())
        })?;
        drop(input);
        std::fs::remove_file(src).map_err(|e| format!("Encrypted, but couldn't delete the original: {e}"))?;
        // Remove the plain thumbnail from the shared cache too.
        Ok(())
    }

    pub fn list(&self, db: &Db) -> Result<Vec<VaultItem>, String> {
        let key = self.key()?;
        let rows: Vec<(String, Vec<u8>, u8, i64, i64)> = db.read(|c| {
            let mut st = c.prepare("SELECT id, meta, kind, size, added FROM vault ORDER BY added DESC")?;
            let r = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
            r.collect()
        })?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, m, kind, size, added)| {
                let meta: VaultMeta = serde_json::from_slice(&open(&key, &m).ok()?).ok()?;
                Some(VaultItem { id, kind, size, added, meta })
            })
            .collect())
    }

    pub fn read_thumb(&self, id: &str) -> Result<Vec<u8>, String> {
        let key = self.key()?;
        open(&key, &std::fs::read(self.thumb(id)).map_err(|e| e.to_string())?)
    }

    /// Plain size of a vault file.
    pub fn plain_len(&self, id: &str) -> Result<u64, String> {
        let mut f = std::fs::File::open(self.file(id)).map_err(|e| e.to_string())?;
        let mut h = [0u8; HEADER];
        f.read_exact(&mut h).map_err(|e| e.to_string())?;
        if &h[..8] != MAGIC {
            return Err("corrupt".into());
        }
        Ok(u64::from_le_bytes(h[24..32].try_into().unwrap()))
    }

    /// Decrypts plain bytes [start, end] (inclusive) — only the chunks needed.
    pub fn read_range(&self, id: &str, start: u64, end: u64) -> Result<Vec<u8>, String> {
        let key = self.key()?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        let mut f = std::fs::File::open(self.file(id)).map_err(|e| e.to_string())?;
        let mut h = [0u8; HEADER];
        f.read_exact(&mut h).map_err(|e| e.to_string())?;
        let prefix: [u8; 16] = h[8..24].try_into().unwrap();
        let len = u64::from_le_bytes(h[24..32].try_into().unwrap());
        let end = end.min(len.saturating_sub(1));
        let mut out = Vec::with_capacity((end + 1 - start) as usize);
        let (c0, c1) = (start / CHUNK as u64, end / CHUNK as u64);
        let mut buf = vec![0u8; CHUNK + TAG];
        for ci in c0..=c1 {
            let off = HEADER as u64 + ci * (CHUNK + TAG) as u64;
            let plain_n = ((len - ci * CHUNK as u64).min(CHUNK as u64)) as usize;
            f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
            f.read_exact(&mut buf[..plain_n + TAG]).map_err(|e| e.to_string())?;
            let pt = cipher
                .decrypt(&xn(&chunk_nonce(&prefix, ci)), &buf[..plain_n + TAG])
                .map_err(|_| "decrypt failed")?;
            let cs = ci * CHUNK as u64;
            let a = start.saturating_sub(cs) as usize;
            let b = ((end - cs) as usize + 1).min(pt.len());
            out.extend_from_slice(&pt[a..b]);
        }
        Ok(out)
    }

    /// Decrypts back to the original location (or "<name> (restored)" if taken).
    pub fn restore(&self, db: &Db, id: &str) -> Result<String, String> {
        let key = self.key()?;
        let m: Vec<u8> = db.read(|c| c.query_row("SELECT meta FROM vault WHERE id = ?1", [id], |r| r.get(0)).optional())?
            .ok_or("Not found")?;
        let meta: VaultMeta = serde_json::from_slice(&open(&key, &m)?).map_err(|e| e.to_string())?;
        let mut target = PathBuf::from(&meta.orig_path);
        if let Some(p) = target.parent() {
            if std::fs::create_dir_all(p).is_err() {
                target = dirs_pictures().join(&meta.name);
            }
        }
        if target.exists() {
            let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let ext = target.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
            target.set_file_name(format!("{stem} (restored){ext}"));
        }
        let len = self.plain_len(id)?;
        let mut out = std::io::BufWriter::new(std::fs::File::create(&target).map_err(|e| e.to_string())?);
        let mut pos = 0u64;
        while pos < len {
            let end = (pos + CHUNK as u64 - 1).min(len - 1);
            out.write_all(&self.read_range(id, pos, end)?).map_err(|e| e.to_string())?;
            pos = end + 1;
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        self.remove(db, id)?;
        let t = target.to_string_lossy().into_owned();
        crate::index::index_one(db, &t);
        Ok(t)
    }

    pub fn remove(&self, db: &Db, id: &str) -> Result<(), String> {
        let _ = std::fs::remove_file(self.file(id));
        let _ = std::fs::remove_file(self.thumb(id));
        db.write(|c| c.execute("DELETE FROM vault WHERE id = ?1", [id]).map(|_| ()))
    }
}

fn dirs_pictures() -> PathBuf {
    std::env::var("USERPROFILE").map(|u| Path::new(&u).join("Pictures")).unwrap_or_else(|_| PathBuf::from("."))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2).ok_or("bad hex")?, 16).map_err(|e| e.to_string()))
        .collect()
}
