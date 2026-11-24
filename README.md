# MeowViewer

A fast, light photo & video viewer and gallery for Windows, with a glass look in light and dark.

Double-click a photo in Explorer and it opens instantly, sized to the image, like the macOS viewer. Open the
gallery to browse your whole library like a phone gallery: timeline, albums, folders inside folders,
auto-albums by app, a map of your photos, a private encrypted album, editing and cleanup tools.

Built with **Tauri 2 (Rust)** + **React + Vite**. It idles at about 150–200 MB with a 12,000-item library, and
thumbnails come from the Windows shell, so OneDrive files that are online-only are never downloaded just to
show a thumbnail.

## Features

**Viewer**
- Opens from Explorer in a window sized to the photo; ← → to move through the folder
- Zoom to cursor (wheel, Ctrl+wheel, touchpad pinch), drag to pan, double-click 100% / fit
- Lossless JPEG/TIFF rotation (EXIF orientation rewritten in place, pixels untouched)
- Ambient, dark or black background; auto-hiding controls; full screen; filmstrip; slideshow
- **Live Text**: select and copy text directly on photos and screenshots (on-device OCR)
- **Motion photos** (Samsung / Google / Pixel): play the clip embedded in the JPEG
- Info panel: camera, lens, exposure, RGB histogram, mini map, star rating, description, tags,
  editable date taken and location

**Video player**
- Glass controls, seek bar with frame preview on hover, ±10 s, volume (remembered), speed 0.25–3×
- Loop and A-B loop, frame stepping, save frame as PNG, rotate, fill/fit, picture-in-picture
- Automatic subtitles from a matching `.srt` / `.vtt` file
- Every format: MP4/MOV/WebM/MKV play natively; with the optional codec pack (FFmpeg, downloaded once)
  AVI, WMV, MPEG, TS, FLV and the rest are remuxed or converted on the fly

**Formats**
- JPEG, PNG, GIF, WebP, AVIF, BMP, ICO, SVG natively
- HEIC/HEIF, TIFF, JPEG XR, DDS, PSD preview, JPEG XL… through Windows codecs
- RAW: CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2… (fast embedded preview)

**Gallery**
- Photos timeline grouped by day / month, date bubble and year scrubber while scrolling
- **On this day** memories
- Albums: folder tree or flat list, change covers, hide folders, **your own albums**, **smart albums**
  (saved searches), tags
- Auto-albums by app: Camera, Screenshots, Screen recordings, WhatsApp, Telegram, Instagram, Downloads…
- **Places**: a map of your photos (dark "Shades of Grey" / light "Masik" styles following the theme),
  clustered photo pins and the photos in view
- **Search** by file name, folder, camera, app, tag, description and **text inside photos**
- Filters by type and rating, 6 sort orders, multi-select, Compare (2–4 photos side by side, synced zoom)
- **Private album**: files are encrypted (XChaCha20-Poly1305, Argon2id PIN) and hidden from everything else;
  auto-locks when you leave or go idle
- **Cleanup**: storage by type and app, exact and similar duplicates, old screenshots, files over 50 MB,
  import from camera / SD card
- Trash with restore, auto-cleanup and Undo

**Editor**
- Crop (free and fixed ratios), rotate, flip, straighten
- Exposure, contrast, saturation, warmth, tint, fade, vignette, soften; auto enhance
- 10 filters; pen and highlighter markup; undo/redo; hold to compare
- Save as a copy, or over the original with a backup kept

**Actions**
- Copy (image + file), copy path, rename, open with, show in Explorer, **Open in Photoshop** (and other
  installed editors: Lightroom, Illustrator, GIMP, Affinity Photo, Paint.NET)
- Share: Windows share sheet, Telegram (desktop or Microsoft Store), e-mail, Bluetooth, Nearby/Quick Share
- Set as wallpaper, print, search with Google Lens (uses your browser's Google session)
- Export / convert / resize (location data removed), desktop shortcuts, add to album

**Look** — light, dark or follow Windows; 7 accent colours; Mica window.
**Updates** — built-in updater that installs signed releases from this repository.

## Shortcuts (viewer)

| Key | Action |
|---|---|
| ← → / PgUp PgDn / Home End | Previous / next / first / last (videos: ← → seek 5 s) |
| + − 0 1 | Zoom in / out / fit / 100% |
| R / Shift+R | Rotate right / left |
| F / F11 / Enter | Full screen |
| I / T / E / B | Info / Live Text / Edit / filmstrip |
| L | Favourite (videos: forward 10 s) |
| Space / K, J | Play-pause, back 10 s |
| ↑ ↓ / M / [ ] / , . / C | Video volume / mute / speed / frame step / captions |
| F5 | Slideshow |
| Del | Move to Trash |
| Ctrl+C / Ctrl+P / F2 | Copy / print / rename |
| Esc | Back / exit full screen |

In the gallery: Ctrl+K search, Ctrl+wheel resizes thumbnails, Alt+← back.

## Development

Requirements: Node 20+, Rust (stable, MSVC), Visual Studio C++ Build Tools, Windows 10/11 SDK.

```bash
npm install
npm run dev        # the app (Tauri + Vite dev server with hot reload)
npm run dist       # release installer → src-tauri/target/release/bundle/nsis
```

Vite is the frontend's build tool: `npm run dev` starts it automatically for Tauri (`npm run vite` runs only
the web part, which isn't useful on its own).

## Releasing (built-in updates)

The app checks `https://github.com/AminMGM/MeowViewer/releases/latest/download/latest.json`.

1. Bump `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. `git tag v0.2.0 && git push origin v0.2.0`
3. The **Release** workflow builds the installer, signs the update and publishes the release.

The repository needs the secret `TAURI_SIGNING_PRIVATE_KEY` (contents of the private updater key). Keep that
key safe: without it, existing installs can't verify new updates.

## Not yet

On-device AI (search by objects like "dog on beach", people/face grouping, background removal, upscaling)
needs a downloadable model pack; Google Drive / OneDrive API sync (beyond their desktop folders) needs app
registrations with Google and Microsoft. See [PLAN.md](PLAN.md).

## License

MIT
