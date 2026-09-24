# Screenshot contract

`chrome_screenshot` and `chrome_computer` with `action: "screenshot"` return a
direct MCP image by default. No base64 decoding step is required by the client.

## Isolated/background behavior

- Viewport: CDP `Page.captureScreenshot` with the current layout viewport clip.
- Unfocused-window viewport: retries after `Page.setWebLifecycleState` and
  DevTools-only focus emulation, neither of which changes Chrome UI focus.
- Full page: CDP `captureBeyondViewport` using `Page.getLayoutMetrics`.
- Very tall full page: background CDP tile capture and offscreen stitching.
- Element: CSS selector bounds are resolved inside the target tab and captured
  with a document-coordinate CDP clip.
- Background capture never calls `tabs.update` or `windows.update`. If Chrome
  cannot render a viewport through CDP, it may use `tabs.captureVisibleTab`
  only after two fresh checks prove that the requested tab is already active
  in its exact window. This attempts detached, unfocused one-tab windows without
  changing the user's active window or tab. Inactive same-window tabs remain
  CDP-only, so the visible working tab can never be substituted silently.
- If CDP cannot attach, the tool returns a clear error without changing focus.

On Windows Chromium, a newly detached unfocused window may produce no compositor
frames even through these fallbacks. The live Edge integration check reproduced
a screencast timeout on 2026-09-24. Viewport, full-page, element, and computer
screenshots all passed for inactive tabs in the existing window. Prefer that
layout for screenshot work; detached-window capture is not a guaranteed capability.

The result contains an `image` block followed by JSON metadata:

```json
{
  "success": true,
  "tabId": 42,
  "mimeType": "image/png",
  "captureMode": "viewport",
  "background": true,
  "width": 1280,
  "height": 720,
  "transportCompressed": false
}
```

PNG is preserved when it fits safely inside the transport. Oversized captures
are converted to a high-quality JPEG, and progressively scaled only if needed.
Metadata always describes the actual returned image so coordinate projection
continues to use the correct dimensions.

`savePng: true` may be requested independently to save the original PNG through
Chrome downloads. `storeBase64: false` suppresses the MCP image block when a
caller only wants the saved file and metadata.
