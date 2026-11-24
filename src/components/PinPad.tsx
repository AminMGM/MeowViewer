import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { Delete, Lock, X } from 'lucide-react'
import { api, errText } from '../api'
import { useStore } from '../store'

export function PinPad({
  title,
  subtitle,
  onSubmit,
  error,
  onCancel,
}: {
  title: string
  subtitle?: string
  onSubmit: (pin: string) => void
  error?: string | null
  onCancel?: () => void
}) {
  const [pin, setPin] = useState('')
  const [shake, setShake] = useState(false)
  useEffect(() => {
    if (!error) return
    setShake(true)
    setPin('')
    const t = setTimeout(() => setShake(false), 450)
    return () => clearTimeout(t)
  }, [error])
  const submit = () => {
    if (pin.length < 4) return
    const p = pin
    setPin('')
    onSubmit(p)
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < 12 ? p + e.key : p))
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1))
      else if (e.key === 'Enter') submit()
      else if (e.key === 'Escape' && onCancel) onCancel()
      else return
      e.stopPropagation()
      e.preventDefault()
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  })
  const press = (d: string) => setPin((p) => (p.length < 12 ? p + d : p))
  return (
    <div className={`pin-card glass${shake ? ' shake' : ''}`}>
      <div className="pin-icon">
        <Lock size={26} />
      </div>
      <h2>{title}</h2>
      {subtitle && <p className="muted">{subtitle}</p>}
      <div className="pin-dots">
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span key={i} className={i < pin.length ? 'on' : ''} />
        ))}
      </div>
      {error && <p className="pin-error">{error}</p>}
      <div className="pin-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <button onClick={() => setPin('')} aria-label="Clear">
          <X size={18} />
        </button>
        <button onClick={() => press('0')}>0</button>
        <button onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete">
          <Delete size={18} />
        </button>
      </div>
      <div className="row" style={{ width: '100%' }}>
        {onCancel && (
          <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} disabled={pin.length < 4} onClick={submit}>
          Continue
        </button>
      </div>
    </div>
  )
}

// ------------------------------------------------- unlock-anywhere dialog

interface UnlockState {
  open: ((ok: boolean) => void) | null
  ask: () => Promise<boolean>
}
const useUnlock = create<UnlockState>((set) => ({
  open: null,
  ask: () => new Promise<boolean>((resolve) => set({ open: resolve })),
}))

/** Makes sure the private album is unlocked, asking for the PIN in a dialog if needed. */
export async function ensureVaultUnlocked(): Promise<boolean> {
  const [setUp, unlocked] = await api.vaultStatus()
  if (unlocked) return true
  if (!setUp) {
    useStore.getState().toast({
      text: 'Set a PIN for your Private album first',
      action: { label: 'Set up', run: () => useStore.getState().go({ kind: 'private' }) },
    })
    return false
  }
  return useUnlock.getState().ask()
}

export function UnlockHost() {
  const open = useUnlock((s) => s.open)
  const [error, setError] = useState<string | null>(null)
  if (!open) return null
  const done = (ok: boolean) => {
    useUnlock.setState({ open: null })
    setError(null)
    open(ok)
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <PinPad
        title="Unlock Private album"
        subtitle="Enter your PIN to move items into it."
        error={error}
        onCancel={() => done(false)}
        onSubmit={async (pin) => {
          try {
            await api.vaultUnlock(pin)
            done(true)
          } catch (e) {
            setError(errText(e))
          }
        }}
      />
    </div>
  )
}
