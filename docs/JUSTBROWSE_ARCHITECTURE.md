# JustBrowseMCP architecture note

The implementation rationale and target design are documented in
[RESEARCH.md](RESEARCH.md). This file records the repository-local boundary for
future development.

## Current invariant

Every MCP transport gets a unique session identity. Browser tool calls from that
transport carry a private `__justBrowse` envelope across native messaging. The
extension removes the envelope, resolves a session-owned tab, and then invokes
the existing tool. Calls originating inside the extension without this envelope
remain legacy/global for compatibility.

Do not expose `__justBrowse` in public MCP schemas. A caller must not be able to
choose another connection's session identity.

## Required next refactor

Move the HTTP/MCP listener into a single per-user broker and make each Chrome
profile's native host a connector. The broker owns profile routing and lease
lifecycle. The extension owns profile-local tab operations. Preserve the rule
that real focus changes occur only through an explicitly named focus operation.

Recorded flows must carry the same scope into every nested `handleCallTool`
invocation before they can be considered isolated.

## Screenshot invariant

An isolated-session screenshot must resolve a leased tab. Full-page and
CSS-selected element captures are CDP-only. Viewport capture also starts with
CDP; if Chrome cannot render a detached background window, the extension may
call `captureVisibleTab(windowId)` only after fresh checks prove that the
requested tab is already the active tab in that exact window. It must never
activate a tab or focus a window. An inactive same-window tab therefore cannot
silently become a capture of the user's visible tab. Successful captures
contain an MCP `image` content block plus compact JSON metadata.

Full-page capture first uses one `captureBeyondViewport` request, then retries
with non-scrolling CDP tiles for surfaces Chrome cannot capture in one shot.
Large results are compressed within the native-message envelope while retaining
the exact returned MIME type and pixel dimensions in metadata.
