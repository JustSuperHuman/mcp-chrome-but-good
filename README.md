# JustBrowseMCP

JustBrowseMCP is a privacy-focused fork of
[`hangwin/mcp-chrome`](https://github.com/hangwin/mcp-chrome) for controlling your
existing Chrome browser through the Model Context Protocol (MCP). It keeps the
upstream extension-and-native-host architecture while adding per-client tab
ownership, background-first browser work, and screenshots that are returned as
native MCP image content.

The project is intended for agents that must use an existing signed-in browser
without taking over the tab or window a person is actively using.

## What this fork changes

- One MCP server instance and private browser-session identity per transport.
- Session-owned tab leases, persisted across extension service-worker suspension.
- Logical tab switching that does not activate a Chrome tab or focus its window.
- Background-first navigation, page inspection, computer actions, and screenshots.
- Collapsed `JustBrowse <session>` tab groups for inactive session tabs.
- Cross-session protection for tab access, tab closing, and tab moves.
- `chrome_move_tab` for state-preserving moves between windows or into a new window.
- Tab-targeted `chrome_network_request` calls that retain the selected tab's browser
  context.
- Direct MCP image results for viewport, full-page, element, and
  `chrome_computer` screenshots.
- Streamable HTTP lifecycle cleanup, idle-session expiry, stdio reconnection, a real
  extension-aware `/ping`, and optional host/port overrides.
- Native-host registration for the JustBrowse and supported upstream extension IDs.

See [the research and target design](docs/RESEARCH.md),
[the architecture note](docs/JUSTBROWSE_ARCHITECTURE.md),
[the screenshot contract](docs/SCREENSHOTS.md), and
[the upstream PR audit](docs/UPSTREAM_PR_AUDIT.md) for implementation details.

> [!IMPORTANT]
> Session isolation currently applies within one connected extension/native-host
> process. Simultaneous routing across multiple Chrome profiles still requires the
> broker refactor described in the architecture note. Recorded flows also need
> end-to-end session propagation before they should be treated as isolated.

## Requirements

- Node.js 20.19 or newer (or Node.js 22.12 or newer)
- pnpm 8 (the commands below pin `8.15.9` through Corepack)
- Chrome or Chromium with Developer mode available

## Build and install from this repository

```powershell
git clone https://github.com/JustSuperHuman/mcp-chrome-but-good.git
cd mcp-chrome-but-good
corepack pnpm@8.15.9 install --frozen-lockfile
corepack pnpm@8.15.9 build:shared
corepack pnpm@8.15.9 build:native
corepack pnpm@8.15.9 build:extension
corepack pnpm@8.15.9 --filter mcp-chrome-bridge register:dev
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select
   `app/chrome-extension/.output/chrome-mv3` from this checkout.
4. Open the JustBrowseMCP extension and click **Connect**.
5. Confirm the bridge and extension are healthy:

```powershell
Invoke-RestMethod http://127.0.0.1:12306/ping
```

A healthy response includes `extensionConnected: true`. The endpoint returns HTTP
503 when the native host is running without a live extension connection.

Re-run the build and `register:dev` commands after moving the checkout because the
native-messaging manifest contains an absolute host path.

## Connect an MCP client

Streamable HTTP is the preferred transport:

```json
{
  "mcpServers": {
    "justbrowse": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:12306/mcp"
    }
  }
}
```

For clients that only support stdio, point the client at the built proxy:

```json
{
  "mcpServers": {
    "justbrowse": {
      "command": "node",
      "args": [
        "C:/absolute/path/to/mcp-chrome-but-good/app/native-server/dist/mcp/mcp-server-stdio.js"
      ]
    }
  }
}
```

The stdio proxy connects to the same local HTTP endpoint configured in
`app/native-server/dist/mcp/stdio-config.json`.

## Install the agent skill

The repository includes a client-neutral skill at
[`skills/justbrowse-browser/SKILL.md`](skills/justbrowse-browser/SKILL.md). Copy the
whole `justbrowse-browser` directory into your agent's skill directory, for example:

```powershell
Copy-Item -Recurse skills\justbrowse-browser "$env:USERPROFILE\.codex\skills\justbrowse-browser"
# or
Copy-Item -Recurse skills\justbrowse-browser "$env:USERPROFILE\.claude\skills\justbrowse-browser"
```

The skill teaches an agent to preserve session ownership and browser focus, use
direct MCP screenshot images, verify important UI outcomes, and clean up disposable
tabs. The tracked copy is the source of truth; update installed copies after pulling
changes.

## Runtime behavior

An isolated session normally starts with `chrome_navigate`. The new tab is created
in the background, leased to that MCP connection, and becomes the connection's
logical active tab. Subsequent tab-scoped calls use that lease when `tabId` is
omitted. `get_windows_and_tabs` shows only the current connection's leased tabs.

An agent may explicitly select an unowned existing tab by ID. The tab is atomically
claimed for that session before any operation runs; another session cannot claim or
operate on it until ownership is released. `chrome_switch_tab` changes only the
logical active tab in isolated sessions and never changes visible Chrome focus.

Viewport, full-page, and CSS-selected element screenshots use Chrome DevTools
Protocol capture without activating the target tab. A successful result contains an
MCP `image` block followed by compact JSON metadata. PNG is preserved when it fits
the native-message envelope; oversized results are converted or scaled and report
their actual MIME type and dimensions.

## Configuration

| Variable                     | Purpose                                                       | Default       |
| ---------------------------- | ------------------------------------------------------------- | ------------- |
| `CHROME_MCP_PORT`            | Native host and MCP listener port                             | `12306`       |
| `MCP_HTTP_PORT`              | Backward-compatible port override                             | `12306`       |
| `CHROME_MCP_HOST`            | Host used in MCP URLs passed to the built-in agent engines    | `127.0.0.1`   |
| `CHROME_MCP_SESSION_IDLE_MS` | Streamable HTTP session idle timeout in milliseconds          | `1800000`     |
| `CHROME_MCP_NODE_PATH`       | Absolute Node executable override for the native-host wrapper | auto-detected |

## Verification

Run the focused isolation checks, native-server typecheck, and production builds:

```powershell
corepack pnpm@8.15.9 --filter chrome-mcp-server exec vitest run tests/browser-session-manager.test.ts tests/background-screenshot.test.ts tests/cdp-session-manager.test.ts tests/move-tab.test.ts tests/network-request-targeting.test.ts
corepack pnpm@8.15.9 --dir app/native-server exec jest --coverage=false --runInBand src/server/server.test.ts src/mcp/mcp-server.test.ts
corepack pnpm@8.15.9 --filter mcp-chrome-bridge exec tsc --noEmit
corepack pnpm@8.15.9 build:shared
corepack pnpm@8.15.9 build:native
corepack pnpm@8.15.9 build:extension
```

The wider inherited extension suite currently includes upstream record/replay tests
that require Sharp 0.32's native binary and an extension-wide Vue typecheck with
pre-existing UI/type-contract failures. Those are not used as release gates for
this focused fork branch.

With the built extension connected, the live smoke scripts exercise no-focus
screenshots, tab moves, and targeted network requests:

```powershell
node scripts/live-screenshot-smoke.mjs
node scripts/live-pr-integration-smoke.mjs
```

`scripts/concurrent-screenshot-worker.mjs` is the lower-level multi-process helper
used to exercise simultaneous sessions; it requires per-worker
`JUSTBROWSE_TEST_LABEL` and `JUSTBROWSE_TEST_URL` values plus a shared barrier
directory. Live artifacts are written under the ignored `live-test-output/`
directory.

## Security and privacy

Browser control runs locally and reuses the selected Chrome profile's cookies and
login state. Treat the MCP endpoint as privileged local access: do not expose port
12306 to an untrusted network. The private `__justBrowse` routing envelope is added
by the native host and is deliberately absent from public tool schemas so an MCP
caller cannot choose another connection's identity.

## Upstream and license

JustBrowseMCP is based on
[`hangwin/mcp-chrome`](https://github.com/hangwin/mcp-chrome). The fork audits and
adapts upstream work while keeping isolation and no-focus invariants explicit. It is
licensed under the [MIT License](LICENSE).
