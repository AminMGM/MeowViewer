import { invoke } from '@tauri-apps/api/core'

/** [id, path, kind, date, favorite, width, height, size] — compact so 100k items stay light. */
export type Item = [number, string, number, number, boolean, number, number, number]
export const I = { id: 0, path: 1, kind: 2, date: 3, fav: 4, w: 5, h: 6, size: 7 } as const

export const KIND = { image: 0, video: 1, gif: 2, raw: 3 } as const

export interface Settings {
  roots: string[]
  wheel: 'zoom' | 'navigate'
  slideshowSecs: number
  slideshowShuffle: boolean
  viewerBg: 'ambient' | 'black' | 'dark'
  accent: string
  trashDays: number
  autoUpdate: boolean
  gridSize: number
  sort: SortKey
  desc: boolean
  filmstrip: boolean
  folderLayout: 'tree' | 'flat'
  sidebarCollapsed: boolean
  theme: 'system' | 'light' | 'dark'
  ocr: boolean
  vaultAutolockMin: number
  videoVolume: number
  videoSpeed: number
  onboarded: boolean
  videoResume: boolean
  videoAutonext: boolean
  subSize: number
  subBg: number
  subColor: string
}

export type SortKey = 'date' | 'modified' | 'added' | 'name' | 'size' | 'type'

export interface Query {
  view: 'all' | 'favorites' | 'recent' | 'folder' | 'source' | 'location' | 'album' | 'tag' | 'onthisday' | 'large'
  album?: number
  tag?: string
  minRating?: number
  folder?: string
  recursive?: boolean
  kinds?: number[]
  source?: string
  sort: SortKey
  desc: boolean
  search?: string
}

export interface FolderNode {
  path: string
  name: string
  parent: string | null
  direct: number
  total: number
  latest: number
  cover: string | null
  hidden: boolean
  isRoot: boolean
}

export interface Group {
  key: string
  count: number
  cover: string | null
}

export interface Overview {
  sources: Group[]
  kinds: Group[]
  specials: Group[]
}

export interface TrashItem {
  id: number
  origPath: string
  trashPath: string
  kind: number
  size: number
  trashedAt: number
}

export interface Info {
  path: string
  name: string
  folder: string
  ext: string
  kind: number
  size: number
  mtime: number
  ctime: number
  taken: number | null
  width: number | null
  height: number | null
  lat: number | null
  lon: number | null
  camera: string | null
  source: string | null
  favorite: boolean
  cloud: boolean
  orientation: number
  fields: [string, string][]
}

export interface UserMeta {
  rating: number
  description: string
  tags: string[]
}

export interface Album {
  id: number
  name: string
  smart: string | null
  cover: string | null
  count: number
}

export interface OcrLine {
  text: string
  words: [string, number, number, number, number][]
}

export interface VaultItem {
  id: string
  kind: number
  size: number
  added: number
  meta: { name: string; origPath: string; taken: number; width: number; height: number }
}

export interface DupGroup {
  kind: 'exact' | 'similar'
  paths: string[]
  size: number
}

export interface Stats {
  total: number
  bytes: number
  byKind: [number, number, number][]
  bySource: [string, number, number][]
  oldScreenshots: number
  oldScreenshotsBytes: number
}

/** [path, lat, lon, kind, date] */
export type Located = [string, number, number, number, number]

export interface Track {
  kind: 'file' | 'embedded' | 'audio'
  src: string
  label: string
}

export interface Startup {
  file: string | null
  folder: string | null
}

export interface Progress {
  scanning: boolean
  found: number
  indexed: number
}

// ------------------------------------------------------------------ URLs

const BASE = 'http://mv.localhost'
const enc = encodeURIComponent

/** Bumped per path after an edit (e.g. rotation) so cached URLs refresh. */
const versions = new Map<string, number>()
export const bumpVersion = (p: string) => versions.set(p, (versions.get(p) ?? 0) + 1)
const v = (p: string) => (versions.has(p) ? `&v=${versions.get(p)}` : '')

export const thumbUrl = (p: string, size = 320) => `${BASE}/t?p=${enc(p)}&s=${size}${v(p)}`
export const fileUrl = (p: string) => `${BASE}/f?p=${enc(p)}${v(p)}`
export const decodeUrl = (p: string) => `${BASE}/d?p=${enc(p)}${v(p)}`
export const motionUrl = (p: string) => `${BASE}/m?p=${enc(p)}`
export const vaultThumbUrl = (id: string) => `${BASE}/vt?p=${id}`
export const vaultFileUrl = (id: string, mime: string) => `${BASE}/vf?p=${id}&mime=${enc(mime)}`
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', svg: 'image/svg+xml', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm',
  mkv: 'video/webm',
}
export const mimeOf = (p: string) => MIME[extOf(p)] ?? 'application/octet-stream'
export const isWebImage = (p: string) => WEB_IMAGE.has(extOf(p))

const WEB_IMAGE = new Set(['jpg', 'jpeg', 'jfif', 'jpe', 'png', 'apng', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'])
export const extOf = (p: string) => {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i + 1).toLowerCase()
}
export const nameOf = (p: string) => p.slice(p.lastIndexOf('\\') + 1)
export const dirOf = (p: string) => p.slice(0, p.lastIndexOf('\\'))
/** URL that shows the full image: the file itself when the WebView can decode it. */
export const viewUrl = (p: string) => (WEB_IMAGE.has(extOf(p)) ? fileUrl(p) : decodeUrl(p))

// -------------------------------------------------------------- commands

export const api = {
  startup: () => invoke<Startup>('get_startup'),
  settings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<void>('set_settings', { settings }),
  rescan: () => invoke<void>('rescan'),
  progress: () => invoke<Progress>('index_progress'),
  query: (query: Query) => invoke<Item[]>('query_media', { query }),
  folders: () => invoke<FolderNode[]>('list_folders'),
  overview: () => invoke<Overview>('album_overview'),
  listDir: (dir: string) => invoke<Item[]>('list_dir', { dir }),
  info: (path: string) => invoke<Info>('get_info', { path }),
  setFavorite: (paths: string[], value: boolean) => invoke<void>('set_favorite', { paths, value }),
  setFolderCover: (folder: string, cover: string | null) => invoke<void>('set_folder_cover', { folder, cover }),
  setFolderHidden: (folder: string, hidden: boolean) => invoke<void>('set_folder_hidden', { folder, hidden }),
  hiddenFolders: () => invoke<string[]>('hidden_folders'),
  trash: (paths: string[]) => invoke<number>('trash_files', { paths }),
  listTrash: () => invoke<TrashItem[]>('list_trash'),
  restore: (ids: number[]) => invoke<number>('restore_trash', { ids }),
  deleteForever: (ids: number[]) => invoke<number>('delete_trash', { ids }),
  rename: (path: string, newName: string) => invoke<string>('rename_file', { path, newName }),
  rotate: (path: string, quarters: number) => invoke<void>('rotate_file', { path, quarters }),
  reveal: (path: string) => invoke<void>('reveal', { path }),
  openWith: (path: string) => invoke<void>('open_with', { path }),
  openExternal: (target: string) => invoke<void>('open_external', { target }),
  print: (path: string) => invoke<void>('print_file', { path }),
  wallpaper: (path: string) => invoke<void>('set_wallpaper', { path }),
  copyImage: (path: string) => invoke<void>('copy_image', { path }),
  copyFiles: (paths: string[]) => invoke<void>('copy_files', { paths }),
  copyText: (text: string) => invoke<void>('copy_text', { text }),
  shortcut: (target: string, name: string, isFolder: boolean) =>
    invoke<string>('create_shortcut', { target, name, isFolder }),
  share: (paths: string[]) => invoke<void>('share_files', { paths }),
  telegram: (paths: string[]) => invoke<boolean>('telegram_send', { paths }),
  bluetooth: (paths: string[]) => invoke<void>('bluetooth_send', { paths }),
  email: (paths: string[]) => invoke<boolean>('email_files', { paths }),
  lens: (path: string) => invoke<void>('lens_search', { path }),
  /** Cancel a running job: scan, dups, export, import, codecs, video, ocr. */
  cancelTask: (name: 'scan' | 'dups' | 'export' | 'import' | 'codecs' | 'video' | 'ocr') => invoke<void>('cancel_task', { name }),
  cacheInfo: () => invoke<number>('cache_info'),
  clearCache: () => invoke<void>('clear_cache'),
  userMeta: (path: string) => invoke<UserMeta>('get_user_meta', { path }),
  setUserMeta: (
    paths: string[],
    p: { rating?: number; description?: string; tags?: string[]; addTags?: string[] },
  ) => invoke<void>('set_user_meta', { paths, ...p }),
  allTags: () => invoke<[string, number][]>('all_tags'),
  setTaken: (paths: string[], ms: number) => invoke<number>('set_taken', { paths, ms }),
  setLocation: (paths: string[], lat: number | null, lon: number | null) => invoke<void>('set_location', { paths, lat, lon }),
  located: () => invoke<Located[]>('located'),
  albums: () => invoke<Album[]>('list_albums'),
  createAlbum: (name: string, smart?: string, paths?: string[]) => invoke<number>('create_album', { name, smart, paths }),
  updateAlbum: (id: number, p: { name?: string; cover?: string | null }) =>
    invoke<void>('update_album', { id, name: p.name, cover: 'cover' in p ? p.cover : undefined }),
  deleteAlbum: (id: number) => invoke<void>('delete_album', { id }),
  albumItems: (id: number, paths: string[], remove = false) => invoke<void>('album_items', { id, paths, remove }),
  onThisDay: () => invoke<[number, string | null]>('on_this_day'),
  stats: () => invoke<Stats>('storage_stats'),
  oldScreenshots: () => invoke<Item[]>('old_screenshots'),
  ocrLines: (path: string) => invoke<OcrLine[]>('ocr_lines', { path }),
  ocrProgress: () => invoke<{ running: boolean; done: number; total: number }>('ocr_progress'),
  ocrControl: (run: boolean) => invoke<void>('ocr_control', { run }),
  vaultStatus: () => invoke<[boolean, boolean]>('vault_status'),
  vaultSetup: (pin: string) => invoke<void>('vault_setup', { pin }),
  vaultUnlock: (pin: string) => invoke<void>('vault_unlock', { pin }),
  vaultChangePin: (old: string, next: string) => invoke<void>('vault_change_pin', { old, new: next }),
  vaultLock: () => invoke<void>('vault_lock'),
  vaultList: () => invoke<VaultItem[]>('vault_list'),
  vaultAdd: (paths: string[]) => invoke<number>('vault_add', { paths }),
  vaultRestore: (ids: string[]) => invoke<number>('vault_restore', { ids }),
  vaultDelete: (ids: string[]) => invoke<void>('vault_delete', { ids }),
  motionInfo: (path: string) => invoke<[number, number] | null>('motion_info', { path }),
  duplicates: (similar: boolean) => invoke<DupGroup[]>('find_duplicates', { similar }),
  exportImages: (paths: string[], dest: string, format: string, maxDim: number, quality: number, keepDates = true) =>
    invoke<number>('export_images', { paths, dest, format, maxDim, quality, keepDates }),
  saveEdited: (path: string, data: string, mode: 'copy' | 'overwrite', ext: string) =>
    invoke<string>('save_edited', { path, data, mode, ext }),
  videoTracks: (path: string) => invoke<Track[]>('video_tracks', { path }),
  readSubtitle: (path: string) => invoke<string>('read_subtitle', { path }),
  extractSubtitle: (path: string, src: string) => invoke<string>('extract_subtitle', { path, src }),
  videoWithAudio: (path: string, audio: number) => invoke<string>('video_with_audio', { path, audio }),
  codecsInstalled: () => invoke<boolean>('codecs_installed'),
  installCodecs: () => invoke<void>('install_codecs'),
  prepareVideo: (path: string) => invoke<string>('prepare_video', { path }),
  subtitles: (path: string) => invoke<string | null>('find_subtitles', { path }),
  saveFrame: (path: string, data: string) => invoke<string>('save_frame', { path, data }),
  cloudFolders: () => invoke<[string, string][]>('cloud_folders'),
  removableDrives: () => invoke<string[]>('removable_drives'),
  importFrom: (src: string) => invoke<number>('import_from', { src }),
  editors: () => invoke<{ name: string; exe: string }[]>('installed_editors'),
  openInEditor: (exe: string, paths: string[]) => invoke<void>('open_in_editor', { exe, paths }),
}

// --------------------------------------------------------------- format

export const fmtSize = (b: number) => {
  if (b < 1024) return `${b} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do {
    b /= 1024
    i++
  } while (b >= 1024 && i < u.length - 1)
  return `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`
}

export const fmtDate = (ms: number, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) =>
  new Date(ms).toLocaleString(undefined, opts)

export const SOURCE_LABEL: Record<string, string> = {
  camera: 'Camera',
  screenshots: 'Screenshots',
  recordings: 'Screen recordings',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  instagram: 'Instagram',
  snapchat: 'Snapchat',
  discord: 'Discord',
  downloads: 'Downloads',
  edited: 'Edited',
  wallpapers: 'Wallpapers',
}

export const isCancelled = (e: unknown) => String(e).startsWith('Cancelled')
export const errText = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e))
