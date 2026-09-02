# Shinkansen unko checker - local static server
# For PWA / Service Worker testing. Open http://localhost:8123/
[int]$Port = 8123
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host ("Serving " + $Root + " at http://localhost:" + $Port + "/  (Ctrl+C to stop)") -ForegroundColor Green
try { Start-Process ("http://localhost:" + $Port + "/") } catch {}

$mime = @{
  ".html"="text/html; charset=utf-8"; ".js"="text/javascript; charset=utf-8";
  ".css"="text/css; charset=utf-8"; ".json"="application/json; charset=utf-8";
  ".webmanifest"="application/manifest+json; charset=utf-8"; ".svg"="image/svg+xml";
  ".png"="image/png"; ".ico"="image/x-icon"
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $rel = [uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
    if ([string]::IsNullOrEmpty($rel)) { $rel = "index.html" }
    $path = Join-Path $Root $rel
    if (Test-Path $path -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($path).ToLower()
      $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
  }
} finally {
  $listener.Stop()
}
