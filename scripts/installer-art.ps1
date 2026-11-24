# Generates the NSIS installer artwork (sidebar 164x314, header 150x57) from the app icon.
# Run: powershell -ExecutionPolicy Bypass -File scripts/installer-art.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$icon = [System.Drawing.Image]::FromFile((Join-Path $root 'src-tauri\icons\icon.png'))
$out = Join-Path $root 'src-tauri\installer'
New-Item -ItemType Directory -Force $out | Out-Null

function New-Gradient($w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(24, 18, 44)), ([System.Drawing.Color]::FromArgb(10, 30, 44)), 65
  $g.FillRectangle($brush, $rect)
  # Soft aurora glows
  $glow = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glow.AddEllipse(-60, -40, $w + 40, [int]($h * 0.6))
  $pg = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow
  $pg.CenterColor = [System.Drawing.Color]::FromArgb(120, 139, 92, 246); $pg.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 139, 92, 246))
  $g.FillPath($pg, $glow)
  $glow2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glow2.AddEllipse(-20, [int]($h * 0.55), $w + 60, [int]($h * 0.6))
  $pg2 = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow2
  $pg2.CenterColor = [System.Drawing.Color]::FromArgb(90, 34, 211, 238); $pg2.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 34, 211, 238))
  $g.FillPath($pg2, $glow2)
  return @($bmp, $g)
}

# ---- sidebar (welcome / finish pages)
$bmp, $g = New-Gradient 164 314
$g.DrawImage($icon, 37, 46, 90, 90)
$white = [System.Drawing.Brushes]::White
$fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'
$title = New-Object System.Drawing.Font 'Segoe UI Semibold', 14
$small = New-Object System.Drawing.Font 'Segoe UI', 8
$soft = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 220, 220, 240))
$g.DrawString('MeowViewer', $title, $white, (New-Object System.Drawing.RectangleF 0, 150, 164, 30), $fmt)
$g.DrawString("Photos & videos,`nfast and light.", $small, $soft, (New-Object System.Drawing.RectangleF 0, 182, 164, 34), $fmt)
$heart = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 92, 138))
$g.DrawString('Made with', $small, $soft, (New-Object System.Drawing.RectangleF 0, 262, 164, 16), $fmt)
$g.DrawString([char]0x2665 + ' by AminMGM', (New-Object System.Drawing.Font 'Segoe UI Semibold', 9), $white, (New-Object System.Drawing.RectangleF 0, 276, 164, 18), $fmt)
$g.DrawString('github.com/AminMGM', $small, $soft, (New-Object System.Drawing.RectangleF 0, 294, 164, 16), $fmt)
$bmp.Save((Join-Path $out 'sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()

# ---- header (inner pages, top-right)
$bmp, $g = New-Gradient 150 57
$g.DrawImage($icon, 8, 8, 41, 41)
$g.DrawString('MeowViewer', (New-Object System.Drawing.Font 'Segoe UI Semibold', 11), $white, 52, 9)
$g.DrawString('by AminMGM', $small, $soft, 54, 30)
$bmp.Save((Join-Path $out 'header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()
$icon.Dispose()
"installer art written to $out"
