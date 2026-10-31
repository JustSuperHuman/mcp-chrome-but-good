import { beforeEach, describe, expect, it, vi } from 'vitest';

const tab = (id: number, active = false): chrome.tabs.Tab => ({
  id,
  index: id,
  windowId: 10,
  highlighted: active,
  active,
  pinned: false,
  incognito: false,
  url: `https://example.com/${id}`,
  title: `Tab ${id}`,
  groupId: -1,
  selected: active,
  discarded: false,
  autoDiscardable: true,
  frozen: false,
});

describe('BrowserSessionManager', () => {
  beforeEach(() => {
    vi.resetModules();
    (chrome.storage.session.get as any).mockResolvedValue({});
    (chrome.tabs.get as any).mockImplementation(async (tabId: number) => tab(tabId, tabId === 99));
    (chrome.tabs.group as any).mockResolvedValue(7);
    (chrome.tabGroups.get as any).mockRejectedValue(new Error('not created yet'));
    (chrome.tabGroups.update as any).mockResolvedValue({});
  });

  it('removes the private connection context before tools receive arguments', async () => {
    const { takeJustBrowseContext } =
      await import('@/entrypoints/background/tools/browser-session-manager');

    expect(
      takeJustBrowseContext({
        url: 'https://example.com',
        __justBrowse: { sessionId: 'session-a', transport: 'sse' },
      }),
    ).toEqual({
      context: { sessionId: 'session-a', transport: 'sse' },
      cleanArgs: { url: 'https://example.com' },
    });
  });

  it('creates the first session tab in the background without reusing a user tab', async () => {
    const { browserSessionManager } =
      await import('@/entrypoints/background/tools/browser-session-manager');

    const prepared = await browserSessionManager.prepare('session-a', 'chrome_navigate', {
      url: 'https://example.com',
    });

    expect(prepared.immediateResult).toBeUndefined();
    expect(prepared.args).toMatchObject({ background: true, reuseExisting: false });
  });

  it('keeps logical tab switching isolated from the real Chrome active tab', async () => {
    const { browserSessionManager } =
      await import('@/entrypoints/background/tools/browser-session-manager');
    await browserSessionManager.recordResult(
      'session-a',
      'chrome_navigate',
      {},
      {
        content: [{ type: 'text', text: JSON.stringify({ tabId: 42 }) }],
        isError: false,
      },
    );

    const switched = await browserSessionManager.prepare('session-a', 'chrome_switch_tab', {
      tabId: 42,
    });
    const view = await browserSessionManager.prepare('session-a', 'get_windows_and_tabs', {});

    expect(switched.immediateResult?.isError).toBe(false);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    const viewContent = view.immediateResult!.content[0];
    expect(viewContent.type).toBe('text');
    if (viewContent.type !== 'text') throw new Error('Expected text result');
    expect(JSON.parse(viewContent.text)).toMatchObject({
      sessionId: 'session-a',
      tabCount: 1,
      windows: [{ tabs: [{ tabId: 42, active: true, chromeActive: false }] }],
    });
  });

  it('prevents a second session from controlling an owned tab', async () => {
    const { browserSessionManager } =
      await import('@/entrypoints/background/tools/browser-session-manager');
    await browserSessionManager.prepare('session-a', 'chrome_click_element', { tabId: 42 });

    const collision = await browserSessionManager.prepare('session-b', 'chrome_click_element', {
      tabId: 42,
    });

    expect(collision.immediateResult?.isError).toBe(true);
    expect(collision.immediateResult?.content[0]).toMatchObject({
      type: 'text',
      text: 'Tab 42 is already owned by another JustBrowse session',
    });
  });

  it('moves only an owned tab and keeps the destination unfocused by default', async () => {
    const { browserSessionManager } =
      await import('@/entrypoints/background/tools/browser-session-manager');
    await browserSessionManager.prepare('session-a', 'chrome_click_element', { tabId: 42 });

    const prepared = await browserSessionManager.prepare('session-a', 'chrome_move_tab', {
      tabId: 42,
      windowId: 20,
    });
    const collision = await browserSessionManager.prepare('session-b', 'chrome_move_tab', {
      tabId: 42,
      windowId: 30,
    });

    expect(prepared.immediateResult).toBeUndefined();
    expect(prepared.args).toMatchObject({ tabId: 42, windowId: 20, focused: false });
    expect(collision.immediateResult?.isError).toBe(true);
  });

  it('releases orphaned tab ownership when an MCP session ends', async () => {
    const { browserSessionManager } =
      await import('@/entrypoints/background/tools/browser-session-manager');
    await browserSessionManager.prepare('session-a', 'chrome_click_element', { tabId: 42 });
    const released = await browserSessionManager.releaseSession('session-a');
    const adopted = await browserSessionManager.prepare('session-b', 'chrome_click_element', {
      tabId: 42,
    });

    expect(released.isError).toBe(false);
    expect(adopted.immediateResult).toBeUndefined();
  });

  it('does not persist or regroup unchanged ownership after repeated tool calls', async () => {
    const { browserSessionManager } =
      await import('@/entrypoints/background/tools/browser-session-manager');
    await browserSessionManager.prepare('session-a', 'chrome_click_element', { tabId: 42 });
    vi.clearAllMocks();
    for (let index = 0; index < 100; index++) {
      const prepared = await browserSessionManager.prepare('session-a', 'chrome_screenshot', {});
      expect(prepared.args.tabId).toBe(42);
      await browserSessionManager.recordResult('session-a', 'chrome_screenshot', prepared.args, {
        content: [],
        isError: false,
      });
    }
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.tabs.group).not.toHaveBeenCalled();
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
    expect(
      (await browserSessionManager.prepare('session-b', 'chrome_screenshot', { tabId: 42 }))
        .immediateResult?.isError,
    ).toBe(true);
  });

  it('still persists logical selection when accessing a different owned tab', async () => {
    const { browserSessionManager } =
      await import('@/entrypoints/background/tools/browser-session-manager');
    await browserSessionManager.prepare('session-a', 'chrome_click_element', { tabId: 41 });
    await browserSessionManager.prepare('session-a', 'chrome_click_element', { tabId: 42 });
    vi.clearAllMocks();
    await browserSessionManager.recordResult(
      'session-a',
      'chrome_read_page',
      { tabId: 41 },
      { content: [], isError: false },
    );
    expect(chrome.storage.session.set).toHaveBeenCalled();
    expect(
      (await browserSessionManager.prepare('session-a', 'chrome_read_page', {})).args.tabId,
    ).toBe(41);
  });

  it('does not persist unrelated user tab removal and replacement events', async () => {
    const { browserSessionManager } =
      await import('@/entrypoints/background/tools/browser-session-manager');
    await browserSessionManager.prepare('session-a', 'chrome_click_element', { tabId: 42 });
    const removed = (chrome.tabs.onRemoved.addListener as any).mock.calls.at(-1)[0];
    const replaced = (chrome.tabs.onReplaced.addListener as any).mock.calls.at(-1)[0];
    vi.clearAllMocks();
    removed(99);
    replaced(100, 99);
    // Await the serialized mutation queue through a subsequent release operation.
    await browserSessionManager.releaseSession('absent-session');
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
  });
});
