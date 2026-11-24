import { useEffect, useMemo, useState } from 'react'
import {
  Camera, Download, EyeOff, Film, FolderOpen, FolderTree, Heart, Image as ImageIcon, ImagePlus, Camera as InstaIcon, List,
  MapPin, MessageCircle, Monitor, Pencil, Play, Send, Sparkles, Video, Wallpaper,
} from 'lucide-react'
import { api, errText, KIND, SOURCE_LABEL, thumbUrl, type Album, type FolderNode, type Item, type Overview } from '../api'
import { BookImage, FolderPlus, Hash, Wand2 } from 'lucide-react'
import { refreshAlbums } from '../actions'
import { prompt } from '../components/ui'
import { toast, useStore } from '../store'
import { openMenu, type MenuItem } from '../components/ui'
import { startSlideshow } from '../actions'

const SOURCE_ICON: Record<string, React.ReactNode> = {
  camera: <Camera size={14} />,
  screenshots: <Monitor size={14} />,
  recordings: <Video size={14} />,
  whatsapp: <MessageCircle size={14} />,
  telegram: <Send size={14} />,
  instagram: <InstaIcon size={14} />,
  downloads: <Download size={14} />,
  edited: <Pencil size={14} />,
  wallpapers: <Wallpaper size={14} />,
}

export function folderMenu(f: FolderNode, items: Item[]): MenuItem[] {
  const go = useStore.getState().go
  const done = (p: Promise<unknown>, msg: string) => p.then(() => toast(msg), (e) => toast(errText(e)))
  return [
    { label: 'Open', icon: <ImageIcon size={16} />, run: () => go({ kind: 'folder', path: f.path }) },
    { label: 'Show in Explorer', icon: <FolderOpen size={16} />, run: () => api.openExternal(f.path) },
    ...(items.length ? [{ label: 'Slideshow', icon: <Play size={16} />, run: () => startSlideshow(items) }] : []),
    { separator: true },
    { label: 'Reset cover', icon: <ImagePlus size={16} />, run: () => done(api.setFolderCover(f.path, null), 'Cover reset') },
    {
      label: 'Add shortcut to desktop',
      icon: <Monitor size={16} />,
      run: () => done(api.shortcut(f.path, f.name, true), 'Shortcut added to desktop'),
    },
    { separator: true },
    {
      label: 'Hide folder',
      icon: <EyeOff size={16} />,
      run: () =>
        api.setFolderHidden(f.path, true).then(() =>
          toast(`"${f.name}" hidden`, { label: 'Undo', run: () => api.setFolderHidden(f.path, false) }),
        ),
    },
  ]
}

export function FolderCard({
  f,
  onOpen,
  onMenu,
  small,
}: {
  f: FolderNode
  onOpen: () => void
  onMenu: (e: React.MouseEvent) => void
  small?: boolean
}) {
  return (
    <button className={`album${small ? ' small' : ''}`} onClick={onOpen} onContextMenu={onMenu} title={f.path}>
      <div className="album-cover">
        {f.cover ? <img src={thumbUrl(f.cover, 320)} loading="lazy" decoding="async" alt="" /> : <FolderOpen size={28} />}
      </div>
      <div className="album-meta">
        <span className="album-name">{f.name}</span>
        <span className="album-count">{f.total.toLocaleString()}</span>
      </div>
    </button>
  )
}

function Collection({
  label,
  count,
  cover,
  icon,
  onOpen,
}: {
  label: string
  count: number
  cover: string | null
  icon: React.ReactNode
  onOpen: () => void
}) {
  return (
    <button className="album" onClick={onOpen}>
      <div className="album-cover">
        {cover ? <img src={thumbUrl(cover, 320)} loading="lazy" decoding="async" alt="" /> : <Sparkles size={26} />}
        <span className="album-icon">{icon}</span>
      </div>
      <div className="album-meta">
        <span className="album-name">{label}</span>
        <span className="album-count">{count < 0 ? 'Smart album' : count.toLocaleString()}</span>
      </div>
    </button>
  )
}

export function AlbumsView() {
  const libVersion = useStore((s) => s.libVersion)
  const settings = useStore((s) => s.settings)!
  const { go, patchSettings } = useStore.getState()
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [ov, setOv] = useState<Overview | null>(null)
  const [albums, setAlbums] = useState<Album[]>([])
  const [tags, setTags] = useState<[string, number][]>([])

  useEffect(() => {
    refreshAlbums().then(setAlbums)
    api.allTags().then(setTags)
  }, [libVersion])

  useEffect(() => {
    api.folders().then(setFolders, (e) => toast(errText(e)))
    api.overview().then(setOv, (e) => toast(errText(e)))
  }, [libVersion])

  const tree = settings.folderLayout === 'tree'
  const shown = useMemo(() => {
    const visible = folders.filter((f) => !f.hidden)
    if (!tree) return visible.filter((f) => f.direct > 0)
    // Tree: roots' children, plus roots that hold photos directly.
    const roots = visible.filter((f) => f.isRoot)
    const out: FolderNode[] = []
    for (const r of roots) {
      if (r.direct > 0 || roots.length > 1) out.push(r)
      if (roots.length === 1) out.push(...visible.filter((f) => f.parent === r.path))
    }
    return out
  }, [folders, tree])

  const kind = (k: number) => ov?.kinds.find((g) => g.key === String(k))
  const special = (k: string) => ov?.specials.find((g) => g.key === k)
  const collections = [
    { key: 'fav', label: 'Favourites', g: special('favorites'), icon: <Heart size={14} />, view: { kind: 'favorites' } as const },
    { key: 'vid', label: 'Videos', g: kind(KIND.video), icon: <Film size={14} />, view: { kind: 'videos' } as const },
    { key: 'loc', label: 'Places', g: special('location'), icon: <MapPin size={14} />, view: { kind: 'places' } as const },
    { key: 'gif', label: 'GIFs', g: kind(KIND.gif), icon: <Sparkles size={14} />, view: { kind: 'type', type: KIND.gif } as const },
    { key: 'raw', label: 'RAW', g: kind(KIND.raw), icon: <Camera size={14} />, view: { kind: 'type', type: KIND.raw } as const },
  ].filter((c) => c.g && c.g.count > 0)

  return (
    <div className="grid-scroll">
      <div className="view-head">
        <div className="title-row">
          <h1>Albums</h1>
          <span className="spacer" />
          <div className="segmented">
            <button className={tree ? 'on' : ''} onClick={() => patchSettings({ folderLayout: 'tree' })} title="Folders inside folders">
              <FolderTree size={15} /> Tree
            </button>
            <button className={!tree ? 'on' : ''} onClick={() => patchSettings({ folderLayout: 'flat' })} title="Every folder">
              <List size={15} /> All folders
            </button>
          </div>
        </div>
      </div>

      <section className="album-section">
        <div className="section-head">
          <h2>My albums</h2>
          <button
            className="chip-btn"
            onClick={async () => {
              const name = await prompt('New album', '', 'Create')
              if (!name?.trim()) return
              await api.createAlbum(name.trim())
              refreshAlbums().then(setAlbums)
            }}
          >
            <FolderPlus size={15} /> New album
          </button>
        </div>
        {albums.length === 0 ? (
          <p className="muted">
            Right-click photos → Add to album, or search and “Save as smart album” to keep a live collection.
          </p>
        ) : (
          <div className="album-grid">
            {albums.map((a) => (
              <Collection
                key={a.id}
                label={a.name}
                count={a.smart ? -1 : a.count}
                cover={a.cover}
                icon={a.smart ? <Wand2 size={14} /> : <BookImage size={14} />}
                onOpen={() => go({ kind: 'album', id: a.id, name: a.name, smart: a.smart })}
              />
            ))}
          </div>
        )}
      </section>

      {tags.length > 0 && (
        <section className="album-section">
          <h2>Tags</h2>
          <div className="tag-cloud">
            {tags.map(([t, n]) => (
              <button key={t} className="filter" onClick={() => go({ kind: 'tag', tag: t })}>
                <Hash size={12} /> {t} <span className="muted">{n}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {collections.length > 0 && (
        <section className="album-section">
          <h2>Collections</h2>
          <div className="album-grid">
            {collections.map((c) => (
              <Collection key={c.key} label={c.label} count={c.g!.count} cover={c.g!.cover} icon={c.icon} onOpen={() => go(c.view)} />
            ))}
          </div>
        </section>
      )}

      {ov && ov.sources.length > 0 && (
        <section className="album-section">
          <h2>From apps</h2>
          <div className="album-grid">
            {ov.sources
              .sort((a, b) => b.count - a.count)
              .map((g) => (
                <Collection
                  key={g.key}
                  label={SOURCE_LABEL[g.key] ?? g.key}
                  count={g.count}
                  cover={g.cover}
                  icon={SOURCE_ICON[g.key] ?? <Sparkles size={14} />}
                  onOpen={() => go({ kind: 'source', source: g.key })}
                />
              ))}
          </div>
        </section>
      )}

      <section className="album-section">
        <h2>Folders</h2>
        {shown.length === 0 ? (
          <p className="muted pad">No folders with photos yet. Add folders in Settings → Library.</p>
        ) : (
          <div className="album-grid">
            {shown.map((f) => (
              <FolderCard
                key={f.path}
                f={f}
                onOpen={() => go({ kind: 'folder', path: f.path })}
                onMenu={(e) => openMenu(e, folderMenu(f, []))}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
