import {
  AppWindow, Bluetooth, BookImage, Copy, ExternalLink, FileOutput, FolderOpen, FolderPlus, Heart, HeartOff,
  Image as ImageIcon, Link2, Lock, Mail, MonitorSmartphone, Pencil, Play, Plus, Printer, ScanSearch, Send, Share2,
  SlidersHorizontal, Star, Trash2, Wallpaper, Columns2,
} from 'lucide-react'
import { api, dirOf, errText, I, KIND, nameOf, type Album, type Item } from './api'
import { toast, useStore } from './store'
import { prompt, type MenuItem } from './components/ui'

/** Image editors found on this PC (Photoshop, Lightroom, GIMP…), detected once at startup. */
export let editorCache: { name: string; exe: string }[] = []
export const detectEditors = () => api.editors().then((e) => (editorCache = e))

/** Albums for synchronous menus; refreshed whenever the library changes. */
export let albumCache: Album[] = []
export const refreshAlbums = () =>
  api.albums().then((a) => {
    albumCache = a
    return a
  })

export function albumSubmenu(paths: string[]): MenuItem[] {
  return [
    {
      label: 'New album…',
      icon: <FolderPlus size={16} />,
      run: async () => {
        const name = await prompt('New album', '', 'Create')
        if (!name?.trim()) return
        await api.createAlbum(name.trim(), undefined, paths).catch((e) => toast(errText(e)))
        refreshAlbums()
        toast(`Added to "${name.trim()}"`)
      },
    },
    ...(albumCache.filter((a) => !a.smart).length ? [{ separator: true } as MenuItem] : []),
    ...albumCache
      .filter((a) => !a.smart)
      .slice(0, 15)
      .map((a) => ({
        label: a.name,
        icon: <BookImage size={16} />,
        hint: String(a.count),
        run: () =>
          api.albumItems(a.id, paths).then(
            () => {
              refreshAlbums()
              toast(`Added to "${a.name}"`)
            },
            (e) => toast(errText(e)),
          ),
      })),
  ]
}

export async function moveToPrivate(paths: string[]) {
  const wasUnlocked = (await api.vaultStatus())[1]
  const { ensureVaultUnlocked } = await import('./components/PinPad')
  if (!(await ensureVaultUnlocked())) return
  try {
    const n = await api.vaultAdd(paths)
    useStore.getState().updateViewerItems((items) => items.filter((it) => !paths.includes(it[I.path])))
    useStore.getState().setSelection(new Set())
    toast(`${n} moved to the private album`)
  } catch (e) {
    toast(errText(e))
  }
  // Unlocked just for this move: lock again.
  if (!wasUnlocked && useStore.getState().view.kind !== 'private') api.vaultLock()
}

export async function exportItems(paths: string[]) {
  const { openExport } = await import('./components/ExportDialog')
  openExport(paths)
}

export async function tagItems(paths: string[]) {
  const t = await prompt('Add tags (comma separated)', '', 'Add')
  if (!t) return
  await api.setUserMeta(paths, { addTags: t.split(',') }).catch((e) => toast(errText(e)))
  toast('Tags added')
}

const run = async (p: Promise<unknown>, ok?: string) => {
  try {
    await p
    if (ok) toast(ok)
  } catch (e) {
    toast(errText(e))
  }
}

export async function moveToTrash(paths: string[]) {
  if (!paths.length) return
  try {
    const n = await api.trash(paths)
    const { viewer, updateViewerItems, setSelection } = useStore.getState()
    if (viewer) updateViewerItems((items) => items.filter((it) => !paths.includes(it[I.path])))
    setSelection(new Set())
    toast(n === 1 ? 'Moved to Trash' : `${n} items moved to Trash`, {
      label: 'Undo',
      run: async () => {
        const trash = await api.listTrash()
        const ids = trash.filter((t) => paths.includes(t.origPath)).map((t) => t.id)
        await run(api.restore(ids), 'Restored')
      },
    })
  } catch (e) {
    toast(errText(e))
  }
}

export async function setFavorite(paths: string[], value: boolean) {
  await run(api.setFavorite(paths, value))
  const { updateViewerItems } = useStore.getState()
  updateViewerItems((items) =>
    items.map((it) => (paths.includes(it[I.path]) ? ([...it.slice(0, 4), value, ...it.slice(5)] as Item) : it)),
  )
}

export async function share(paths: string[], via: 'sheet' | 'telegram' | 'bluetooth' | 'email') {
  try {
    if (via === 'telegram') {
      if (await api.telegram(paths)) return
      toast('Telegram Desktop not found — opening the share sheet')
    } else if (via === 'email') {
      if (await api.email(paths)) return
    } else if (via === 'bluetooth') {
      await api.bluetooth(paths)
      toast('File path copied — paste it into the Bluetooth window')
      return
    }
    await api.share(paths)
  } catch (e) {
    toast(errText(e))
  }
}

export const shareMenu = (paths: string[]): MenuItem[] => [
  { label: 'Share…', icon: <Share2 size={16} />, hint: 'Nearby, Phone Link, apps', run: () => share(paths, 'sheet') },
  { label: 'Telegram', icon: <Send size={16} />, run: () => share(paths, 'telegram') },
  { label: 'Email', icon: <Mail size={16} />, run: () => share(paths, 'email') },
  { label: 'Bluetooth', icon: <Bluetooth size={16} />, run: () => share(paths, 'bluetooth') },
  { label: 'Quick Share / Nearby', icon: <MonitorSmartphone size={16} />, run: () => share(paths, 'sheet') },
]

export async function renameItem(path: string) {
  const name = await prompt('Rename', nameOf(path), 'Rename')
  if (!name || name === nameOf(path)) return
  try {
    const np = await api.rename(path, name)
    useStore.getState().updateViewerItems((items) =>
      items.map((it) => (it[I.path] === path ? ([it[0], np, ...it.slice(2)] as Item) : it)),
    )
  } catch (e) {
    toast(errText(e))
  }
}

export function startSlideshow(items: Item[], index = 0) {
  const photos = items.filter((it) => it[I.kind] !== KIND.video || items.length < 50)
  if (!photos.length) return
  const { settings, openViewer } = useStore.getState()
  let list = photos
  if (settings?.slideshowShuffle) list = [...photos].sort(() => Math.random() - 0.5)
  openViewer({ items: list, index: Math.min(index, list.length - 1), origin: 'gallery', slideshow: true })
}

/** Context menu for one media item (grid tile or viewer). */
export function itemMenu(item: Item, opts: { open?: () => void; slideshow?: () => void; compareWith?: string } = {}): MenuItem[] {
  const p = item[I.path]
  const fav = item[I.fav]
  const isVideo = item[I.kind] === KIND.video
  const items: MenuItem[] = []
  if (opts.open) items.push({ label: 'Open', icon: <ImageIcon size={16} />, run: opts.open })
  if (!isVideo) items.push({ label: 'Edit', icon: <SlidersHorizontal size={16} />, hint: 'E', run: () => useStore.getState().setEditing(p) })
  const ps = editorCache.find((e) => e.name === 'Photoshop')
  if (ps && !isVideo) items.push({ label: 'Open in Photoshop', icon: <ExternalLink size={16} />, run: () => run(api.openInEditor(ps.exe, [p])) })
  const others = editorCache.filter((e) => e !== ps)
  if (others.length && !isVideo)
    items.push({
      label: 'Open in',
      icon: <ExternalLink size={16} />,
      items: others.map((e) => ({ label: e.name, run: () => run(api.openInEditor(e.exe, [p])) })),
    })
  items.push(
    { label: 'Open with…', icon: <AppWindow size={16} />, run: () => run(api.openWith(p)) },
    { label: 'Show in Explorer', icon: <FolderOpen size={16} />, run: () => run(api.reveal(p)) },
    { separator: true },
    fav
      ? { label: 'Remove from favourites', icon: <HeartOff size={16} />, run: () => setFavorite([p], false) }
      : { label: 'Add to favourites', icon: <Heart size={16} />, run: () => setFavorite([p], true) },
    { label: 'Copy', icon: <Copy size={16} />, hint: 'Ctrl+C', run: () => run(api.copyImage(p), 'Copied') },
    { label: 'Copy path', icon: <Link2 size={16} />, run: () => run(api.copyText(p), 'Path copied') },
    { label: 'Share', icon: <Share2 size={16} />, items: shareMenu([p]) },
    { label: 'Add to album', icon: <Plus size={16} />, items: albumSubmenu([p]) },
    { separator: true },
  )
  if (!isVideo) {
    items.push(
      { label: 'Set as wallpaper', icon: <Wallpaper size={16} />, run: () => run(api.wallpaper(p), 'Wallpaper set') },
      { label: 'Print…', icon: <Printer size={16} />, hint: 'Ctrl+P', run: () => run(api.print(p)) },
    )
  }
  items.push(
    { label: 'Search with Google Lens', icon: <ScanSearch size={16} />, run: () => run(api.lens(p), 'Opening Google Lens…') },
    {
      label: 'Set as album cover',
      icon: <Star size={16} />,
      run: () => run(api.setFolderCover(dirOf(p), p), 'Album cover updated'),
    },
    {
      label: 'Add shortcut to desktop',
      icon: <ExternalLink size={16} />,
      run: () => run(api.shortcut(p, nameOf(p), false), 'Shortcut added to desktop'),
    },
  )
  if (opts.slideshow) items.push({ label: 'Slideshow from here', icon: <Play size={16} />, run: opts.slideshow })
  if (opts.compareWith)
    items.push({ label: 'Compare with…', icon: <Columns2 size={16} />, run: () => useStore.getState().setCompare([p], useStore.getState().viewer?.items ?? null) })
  items.push(
    { separator: true },
    { label: 'Export / convert…', icon: <FileOutput size={16} />, run: () => exportItems([p]) },
    { label: 'Move to private album', icon: <Lock size={16} />, run: () => moveToPrivate([p]) },
    { label: 'Rename', icon: <Pencil size={16} />, hint: 'F2', run: () => renameItem(p) },
    { label: 'Delete', icon: <Trash2 size={16} />, hint: 'Del', danger: true, run: () => moveToTrash([p]) },
  )
  return items
}
