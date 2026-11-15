# Envia os arquivos do projeto para o GitHub (sem precisar do Git instalado).
# Uso: powershell -ExecutionPolicy Bypass -File scripts\publicar.ps1 [arquivos...]
param([string[]]$Arquivos)
$ErrorActionPreference = 'Stop'
$env:Path = "C:\Program Files\GitHub CLI;$env:Path"
$root = Split-Path -Parent $PSScriptRoot
$owner = (gh api user --jq .login).Trim()
$repo = "$owner/radar-investimentos"
if (-not $Arquivos) {
  $Arquivos = @('config.json','scripts/update.mjs','scripts/serve.mjs','scripts/publicar.ps1','.github/workflows/atualizar.yml',
    'docs/index.html','docs/sw.js','docs/manifest.webmanifest','docs/icon.svg','docs/icon-192.png','docs/icon-512.png','docs/.nojekyll','docs/data.json','data/state.json')
}
$tmp = Join-Path $env:TEMP 'radar-put.json'
foreach ($f in $Arquivos) {
  $full = Join-Path $root $f
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($full))
  $sha = $null
  try { $sha = (gh api "repos/$repo/contents/$f" --jq .sha 2>$null) } catch {}
  $body = @{ message = "Atualiza $f"; content = $b64; branch = 'main' }
  if ($sha) { $body.sha = $sha.Trim() }
  [IO.File]::WriteAllText($tmp, ($body | ConvertTo-Json -Compress))
  gh api -X PUT "repos/$repo/contents/$f" --input $tmp --jq '.content.path' | Out-Null
  Write-Output "enviado: $f"
}
Remove-Item $tmp -ErrorAction SilentlyContinue
