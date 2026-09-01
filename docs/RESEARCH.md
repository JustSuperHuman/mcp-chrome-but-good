# Making JustBrowseMCP non-interfering, concurrent, and profile-aware

Research date: 2026-08-31

## Executive conclusion

The browser interference is not primarily an MCP limitation. It comes from
upstream `mcp-chrome` treating Chrome's physically active tab as global state.
Several tools activate or focus tabs, visible screenshots depend on the active
tab, nested computer actions can discard the caller's explicit tab ID, and the
native bridge formerly shared one MCP SDK `Server` across multiple transports.

Claude and ChatGPT solve the user-experience problem with the same broad design:
an agent owns a scoped collection of tabs, tracks its own logical active tab,
keeps normal automation in inactive tabs or unfocused windows, groups the tabs,
and uses Chrome DevTools Protocol operations when the visible-tab APIs would
steal focus. Their product-specific account, pairing, and cloud protocols are
not needed for JustBrowseMCP and must not be copied.

The right product is therefore not a clone of either extension. It is an open,
local broker with independent browser-profile connectors and a strict session →
profile → tab ownership model.

## Evidence collected

### Public product behavior

- The ChatGPT Web Store description says background tasks run without taking
  over the active browsing session. The inspected public package is version
  `1.2.27268.51612`, updated 2026-08-20.
- Anthropic documents dedicated tab groups, multi-tab work, and background
  scheduled work. The inspected public package is version `1.0.90`, updated
  2026-08-30.
- Both manifests request `debugger`, `tabs`, `tabGroups`, `scripting`,
  `nativeMessaging`, and `<all_urls>`, which is consistent with isolated tab
  work plus CDP-backed automation.

Sources:

- https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg
- https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn
- https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome

### Exact local reference packages

| Package     | Version         | SHA-256                                                            |
| ----------- | --------------- | ------------------------------------------------------------------ |
| Claude CRX  | 1.0.90          | `DF8E893B8DF2B29D2112A28CB92E1DAC5EDF19CEAFEE5AAA263689D9A061D1F0` |
| ChatGPT CRX | 1.2.27268.51612 | `EB87B8C29EFFC254BF4284A732607F45F66E76321C212142DD212A53F9C9BD84` |

The packages were downloaded from Google's public extension update service and
unpacked locally. They are retained only for interoperability research. This
work uses behavior and architecture observations, not proprietary source code.

### Clean-room bundle observations

The ChatGPT package contains a durable browser-session model with a logical
active tab separate from Chrome's real `tab.active`, per-session tab leases,
inactive tab creation, unfocused window creation, managed/collapsed tab groups,
child-tab claiming, ownership-collision rejection, and debugger detachment on
session cleanup.

The Claude package passes a session scope and tab-group ID through browser tool
calls and creates isolated tab groups around a browser session. Its Anthropic
native pairing and account paths are product-specific and deliberately excluded
from this design.

## Why upstream interferes with normal browsing

1. `chrome_navigate` defaults `background` to false and normally activates its
   target. Its final fallback previously created a focused window even for a
   requested background navigation.
2. `chrome_screenshot` falls back to `tabs.captureVisibleTab`. Chrome defines
   that API as capturing the active tab in a window, so it cannot capture an
   arbitrary inactive tab without first changing what the user sees.
3. Several nested paths inside `chrome_computer` invoked click, keyboard, fill,
   or screenshot helpers without forwarding the already-resolved `tab.id`.
   Those helpers could fall back to the user's active tab.
4. MCP tool calls had no durable browser-session identity. The extension could
   not distinguish two agents or keep their tabs separate.
5. The bridge used one MCP SDK `Server` singleton. A second transport could hit
   the SDK's “Already connected to a transport” constraint.
6. `get_windows_and_tabs`, tab switching, URL-wide close, and matching-URL
   navigation all operate on global browser state rather than session-owned
   state.
7. Every Chrome profile starts the same native host and requests fixed port
   `127.0.0.1:12306`. There is no profile registry or routing key, so a second
   profile is a port/lifecycle collision rather than another selectable target.

Relevant platform documentation:

- `captureVisibleTab`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab
- Chrome debugger/CDP: https://developer.chrome.com/docs/extensions/reference/api/debugger
- Native messaging: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- `activeTab` semantics: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab

## What the current fork implements

Branch: `justbrowse/session-isolation`

- Creates one MCP SDK `Server` per SSE or Streamable HTTP transport.
- Injects a private connection/session context at the bridge boundary and strips
  it before the public tool executor sees arguments.
- Maintains per-session tab ownership and a logical active tab.
- Stores ownership in `chrome.storage.session`, surviving MV3 worker suspension
  but clearing at browser restart so recycled Chrome tab IDs cannot be trusted.
- Defaults navigation, screenshots, computer actions, fetch, and console work to
  background mode.
- Prevents the first navigation from adopting a matching tab in the user's
  workspace.
- Makes `chrome_switch_tab` change only the session's logical cursor, not Chrome
  focus.
- Returns only the calling session's tabs from `get_windows_and_tabs`.
- Blocks URL-wide closing and cross-session tab control.
- Reserves an explicitly selected tab before executing a tool, closing the race
  where two concurrent sessions could both act before ownership was recorded.
- Groups and collapses session tabs under `JustBrowse <session-prefix>`.
- Forwards the resolved tab ID through nested computer click/fill/keyboard and
  screenshot helpers.
- Captures viewport, full-page, and CSS-selected element screenshots through
  CDP while tabs remain inactive; tall pages retry as background CDP tiles.
- Returns screenshots as MCP `image` content blocks and adaptively compresses
  only captures that would exceed the native transport envelope.
- Respects `background: true` when navigation must create a fallback window.

This is a meaningful phase-one fix, but it is not yet the cross-profile system.
Recorded flows can also invoke nested tools without preserving the new session
context, so flows should be treated as legacy/global until that executor is
made session-aware.

## Target architecture

```text
Claude / Codex / other MCP clients
              |
              v
   JustBrowse local broker (one per OS user)
   - MCP transports and resumable client sessions
   - profile registry and routing
   - leases, policy, audit, lifecycle
        |                    |
        v                    v
 Chrome profile A       Chrome profile B
 extension connector    extension connector
        |                    |
        +--> session tab groups / logical tabs
             CDP + content-script operations
```

### Broker and profile model

Run exactly one broker per operating-system user. Each installed extension
instance creates a random, non-secret `profileInstanceId`, lets the user assign
a display label, and registers capabilities over native messaging. Do not infer
identity from Chrome's profile directory or collect browsing-account identity.

Expose MCP tools such as:

- `browser_profiles_list`
- `browser_profile_select`
- `browser_session_status`
- `browser_claim_tab` and `browser_release_tab`
- `browser_focus_tab` as the only tool that deliberately changes user focus

An MCP connection gets a default profile but may route an individual session to
another registered profile. Profile connectors can disconnect/reconnect without
changing the MCP listening address.

### Session and tab model

Each tab lease records:

- broker session ID and client connection ID
- profile instance ID
- tab ID and window ID
- origin: `agent-created` or `user-claimed`
- lifecycle: `active`, `handoff`, `released`, or `orphaned`
- logical active status and last activity time

Agent-created tabs open inactive, are grouped by session, and can be cleaned up
under an explicit session policy. User-claimed tabs are never auto-closed.
Popups and links that create tabs are claimed by the initiating session and
remain inactive unless `browser_focus_tab` is called.

### Non-interference rules

1. Every tab-scoped command must carry or resolve a leased tab ID.
2. No helper may call an “active tab” fallback after a session target resolves.
3. “Switch tab” means change the logical tab; “focus tab” is separate and
   explicit.
4. Navigation creates `active: false`; new windows use `focused: false`.
5. Background screenshots use `Page.captureScreenshot`, including full-page
   capture with layout metrics and `captureBeyondViewport`; selector capture
   should use a CDP clip. `captureVisibleTab` remains only for explicit
   foreground/legacy calls.
6. Downloads, dialogs, network capture, debugger use, and popup creation remain
   tied to the lease that initiated them.
7. A session may not enumerate, switch, close, or mutate another session's tabs.

### “No authentication” safely interpreted

JustBrowseMCP should require no Claude/OpenAI account, cloud login, OAuth flow,
or manual pairing ceremony. That does not justify an unauthenticated network
service with full browser authority.

The broker must remain loopback-only and use operating-system local boundaries:
a per-user named pipe/socket with user ACLs is preferred, or a random local
capability passed in the MCP launch configuration. CORS is not authentication
and does not protect the HTTP endpoint from other local processes. Never bind
this service to LAN interfaces by default.

## Delivery roadmap

### Phase 1 — session isolation (implemented in this workspace)

Finish cleanup semantics, make recorded flows propagate scope, and test two live
MCP clients against one profile. Background CDP viewport/full-page/element
screenshots are implemented and covered by focused regression tests.

### Phase 2 — one local broker, many profiles

Separate the HTTP/MCP broker from each native-messaging process, add a per-user
IPC transport, build a profile registry and profile-selection tools, and handle
extension reconnects/browser restarts. This removes the fixed-port collision.

### Phase 3 — lifecycle and handoff

Track agent-created versus user-claimed tabs, intercept child tabs, add explicit
focus/claim/release/handoff commands, define disconnect grace periods, and make
cleanup observable and recoverable.

### Phase 4 — product packaging

Rename the extension/bridge, use a stable signed extension ID and matching
native-host allowlist, provide installer/doctor/update paths for
Windows/macOS/Linux, and publish a threat model and reproducible release hashes.

## Acceptance test matrix

The product is not complete until all of these pass in real Chrome:

| Scenario                                               | Required result                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| User types in tab A while agent navigates/clicks tab B | Focus and typing remain in A                                          |
| Inactive-tab viewport/full-page/element screenshots    | Correct B image; A never activates                                    |
| Two MCP clients in one profile                         | Independent logical tabs; collision is rejected before side effects   |
| One MCP client across two profiles                     | Explicit, stable routing to the selected profile                      |
| Two profiles reconnect in either order                 | Both register; no port ownership race                                 |
| Link opens a child tab/window                          | Child is leased to the initiating session and stays backgrounded      |
| MCP transport drops and reconnects                     | Grace/recovery policy is deterministic and visible                    |
| MV3 worker suspends                                    | Session leases reload from browser-session storage                    |
| Chrome restarts and tab IDs are recycled               | Old leases are not applied to unrelated tabs                          |
| Session closes                                         | Agent tabs follow configured cleanup; user tabs are never auto-closed |
| Malicious second local client requests another lease   | Broker rejects unauthorized/colliding ownership                       |
| Broker is probed from LAN                              | No listener is reachable                                              |

Verification must exercise MCP `initialize`, `tools/list`, actual tool calls,
disconnect/reconnect, two simultaneous clients, and two real Chrome profiles.
A `/ping` response or a successful extension build is not sufficient.
