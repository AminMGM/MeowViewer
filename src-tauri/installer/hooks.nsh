; MeowViewer installer hooks
; - close a running MeowViewer before files are replaced
; - register with Windows Default Apps (RegisteredApplications + Capabilities) and "Open with"
; - refresh the icon cache so Start / taskbar / desktop show the current icon

!define MV_EXE "$INSTDIR\meowviewer.exe"
!define MV_CAPS "Software\MeowViewer\Capabilities"

!macro MV_PROGID ID NAME
  WriteRegStr SHCTX "Software\Classes\${ID}" "" "${NAME} (MeowViewer)"
  WriteRegStr SHCTX "Software\Classes\${ID}" "FriendlyTypeName" "${NAME}"
  WriteRegStr SHCTX "Software\Classes\${ID}\DefaultIcon" "" "${MV_EXE},0"
  WriteRegStr SHCTX "Software\Classes\${ID}\shell\open\command" "" '"${MV_EXE}" "%1"'
!macroend

!macro MV_EXT EXT ID
  WriteRegStr SHCTX "${MV_CAPS}\FileAssociations" ".${EXT}" "${ID}"
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${ID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\meowviewer.exe\SupportedTypes" ".${EXT}" ""
!macroend

!macro MV_UNEXT EXT ID
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${ID}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM meowviewer.exe'
  Sleep 700
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro MV_PROGID "MeowViewer.Image" "Image"
  !insertmacro MV_PROGID "MeowViewer.Raw" "RAW photo"
  !insertmacro MV_PROGID "MeowViewer.Video" "Video"
  WriteRegStr SHCTX "${MV_CAPS}" "ApplicationName" "MeowViewer"
  WriteRegStr SHCTX "${MV_CAPS}" "ApplicationDescription" "Fast, light photo & video viewer and gallery"
  WriteRegStr SHCTX "${MV_CAPS}" "ApplicationIcon" "${MV_EXE},0"
  !insertmacro MV_EXT "jpg" "MeowViewer.Image"
  !insertmacro MV_EXT "jpeg" "MeowViewer.Image"
  !insertmacro MV_EXT "jfif" "MeowViewer.Image"
  !insertmacro MV_EXT "jpe" "MeowViewer.Image"
  !insertmacro MV_EXT "png" "MeowViewer.Image"
  !insertmacro MV_EXT "apng" "MeowViewer.Image"
  !insertmacro MV_EXT "gif" "MeowViewer.Image"
  !insertmacro MV_EXT "webp" "MeowViewer.Image"
  !insertmacro MV_EXT "avif" "MeowViewer.Image"
  !insertmacro MV_EXT "heic" "MeowViewer.Image"
  !insertmacro MV_EXT "heif" "MeowViewer.Image"
  !insertmacro MV_EXT "hif" "MeowViewer.Image"
  !insertmacro MV_EXT "bmp" "MeowViewer.Image"
  !insertmacro MV_EXT "dib" "MeowViewer.Image"
  !insertmacro MV_EXT "ico" "MeowViewer.Image"
  !insertmacro MV_EXT "tif" "MeowViewer.Image"
  !insertmacro MV_EXT "tiff" "MeowViewer.Image"
  !insertmacro MV_EXT "jxl" "MeowViewer.Image"
  !insertmacro MV_EXT "jxr" "MeowViewer.Image"
  !insertmacro MV_EXT "wdp" "MeowViewer.Image"
  !insertmacro MV_EXT "dds" "MeowViewer.Image"
  !insertmacro MV_EXT "tga" "MeowViewer.Image"
  !insertmacro MV_EXT "svg" "MeowViewer.Image"
  !insertmacro MV_EXT "cr2" "MeowViewer.Raw"
  !insertmacro MV_EXT "cr3" "MeowViewer.Raw"
  !insertmacro MV_EXT "nef" "MeowViewer.Raw"
  !insertmacro MV_EXT "arw" "MeowViewer.Raw"
  !insertmacro MV_EXT "dng" "MeowViewer.Raw"
  !insertmacro MV_EXT "raf" "MeowViewer.Raw"
  !insertmacro MV_EXT "orf" "MeowViewer.Raw"
  !insertmacro MV_EXT "rw2" "MeowViewer.Raw"
  !insertmacro MV_EXT "pef" "MeowViewer.Raw"
  !insertmacro MV_EXT "srw" "MeowViewer.Raw"
  !insertmacro MV_EXT "mp4" "MeowViewer.Video"
  !insertmacro MV_EXT "m4v" "MeowViewer.Video"
  !insertmacro MV_EXT "mov" "MeowViewer.Video"
  !insertmacro MV_EXT "mkv" "MeowViewer.Video"
  !insertmacro MV_EXT "webm" "MeowViewer.Video"
  !insertmacro MV_EXT "avi" "MeowViewer.Video"
  !insertmacro MV_EXT "wmv" "MeowViewer.Video"
  !insertmacro MV_EXT "3gp" "MeowViewer.Video"
  !insertmacro MV_EXT "mts" "MeowViewer.Video"
  !insertmacro MV_EXT "m2ts" "MeowViewer.Video"
  WriteRegStr SHCTX "Software\Classes\Applications\meowviewer.exe" "FriendlyAppName" "MeowViewer"
  WriteRegStr SHCTX "Software\Classes\Applications\meowviewer.exe\shell\open\command" "" '"${MV_EXE}" "%1"'
  WriteRegStr SHCTX "Software\RegisteredApplications" "MeowViewer" "${MV_CAPS}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM meowviewer.exe'
  Sleep 700
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro MV_UNEXT "jpg" "MeowViewer.Image"
  !insertmacro MV_UNEXT "jpeg" "MeowViewer.Image"
  !insertmacro MV_UNEXT "jfif" "MeowViewer.Image"
  !insertmacro MV_UNEXT "jpe" "MeowViewer.Image"
  !insertmacro MV_UNEXT "png" "MeowViewer.Image"
  !insertmacro MV_UNEXT "apng" "MeowViewer.Image"
  !insertmacro MV_UNEXT "gif" "MeowViewer.Image"
  !insertmacro MV_UNEXT "webp" "MeowViewer.Image"
  !insertmacro MV_UNEXT "avif" "MeowViewer.Image"
  !insertmacro MV_UNEXT "heic" "MeowViewer.Image"
  !insertmacro MV_UNEXT "heif" "MeowViewer.Image"
  !insertmacro MV_UNEXT "hif" "MeowViewer.Image"
  !insertmacro MV_UNEXT "bmp" "MeowViewer.Image"
  !insertmacro MV_UNEXT "dib" "MeowViewer.Image"
  !insertmacro MV_UNEXT "ico" "MeowViewer.Image"
  !insertmacro MV_UNEXT "tif" "MeowViewer.Image"
  !insertmacro MV_UNEXT "tiff" "MeowViewer.Image"
  !insertmacro MV_UNEXT "jxl" "MeowViewer.Image"
  !insertmacro MV_UNEXT "jxr" "MeowViewer.Image"
  !insertmacro MV_UNEXT "wdp" "MeowViewer.Image"
  !insertmacro MV_UNEXT "dds" "MeowViewer.Image"
  !insertmacro MV_UNEXT "tga" "MeowViewer.Image"
  !insertmacro MV_UNEXT "svg" "MeowViewer.Image"
  !insertmacro MV_UNEXT "cr2" "MeowViewer.Raw"
  !insertmacro MV_UNEXT "cr3" "MeowViewer.Raw"
  !insertmacro MV_UNEXT "nef" "MeowViewer.Raw"
  !insertmacro MV_UNEXT "arw" "MeowViewer.Raw"
  !insertmacro MV_UNEXT "dng" "MeowViewer.Raw"
  !insertmacro MV_UNEXT "raf" "MeowViewer.Raw"
  !insertmacro MV_UNEXT "orf" "MeowViewer.Raw"
  !insertmacro MV_UNEXT "rw2" "MeowViewer.Raw"
  !insertmacro MV_UNEXT "pef" "MeowViewer.Raw"
  !insertmacro MV_UNEXT "srw" "MeowViewer.Raw"
  !insertmacro MV_UNEXT "mp4" "MeowViewer.Video"
  !insertmacro MV_UNEXT "m4v" "MeowViewer.Video"
  !insertmacro MV_UNEXT "mov" "MeowViewer.Video"
  !insertmacro MV_UNEXT "mkv" "MeowViewer.Video"
  !insertmacro MV_UNEXT "webm" "MeowViewer.Video"
  !insertmacro MV_UNEXT "avi" "MeowViewer.Video"
  !insertmacro MV_UNEXT "wmv" "MeowViewer.Video"
  !insertmacro MV_UNEXT "3gp" "MeowViewer.Video"
  !insertmacro MV_UNEXT "mts" "MeowViewer.Video"
  !insertmacro MV_UNEXT "m2ts" "MeowViewer.Video"
  DeleteRegKey SHCTX "Software\Classes\MeowViewer.Image"
  DeleteRegKey SHCTX "Software\Classes\MeowViewer.Raw"
  DeleteRegKey SHCTX "Software\Classes\MeowViewer.Video"
  DeleteRegKey SHCTX "Software\Classes\Applications\meowviewer.exe"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "MeowViewer"
  DeleteRegKey SHCTX "Software\MeowViewer"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
