# Upstream open pull-request audit

Refreshed against `hangwin/mcp-chrome` on 2026-10-31 (initial audit 2026-08-31).
Upstream `master` is still `f48e71751e00bc09725c7e173423cff4f2ccd12a`, already
contained in this fork. There are no new mainline commits to merge. The fork adapts
useful changes instead of blindly merging overlapping branches into the session-isolated
implementation.

## October refresh

- Reviewed all 31 open PRs and the PRs updated since the September audit. Mainline
  remains at `f48e71751e00bc09725c7e173423cff4f2ccd12a`; the fork contains it.
- [#389](https://github.com/hangwin/mcp-chrome/pull/389): cherry-picked
  `3822d3ccc3a7bf8f6f7591b01f6df681743f4af2` with attribution. File downloads now
  reject private/local destinations and validate redirects. File names, temporary
  reads, verification and cleanup are confined to the upload directory.
  Review found gaps in the proposal: it checked IPv6 before falling back to IPv4,
  resolved DNS again during fetch, missed parts of private IPv6 ranges, and followed
  directory links. The fork checks every DNS answer, pins socket lookup to those
  answers, uses Node's subnet checks, rejects tunnel ranges, and checks real paths.
  Uploads use distinct, exclusively created files so repeated names cannot overwrite
  an earlier upload. Explicit `chrome_upload_file.filePath` uploads still work directly
  through CDP; the restrictions apply to the native temporary-file operations.
- [#393](https://github.com/hangwin/mcp-chrome/pull/393): already covered by the
  fork's per-session server factory and transport cleanup. Its close callback repeats
  the recursive cleanup pattern discussed under #382 below. Retained the fork's
  tested implementation.
- [#390](https://github.com/hangwin/mcp-chrome/pull/390): not included. It adds a
  third-party search service to new Claude AgentChat sessions by default, sending
  queries and requested URLs to Parallel. This optional product feature changes the
  fork's privacy defaults.
- [#374](https://github.com/hangwin/mcp-chrome/pull/374) was closed without merging;
  the fork already uses `better-sqlite3` 12. The updated #382 remains covered by the
  September fixes.

Release 1.1.1 pairs extension and bridge 1.1.1. Packaging now audits source and all
shipped text files for Chinese text and rejects Chinese/Japanese locale directories.
The upload regression suite also covers mixed DNS answers, socket lookup pinning,
redirects to private hosts, IPv4-mapped IPv6, directory links and repeated names.

## September refresh

- [#383](https://github.com/hangwin/mcp-chrome/pull/383): cherry-picked
  `bdc0400b845c3570db5098b7d55a53993278a05e` with attribution. URL-aware origin
  matching closes the loopback-prefix bypass. Added rejection before route execution,
  malformed-origin and configured-port checks, and actual Fastify/HTTP regression checks.
- [#382](https://github.com/hangwin/mcp-chrome/pull/382): the per-session factory and
  Streamable HTTP response ownership are already present. Its `onclose -> server.close()`
  pattern recurses with our pinned MCP SDK; removed that pattern from the fork after
  reproducing a stack overflow with a real session DELETE. Also preserve CORS headers
  on raw SDK responses, expose the session ID, let the SDK write legacy SSE headers,
  and release each session once during disconnect or server shutdown.
- [#324](https://github.com/hangwin/mcp-chrome/pull/324): skipped the Codex plugin
  packaging. Its `npx mcp-chrome-bridge` entry points to the upstream CLI rather than
  this fork's HTTP endpoint or stdio proxy; the existing fork skill remains authoritative.
- Reviewed the current list of 29 open PRs. The decisions for the previously reviewed proposals
  below still apply. The refreshed mainline contains no new merged fixes.

`scripts/verify-native-http.mjs` exercises the compiled server over real sockets:
21 disallowed requests, permitted browser-origin traffic, simultaneous MCP sessions,
DELETE without recursion, invalid DELETE preservation, legacy SSE, and shutdown
cleanup. Extension 1.0.1 packages the existing isolation behavior alongside bridge
1.0.30; detached-window screenshots retain the limitation in [SCREENSHOTS.md](SCREENSHOTS.md).

## Previous proposals

| PR                                                     | Decision                        | Reason                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#381](https://github.com/hangwin/mcp-chrome/pull/381) | Skip                            | Richer of the two tab-group APIs, but it can list or mutate every user group. JustBrowse already creates per-session groups automatically and must not expose cross-session/user groups. |
| [#377](https://github.com/hangwin/mcp-chrome/pull/377) | Integrated                      | Fastify now yields raw POST/GET/DELETE response ownership to the MCP transport before the SDK writes headers.                                                                            |
| [#374](https://github.com/hangwin/mcp-chrome/pull/374) | Integrated                      | `better-sqlite3` 12 fixes Node 24/25 native bindings. Confirmed with a real Node 25 in-memory SQL query.                                                                                 |
| [#372](https://github.com/hangwin/mcp-chrome/pull/372) | Integrated in part              | Its GET response-ownership regression test was adapted; #377 covers POST and DELETE as well.                                                                                             |
| [#365](https://github.com/hangwin/mcp-chrome/pull/365) | Integrated                      | `/ping` probes the extension and returns 503 for a stale bridge instead of a false healthy response.                                                                                     |
| [#354](https://github.com/hangwin/mcp-chrome/pull/354) | Superseded                      | Same per-transport factory fix as several PRs. JustBrowse already has the factory plus connection identity, cleanup, and browser-tab isolation.                                          |
| [#353](https://github.com/hangwin/mcp-chrome/pull/353) | Skip                            | Agent-chat Markdown UI dependency upgrade is unrelated to browser reliability and increases release risk.                                                                                |
| [#348](https://github.com/hangwin/mcp-chrome/pull/348) | Integrated                      | Network requests now honor the session-owned `tabId`, preserving cookies/context without activating the user's tab.                                                                      |
| [#346](https://github.com/hangwin/mcp-chrome/pull/346) | Superseded plus tests           | The factory is already stronger locally. Its distinct-server/transport regression coverage was adapted.                                                                                  |
| [#341](https://github.com/hangwin/mcp-chrome/pull/341) | Skip                            | Older and less complete tab-group API than #381, with the same global ownership problem.                                                                                                 |
| [#338](https://github.com/hangwin/mcp-chrome/pull/338) | Superseded                      | Duplicate per-transport server approach. Local implementation also propagates session identity into extension tools.                                                                     |
| [#336](https://github.com/hangwin/mcp-chrome/pull/336) | Skip                            | Popup localization is useful upstream product work but unrelated to JustBrowse session/screenshot behavior.                                                                              |
| [#335](https://github.com/hangwin/mcp-chrome/pull/335) | Integrated safely               | Added state-preserving tab moves, restricted to owned tabs and changed the default to no destination focus.                                                                              |
| [#334](https://github.com/hangwin/mcp-chrome/pull/334) | Skip                            | Repository disclosure-policy documentation only; no runtime change.                                                                                                                      |
| [#329](https://github.com/hangwin/mcp-chrome/pull/329) | Integrated                      | Replaced blocked/deprecated `unload` listeners with `pagehide`.                                                                                                                          |
| [#313](https://github.com/hangwin/mcp-chrome/pull/313) | Integrated                      | Optional `CHROME_MCP_HOST` supports WSL/non-default loopback routing without changing the default.                                                                                       |
| [#312](https://github.com/hangwin/mcp-chrome/pull/312) | Integrated and hardened         | Stdio proxy detects a dead client, rebuilds it, retries one connection failure, and propagates unrecoverable setup errors.                                                               |
| [#305](https://github.com/hangwin/mcp-chrome/pull/305) | Integrated                      | Navigation and tab closing now form valid exact patterns for `file://` URLs.                                                                                                             |
| [#304](https://github.com/hangwin/mcp-chrome/pull/304) | Integrated via combined cleanup | Stdio now closes its MCP client/server when stdin ends or closes.                                                                                                                        |
| [#303](https://github.com/hangwin/mcp-chrome/pull/303) | Skip                            | PR describes itself as an incomplete Qwen MVP and its automated review reported numerous unresolved comments.                                                                            |
| [#302](https://github.com/hangwin/mcp-chrome/pull/302) | Adapted                         | Kept lifecycle cleanup without its manual duplicate HTTP DELETE/watchdog. SDK client close owns transport teardown.                                                                      |
| [#301](https://github.com/hangwin/mcp-chrome/pull/301) | Superseded                      | Minimal factory-only form; lacks connection context, cleanup, and regression coverage now present here.                                                                                  |
| [#295](https://github.com/hangwin/mcp-chrome/pull/295) | Superseded                      | Earliest duplicate factory implementation; later comments point to #301/#346 variants.                                                                                                   |
| [#291](https://github.com/hangwin/mcp-chrome/pull/291) | Skip                            | Draft explicitly contains no changes and targets the wrong repository.                                                                                                                   |
| [#286](https://github.com/hangwin/mcp-chrome/pull/286) | Skip                            | Large UI localization/default-locale change outside the browser-control scope.                                                                                                           |
| [#285](https://github.com/hangwin/mcp-chrome/pull/285) | Integrated                      | Preserves PowerShell statement boundaries in the Windows directory picker.                                                                                                               |
| [#281](https://github.com/hangwin/mcp-chrome/pull/281) | Skip                            | Claude-specific environment loading is outside the bridge path and its Windows host-script behavior is explicitly unverified.                                                            |

Additional lifecycle hardening was added from the discussion on #346: inactive
Streamable HTTP sessions expire after 4 hours (configurable with
`CHROME_MCP_SESSION_IDLE_MS`), and ending sessions release extension-side tab ownership
so abandoned clients cannot permanently reserve tabs. A client that returns with an
expired session ID, or one from before a bridge restart, is resumed under the same ID
instead of being rejected.
