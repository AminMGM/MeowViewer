import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownWideNarrow, ArrowLeft, ArrowUpNarrowWide, BookmarkPlus, CalendarHeart, Check, ChevronRight, Columns2, Copy,
  FileOutput, FolderOpen, Heart, ImageOff, Layers, Lock, Pencil, Play, Plus, Share2, Star, Tag, Trash2, X,
} from 'lucide-react'
import { api, errText, I, KIND, nameOf, SOURCE_LABEL, thumbUrl, type FolderNode, type Item, type Query, type SortKey } from '../api'
import { toast, useStore, type View } from '../store'
import { MediaGrid } from '../components/MediaGrid'
import {
  albumSubmenu, exportItems, moveToPrivate, moveToTrash, refreshAlbums, setFavorite, shareMenu, startSlideshow, tagItems,
} from '../actions'
import { confirmDialog, openMenu, openMenuAt, prompt } from '../components/ui'
import { FolderCard, folderMenu } from './AlbumsView'

const SORTS: [SortKey, string][] = [
  ['date', 'Date taken'],
  ['modified', 'Date modified'],
  ['added', 'Date added'],
  ['name', 'Name'],
  ['size', 'Size'],
  ['type', 'Type'],
]

const FILTERS: [string, number[] | null][] = [
  ['All', null],
  ['Photos', [KIND.image]],
  ['Videos', [KIND.video]],
  ['GIFs', [KIND.gif]],
  ['RAW', [KIND.raw]],
]

function titleOf(v: View): string {
  switch (v.kind) {
    case 'photos':
      return 'Photos'
    case 'videos':
      return 'Videos'
    case 'favorites':
      return 'Favourites'
    case 'recent':
      return 'Recently added'
    case 'places':
      return 'Places'
    case 'folder':
      return nameOf(v.path)
    case 'source':
      return SOURCE_LABEL[v.source] ?? v.source
    case 'type':
      return ['Photos', 'Videos', 'GIFs', 'RAW photos'][v.type] ?? 'Items'
    case 'album':
      return v.name
    case 'tag':
      return `#${v.tag}`
    case 'onthisday':
      return 'On this day'
    default:
      return ''
  }
}

export function LibraryView() {
  const view = useStore((s) => s.view)
  const search = useStore((s) => s.search)
  const settings = useStore((s) => s.settings)!
  const libVersion = useStore((s) => s.libVersion)
  const selection = useStore((s) => s.selection)
  const { patchSettings, setSelection, go } = useStore.getState()
  const [items, setItems] = useState<Item[] | null>(null)
  const [filter, setFilter] = useState(0)
  const [recursive, setRecursive] = useState(false)
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [minRating, setMinRating] = useState(0)
  const [memory, setMemory] = useState<[number, string | null] | null>(null)
  const reqId = useRef(0)

  useEffect(() => {
    if (view.kind === 'photos') api.onThisDay().then(setMemory)
  }, [view.kind, libVersion])

  const isFolder = view.kind === 'folder'
  const sort: SortKey = view.kind === 'recent' ? 'added' : settings.sort
  const desc = view.kind === 'recent' ? true : settings.desc

  const query = useMemo<Query>(() => {
    const kinds = view.kind === 'videos' ? [KIND.video] : view.kind === 'type' ? [view.type] : (FILTERS[filter][1] ?? undefined)
    const base = { sort, desc, kinds, search: search || undefined, minRating: minRating || undefined }
    switch (view.kind) {
      case 'album': {
        if (view.smart) {
          const sm = JSON.parse(view.smart) as { search?: string; kinds?: number[]; minRating?: number }
          return { ...base, view: 'all', search: [sm.search, search].filter(Boolean).join(' ') || undefined, kinds: sm.kinds ?? kinds, minRating: sm.minRating || base.minRating }
        }
        return { ...base, view: 'album', album: view.id }
      }
      case 'tag':
        return { ...base, view: 'tag', tag: view.tag }
      case 'onthisday':
        return { ...base, view: 'onthisday' }
      case 'favorites':
        return { ...base, view: 'favorites' }
      case 'recent':
        return { ...base, view: 'recent' }
      case 'places':
        return { ...base, view: 'location' }
      case 'folder':
        return { ...base, view: 'folder', folder: view.path, recursive }
      case 'source':
        return { ...base, view: 'source', source: view.source }
      default:
        return { ...base, view: 'all' }
    }
  }, [view, filter, sort, desc, search, recursive, minRating])

  useEffect(() => {
    const id = ++reqId.current
    api.query(query).then(
      (r) => id === reqId.current && setItems(r),
      (e) => toast(String(e)),
    )
  }, [query, libVersion])

  useEffect(() => {
    if (!isFolder) return
    api.folders().then(setFolders)
  }, [isFolder, libVersion])

  useEffect(() => setFilter(0), [view])

  const subfolders = isFolder
    ? folders.filter((f) => f.parent?.toLowerCase() === view.path.toLowerCase() && !f.hidden)
    : []
  const crumbs = useMemo(() => {
    if (!isFolder) return []
    const out: FolderNode[] = []
    let cur = folders.find((f) => f.path === view.path)
    while (cur) {
      out.unshift(cur)
      if (cur.isRoot) break
      cur = folders.find((f) => f.path === cur!.parent)
    }
    return out
  }, [folders, isFolder, view])

  const group: 'day' | 'month' | 'none' =
    !['date', 'modified', 'added'].includes(sort) || search ? 'none' : items && items.length > 3000 ? 'month' : 'day'

  const selected = items?.filter((it) => selection.has(it[I.path])) ?? []
  const selPaths = selected.map((it) => it[I.path])

  const header = (
    <div className="view-head">
      {selection.size > 0 ? (
        <div className="selection-bar glass">
          <button className="icon-btn" onClick={() => setSelection(new Set())} title="Clear selection">
            <X size={18} />
          </button>
          <strong>{selection.size} selected</strong>
          <button className="link-btn" onClick={() => setSelection(new Set(items?.map((it) => it[I.path])))}>
            Select all
          </button>
          <span className="spacer" />
          <button className="icon-btn" title="Favourite" onClick={() => setFavorite(selPaths, !selected.every((s) => s[I.fav]))}>
            <Heart size={18} />
          </button>
          <button className="icon-btn" title="Share" onClick={(e) => openMenuAt(e.currentTarget, shareMenu(selPaths), 'right')}>
            <Share2 size={18} />
          </button>
          <button
            className="icon-btn"
            title="Copy"
            onClick={() => api.copyFiles(selPaths).then(() => toast(`${selPaths.length} files copied`))}
          >
            <Copy size={18} />
          </button>
          <button className="icon-btn" title="Slideshow" onClick={() => startSlideshow(selected)}>
            <Play size={18} />
          </button>
          <button className="icon-btn" title="Add to album" onClick={(e) => openMenuAt(e.currentTarget, albumSubmenu(selPaths), 'right')}>
            <Plus size={18} />
          </button>
          <button className="icon-btn" title="Add tags" onClick={() => tagItems(selPaths)}>
            <Tag size={18} />
          </button>
          {selPaths.length >= 1 && selPaths.length <= 4 && (
            <button className="icon-btn" title="Compare" onClick={() => useStore.getState().setCompare(selPaths, items)}>
              <Columns2 size={18} />
            </button>
          )}
          <button className="icon-btn" title="Export / convert" onClick={() => exportItems(selPaths)}>
            <FileOutput size={18} />
          </button>
          <button className="icon-btn" title="Move to private album" onClick={() => moveToPrivate(selPaths)}>
            <Lock size={18} />
          </button>
          {view.kind === 'album' && !view.smart && (
            <button
              className="icon-btn"
              title="Remove from album"
              onClick={() => api.albumItems(view.id, selPaths, true).then(() => setSelection(new Set()))}
            >
              <X size={18} />
            </button>
          )}
          <button className="icon-btn danger" title="Delete" onClick={() => moveToTrash(selPaths)}>
            <Trash2 size={18} />
          </button>
        </div>
      ) : (
        <>
          {isFolder && crumbs.length > 0 && (
            <nav className="crumbs">
              <button className="link-btn" onClick={() => go({ kind: 'albums' })}>
                Albums
              </button>
              {crumbs.map((c) => (
                <span key={c.path} className="crumb">
                  <ChevronRight size={14} />
                  <button className="link-btn" onClick={() => go({ kind: 'folder', path: c.path })}>
                    {c.name}
                  </button>
                </span>
              ))}
            </nav>
          )}
          <div className="title-row">
            {['folder', 'album', 'source', 'tag', 'type', 'onthisday'].includes(view.kind) && (
              <button
                className="icon-btn back-btn"
                title="Back (Alt+←)"
                onClick={() => {
                  const st = useStore.getState()
                  if (st.history.length) st.back()
                  else go({ kind: 'albums' })
                }}
              >
                <ArrowLeft size={20} />
              </button>
            )}
            <h1>{search ? `Results for “${search}”` : titleOf(view)}</h1>
            <span className="count">{items ? items.length.toLocaleString() : ''}</span>
            <span className="spacer" />
            {search && (
              <button
                className="chip-btn"
                title="Save this search as a smart album"
                onClick={async () => {
                  const name = await prompt('Smart album name', search, 'Save')
                  if (!name) return
                  await api.createAlbum(name, JSON.stringify({ search, kinds: FILTERS[filter][1] ?? undefined, minRating }))
                  refreshAlbums()
                  toast(`Smart album "${name}" saved`)
                }}
              >
                <BookmarkPlus size={15} /> Save as smart album
              </button>
            )}
            {view.kind === 'album' && (
              <button
                className="icon-btn"
                title="Rename album"
                onClick={async () => {
                  const name = await prompt('Rename album', view.name, 'Rename')
                  if (!name) return
                  await api.updateAlbum(view.id, { name })
                  refreshAlbums()
                  useStore.setState({ view: { ...view, name } })
                }}
              >
                <Pencil size={17} />
              </button>
            )}
            {view.kind === 'album' && (
              <button
                className="icon-btn danger"
                title="Delete album (photos are kept)"
                onClick={async () => {
                  if (!(await confirmDialog(`Delete album "${view.name}"?`, 'Photos stay where they are.', 'Delete', true))) return
                  await api.deleteAlbum(view.id).catch((e) => toast(errText(e)))
                  refreshAlbums()
                  go({ kind: 'albums' })
                }}
              >
                <Trash2 size={17} />
              </button>
            )}
            <button
              className={`chip-btn${minRating ? ' on' : ''}`}
              title="Minimum rating"
              onClick={(e) =>
                openMenuAt(
                  e.currentTarget,
                  [0, 1, 2, 3, 4, 5].map((r) => ({
                    label: r ? `${'★'.repeat(r)} and up` : 'Any rating',
                    icon: minRating === r ? <Check size={15} /> : undefined,
                    run: () => setMinRating(r),
                  })),
                  'right',
                )
              }
            >
              <Star size={15} /> {minRating ? `${minRating}+` : ''}
            </button>
            {isFolder && (
              <>
                <button className={`chip-btn${recursive ? ' on' : ''}`} onClick={() => setRecursive((r) => !r)} title="Include subfolders">
                  <Layers size={15} /> Subfolders
                </button>
                <button
                  className="icon-btn"
                  title="Folder options"
                  onClick={(e) => {
                    const f = folders.find((x) => x.path === view.path)
                    if (f) openMenuAt(e.currentTarget, folderMenu(f, items ?? []), 'right')
                  }}
                >
                  <FolderOpen size={18} />
                </button>
              </>
            )}
            {items && items.length > 0 && (
              <button className="icon-btn" title="Slideshow" onClick={() => startSlideshow(items)}>
                <Play size={18} />
              </button>
            )}
            {view.kind !== 'recent' && (
              <button
                className="chip-btn"
                onClick={(e) =>
                  openMenuAt(
                    e.currentTarget,
                    SORTS.map(([k, label]) => ({
                      label,
                      icon: settings.sort === k ? <Check size={15} /> : undefined,
                      run: () => patchSettings({ sort: k }),
                    })).concat([
                      { separator: true } as never,
                      {
                        label: settings.desc ? 'Newest / largest first' : 'Oldest / smallest first',
                        icon: settings.desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />,
                        run: () => patchSettings({ desc: !settings.desc }),
                      },
                    ]),
                    'right',
                  )
                }
              >
                {settings.desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
                {SORTS.find(([k]) => k === sort)?.[1]}
              </button>
            )}
          </div>
          {view.kind === 'photos' && !search && memory && memory[0] > 0 && (
            <button className="memory-card" onClick={() => go({ kind: 'onthisday' })}>
              {memory[1] && <img src={thumbUrl(memory[1], 640)} alt="" />}
              <div>
                <CalendarHeart size={18} />
                <strong>On this day</strong>
                <span>{memory[0]} memories from past years</span>
              </div>
            </button>
          )}
          {view.kind !== 'videos' && view.kind !== 'type' && (
            <div className="filters">
              {FILTERS.map(([label], i) => (
                <button key={label} className={`filter${filter === i ? ' on' : ''}`} onClick={() => setFilter(i)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {subfolders.length > 0 && (
            <div className="folder-row">
              {subfolders
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
                .map((f) => (
                  <FolderCard
                    key={f.path}
                    f={f}
                    small
                    onOpen={() => go({ kind: 'folder', path: f.path })}
                    onMenu={(e) => openMenu(e, folderMenu(f, []))}
                  />
                ))}
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <MediaGrid
      items={items ?? []}
      group={group}
      header={header}
      empty={
        items && (
          <div className="empty">
            {isFolder && subfolders.length > 0 ? null : (
              <>
                <ImageOff size={40} />
                <p>{search ? 'Nothing matches your search' : 'Nothing here yet'}</p>
                {view.kind === 'photos' && !search && (
                  <button className="btn" onClick={() => go({ kind: 'settings' })}>
                    Choose library folders
                  </button>
                )}
              </>
            )}
          </div>
        )
      }
    />
  )
}

