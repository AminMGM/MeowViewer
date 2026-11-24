# MeowViewer — Product & Build Plan

A fast, light, frosted-glass photo & video viewer + gallery for Windows.
Opens a single file instantly like macOS Preview, and browses your whole library like Samsung Gallery.
Shares its look (graphite glass over Windows acrylic, accent colour, adjustable blur) with MeowPlayer.

---

## 1. Stack decision

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** (Rust) + WebView2 | ~10 MB installer, ~50–80 MB RAM, ~300 ms cold start. Electron (MeowPlayer's stack) costs ~150 MB RAM and ~1 s+ to first paint, which kills the "double-click → image is already there" feel. |
| UI | **React 19 + Vite + TypeScript + Zustand** | Same as MeowPlayer, so the design tokens, glass CSS, sidebar, context menus, modals and settings pages port over directly. |
| Core (Rust) | indexer, thumbnailer, decoders, metadata, DB, file ops, crypto, Windows APIs | All heavy work off the UI thread, in parallel (rayon/tokio). |
| Database | **SQLite** (WAL) + **FTS5** (text search) + **sqlite-vec** (semantic search vectors) | One file, instant queries over 100k+ items. |
| Image decode | WebView2 native (JPEG/PNG/GIF/WebP/AVIF/BMP/ICO/SVG) → Rust fallbacks: **libheif** (HEIC/HEIF), **jxl-oxide** (JPEG XL), **LibRaw** (RAW), **tiff**, **psd** composite, **exr/hdr**, **tga**, **qoi** | Fast path uses the browser decoder (GPU-accelerated); exotic formats decode in Rust into a GPU-ready texture/blob. |
| Video | WebView2 `<video>` (H.264, HEVC*, VP9, AV1, MP4/WebM/MOV) → **FFmpeg sidecar**: remux to fragmented MP4 on the fly (MKV/AVI/FLV/TS — instant, no re-encode) → hardware transcode (NVENC/QSV/AMF) only for truly exotic codecs (WMV, MPEG-2, ProRes, DivX…) | "All codecs" with one UI. *HEVC needs the HEVC Video Extension or hardware support — detect and fall back to transcode. |
| ML (on-device) | **ONNX Runtime + DirectML** (GPU, any vendor) | Semantic search, object tags, faces, background removal — no cloud, no API cost. |
| OCR | **Windows.Media.Ocr** (built into Windows, free, offline) | Search text inside screenshots/photos. |
| Map | **MapLibre GL** + OpenStreetMap tiles; offline reverse-geocoding with GeoNames cities DB | No API key. |
| Metadata write | **exiv2** (via bindings) for EXIF/XMP/IPTC; bundled **ExifTool** for edge cases & video | Exact, standards-compatible writes. |

Prerequisites to install: Rust (rustup), Visual Studio Build Tools (C++), FFmpeg (bundled in installer).

---

## 2. Performance budget ("fast and light")

| Metric | Target |
|---|---|
| Double-click a JPEG in Explorer → visible | < 300 ms (warm), < 600 ms (cold) |
| Next/prev image | < 30 ms (neighbours pre-decoded) |
| Gallery grid scroll | 120 fps, virtualized, no jank at 100k items |
| Idle RAM | < 90 MB |
| First index of 50k photos | background, throttled, UI usable immediately |

Techniques:
- **Single instance** — second launch passes the file to the running process (no second boot). Optional "keep warm in tray".
- **Progressive display** — show the embedded EXIF thumbnail / RAW embedded JPEG instantly, swap to full-res when decoded.
- **Preload** ±2 neighbours, release far images; GPU textures capped by a memory budget.
- **Thumbnail cache** — 2 sizes (256 px grid, 1024 px preview) as WebP in `%LOCALAPPDATA%/MeowViewer/thumbs`, keyed by path + size + mtime. Use Windows shell thumbnail cache (`IShellItemImageFactory`) for cloud placeholders so OneDrive files are **never downloaded** just to make a thumbnail.
- **Incremental indexing** — `ReadDirectoryChangesW` watcher (notify crate); on startup compare mtime/size only. Heavy jobs (OCR, ML embeddings, faces) run in a low-priority queue, pause on battery / when the user is active.
- **Virtualized grid** with fixed row heights per zoom level; images decoded at display size via `createImageBitmap` with resize options.
- Custom `mv-media://` protocol with HTTP range support (ported from MeowPlayer's `range.ts`) for video seeking.

---

## 3. Two modes, one app

### A. Viewer mode (opened from Explorer — "macOS Preview" feel)
- Window sizes itself to the image (clamped to screen), glass chrome, title bar & toolbar **auto-hide** after 1.5 s idle; show on mouse move.
- Navigate the folder with ← → / wheel / swipe; filmstrip at the bottom (toggle).
- Zoom: wheel / Ctrl+wheel / pinch / double-click (fit ↔ 100%), smooth pan with inertia, zoom-to-cursor, pixel-perfect at >100%.
- Fit modes: fit, fill, 100%, fit width. Fullscreen (F11 / double-click), presentation black background.
- Rotate (R / Shift+R), flip — **lossless** for JPEG (EXIF orientation or lossless transform), prompt to save.
- Inspector panel (I): info, histogram, map, tags.
- Space = play/pause video & animated GIF/WebP; frame-step with , and .
- "Open in Gallery" button jumps to the item inside the library.

### B. Gallery mode (Samsung Gallery feel)
Sidebar tabs: **Pictures (timeline) · Albums · Stories/Memories · Map · Search · Favorites · Recent · Private · Trash · Settings**

---

## 4. Feature spec (everything you asked for)

### Library & folders
- **Library settings**: choose root folders to include/exclude (default: Pictures, Videos, Downloads, Desktop, OneDrive\Pictures, Google Drive). Per-folder "include subfolders".
- **Folders inside folders** — nested album tree mirrors disk; breadcrumb navigation; "flatten view" toggle to show all media of a folder tree at once.
- **Hide folders** — hidden folders are excluded from timeline, search, Recent and Map, but still listed under *Settings → Hidden folders* to unhide. (Hide ≠ Private: hide is just declutter.)
- **Album covers** — auto = newest item; right-click → *Change cover* to pick any item, with crop of the cover thumbnail.
- **Custom albums** (virtual, no file copies) + "Move/Copy into folder" (real disk operations).
- **Recently added** — by import/index date (not EXIF date), last 30 days, grouped by day.
- **Favorites** — heart in viewer & grid (shortcut: F); stored in DB and mirrored to XMP `xmp:Rating`/label so other apps see it.

### Auto albums (by app / source / category)
Detected from path patterns + filename patterns + EXIF `Software`/`Make` + ML:
- **By app**: Screenshots, Screen recordings, Camera, WhatsApp, Telegram, Instagram, Snapchat, Discord, Downloads, Edited (by MeowViewer/Photoshop/Lightroom), Phone imports.
- **By type**: Photos, Videos, GIFs, RAW, HEIC, Live/Motion photos, Panoramas, 360°, Selfies (front camera EXIF), Portraits (depth data), Slow-mo, Long videos.
- **By content (ML)**: Documents & receipts, Food, Pets, Nature, Cars, Text-heavy, People, Night, Sky… (top ~40 categories from CLIP zero-shot).
- Each auto album can be pinned, hidden, or turned into a regular album.

### Sorting & grouping
Date taken · date modified · date added · name (natural sort) · size · type · resolution · duration · rating · random. Asc/desc. Group by day/month/year/folder/none. Grid density with Ctrl+wheel (Samsung-style pinch through year → month → day).

### Categories by type
Filter chips on every view: All · Photos · Videos · GIFs · RAW · Screenshots · Favourites · Has location · Has text.

### Search (like Samsung Gallery)
One search box, instant results, combines:
- **Text inside images** (OCR, FTS5) — "invoice 2024", a phone number from a screenshot.
- **Semantic / object search** (CLIP-style embeddings via ONNX, e.g. MobileCLIP/SigLIP) — "dog on beach", "red car at night".
- **Metadata** — camera, lens, ISO, place name ("Paris"), date expressions ("last summer", "March 2023").
- **Tags, captions, filenames, folder names, people names**.
- Suggested chips: places, things, people, document types. Saved searches become **smart albums**.

### Map
- Map tab with clustered pins (counts), heatmap toggle; click cluster → grid of those items.
- In viewer: "Show on map" mini-map in inspector; *Open in Google Maps / Bing Maps* button.
- **Edit location**: drag pin or search a place; batch-assign location to many items.

### Viewer actions
- **Copy** (image to clipboard as bitmap + file), Copy path, Copy as text (OCR).
- **Set as wallpaper** — desktop (fill/fit/centre/span), lock screen, per-monitor; also "rotating wallpaper from album".
- **Print** — own print dialog: layouts (full page, 4×6, 2×2 contact sheet, wallet), margins, fit/fill, then Windows print.
- **Search with Google** — Google Lens upload (unofficial endpoint, may change → fallback: copy image + open lens.google.com). Warn once that the image is uploaded.
- **Open file location**, Open with…, Rename (F2), Duplicate, Convert format, Resize.
- **Add desktop shortcut** — for a file, folder, album or smart album (`.lnk` with `meowviewer://album/…` deep link and custom icon from the album cover).
- **Slideshow** — interval, shuffle, transitions (fade/Ken Burns/slide), background music (pick a file or a MeowPlayer playlist), include videos, loop, choose album/selection.

### Share
- **Windows share sheet** (DataTransferManager) — covers Nearby Share, Mail, Phone Link and any app registered as share target.
- **Telegram** — `Telegram.exe -sendpath <file>` (detects Desktop & Store installs).
- **Bluetooth** — via share sheet / `fsquirt` wizard.
- **Email** — MAPI attach (default mail client) or Outlook; mailto fallback.
- **Quick Share** (Google's Windows app) — hand off files where installed; verify integration during build.
- **WhatsApp Desktop** via share sheet.
- Share options: convert HEIC→JPG, resize (S/M/L/original), **strip location**, strip all metadata.

### Metadata & info (editable)
- Info panel: filename, path, size, dimensions, MP, format, colour profile, date taken/modified/added, camera, lens, focal length, aperture, shutter, ISO, flash, GPS + place, video codec/bitrate/fps/audio tracks, duration.
- Editable: title, caption/description, date taken (single or batch shift by offset — fixes wrong camera clocks), location, rating, author, copyright, keywords.
- Write mode setting: **into file** (EXIF/XMP/IPTC) · **XMP sidecar** · **database only**. Originals' timestamps preserved.

### Tags (editable)
- Free tags + hierarchical tags (`Travel/Japan/Kyoto`), colours, auto-tags from ML shown as suggestions (accept/reject).
- Batch tagging on multi-select; tag manager (rename/merge/delete); written to XMP `dc:subject` so Lightroom/digiKam read them.

### Trash
- App trash with **30-day retention** (configurable), restore to original path, empty trash, "Delete permanently". Optional: use Windows Recycle Bin instead.
- Every delete shows an **Undo** toast.

### Private album (PIN)
- PIN (6 digits) or password, plus **Windows Hello** (face/fingerprint) unlock.
- Files are **moved and encrypted** (XChaCha20-Poly1305, key from Argon2id(PIN); key wrapped by Windows Hello/DPAPI) into a private vault — they disappear from Explorer and every other view. Thumbnails encrypted too; nothing in OCR/search index unless unlocked.
- Auto-lock on minimize / after N minutes; screenshot protection (`SetWindowDisplayAffinity`) while open; PIN recovery via recovery key shown once.

### Light photo editor
Non-destructive (edit stack stored, original kept → "Revert to original" anytime, like Samsung). Live preview with WebGL shaders, final render in Rust at full resolution.
- **Transform**: crop (free/1:1/4:3/16:9/original), rotate, straighten slider, flip, perspective.
- **Adjust**: auto-enhance, exposure, brightness, contrast, highlights, shadows, whites, blacks, saturation, vibrance, warmth, tint, sharpness, clarity, vignette, noise reduction.
- **Filters**: ~12 presets + intensity slider; save your own.
- **Markup**: pen, highlighter, arrows, shapes, text, blur/pixelate (redact), emoji stickers.
- **Video**: trim, rotate, mute, extract frame as photo, speed, save as GIF.
- Save as copy / overwrite (with original backup). Export format & quality.

### Cloud sync (OneDrive & Google Drive)
- **Phase 1 (simple, robust)**: detect OneDrive / Google Drive for Desktop folders and include them as library roots; show cloud status badge (online-only / local / syncing) using placeholder attributes; "Download / Free up space" actions. Thumbnails from shell cache so nothing is downloaded unnecessarily.
- **Phase 2 (API)**: Microsoft Graph + Google Drive API (OAuth PKCE, tokens in Windows Credential Manager) for: browsing cloud-only photos without the desktop client, uploading an album, **backup a folder**, share link to an album.
- Albums/tags/favourites sync between PCs by syncing a small `meowviewer-library.json` in the user's chosen cloud folder.

### Look & feel (MeowPlayer glass)
- Port `tokens.css`, `shell.css`, `components.css` from MeowPlayer V2: graphite shell, translucent surfaces over Windows **acrylic/Mica**, accent colour, adjustable blur, light/dark/auto.
- Viewer background options: glass, black, dark grey, checkerboard (transparency), blurred-image ambient.
- Auto-hide everything in viewer and fullscreen; hover zones reveal toolbar/filmstrip.
- Smooth shared-element zoom from grid thumbnail into viewer (Samsung-style).
- Cat logo icon; per-format file icons generated from the logo.

---

## 5. Data model (SQLite)

```
roots(id, path, include_subfolders, hidden)
folders(id, root_id, parent_id, path, name, hidden, cover_media_id, sort_pref)
media(id, folder_id, path, name, ext, kind[photo|video|gif|raw|...], size, mtime, added_at,
      taken_at, width, height, duration_ms, orientation, lat, lon, place_id, camera, lens,
      iso, fnum, exposure, focal, rating, favorite, color_label, cloud_state,
      source_app, is_screenshot, is_motion_photo, is_360, hash_xxh3, phash, deleted_at)
places(id, city, region, country)
tags(id, name, parent_id, color)          media_tags(media_id, tag_id, source[user|ml], score)
albums(id, name, type[manual|smart|auto], rule_json, cover_media_id, pinned, hidden, sort)
album_items(album_id, media_id, position)
ocr_fts(media_id, text)  -- FTS5
embeddings(media_id, vec)  -- sqlite-vec
faces(id, media_id, bbox, vec, person_id)  persons(id, name, cover_face_id, hidden)
edits(media_id, stack_json, original_backup_path, updated_at)
trash(media_id, original_path, trashed_at)
vault_items(id, enc_path, enc_thumb, meta_enc)   -- private album
jobs(id, kind, media_id, state, priority)
settings(key, value)
```

---

## 6. Project structure

```
MeowViewer/
  src-tauri/
    src/
      main.rs            app, single-instance, deep links, tray
      index/             scanner, watcher, job queue
      decode/            heif, raw, jxl, tiff, psd, exr; thumbnailer
      video/             ffmpeg sidecar: probe, remux, transcode, thumbnails
      meta/              exif/xmp/iptc read+write, geocode
      ml/                onnx: clip, tagger, faces, bg-removal; ocr (Windows.Media.Ocr)
      db/                sqlite schema, migrations, queries
      ops/               copy/move/rename/trash/convert/resize/print/wallpaper
      share/             share sheet, telegram, mail, bluetooth, lens
      vault/             private album crypto, Windows Hello
      cloud/             onedrive (graph), google drive
      protocol.rs        mv-media:// range server
  src/
    app/ views/ (Timeline, Albums, Folder, Map, Search, Favorites, Recent, Private, Trash, Settings)
    viewer/ (Canvas, Filmstrip, Inspector, Toolbar, VideoPlayer, Slideshow)
    editor/ (webgl pipeline, tools)
    components/ store/ styles/ (ported from MeowPlayer)
```

---

## 7. Build phases (thin vertical slice first)

| # | Phase | Deliverable |
|---|---|---|
| 0 | Scaffold | Tauri 2 + Vite React TS, MeowPlayer glass ported, acrylic window, single instance, file associations |
| 1 | **Viewer MVP** | Open from Explorer, folder navigation, zoom/pan, rotate, fullscreen, auto-hide, filmstrip, copy, delete-to-trash, info panel. *Ship this first — it's usable on day one.* |
| 2 | Formats | HEIC, AVIF, JXL, RAW, TIFF, PSD, SVG, animated GIF/WebP; video via native + FFmpeg remux/transcode |
| 3 | Library | Library settings, indexer + watcher, thumbnails, timeline, folders tree, hide folders, sorting, type filters, favorites, recent |
| 4 | Albums | Manual albums, covers, auto albums (by app/type), trash with restore |
| 5 | Actions | Share (sheet/Telegram/mail/Bluetooth/Quick Share), wallpaper, print, Lens search, desktop shortcuts, slideshow |
| 6 | Metadata | Editable info, tags, batch edit, write modes; map tab + location editing |
| 7 | Editor | Crop/rotate/adjust/filters/markup, video trim, non-destructive |
| 8 | Search | OCR, CLIP semantic search, ML categories, smart albums |
| 9 | Private | Encrypted vault, PIN + Windows Hello |
| 10 | Cloud | OneDrive/Google Drive folder integration → API sync & backup |
| 11 | Polish | 30 ideas below, installer, auto-updater (like MeowPlayer), tests, perf profiling |

---

## 8. Thirty more ideas

1. **Spacebar Quick Look in Explorer** — select a file in Explorer, press Space, MeowViewer peeks it (like macOS).
2. **Duplicate & similar finder** — exact (hash) + near-duplicates (perceptual hash), keep-best suggestion.
3. **Burst & series grouping** — stacks shots taken within seconds; auto-pick the sharpest/eyes-open one.
4. **Memories / "On this day"** — auto stories with music and Ken Burns, exportable as video.
5. **People** — on-device face clustering, name people, search by person.
6. **Compare mode** — 2–4 images side by side with synced zoom/pan.
7. **Motion / Live photos** — play Samsung Motion Photos, Google Motion Photos, iPhone Live Photos (HEIC+MOV pair).
8. **360° & panorama viewer** — drag-to-look sphere for photo spheres and 360 videos.
9. **Remove background / copy subject** — on-device cutout, copy as PNG sticker.
10. **Live Text** — select and copy text directly on the image; click phone numbers, URLs, emails.
11. **QR & barcode detection** — open link / copy content / Wi-Fi join.
12. **Batch tools** — rename with patterns, convert, resize, compress, strip metadata, watermark.
13. **Screenshot cleanup** — "You have 1,240 screenshots older than 6 months — review?".
14. **Storage insights** — biggest videos, duplicates, blurry photos; one-click free space.
15. **GIF maker & frame grabber** — select a range from a video, export GIF/WebP/MP4 clip.
16. **Collage maker** — 2–9 photo templates, borders, export.
17. **Star ratings & colour labels** — Lightroom-compatible XMP, filter by them (1–5 keys).
18. **Smart albums** — rule builder (e.g. "RAW from Sony, 2025, rated ≥4, in Japan").
19. **Fast-scroll timeline** — year/month scrubber on the right edge like Samsung.
20. **Phone import** — iPhone/Android over USB (MTP/WPD), skip already-imported, auto-delete from phone option.
21. **SD card / camera auto-import** — detect card insert, import to dated folders.
22. **Cast to TV** — Chromecast/DLNA slideshow and video.
23. **HDR support** — Ultra HDR (gain map) JPEG, HDR AVIF/HEIC on HDR displays.
24. **Photographer overlay** — histogram, clipping warnings, focus points, EXIF HUD.
25. **Colour management** — honour ICC profiles and the monitor profile.
26. **AI upscale & denoise** — Real-ESRGAN via ONNX for small/old photos.
27. **Document scanner mode** — perspective-correct photos of paper, export as PDF.
28. **Trips** — auto-albums from location clusters away from home + map route.
29. **Command palette (Ctrl+K)** and fully remappable keyboard shortcuts.
30. **Rotating desktop/lock-screen wallpaper** from any album on a schedule.
31. *(bonus)* **Portable mode** — run from USB with library DB next to the exe.
32. *(bonus)* **MeowPlayer link** — slideshow music from MeowPlayer playlists; shared theme setting.
33. *(bonus)* **Undo history** for every file operation (move, rename, delete, edit) across the session.

---

## 9. Risks & open points
- **"All codecs"**: native WebView2 + FFmpeg remux/transcode covers practically everything; HEVC depends on the system codec, so detect and fall back. Bundling FFmpeg: use an LGPL build to keep licensing simple.
- **Google Lens** has no public upload API — the endpoint can change; keep the copy-and-open fallback.
- **Quick Share** integration is via the user's installed app — confirm what it exposes during Phase 5.
- **Windows Hello** for the vault needs the `Windows.Security.Credentials` WinRT API from Rust (windows crate) — doable, test early.
- ML models add ~100–200 MB; make them an **optional download** in settings to keep the base install light.
