# JustBrowseMCP releases

Releases are published on GitHub:
<https://github.com/JustSuperHuman/mcp-chrome-but-good/releases>. Each one has
`justbrowse-<version>.zip`, `justbrowse-<version>.tar.gz` and `SHA256SUMS`; the one-line
installers in the [README](../README.md#install) download the newest and check it against
`SHA256SUMS`. `node scripts/package-release.mjs` builds them.

## 1.1.0 — 2026-10-26

Extension **1.1.0** pairs with native bridge **1.1.0**.

- **One-line install and update.** `install.ps1` (Windows) and `install.sh` (macOS, Linux)
  install the extension, the native bridge, the `justbrowse-browser` agent skill and the
  `justbrowse` MCP server for Claude Code and Codex, for the current user. Loading the
  unpacked extension once is the only manual step. `bro install justbrowse` runs the same
  installer.
- **A stable extension ID.** Release builds carry JustBrowse's manifest key, so the
  extension is `dgpjcgoidnfedcpaijeelljbppcfhcll` wherever it is unpacked. The native host
  authorizes it alongside the development and upstream IDs. Development builds are
  unchanged and build into `.output`, release builds into `.output-release`.
- **Edge and Brave.** The installers register the native host for Chrome, Chromium, Edge and
  Brave.
- **English only.** Comments, logs, UI text, prompts and docs are in English; the Chinese and
  Japanese locales and the Chinese-only docs are gone, and the default locale is `en`.
  Characters the code matches on (CJK sentence punctuation for semantic search, and the
  tables inside dependencies) are written as `\uXXXX` escapes, so the shipped extension
  contains no literal Chinese text and behaves as before.
- **Windows startup.** `scripts/install-windows-startup.ps1` adds a hidden sign-in task that
  starts the bridge's browser profile; `run_host.bat` no longer breaks on PATH entries with
  quotes, parentheses or ampersands.

### Update from 1.0.x

Run the installer. It installs to `%LOCALAPPDATA%\JustBrowseMCP` (macOS
`~/Library/Application Support/JustBrowseMCP`, Linux `~/.local/share/justbrowse-mcp`) and
points the native host there. Load that `extension` folder with **Load unpacked**: its ID
differs from a development build's, so remove the development copy to keep one extension
talking to the bridge, then click **Connect**.

### Validation

- 659 extension tests (43 files) and 31 native tests pass; native TypeScript passes.
- The release build passes `verify-extension-build` (with `JUSTBROWSE_RELEASE=1`) and
  `verify-native-http`; every emitted script parses.
- `install.ps1` was run end to end from the bundle into a clean profile: bridge dependencies,
  native-host registration for all four browsers, skills, the Claude Code and Codex MCP
  entries, and `mcp-chrome-bridge doctor` all pass.
- Multi-profile broker routing and recorded-flow isolation remain future work.

## 1.0.1 — 2026-09-24

Extension 1.0.1 with native bridge 1.0.30: upstream PR #383's exact host and protocol
matching for the bridge, origins rejected before HTTP handlers run, CORS and session
headers kept on streamed MCP responses, and fixes for recursive session close, duplicate
cleanup, invalid DELETE session removal and shutdown with open streams.
