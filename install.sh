#!/usr/bin/env bash
# JustBrowseMCP for macOS and Linux: the browser extension, its native bridge, the justbrowse-browser agent
# skill and the MCP entries for Claude Code and Codex. Run it again to update.
#
#   curl -fsSL https://raw.githubusercontent.com/JustSuperHuman/mcp-chrome-but-good/master/install.sh | bash
#
# JUSTBROWSE_VERSION=v1.1.0 installs that release instead of the newest. Run from an unpacked release bundle, it
# installs the bundle beside it. Everything goes in ~/Library/Application Support/JustBrowseMCP (macOS) or
# ${XDG_DATA_HOME:-~/.local/share}/justbrowse-mcp (Linux), or $JUSTBROWSE_DIR, for this user only.
set -euo pipefail

repo="JustSuperHuman/mcp-chrome-but-good"
extension_id="dgpjcgoidnfedcpaijeelljbppcfhcll"
host_name="com.chromemcp.nativehost"
mcp_url="http://127.0.0.1:12306/mcp"
if [ -n "${JUSTBROWSE_DIR:-}" ]; then
  root="$JUSTBROWSE_DIR"
elif [ "$(uname -s)" = "Darwin" ]; then
  root="$HOME/Library/Application Support/JustBrowseMCP"
else
  root="${XDG_DATA_HOME:-$HOME/.local/share}/justbrowse-mcp"
fi

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf 'justbrowse: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "JustBrowseMCP needs Node.js 20 or newer (bro install node, or nodejs.org), then run this again"
major=$(node -p "process.versions.node.split('.')[0]")
[ "$major" -ge 20 ] || die "Node.js $(node --version) is too old: JustBrowseMCP needs 20 or newer"

# The bundle: the one this script sits in, else the release on GitHub (checked against its SHA256SUMS)
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/bridge/package.json" ]; then
  bundle="$here"
else
  if [ -n "${JUSTBROWSE_VERSION:-}" ]; then api="https://api.github.com/repos/$repo/releases/tags/$JUSTBROWSE_VERSION"; else api="https://api.github.com/repos/$repo/releases/latest"; fi
  json="$(curl -fsSL -H 'User-Agent: justbrowse-installer' "$api")"
  tag="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name))')"
  url() { printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).assets.find(a=>new RegExp(process.argv[1]).test(a.name));console.log(a?a.browser_download_url:"")})' "$1"; }
  archive_url="$(url '^justbrowse-.*\.tar\.gz$')"
  [ -n "$archive_url" ] || die "release $tag has no justbrowse-*.tar.gz"
  step "JustBrowseMCP $tag"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  name="${archive_url##*/}"
  curl -fsSL "$archive_url" -o "$tmp/$name"
  sums_url="$(url '^SHA256SUMS$')"
  if [ -n "$sums_url" ]; then
    curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS"
    want="$(grep "  $name\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
    if command -v sha256sum >/dev/null; then got="$(sha256sum "$tmp/$name" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1)"; fi
    [ "$want" = "$got" ] || die "$name doesn't match its SHA-256 in SHA256SUMS: not installing it"
    note "checked against its SHA-256"
  fi
  tar -xzf "$tmp/$name" -C "$tmp"
  bundle="$(find "$tmp" -mindepth 2 -maxdepth 2 -name release.json -exec dirname {} \; | head -n1)"
  [ -n "$bundle" ] || die "$name isn't a JustBrowseMCP bundle"
fi
field() { node -p "require(process.argv[1])[process.argv[2]]" "$bundle/release.json" "$1"; }
version="$(field version)"
bridge_version="$(field bridge)"

# A running bridge is restarted by the extension when it reconnects
pkill -f "$root/bridge/dist" 2>/dev/null || true

step "extension $version -> $root/extension"
mkdir -p "$root"
rm -rf "$root/extension"
cp -R "$bundle/extension" "$root/extension"

step "native bridge $bridge_version -> $root/bridge"
mkdir -p "$root/bridge"
rm -rf "$root/bridge/dist" "$root/bridge/vendor"
cp -R "$bundle/bridge/." "$root/bridge/"
(cd "$root/bridge" && npm install --omit=dev --install-links --no-audit --no-fund --loglevel=error)

step "registering the native host for Chrome, Chromium, Edge and Brave"
node "$root/bridge/dist/cli.js" register --browser all
if [ "$(uname -s)" = "Darwin" ]; then
  base="$HOME/Library/Application Support"
  chrome_manifest="$base/Google/Chrome/NativeMessagingHosts/$host_name.json"
  others=("$base/Microsoft Edge/NativeMessagingHosts" "$base/BraveSoftware/Brave-Browser/NativeMessagingHosts")
else
  chrome_manifest="$HOME/.config/google-chrome/NativeMessagingHosts/$host_name.json"
  others=("$HOME/.config/microsoft-edge/NativeMessagingHosts" "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts")
fi
for dir in "${others[@]}"; do
  if [ -f "$chrome_manifest" ] && [ -d "$(dirname "$dir")" ]; then
    mkdir -p "$dir" && cp "$chrome_manifest" "$dir/"
  fi
done

step "the justbrowse-browser skill"
for spec in "$HOME/.claude:claude" "${CODEX_HOME:-$HOME/.codex}:codex" "$HOME/.agents:"; do
  dir="${spec%:*}"; cli="${spec##*:}"
  if [ ! -d "$dir" ] && { [ -z "$cli" ] || ! command -v "$cli" >/dev/null; }; then continue; fi
  dest="$dir/skills/justbrowse-browser"
  if [ -L "$dest" ]; then note "$dest is a link: left as it is"; continue; fi
  mkdir -p "$dest"
  cp -R "$bundle/skills/justbrowse-browser/." "$dest/"
  note "$dest"
done

step "MCP server 'justbrowse' ($mcp_url)"
if command -v claude >/dev/null; then
  if claude mcp get justbrowse >/dev/null 2>&1; then note "Claude Code: already added"
  elif claude mcp add --scope user --transport http justbrowse "$mcp_url" >/dev/null 2>&1; then note "Claude Code: added for every project"
  else note "Claude Code: add it yourself: claude mcp add --scope user --transport http justbrowse $mcp_url"; fi
fi
if command -v codex >/dev/null; then
  config="${CODEX_HOME:-$HOME/.codex}/config.toml"
  if [ -f "$config" ] && grep -qF '[mcp_servers.justbrowse]' "$config"; then note "Codex: already added"
  elif codex mcp add justbrowse --url "$mcp_url" >/dev/null 2>&1; then note "Codex: added"
  else note "Codex: this version can't add it from here: add [mcp_servers.justbrowse] url = \"$mcp_url\" to $config"; fi
fi

printf '{\n  "version": "%s",\n  "bridge": "%s",\n  "extensionId": "%s",\n  "installedAt": "%s"\n}\n' \
  "$version" "$bridge_version" "$extension_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$root/installed.json"

echo
if grep -rqsF "$extension_id" "$HOME/Library/Application Support/Google/Chrome" "$HOME/.config/google-chrome" \
  "$HOME/Library/Application Support/Microsoft Edge" "$HOME/.config/microsoft-edge" --include='Secure Preferences' 2>/dev/null; then
  step "done: on your browser's extensions page, click Reload on JustBrowseMCP, then Connect in its popup"
else
  step "done: one step left, in Chrome, Edge or Brave"
  note "1. open chrome://extensions (edge://extensions), turn on Developer mode"
  note "2. Load unpacked: $root/extension"
  note "3. click the JustBrowseMCP icon, then Connect"
fi
note "check it with: curl http://127.0.0.1:12306/ping (extensionConnected: true)"
