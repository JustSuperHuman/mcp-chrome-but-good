# JustBrowseMCP releases

Releases are published on GitHub:
<https://github.com/JustSuperHuman/mcp-chrome-but-good/releases>. Each one has
`justbrowse-<version>.zip`, `justbrowse-<version>.tar.gz` and `SHA256SUMS`; the one-line
installers in the [README](../README.md#install) download the newest and check it against
`SHA256SUMS`. `node scripts/package-release.mjs` builds them.

## 1.1.3 — 2026-11-04

Extension **1.1.3** pairs with native bridge **1.1.3**. Only the bridge changed.

- Agents keep the browser after a break. The bridge used to forget an MCP session
  after 30 idle minutes, or whenever it restarted along with the browser. From then
  on it answered every call from that client with
  `HTTP 400: Invalid MCP request or session.`, while the extension still showed
  Connected. Codex never recovered without a restart. The bridge now resumes the
  session under the ID the client already holds, so the next call works. After a
  bridge restart the agent keeps its tabs too.
- A session ID the bridge never issued gets `404 Session not found`, the MCP spec's
  signal to start a new session, instead of a 400.
- Idle sessions keep their tabs for 4 hours instead of 30 minutes.
  `CHROME_MCP_SESSION_IDLE_MS` still overrides this.
- Ending a session that already expired succeeds and frees its tabs. The stdio
  bridge reconnects when it sees `Session not found`.

Run the one-line installer to update. It restarts the bridge, and agents that are
already running carry on without being restarted. Reloading the extension only
updates its version number; its code is unchanged.

Validation: 669 extension tests and 156 native tests pass. Ten new session tests
fail against 1.1.2 with its 400. Resuming works with the pinned MCP SDK 1.24.3 and
the current 1.32.2. On a live Edge bridge, a session opened before a restart made a
browser call after it under the same ID. Release, HTTP/SSE, framing and
English-text checks pass.

## 1.1.2 — 2026-10-31

Extension **1.1.2** pairs with native bridge **1.1.2**.

- Native messages use a chunk queue instead of repeatedly copying a partially
  received message. A controlled 4 MB message split into 4 KB fragments required
  about 2 GB of copying before this change and 4 MB afterward.
- Repeated tool calls on the current session tab reuse its lease and group. They
  no longer rewrite the full session state or regroup the tab after every call.
  Closing unrelated user tabs also leaves session storage alone.
- The automation scheduler backs off polling when its queue is empty. Explicit
  enqueue/completion notifications still run immediately; the default fallback
  polling delay is capped at the 7.5-second lease-reclaim interval.
- Content indexing keeps one page-cache entry per tab, clears it on removal,
  cancels pending work on navigation/close, and installs listeners once across
  model changes. Repeated page-completion events share one deferred indexing task.
- Production scripts are minified. The extension uses the bro arm icon at actual
  toolbar sizes: all five icon files together are about 39 KB, down from 1 MB.
  The extension name and popup title now read JustBrowseMCP.

If reloading still shows Chinese text, check the extension's version. The old
development folder can still contain a 1.0.1 build with `zh_CN` as its default
locale. Update through the installer or rebuild that folder, then reload the
extension; reloading alone does not rebuild its files.

Validation: 669 extension tests and 146 native tests pass. Release, HTTP/SSE and
Windows launcher checks pass, including a real-pipe test with a fragmented 1 MB
payload and 350 responses. All 96 shipped scripts parse; the two archives contain
the same 222 files and pass SHA-256 checks. Production JavaScript totals 7.1 MB,
down from 12.3 MB. A clean bundle dependency install, CLI version check and SQLite
query pass. The loaded Edge extension was reloaded and verified as 1.1.2 with an
English popup and the bro icon.

## 1.1.1 — 2026-10-31

Extension **1.1.1** pairs with native bridge **1.1.1**.

- File uploads include upstream [PR #389](https://github.com/hangwin/mcp-chrome/pull/389),
  with additional fixes for DNS rebinding, mixed IPv4/IPv6 answers, private IPv6
  ranges and directory links. Downloads accept public HTTP(S) destinations and
  recheck every redirect. Native temporary-file reads and cleanup stay inside the
  upload directory; repeated file names create separate files.
- Release packaging checks the source and every shipped text file for Chinese
  text. The released extension keeps English as its default locale and excludes
  the Chinese and Japanese locale directories. Release verification also checks
  that the stable extension ID has not changed.
- The [upstream audit](../docs/UPSTREAM_PR_AUDIT.md) is current through October 31.
  Upstream mainline has no newer commits. The latest per-session MCP server proposal
  is already covered by the fork's session implementation.

Run the same one-line installer to update, then reload the extension. `fileUrl`
downloads from localhost or a private network are now rejected; use `filePath` for
an existing local file or `base64Data` for supplied bytes.

Validation: 659 extension tests and 133 native tests pass. The release build,
native TypeScript, lint on changed code, English-text audit, HTTP/SSE transport
checks and Windows launcher checks pass. All 95 shipped scripts parse, both
archives contain the same 219 files, and their SHA-256 checksums match. A clean
bundle installs its production dependencies and passes the bridge CLI version
check and an in-memory SQLite query. A public HTTPS download and temporary-file
cleanup also pass against the compiled bridge.

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
