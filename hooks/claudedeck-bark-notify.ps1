# ClaudeDeck — Claude Code hook → 手机推送（默认 Bark）
#
# 用法：
#   1. 复制本文件到 ~/.claude/hooks/（Windows: C:\Users\<你>\.claude\hooks\）
#   2. 把下面的 PUT_YOUR_BARK_KEY_HERE 改成你的 Bark key
#   3. 按 README「手机推送配置」把 hooks 片段合并进 ~/.claude/settings.json
#   4. 新开一个 Claude Code 会话生效
#
# 要点：
#   - 本文件**必须保存为 UTF-8 with BOM**，否则 Windows PowerShell 5.1 读中文字面量会乱码。
#   - settings.json 里用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <本脚本正斜杠路径>` 调用。
#   - 换 ntfy / 微信等渠道：改最下方 curl 的目标即可。

$ErrorActionPreference = 'SilentlyContinue'

# 关键：强制按 UTF-8 读 stdin。Claude Code 写的是 UTF-8，5.1 的 [Console]::In 默认按 GBK 读会解析失败。
$raw = ''
try {
    $sr = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
    $raw = $sr.ReadToEnd()
    $sr.Dispose()
} catch { }

$j = $null
if ($raw) { try { $j = $raw | ConvertFrom-Json } catch { } }

$cwd  = if ($j -and $j.cwd) { [string]$j.cwd } else { '' }
$proj = if ($cwd) { Split-Path $cwd -Leaf } else { '会话' }
$ev   = if ($j) { [string]$j.hook_event_name } else { '' }
$sid  = if ($j -and $j.session_id) { [string]$j.session_id } else { 'unknown' }

$stateDir  = Join-Path $env:USERPROFILE '.claude\hooks\.state'
$stateFile = Join-Path $stateDir $sid

# ↓↓↓ 改成你的 Bark key（Bark app 首页 https://api.day.app/<KEY>/ 里的 KEY）
$barkKey = 'PUT_YOUR_BARK_KEY_HERE'
$url = "https://api.day.app/$barkKey"
$THRESHOLD_MS = 30000   # 长任务阈值：本轮满 30s 才推完成通知，过滤短问答

# ── UserPromptSubmit：仅记录本轮起点。必须绝对静默（该事件 stdout 会被注入对话！）──
if ($ev -eq 'UserPromptSubmit') {
    try {
        if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force $stateDir > $null }
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() |
            Set-Content -Path $stateFile -Encoding ASCII
    } catch { }
    exit 0
}

if ($ev -eq 'Stop') {
    $start = $null
    if (Test-Path $stateFile) {
        try { $start = [int64]((Get-Content $stateFile -Raw).Trim()) } catch { }
        Remove-Item $stateFile -Force
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $dur = if ($start) { $now - $start } else { 0 }
    if ($dur -lt $THRESHOLD_MS) { exit 0 }   # 短任务，安静

    $sec = [int]($dur / 1000)
    $durTxt = if ($sec -lt 60) { "${sec}s" } else { "{0}m{1}s" -f [int]($sec / 60), ($sec % 60) }
    $title = "✅ $proj · 任务完成"
    $body  = "用时 $durTxt"
    $sound = 'birdsong'
}
elseif ($ev -eq 'Notification') {
    $msg = if ($j -and $j.message) { [string]$j.message } else { '' }
    $title = "⏳ $proj · 需要你处理"
    $body  = if ($msg) { $msg } elseif ($cwd) { $cwd } else { '等待你的操作' }
    $sound = 'alarm'
}
else {
    exit 0
}

# 自己按 UTF-8 做 URL 编码，避免不同 PowerShell 版本 / shell 下 curl 参数中文乱码
function Enc([string]$s) { [uri]::EscapeDataString($s) }
$form = "title=$(Enc $title)&body=$(Enc $body)&group=ClaudeDeck&sound=$sound"
& curl.exe -s -X POST $url --data $form > $null
exit 0
