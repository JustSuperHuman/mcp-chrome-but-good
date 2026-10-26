# JustBrowseMCP for Windows: the browser extension, its native bridge, the justbrowse-browser agent skill and
# the MCP entries for Claude Code and Codex. Run it again to update.
#
#   irm https://raw.githubusercontent.com/JustSuperHuman/mcp-chrome-but-good/master/install.ps1 | iex
#
# $env:JUSTBROWSE_VERSION = 'v1.1.0' installs that release instead of the newest. Run from an unpacked release
# bundle, it installs the bundle beside it. Everything goes in %LOCALAPPDATA%\JustBrowseMCP (or $env:JUSTBROWSE_DIR),
# for this user only.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'JustSuperHuman/mcp-chrome-but-good'
$root = if ($env:JUSTBROWSE_DIR) { $env:JUSTBROWSE_DIR } else { Join-Path $env:LOCALAPPDATA 'JustBrowseMCP' }
$userHome = $env:USERPROFILE
$extensionId = 'dgpjcgoidnfedcpaijeelljbppcfhcll'
$hostName = 'com.chromemcp.nativehost'
$mcpUrl = 'http://127.0.0.1:12306/mcp'

function Step([string] $text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Note([string] $text) { Write-Host "    $text" }

# Node.js 20 or newer runs the bridge
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'JustBrowseMCP needs Node.js 20 or newer: winget install OpenJS.NodeJS.LTS (or bro install node), then run this again.'
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { throw "Node.js $(& node --version) is too old: JustBrowseMCP needs 20 or newer." }

# The bundle: the one this script sits in, else the release on GitHub (checked against its SHA256SUMS)
$bundle = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'bridge\package.json'))) {
    $bundle = $PSScriptRoot
} else {
    $tag = $env:JUSTBROWSE_VERSION
    $api = if ($tag) { "https://api.github.com/repos/$repo/releases/tags/$tag" } else { "https://api.github.com/repos/$repo/releases/latest" }
    $release = Invoke-RestMethod $api -Headers @{ 'User-Agent' = 'justbrowse-installer' }
    $asset = $release.assets | Where-Object { $_.name -like 'justbrowse-*.zip' } | Select-Object -First 1
    if (-not $asset) { throw "release $($release.tag_name) has no justbrowse-*.zip" }
    Step "JustBrowseMCP $($release.tag_name)"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('justbrowse-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp $asset.name
    Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
    $sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1
    if ($sums) {
        $file = Join-Path $tmp 'SHA256SUMS'
        Invoke-WebRequest $sums.browser_download_url -OutFile $file -UseBasicParsing
        $line = Get-Content $file | Where-Object { $_ -like "*  $($asset.name)" } | Select-Object -First 1
        $want = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
        $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
        if ($want -ne $got) { throw "$($asset.name) doesn't match its SHA-256 in SHA256SUMS: not installing it" }
        Note 'checked against its SHA-256'
    }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $bundle = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'bridge\package.json') } | Select-Object -First 1 -ExpandProperty FullName
    if (-not $bundle) { throw "$($asset.name) isn't a JustBrowseMCP bundle" }
}
$info = Get-Content (Join-Path $bundle 'release.json') -Raw | ConvertFrom-Json

# A running bridge keeps its native module open: stop it (the extension starts it again when it reconnects)
$bridgeDir = Join-Path $root 'bridge'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($bridgeDir) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Step "extension $($info.version) -> $root\extension"
New-Item -ItemType Directory -Path $root -Force | Out-Null
$extensionDir = Join-Path $root 'extension'
if (Test-Path $extensionDir) { Remove-Item $extensionDir -Recurse -Force }
Copy-Item (Join-Path $bundle 'extension') $extensionDir -Recurse

Step "native bridge $($info.bridge) -> $bridgeDir"
New-Item -ItemType Directory -Path $bridgeDir -Force | Out-Null
foreach ($old in 'dist', 'vendor') {
    $p = Join-Path $bridgeDir $old
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Copy-Item (Join-Path $bundle 'bridge\*') $bridgeDir -Recurse -Force
Push-Location $bridgeDir
try {
    & npm install --omit=dev --install-links --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed in $bridgeDir (exit $LASTEXITCODE)" }
} finally { Pop-Location }

Step 'registering the native host for Chrome, Chromium, Edge and Brave'
& node (Join-Path $bridgeDir 'dist\cli.js') register --browser all
if ($LASTEXITCODE -ne 0) { throw "registering the native host failed (exit $LASTEXITCODE)" }
$manifest = Join-Path $env:APPDATA "Google\Chrome\NativeMessagingHosts\$hostName.json"
foreach ($browser in 'Microsoft\Edge', 'BraveSoftware\Brave-Browser') {
    $key = "HKCU:\Software\$browser\NativeMessagingHosts\$hostName"
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $manifest
}

Step 'the justbrowse-browser skill'
$homes = @(
    @{ Dir = (Join-Path $userHome '.claude'); Cli = 'claude' },
    @{ Dir = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $userHome '.codex' }); Cli = 'codex' },
    @{ Dir = (Join-Path $userHome '.agents'); Cli = $null }
)
foreach ($h in $homes) {
    $used = (Test-Path $h.Dir) -or ($h.Cli -and (Get-Command $h.Cli -ErrorAction SilentlyContinue))
    if (-not $used) { continue }
    $skills = Join-Path $h.Dir 'skills'
    $dest = Join-Path $skills 'justbrowse-browser'
    $linked = (Test-Path $dest) -and ((Get-Item $dest -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
    if ($linked) { Note "$dest is a link: left as it is"; continue }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item (Join-Path $bundle 'skills\justbrowse-browser\*') $dest -Recurse -Force
    Note $dest
}

# Runs a native command with its output hidden; true when it exits 0. (Windows PowerShell turns the stderr of a
# redirected native command into errors, which 'Stop' would throw on.)
function Quietly([scriptblock] $command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $command *> $null; return $LASTEXITCODE -eq 0 } catch { return $false } finally { $ErrorActionPreference = $previous }
}

Step "MCP server 'justbrowse' ($mcpUrl)"
if (Get-Command claude -ErrorAction SilentlyContinue) {
    if (Quietly { claude mcp get justbrowse }) {
        Note 'Claude Code: already added'
    } elseif (Quietly { claude mcp add --scope user --transport http justbrowse $mcpUrl }) {
        Note 'Claude Code: added for every project'
    } else {
        Note "Claude Code: add it yourself: claude mcp add --scope user --transport http justbrowse $mcpUrl"
    }
}
if (Get-Command codex -ErrorAction SilentlyContinue) {
    $config = Join-Path $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $userHome '.codex' }) 'config.toml'
    if ((Test-Path $config) -and (Select-String -Path $config -SimpleMatch '[mcp_servers.justbrowse]' -Quiet)) {
        Note 'Codex: already added'
    } elseif (Quietly { codex mcp add justbrowse --url $mcpUrl }) {
        Note 'Codex: added'
    } else {
        Note "Codex: this version can't add it from here: add [mcp_servers.justbrowse] url = `"$mcpUrl`" to $config"
    }
}

@{ version = $info.version; bridge = $info.bridge; extensionId = $extensionId; installedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -Path (Join-Path $root 'installed.json') -Encoding UTF8

# Load the extension: browsers only take an unpacked one by hand
$profiles = @(
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'),
    (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data')
) | Where-Object { Test-Path $_ }
$loaded = $false
foreach ($p in $profiles) {
    $prefs = Get-ChildItem $p -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'Secure Preferences' } | Where-Object { Test-Path $_ }
    foreach ($f in $prefs) { if (Select-String -Path $f -SimpleMatch $extensionId -Quiet) { $loaded = $true } }
}
Write-Host ''
if ($loaded) {
    Step 'done: on your browser''s extensions page, click Reload on JustBrowseMCP, then Connect in its popup'
} else {
    Set-Clipboard -Value $extensionDir -ErrorAction SilentlyContinue
    Step 'done: one step left, in Chrome, Edge or Brave'
    Note '1. open chrome://extensions (edge://extensions), turn on Developer mode'
    Note "2. Load unpacked: $extensionDir (the path is on your clipboard)"
    Note '3. click the JustBrowseMCP icon, then Connect'
}
Note "check it with: Invoke-RestMethod http://127.0.0.1:12306/ping (extensionConnected: true)"
