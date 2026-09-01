import { beforeEach, describe, expect, it, vi } from 'vitest';
import { moveTabTool } from '@/entrypoints/background/tools/browser/move-tab';

describe('move tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves tab state without focusing the destination by default', async () => {
    (chrome.tabs.move as any).mockResolvedValue({
      id: 42,
      windowId: 20,
      index: 0,
      url: 'https://example.com',
    });

    const result = await moveTabTool.execute({ tabId: 42, windowId: 20, index: 0 });

    expect(result.isError).toBe(false);
    expect(chrome.tabs.move).toHaveBeenCalledWith(42, { windowId: 20, index: 0 });
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });
});
