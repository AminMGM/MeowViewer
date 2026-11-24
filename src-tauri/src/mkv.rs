//! Native Matroska (MKV/WebM) subtitle reader: lists text subtitle tracks and extracts them as
//! SRT text without FFmpeg. Only subtitle blocks are read; video/audio payloads are skipped by
//! seeking, so even multi-GB files are scanned in seconds.

use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};

const SEGMENT: u32 = 0x1853_8067;
const INFO: u32 = 0x1549_A966;
const TIMECODE_SCALE: u32 = 0x2A_D7B1;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const TRACK_TYPE: u32 = 0x83;
const CODEC_ID: u32 = 0x86;
const LANGUAGE: u32 = 0x22_B59C;
const LANGUAGE_BCP47: u32 = 0x22_B59D;
const NAME: u32 = 0x53_6E;
const FLAG_DEFAULT: u32 = 0x88;
const FLAG_FORCED: u32 = 0x55AA;
const CLUSTER: u32 = 0x1F43_B675;
const CLUSTER_TIMECODE: u32 = 0xE7;
const SIMPLE_BLOCK: u32 = 0xA3;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const BLOCK_DURATION: u32 = 0x9B;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubTrack {
    pub number: u64,
    pub codec: String,
    pub language: String,
    pub name: String,
    pub default: bool,
    pub forced: bool,
}

struct R {
    f: BufReader<File>,
    pos: u64,
}

impl R {
    fn byte(&mut self) -> Option<u8> {
        let mut b = [0u8; 1];
        self.f.read_exact(&mut b).ok()?;
        self.pos += 1;
        Some(b[0])
    }
    /// Element ID (marker bits kept).
    fn id(&mut self) -> Option<u32> {
        let first = self.byte()?;
        let len = first.leading_zeros() as usize + 1;
        if len > 4 {
            return None;
        }
        let mut v = first as u32;
        for _ in 1..len {
            v = (v << 8) | self.byte()? as u32;
        }
        Some(v)
    }
    /// Size vint (marker removed). None for "unknown size".
    fn size(&mut self) -> Option<Option<u64>> {
        let first = self.byte()?;
        let len = first.leading_zeros() as usize + 1;
        if len > 8 {
            return None;
        }
        let mut v = (first as u64) & (0xFF >> len);
        let mut all_ones = v == (0xFF >> len) as u64;
        for _ in 1..len {
            let b = self.byte()?;
            all_ones &= b == 0xFF;
            v = (v << 8) | b as u64;
        }
        Some(if all_ones { None } else { Some(v) })
    }
    fn bytes(&mut self, n: u64) -> Option<Vec<u8>> {
        if n > 16 * 1024 * 1024 {
            return None;
        }
        let mut b = vec![0u8; n as usize];
        self.f.read_exact(&mut b).ok()?;
        self.pos += n;
        Some(b)
    }
    fn skip(&mut self, n: u64) -> Option<()> {
        self.f.seek_relative(n as i64).ok()?;
        self.pos += n;
        Some(())
    }
    fn uint(&mut self, n: u64) -> Option<u64> {
        Some(self.bytes(n)?.iter().fold(0u64, |a, b| (a << 8) | *b as u64))
    }
    fn string(&mut self, n: u64) -> Option<String> {
        Some(String::from_utf8_lossy(&self.bytes(n)?).trim_end_matches('\0').to_string())
    }
}

fn open(path: &str) -> Option<R> {
    let f = File::open(path).ok()?;
    let mut r = R { f: BufReader::with_capacity(64 * 1024, f), pos: 0 };
    // EBML header
    if r.id()? != 0x1A45_DFA3 {
        return None;
    }
    let sz = r.size()??;
    r.skip(sz)?;
    Some(r)
}

fn is_text(codec: &str) -> bool {
    matches!(codec, "S_TEXT/UTF8" | "S_TEXT/ASCII" | "S_TEXT/ASS" | "S_TEXT/SSA" | "S_ASS" | "S_SSA" | "S_TEXT/WEBVTT")
}

fn parse_tracks(r: &mut R, end: u64) -> Option<Vec<SubTrack>> {
    let mut out = Vec::new();
    while r.pos < end {
        let id = r.id()?;
        let sz = r.size()??;
        if id != TRACK_ENTRY {
            r.skip(sz)?;
            continue;
        }
        let entry_end = r.pos + sz;
        let mut t = SubTrack { number: 0, codec: String::new(), language: "und".into(), name: String::new(), default: true, forced: false };
        let mut kind = 0;
        while r.pos < entry_end {
            let id = r.id()?;
            let sz = r.size()??;
            match id {
                TRACK_NUMBER => t.number = r.uint(sz)?,
                TRACK_TYPE => kind = r.uint(sz)?,
                CODEC_ID => t.codec = r.string(sz)?,
                LANGUAGE => t.language = r.string(sz)?,
                LANGUAGE_BCP47 => t.language = r.string(sz)?,
                NAME => t.name = r.string(sz)?,
                FLAG_DEFAULT => t.default = r.uint(sz)? != 0,
                FLAG_FORCED => t.forced = r.uint(sz)? != 0,
                _ => r.skip(sz)?,
            }
        }
        if kind == 0x11 && is_text(&t.codec) {
            out.push(t);
        }
    }
    Some(out)
}

/// Text subtitle tracks in an MKV/WebM file (reads only the header area).
pub fn tracks(path: &str) -> Vec<SubTrack> {
    let run = || -> Option<Vec<SubTrack>> {
        let mut r = open(path)?;
        if r.id()? != SEGMENT {
            return None;
        }
        let seg_end = r.size()?.map(|s| r.pos + s).unwrap_or(u64::MAX);
        while r.pos < seg_end {
            let id = r.id()?;
            let sz = r.size()?;
            match (id, sz) {
                (TRACKS, Some(s)) => {
                    let end = r.pos + s;
                    return parse_tracks(&mut r, end);
                }
                (CLUSTER, _) => return Some(Vec::new()), // tracks always precede clusters
                (_, Some(s)) => r.skip(s)?,
                (_, None) => return None,
            }
        }
        Some(Vec::new())
    };
    run().unwrap_or_default()
}

struct Cue {
    start: i64,
    dur: Option<i64>,
    text: String,
}

fn fmt_srt(ms: i64) -> String {
    let ms = ms.max(0);
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}

/// ASS dialogue blocks in Matroska: "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text".
fn ass_text(s: &str) -> String {
    s.splitn(9, ',').nth(8).unwrap_or(s).to_string()
}

/// Extracts one text subtitle track as SRT text.
pub fn extract(path: &str, track: u64) -> Result<String, String> {
    let run = || -> Option<(Vec<Cue>, String)> {
        let mut r = open(path)?;
        if r.id()? != SEGMENT {
            return None;
        }
        let seg_end = r.size()?.map(|s| r.pos + s).unwrap_or(u64::MAX);
        let mut scale_ns: u64 = 1_000_000;
        let mut codec = String::new();
        let mut cluster_tc: i64 = 0;
        let mut cues: Vec<Cue> = Vec::new();
        // Containers we "enter" instead of skipping: Cluster (children follow inline; also handles
        // unknown-size clusters) and BlockGroup (bounded, to pair Block with BlockDuration).
        let mut group: Option<(u64, Option<Cue>, Option<i64>)> = None;
        while r.pos < seg_end {
            if let Some((gend, _, _)) = &group {
                if r.pos >= *gend {
                    let (_, cue, dur) = group.take().unwrap();
                    if let Some(mut c) = cue {
                        c.dur = dur.map(|d| d * scale_ns as i64 / 1_000_000);
                        cues.push(c);
                    }
                    continue;
                }
            }
            let Some(id) = r.id() else { break };
            let Some(sz) = r.size() else { break };
            match id {
                INFO => {
                    let end = r.pos + sz?;
                    while r.pos < end {
                        let cid = r.id()?;
                        let csz = r.size()??;
                        if cid == TIMECODE_SCALE {
                            scale_ns = r.uint(csz)?;
                        } else {
                            r.skip(csz)?;
                        }
                    }
                }
                TRACKS => {
                    let end = r.pos + sz?;
                    let ts = parse_tracks(&mut r, end)?;
                    codec = ts.into_iter().find(|t| t.number == track).map(|t| t.codec).unwrap_or_default();
                }
                CLUSTER => {}
                CLUSTER_TIMECODE => cluster_tc = r.uint(sz?)? as i64,
                BLOCK_GROUP => group = Some((r.pos + sz?, None, None)),
                BLOCK_DURATION => {
                    let d = r.uint(sz?)? as i64;
                    if let Some(g) = group.as_mut() {
                        g.2 = Some(d);
                    }
                }
                SIMPLE_BLOCK | BLOCK => {
                    let sz = sz?;
                    let start = r.pos;
                    // Track number is a size-style vint.
                    let first = r.byte()?;
                    let len = first.leading_zeros() as u64 + 1;
                    let mut num = (first as u64) & (0xFF >> len);
                    for _ in 1..len {
                        num = (num << 8) | r.byte()? as u64;
                    }
                    if num != track {
                        r.skip(sz - (r.pos - start))?;
                        continue;
                    }
                    let rel = i16::from_be_bytes([r.byte()?, r.byte()?]) as i64;
                    let _flags = r.byte()?;
                    let data = r.bytes(sz - (r.pos - start))?;
                    let mut text = String::from_utf8_lossy(&data).trim_end_matches('\0').to_string();
                    if codec.contains("ASS") || codec.contains("SSA") {
                        text = ass_text(&text);
                    }
                    let cue = Cue { start: (cluster_tc + rel) * scale_ns as i64 / 1_000_000, dur: None, text };
                    match group.as_mut() {
                        Some(g) if id == BLOCK => g.1 = Some(cue),
                        _ => cues.push(cue),
                    }
                }
                _ => match sz {
                    Some(s) => r.skip(s)?,
                    None => {} // unknown-size container: children follow inline
                },
            }
        }
        if let Some((_, Some(mut c), d)) = group.take() {
            c.dur = d.map(|d| d * scale_ns as i64 / 1_000_000);
            cues.push(c);
        }
        Some((cues, codec))
    };
    let (mut cues, _) = run().ok_or("Couldn't read subtitles from this file")?;
    if cues.is_empty() {
        return Err("This subtitle track is empty".into());
    }
    cues.sort_by_key(|c| c.start);
    let mut out = String::new();
    for i in 0..cues.len() {
        let c = &cues[i];
        let next = cues.get(i + 1).map(|n| n.start).unwrap_or(c.start + 5000);
        let end = c.start + c.dur.unwrap_or_else(|| (next - c.start).clamp(500, 5000));
        let text = c.text.replace("\r\n", "\n");
        out.push_str(&format!("{}\n{} --> {}\n{}\n\n", i + 1, fmt_srt(c.start), fmt_srt(end), text.trim()));
    }
    Ok(out)
}
