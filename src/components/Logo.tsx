import icon from '../../assets/icon.svg'

/** The MeowViewer app icon — the same artwork as the taskbar, Start menu, installer and exe. */
export function Logo({ size = 24 }: { size?: number }) {
  return <img src={icon} width={size} height={size} alt="" draggable={false} style={{ display: 'block', borderRadius: size * 0.22 }} />
}
