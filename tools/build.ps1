# 打包成可以上傳到 Chrome 線上應用程式商店的 ZIP
#
#   powershell -ExecutionPolicy Bypass -File tools\build.ps1
#
# 只會放進「擴充功能執行時真的需要」的檔案；tools/、store/、dist/、README
# 這些開發用的東西不會進去（審查員看到用不到的程式碼容易有疑慮）。
#
# 注意：這裡刻意不用 Compress-Archive。Windows PowerShell 5.1 的
# Compress-Archive 會把路徑分隔符寫成反斜線，而商店那邊是在 Linux 解壓，
# 有機會整個子資料夾讀不到。所以改成自己建立項目並強制用正斜線。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$mf   = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver  = $mf.version
$dist = Join-Path $root 'dist'
$zip  = Join-Path $dist ('PaperLens-' + $ver + '.zip')

# 要打包的項目（檔案或資料夾）
$items = @('manifest.json', 'background.js', 'shared', 'content', 'export', 'options', 'popup', 'pdf', 'vendor', 'icons',
           '使用說明書.md', 'README.md')
$skip  = @('.map', '.sample-export.json', '.DS_Store', 'Thumbs.db')

Write-Host "PaperLens v$ver 打包中..."

# 收集檔案清單
$files = @()
foreach ($item in $items) {
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { throw "找不到 $item" }
  if (Test-Path $src -PathType Leaf) {
    $files += Get-Item $src
  } else {
    $files += Get-ChildItem $src -Recurse -File
  }
}
$files = $files | Where-Object {
  $n = $_.Name
  -not ($skip | Where-Object { $n.EndsWith($_) })
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }

$fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
try {
  $archive = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
      $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
      $out = $entry.Open()
      try {
        $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
        $out.Write($bytes, 0, $bytes.Length)
      } finally { $out.Dispose() }
      Write-Host ("  + " + $rel)
    }
  } finally { $archive.Dispose() }
} finally { $fs.Dispose() }

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)

Write-Host ''
Write-Host "完成：$zip"
Write-Host ("大小：$size KB，共 " + $files.Count + " 個檔案")
Write-Host ''
Write-Host '這個 ZIP 可以：'
Write-Host '  - 帶到另一台電腦解壓縮後「載入未封裝項目」'
Write-Host '  - 或日後上傳到 Chrome 線上應用程式商店'
