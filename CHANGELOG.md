# Changelog

## v1.1.0

**New**
- Subtitles inside MKV / WebM files (SRT, ASS, WebVTT) are read directly — no codec pack needed — and load
  automatically; right-to-left subtitles (Farsi, Arabic, Hebrew) display correctly
- Installs to Program Files by default
- Your app icon everywhere: title bar, setup, taskbar, Start menu, desktop and installer

**Fixed**
- Installing or updating while MeowViewer is open failed with "Error opening file for writing" — the installer
  now closes the app first and refreshes Windows' icon cache

## v1.0.0

The first stable release.

**New**
- First-launch setup: theme, accent colour, library folders, optional downloads, default app
- Video player: subtitles (auto-load, load file, embedded tracks, size / colour / background / position / delay),
  resume where you left off, audio track switching, volume boost, equaliser, picture adjustments,
  aspect-ratio override, jump to time, always on top, auto-play next
- Photo editor rebuilt on the GPU: highlights, shadows, whites, blacks, vibrance, clarity, sharpen, grain,
  12 looks, live histogram, before/after, arrows, shapes, text, blur and pixelate; JPEG saves keep camera info,
  date and location
- Export / convert dialog: JPEG, PNG, WebP, TIFF, BMP, GIF, size presets, destination choice
- Compare is in the right-click menu (select 2–4 photos) and in the viewer menu
- Themed installer, new full-bleed icon, "Made with ❤️ by AminMGM" credit

**Fixed**
- Live Text: selection lines up with the words, Ctrl+C copies the selected text with line breaks
- Bluetooth sends the file directly instead of asking for a path
- Private album: confirming a new PIN starts empty; "Move to private" asks for the PIN in place
- Year scrubber no longer covers the sort button
- Telegram from the Microsoft Store and Google Lens work
- Duplicate list keys in the viewer and grid; the window always appears even if the UI is slow to load

## v0.2.0

Map view, private album, OCR search and Live Text, motion photos, editor, cleanup tools, light mode.

## v0.1.0

Viewer, gallery, albums, trash, sharing and the built-in updater.
