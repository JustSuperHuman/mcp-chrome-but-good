# JustBrowseMCP 1.0.1 — 2026-09-24

Extension **1.0.1** pairs with native bridge **1.0.30**.

## Changes

- Integrated upstream [PR #383](https://github.com/hangwin/mcp-chrome/pull/383):
  exact host/protocol matching prevents lookalike origins from accessing the bridge.
- Reject disallowed origins before HTTP handlers execute, including simple requests.
- Preserve CORS and session headers for browser clients on streamed MCP responses.
- Fix recursive session close, duplicate cleanup, invalid DELETE session removal,
  and shutdown with open streams. Keep simultaneous clients independent.
- Exercise production extension assets and compiled HTTP transports with
  `corepack pnpm@8.15.9 verify:release` after building shared/native and the extension ZIP.

## Update from this checkout

```powershell
corepack pnpm@8.15.9 install --frozen-lockfile
corepack pnpm@8.15.9 build:shared
corepack pnpm@8.15.9 build:native
corepack pnpm@8.15.9 --filter chrome-mcp-server zip
corepack pnpm@8.15.9 verify:release
corepack pnpm@8.15.9 --filter mcp-chrome-bridge register:dev
```

In `chrome://extensions` or `edge://extensions`, **Reload** the existing unpacked
extension, then open its popup and reconnect if necessary. Keep the installed
directory unchanged: `app/chrome-extension/.output/chrome-mv3`. A different unpacked
path can produce a different extension ID that the native host does not authorize.

The native host must restart for the HTTP fixes to become active. Reloading the
extension disconnects the old native process; reconnecting launches the rebuilt
bridge. Check `http://127.0.0.1:12306/ping` for `extensionConnected: true` afterward.

## Archive

The build creates `.output/chrome-mcp-server-1.0.1-chrome.zip` under
`app/chrome-extension`. The repository's
[latest ZIP](chrome-extension/latest/chrome-mcp-server-lastest.zip) contains the same
extension; the historical filename is retained for existing links.
[SHA256SUMS](chrome-extension/latest/SHA256SUMS) records its checksum.

This ZIP contains the extension only. Update the native bridge from the matching
checkout as well. When replacing an existing unpacked installation, preserve its
directory and reload it; do not install a second copy at an arbitrary path.

## Validation and known limits

- 18 focused extension tests and 31 native tests pass; native TypeScript passes.
- Shared, native, and extension production builds pass. The release checks verify
  static assets and real HTTP/SSE transport behavior using a test native connection.
- Live checks against the currently connected Edge extension pass for viewport,
  full-page, element, and computer screenshots without activating the test tab.
- The live detach/move check still times out capturing a new unfocused window on
  Windows. Keep screenshot work in background tabs of an existing window.
- These live checks precede reloading version 1.0.1. Re-run the live smoke scripts
  after reload; the new installed runtime has not yet been verified.
- Multi-profile broker routing and recorded-flow isolation remain future work.
