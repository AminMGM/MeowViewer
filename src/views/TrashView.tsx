import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, Trash2, X } from 'lucide-react'
import { api, errText, fmtSize, I, nameOf, type Item, type TrashItem } from '../api'
import { toast, useStore } from '../store'
import { MediaGrid } from '../components/MediaGrid'
import { confirmDialog } from '../components/ui'

export function TrashView() {
  const libVersion = useStore((s) => s.libVersion)
  const settings = useStore((s) => s.settings)!
  const selection = useStore((s) => s.selection)
  const { setSelection, openViewer } = useStore.getState()
  const [list, setList] = useState<TrashItem[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    api.listTrash().then(setList, (e) => toast(errText(e)))
  }, [libVersion, tick])

  // Grid items point at the file inside the trash folder.
  const items = useMemo<Item[]>(
    () => list.map((t) => [t.id, t.trashPath, t.kind, t.trashedAt, false, 0, 0, t.size]),
    [list],
  )
  const byPath = useMemo(() => new Map(list.map((t) => [t.trashPath, t])), [list])
  const selectedIds = [...selection].map((p) => byPath.get(p)?.id).filter((x): x is number => x != null)
  const total = list.reduce((a, t) => a + t.size, 0)

  const restore = async (ids: number[]) => {
    try {
      const n = await api.restore(ids)
      toast(n === 1 ? 'Restored' : `${n} items restored`)
    } catch (e) {
      toast(errText(e))
    }
    setSelection(new Set())
    setTick((t) => t + 1)
  }
  const remove = async (ids: number[]) => {
    const ok = await confirmDialog(
      ids.length === 1 ? 'Delete permanently?' : `Delete ${ids.length} items permanently?`,
      "This can't be undone.",
      'Delete',
      true,
    )
    if (!ok) return
    await api.deleteForever(ids).catch((e) => toast(errText(e)))
    setSelection(new Set())
    setTick((t) => t + 1)
  }

  const header = (
    <div className="view-head">
      {selection.size > 0 ? (
        <div className="selection-bar glass">
          <button className="icon-btn" onClick={() => setSelection(new Set())}>
            <X size={18} />
          </button>
          <strong>{selection.size} selected</strong>
          <span className="spacer" />
          <button className="btn" onClick={() => restore(selectedIds)}>
            <RotateCcw size={15} /> Restore
          </button>
          <button className="btn danger" onClick={() => remove(selectedIds)}>
            <Trash2 size={15} /> Delete
          </button>
        </div>
      ) : (
        <div className="title-row">
          <h1>Trash</h1>
          <span className="count">
            {list.length.toLocaleString()} · {fmtSize(total)}
          </span>
          <span className="spacer" />
          {list.length > 0 && (
            <>
              <button className="btn" onClick={() => restore(list.map((t) => t.id))}>
                <RotateCcw size={15} /> Restore all
              </button>
              <button className="btn danger" onClick={() => remove(list.map((t) => t.id))}>
                <Trash2 size={15} /> Empty trash
              </button>
            </>
          )}
        </div>
      )}
      <p className="muted">Items are permanently deleted after {settings.trashDays} days.</p>
    </div>
  )

  return (
    <MediaGrid
      items={items}
      group="none"
      header={header}
      empty={
        <div className="empty">
          <Trash2 size={40} />
          <p>Trash is empty</p>
        </div>
      }
      onOpen={(i) => openViewer({ items, index: i, origin: 'gallery' })}
      menuFor={(it) => {
        const t = byPath.get(it[I.path])!
        return [
          { label: `From ${nameOf(t.origPath)}`, disabled: true },
          { separator: true },
          { label: 'Restore', icon: <RotateCcw size={16} />, run: () => restore([t.id]) },
          { label: 'Delete permanently', icon: <Trash2 size={16} />, danger: true, run: () => remove([t.id]) },
        ]
      }}
    />
  )
}
