---
name: justbrowse-browser
description: Control an existing signed-in Chrome browser through JustBrowseMCP while preserving the user's active tab and isolating each agent session. Use this skill whenever a task needs authenticated browser UI work, page inspection, clicks or form entry, screenshots, tab-scoped network requests, downloads, browser console or performance inspection, or verification in the user's real Chrome profile, even if the user only says to open, check, test, or do something in the browser.
compatibility: Requires a connected JustBrowseMCP extension and its chrome_* MCP tools.
---

# JustBrowse browser control

Use JustBrowseMCP as a privileged view into the user's real Chrome profile. Preserve
their visible browsing context, keep work inside the current MCP session's tab
leases, and verify outcomes from the page rather than assuming an action succeeded.

## Start safely

1. Confirm the JustBrowse tools are available. If the bridge is unavailable, ask the
   user to connect the extension; do not substitute a different browser when their
   existing Chrome login state is required.
2. Use `chrome_navigate` without a `tabId` to create the session's first background
   tab. It becomes the session's logical active tab without taking visible focus.
3. Use `get_windows_and_tabs` when you need the session's owned tab IDs. In an
   isolated connection it intentionally shows only tabs leased to that session.
4. Pass a `tabId` when coordinating multiple owned tabs or when the target must be
   unambiguous. Omitting it uses the session's logical active tab for tab-scoped
   tools.

Only claim an existing unowned tab by ID when the user clearly wants work performed
in that exact tab. Claiming is exclusive: another JustBrowse session cannot use the
tab until this session releases it.

## Preserve focus and ownership

- Treat `chrome_switch_tab` as a logical selection. In an isolated session it does
  not activate the Chrome tab or focus its window.
- Prefer background navigation and tool calls. JustBrowse supplies background-safe
  defaults for session-scoped navigation, inspection, computer actions, console
  work, and screenshots.
- Use `chrome_move_tab` to preserve page state when a tab must move. Keep
  `focused: false` unless visible focus is an explicit user requirement.
- Keep screenshot tasks in background tabs of an existing window when possible.
  Windows Chromium may stop producing frames for a newly detached unfocused window;
  report a capture timeout without activating the user's window.
- Never operate on, close, or move a tab reported as owned by another session.
- Close disposable session tabs with `chrome_close_tabs` when the task is complete.
  Do not use URL-wide closing in an isolated session.

## Inspect before interacting

Prefer semantic page information before coordinate actions:

1. Use `chrome_read_page`, `chrome_get_web_content`, or
   `chrome_get_interactive_elements` to understand the current state.
2. Use `chrome_click_element` and `chrome_fill_or_select` when stable selectors or
   element references exist.
3. Use `chrome_computer` for visual or coordinate-driven interfaces that cannot be
   handled reliably through semantic tools.
4. After mutations, inspect the resulting page state, URL, visible confirmation, or
   returned data. For consequential flows, capture a screenshot as additional
   evidence.

Avoid brittle repeated clicks. If the page changes unexpectedly, inspect it again
before continuing.

## Screenshots

Use `chrome_screenshot` for viewport, full-page, or CSS-selected element capture,
and `chrome_computer` with `action: "screenshot"` when staying in a computer-use
loop.

- Screenshots return a directly viewable MCP `image` content block by default. Do
  not ask the user to decode base64 and do not save a file merely to inspect it.
- Use `fullPage: true` only when the whole document is relevant.
- Use `selector` for a specific element when a stable CSS selector is known.
- Use `savePng: true` only when the user needs a downloaded artifact.
- Read the JSON metadata that accompanies the image. It reports the actual MIME
  type, dimensions, target tab, capture mode, and whether transport compression was
  needed.
- A background capture failure is preferable to activating the wrong tab. Report
  the limitation instead of changing visible focus without permission.

## Authenticated and sensitive flows

The browser may expose the user's cookies, private pages, and account data. Keep the
task within the sites and actions the user requested. Never print cookies, tokens,
passwords, or unrelated private page content.

Before a purchase, message send, publication, deletion, account-setting change, or
other consequential final action, make sure the user's request clearly authorizes
that action. Browser access does not broaden authorization.

## Network and diagnostics

- Use `chrome_network_request` with the owned `tabId` when a request needs that
  tab's cookies or browser context. Prefer direct page interaction when the user
  asked to test the UI itself.
- Use network capture, console, JavaScript, or performance tools only when they are
  relevant to the requested diagnosis. Keep all tab-scoped calls on the owned tab.
- Do not expose the local MCP endpoint beyond trusted local access.

## Completion report

Lead with the verified outcome. Mention the page or flow exercised, the evidence
checked, and any remaining limitation. Distinguish a successful tool call from a
visibly confirmed browser result. If disposable tabs were created, state that they
were closed.
