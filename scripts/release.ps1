# Publica uma versão do Heydesk no GitHub Releases, assinada localmente.
# A chave privada nunca sai deste PC (sem segredo no GitHub): quem publica usa a sua.
#
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\release.ps1 [-Notes "novidades"]
# Pré-requisitos: gh logado; chave em %USERPROFILE%\.tauri\heydesk.key (gerada com
# "npx tauri signer generate"); a chave pública correspondente em tauri.conf.json.
# A versão publicada é a de src-tauri/tauri.conf.json (mantenha package.json e
# Cargo.toml iguais).
param(
  [string]$Notes = "O Heydesk instalado se atualiza sozinho.",
  [string]$Key = "$env:USERPROFILE\.tauri\heydesk.key",
  [string]$Repo = "eudresfs/heydesk"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$version = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
$npm = (Get-Content package.json -Raw | ConvertFrom-Json).version
$cargo = (Select-String -Path src-tauri/Cargo.toml -Pattern '^version = "(.+)"' | Select-Object -First 1).Matches.Groups[1].Value
if ($npm -ne $version -or $cargo -ne $version) { throw "Versões diferentes: tauri.conf $version, package.json $npm, Cargo.toml $cargo." }
if (-not (Test-Path $Key)) { throw "Chave de assinatura não encontrada em $Key." }
if (git status --porcelain --untracked-files=no) { throw "Há alterações não commitadas." }
$tag = "v$version"
# Comandos externos escrevem avisos no stderr; o PowerShell 5 os trataria como erro fatal.
$ErrorActionPreference = "Continue"
gh release view $tag --repo $Repo *> $null
if ($LASTEXITCODE -eq 0) { throw "A versão $tag já foi publicada." }

# Assinatura das atualizações (só neste processo).
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $Key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npx tauri build
if ($LASTEXITCODE) { throw "O build falhou." }
$ErrorActionPreference = "Stop"

$bundle = "src-tauri/target/release/bundle/nsis"
$setup = Get-Item "$bundle/Heydesk_${version}_x64-setup.exe"
$signature = Get-Content "$($setup.FullName).sig" -Raw
$latest = [ordered]@{
  version = $version
  notes = $Notes
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = @{ "windows-x86_64" = @{ signature = $signature.Trim(); url = "https://github.com/$Repo/releases/download/$tag/$($setup.Name)" } }
}
$json = Join-Path $bundle "latest.json"
$latest | ConvertTo-Json -Depth 5 | Set-Content $json -Encoding utf8

$ErrorActionPreference = "Continue"
git tag $tag
git push origin $tag
if ($LASTEXITCODE) { throw "Não foi possível enviar a tag $tag." }
gh release create $tag $setup.FullName $json --repo $Repo --title "Heydesk $tag" --notes $Notes
if ($LASTEXITCODE) { throw "Não foi possível criar a Release." }
Write-Host "Publicado: https://github.com/$Repo/releases/tag/$tag"
