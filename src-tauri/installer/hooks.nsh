; MeowViewer installer hooks
; Close any running MeowViewer so its files can be replaced (avoids "Error opening file for writing").
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM meowviewer.exe'
  Sleep 700
!macroend

; Make Explorer, Start and the taskbar pick up the new icon immediately.
!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM meowviewer.exe'
  Sleep 700
!macroend
