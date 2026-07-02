# 生成并上传 Tauri updater 的 latest.json 到 GitHub Release（官方自动更新的更新源）。
#
# 用法（发版流程最后一步，在 gh release create 并上传 -setup.exe 与 -setup.exe.sig 之后跑）:
#   .\scripts\make-latest-json.ps1 -Tag v0.10.0
#
# 前置：
#   1. build 时签名环境变量在位（TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD，
#      本机存于用户级环境变量；私钥 ~/.tauri/claudedeck.key 不在仓库内），bundle 才会产 .sig。
#   2. 该 Release 已创建、已上传 ClaudeDeck_x.y.z_x64-setup.exe 和同名 .sig。
#
# 行为：从 Release 资产读取 .sig 内容，拼 latest.json（version + notes〔取 release body，
# 显示在应用内更新弹窗〕+ platforms{url,signature}），上传到该 Release（--clobber 可重跑）。
# mac 的 .app.tar.gz + .sig 若在资产里（mac 侧构建接入签名后）会自动带上 darwin-aarch64。
param(
    [Parameter(Mandatory = $true)][string]$Tag
)

$ErrorActionPreference = 'Stop'
$repo = 'XueTianyu24/ClaudeDeck'
$version = $Tag -replace '^v', ''

$rel = gh release view $Tag --repo $repo --json assets,body | ConvertFrom-Json
if (-not $rel) { throw "找不到 Release $Tag" }
$assetNames = @($rel.assets | ForEach-Object { $_.name })

$sigDir = Join-Path $env:TEMP "claudedeck-latest-json"
if (Test-Path $sigDir) { Remove-Item -Recurse -Force $sigDir }
New-Item -ItemType Directory -Force $sigDir | Out-Null

function Get-SigContent([string]$sigName) {
    gh release download $Tag --repo $repo --pattern $sigName --dir $sigDir --clobber | Out-Null
    (Get-Content (Join-Path $sigDir $sigName) -Raw).Trim()
}

$platforms = [ordered]@{}

# Windows x64：NSIS -setup.exe（与 tauri.conf.json updater 安装路径对应）
$setup = $assetNames | Where-Object { $_ -like '*-setup.exe' } | Select-Object -First 1
$setupSig = $assetNames | Where-Object { $_ -like '*-setup.exe.sig' } | Select-Object -First 1
if ($setup -and $setupSig) {
    $platforms['windows-x86_64'] = [ordered]@{
        signature = Get-SigContent $setupSig
        url       = "https://github.com/$repo/releases/download/$Tag/$setup"
    }
}

# macOS Apple Silicon：.app.tar.gz（mac 侧构建带签名上传后生效）
$macTar = $assetNames | Where-Object { $_ -like '*.app.tar.gz' } | Select-Object -First 1
$macSig = $assetNames | Where-Object { $_ -like '*.app.tar.gz.sig' } | Select-Object -First 1
if ($macTar -and $macSig) {
    $platforms['darwin-aarch64'] = [ordered]@{
        signature = Get-SigContent $macSig
        url       = "https://github.com/$repo/releases/download/$Tag/$macTar"
    }
}

if ($platforms.Count -eq 0) {
    throw "Release $Tag 没有可用的 updater 资产（缺 *-setup.exe 或其 .sig；build 时签名环境变量是否在位？）"
}

$latest = [ordered]@{
    version  = $version
    notes    = [string]$rel.body
    pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = $platforms
}

$outPath = Join-Path $sigDir 'latest.json'
$latest | ConvertTo-Json -Depth 5 | Set-Content $outPath -Encoding utf8NoBOM
Write-Output "latest.json 内容："
Get-Content $outPath
gh release upload $Tag $outPath --repo $repo --clobber
Write-Output "✅ latest.json 已上传到 $Tag（平台：$($platforms.Keys -join ', ')）"
