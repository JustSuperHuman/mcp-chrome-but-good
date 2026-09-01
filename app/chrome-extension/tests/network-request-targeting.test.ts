import { beforeEach, describe, expect, it, vi } from 'vitest';
import { networkRequestTool } from '@/entrypoints/background/tools/browser/network-request';

describe('network request tab targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs through the explicit inactive session tab instead of the Chrome active tab', async () => {
    (chrome.tabs.get as any).mockResolvedValue({
      id: 42,
      active: false,
      url: 'https://example.com/page',
    });
    const inject = vi
      .spyOn(networkRequestTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const send = vi
      .spyOn(networkRequestTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true, status: 200 });

    const result = await networkRequestTool.execute({
      url: 'https://example.com/api',
      tabId: 42,
      background: true,
    });

    expect(result.isError).toBe(false);
    expect(inject).toHaveBeenCalledWith(42, ['inject-scripts/network-helper.js']);
    expect(send).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        url: 'https://example.com/api',
      }),
    );
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('uses extension fetch for cross-origin calls and strips forbidden headers', async () => {
    (chrome.tabs.get as any).mockResolvedValue({
      id: 42,
      active: false,
      url: 'https://example.com/page',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const inject = vi.spyOn(networkRequestTool as any, 'injectContentScript');

    const result = await networkRequestTool.execute({
      url: 'https://api.example.net/data',
      tabId: 42,
      headers: { Cookie: 'blocked', Authorization: 'allowed' },
    });

    expect(result.isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.net/data',
      expect.objectContaining({ headers: { Authorization: 'allowed' } }),
    );
    expect(inject).not.toHaveBeenCalled();
  });
});
