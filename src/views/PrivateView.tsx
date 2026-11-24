import { useCallback, useEffect, useMemo, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { FilePlus2, KeyRound, Lock, ShieldCheck, Trash2, Undo2, X } from 'lucide-react'
import { PinPad } from '../components/PinPad'
import { api, errText, fmtSize, I, vaultThumbUrl, type Item, type VaultItem } from '../api'
import { toast, useStore } from '../store'
import { MediaGrid } from '../components/MediaGrid'
import { confirmDialog } from '../components/ui'

/** Decrypted metadata of the open private album, keyed by vault id (cleared on lock). */
export const vaultMeta = new Map<string, VaultItem>()

export function PrivateView() {
  const libVersion = useStore((s) => s.libVersion)
  const settings = useStore((s) => s.settings)!
  const selection = useStore((s) => s.selection)
  const { setSelection, openViewer } = useStore.getState()
  const [status, setStatus] = useState<[boolean, boolean] | null>(null)
  const [list, setList] = useState<VaultItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [firstPin, setFirstPin] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const st = await api.vaultStatus()
    setStatus(st)
    if (st[1]) {
      const l = await api.vaultList()
      vaultMeta.clear()
      for (const it of l) vaultMeta.set(it.id, it)
      setList(l)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh, libVersion])

  const lock = useCallback(async () => {
    await api.vaultLock()
    vaultMeta.clear()
    setList([])
    setStatus((s) => (s ? [s[0], false] : s))
    const v = useStore.getState().viewer
    if (v?.vault) useStore.getState().closeViewer()
  }, [])

  // Lock when leaving the view, when the window is minimised/hidden, and after inactivity.
  useEffect(() => {
    if (!status?.[1]) return
    let timer = window.setTimeout(lock, settings.vaultAutolockMin * 60_000)
    const bump = () => {
      clearTimeout(timer)
      timer = window.setTimeout(lock, settings.vaultAutolockMin * 60_000)
    }
    const vis = () => document.hidden && lock()
    window.addEventListener('pointermove', bump)
    window.addEventListener('keydown', bump)
    document.addEventListener('visibilitychange', vis)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointermove', bump)
      window.removeEventListener('keydown', bump)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [status, lock, settings.vaultAutolockMin])
  useEffect(() => () => void lock(), [lock])

  const items = useMemo<Item[]>(
    () => list.map((v) => [0, v.id, v.kind, v.meta.taken, false, v.meta.width, v.meta.height, v.size]),
    [list],
  )

  if (!status) return null

  if (!status[0]) {
    return (
      <div className="pin-wrap">
      <PinPad
        key={firstPin ? 'confirm' : 'create'}
        title={firstPin ? 'Confirm your PIN' : 'Create a PIN'}
        subtitle={
          firstPin
            ? 'Enter the same PIN again.'
            : 'Private album files are encrypted on this PC and hidden from everything else. Use 4–12 digits. There is no way to recover a forgotten PIN.'
        }
        error={error}
        onSubmit={async (pin) => {
          if (!firstPin) {
            setFirstPin(pin)
            setError(null)
            return
          }
          if (pin !== firstPin) {
            setFirstPin(null)
            setError("PINs didn't match — start again")
            return
          }
          try {
            await api.vaultSetup(pin)
            setError(null)
            refresh()
          } catch (e) {
            setError(errText(e))
          }
        }}
      />
      </div>
    )
  }

  if (!status[1]) {
    return (
      <div className="pin-wrap">
      <PinPad
        title="Private album"
        subtitle="Enter your PIN to unlock."
        error={error}
        onSubmit={async (pin) => {
          try {
            await api.vaultUnlock(pin)
            setError(null)
            refresh()
          } catch (e) {
            setError(errText(e))
          }
        }}
      />
      </div>
    )
  }

  const addFiles = async () => {
    const files = await openDialog({ multiple: true, title: 'Move files to the private album' })
    if (!files) return
    const paths = Array.isArray(files) ? files : [files]
    setBusy(`Encrypting ${paths.length} file(s)…`)
    try {
      const n = await api.vaultAdd(paths)
      toast(`${n} moved to the private album`)
    } catch (e) {
      toast(errText(e))
    }
    setBusy(null)
    refresh()
  }

  const ids = [...selection]
  const restore = async (which: string[]) => {
    setBusy('Restoring…')
    await api.vaultRestore(which).then((n) => toast(`${n} restored to their original folders`), (e) => toast(errText(e)))
    setBusy(null)
    setSelection(new Set())
    refresh()
  }
  const remove = async (which: string[]) => {
    if (!(await confirmDialog(`Delete ${which.length} item(s) permanently?`, "Private items don't go to Trash.", 'Delete', true))) return
    await api.vaultDelete(which).catch((e) => toast(errText(e)))
    setSelection(new Set())
    refresh()
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
          <button className="btn" onClick={() => restore(ids)}>
            <Undo2 size={15} /> Restore
          </button>
          <button className="btn danger" onClick={() => remove(ids)}>
            <Trash2 size={15} /> Delete
          </button>
        </div>
      ) : (
        <div className="title-row">
          <h1>Private</h1>
          <span className="count">
            {list.length} · {fmtSize(list.reduce((a, v) => a + v.size, 0))}
          </span>
          <span className="chip private-chip">
            <ShieldCheck size={13} /> Encrypted
          </span>
          <span className="spacer" />
          {busy && <span className="muted">{busy}</span>}
          <button className="btn" onClick={addFiles}>
            <FilePlus2 size={15} /> Add files
          </button>
          <button className="btn" onClick={() => changePin()}>
            <KeyRound size={15} /> Change PIN
          </button>
          <button className="btn" onClick={lock}>
            <Lock size={15} /> Lock
          </button>
        </div>
      )}
    </div>
  )

  return (
    <MediaGrid
      items={items}
      group="month"
      header={header}
      thumbFor={(it) => vaultThumbUrl(it[I.path])}
      onOpen={(i) => openViewer({ items, index: i, origin: 'gallery', vault: true })}
      menuFor={(it) => [
        { label: 'Restore to original folder', icon: <Undo2 size={16} />, run: () => restore([it[I.path]]) },
        { label: 'Delete permanently', icon: <Trash2 size={16} />, danger: true, run: () => remove([it[I.path]]) },
      ]}
      empty={
        <div className="empty">
          <ShieldCheck size={40} />
          <p>Nothing here yet. Right-click any photo → Move to private album, or use Add files.</p>
        </div>
      }
    />
  )
}

async function changePin() {
  const { prompt } = await import('../components/ui')
  const old = await prompt('Current PIN', '', 'Next')
  if (!old) return
  const next = await prompt('New PIN (4–12 digits)', '', 'Change PIN')
  if (!next) return
  try {
    await api.vaultChangePin(old, next)
    toast('PIN changed')
  } catch (e) {
    toast(errText(e))
  }
}
