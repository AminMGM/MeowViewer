import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { errText } from './api'
import { useStore } from './store'

/** Updates come from GitHub Releases: github.com/AminMGM/MeowViewer (latest.json, signed). */
export async function checkForUpdate(manual = false): Promise<Update | null> {
  const { toast } = useStore.getState()
  try {
    const update = await check({ timeout: 15000 })
    if (!update) {
      if (manual) toast({ text: "You're on the latest version" })
      return null
    }
    toast({
      text: `MeowViewer ${update.version} is available`,
      sticky: true,
      action: { label: 'Update', run: () => installUpdate(update) },
    })
    return update
  } catch (e) {
    if (manual) toast({ text: `Couldn't check for updates: ${errText(e)}` })
    return null
  }
}

export async function installUpdate(update: Update) {
  const { toast, dismiss } = useStore.getState()
  let total = 0
  let got = 0
  const id = toast({ text: 'Downloading update…', sticky: true })
  try {
    await update.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0
      else if (ev.event === 'Progress') got += ev.data.chunkLength
    })
    dismiss(id)
    void total
    void got
    await relaunch()
  } catch (e) {
    dismiss(id)
    toast({ text: `Update failed: ${errText(e)}` })
  }
}
