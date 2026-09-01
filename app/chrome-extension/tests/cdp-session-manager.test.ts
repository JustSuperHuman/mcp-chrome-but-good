import { afterEach, describe, expect, it, vi } from 'vitest';

import { cdpSessionManager } from '@/utils/cdp-session-manager';

describe('CDP session manager timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects and detaches when Chrome strands a debugger command', async () => {
    vi.useFakeTimers();
    vi.mocked(chrome.debugger.getTargets).mockResolvedValue([]);
    vi.mocked(chrome.debugger.attach).mockResolvedValue(undefined);
    vi.mocked(chrome.debugger.detach).mockResolvedValue(undefined);
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(
      () => new Promise(() => {}) as Promise<object>,
    );

    const operation = cdpSessionManager.withSession(42, 'timeout-test', () =>
      cdpSessionManager.sendCommand(42, 'Page.captureScreenshot', {}),
    );
    const rejection = expect(operation).rejects.toThrow(
      'CDP Page.captureScreenshot for tab 42 timed out after 15000ms',
    );

    await vi.advanceTimersByTimeAsync(15_001);
    await rejection;
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
  });
});
