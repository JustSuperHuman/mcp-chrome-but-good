import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  withSession: vi.fn(async (_tabId: number, _owner: string, run: () => Promise<unknown>) => run()),
  createImageBitmapFromUrl: vi.fn(async () => ({ width: 800, height: 600 })),
  stitchImages: vi.fn(async () => ({ kind: 'stitched-canvas' })),
  canvasToDataURL: vi.fn(async () => 'data:image/png;base64,dGlsZWQ='),
  compressImage: vi.fn(async () => ({
    dataUrl: 'data:image/jpeg;base64,anBlZw==',
    mimeType: 'image/jpeg',
  })),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: mocks.sendCommand,
    withSession: mocks.withSession,
  },
}));

vi.mock('@/utils/image-utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/image-utils')>();
  return {
    ...original,
    createImageBitmapFromUrl: mocks.createImageBitmapFromUrl,
    stitchImages: mocks.stitchImages,
    canvasToDataURL: mocks.canvasToDataURL,
    compressImage: mocks.compressImage,
  };
});

import { screenshotTool } from '@/entrypoints/background/tools/browser/screenshot';

const inactiveTab: chrome.tabs.Tab = {
  id: 42,
  index: 1,
  windowId: 10,
  highlighted: false,
  active: false,
  pinned: false,
  incognito: false,
  url: 'https://example.com/inactive',
  title: 'Inactive test tab',
  groupId: -1,
  selected: false,
  discarded: false,
  autoDiscardable: true,
  frozen: false,
};

const metrics = {
  cssLayoutViewport: {
    clientWidth: 1280,
    clientHeight: 720,
    pageX: 0,
    pageY: 120,
  },
  cssContentSize: { x: 0, y: 0, width: 1280, height: 5000 },
};

function imageContent(result: Awaited<ReturnType<typeof screenshotTool.execute>>) {
  return result.content.find((item) => item.type === 'image');
}

describe('background screenshot capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (chrome.tabs.get as any).mockResolvedValue(inactiveTab);
    mocks.createImageBitmapFromUrl.mockResolvedValue({ width: 1280, height: 720 });
    mocks.sendCommand.mockImplementation(async (_tabId, method, params) => {
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      if (method === 'Page.captureScreenshot') return { data: 'cG5n' };
      return {};
    });
  });

  it('returns an MCP image for an inactive viewport without touching Chrome focus', async () => {
    const result = await screenshotTool.execute({ tabId: 42, background: true });

    expect(result.isError).toBe(false);
    expect(imageContent(result)).toMatchObject({
      type: 'image',
      data: 'cG5n',
      mimeType: 'image/png',
    });
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      42,
      'Page.captureScreenshot',
      expect.objectContaining({
        captureBeyondViewport: false,
        clip: { x: 0, y: 120, width: 1280, height: 720, scale: 1 },
      }),
      7000,
    );
  });

  it('captures a full page in one CDP operation without visible-tab APIs', async () => {
    const result = await screenshotTool.execute({ tabId: 42, background: true, fullPage: true });

    expect(result.isError).toBe(false);
    expect(imageContent(result)?.type).toBe('image');
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      42,
      'Page.captureScreenshot',
      expect.objectContaining({
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1280, height: 5000, scale: 1 },
      }),
      7000,
    );
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('captures a CSS-selected element by its document clip while the tab stays inactive', async () => {
    mocks.sendCommand.mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'Runtime.evaluate' && params.expression === 'window.devicePixelRatio || 1') {
        return { result: { value: 1.25 } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 44, y: 900, width: 320, height: 180 } } };
      }
      if (method === 'Page.captureScreenshot') return { data: 'ZWxlbWVudA==' };
      return {};
    });

    const result = await screenshotTool.execute({
      tabId: 42,
      background: true,
      selector: '#target',
    });

    expect(result.isError).toBe(false);
    expect(imageContent(result)).toMatchObject({ data: 'ZWxlbWVudA==', mimeType: 'image/png' });
    const elementEvaluation = mocks.sendCommand.mock.calls.find(
      ([, method, params]) =>
        method === 'Runtime.evaluate' && params.expression !== 'window.devicePixelRatio || 1',
    );
    expect(elementEvaluation?.[2].expression).not.toContain('scrollIntoView');
    expect(mocks.sendCommand).toHaveBeenCalledWith(
      42,
      'Page.captureScreenshot',
      expect.objectContaining({
        captureBeyondViewport: true,
        clip: { x: 44, y: 900, width: 320, height: 180, scale: 1 },
      }),
      7000,
    );
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('uses background CDP tiles if Chrome rejects a very tall single capture', async () => {
    let captureCount = 0;
    mocks.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'Page.getLayoutMetrics') {
        return { ...metrics, cssContentSize: { x: 0, y: 0, width: 1280, height: 9000 } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      if (method === 'Page.captureScreenshot') {
        captureCount += 1;
        if (captureCount === 1) throw new Error('surface too large');
        return { data: captureCount === 2 ? 'dGlsZTE=' : 'dGlsZTI=' };
      }
      return {};
    });

    const result = await screenshotTool.execute({ tabId: 42, background: true, fullPage: true });

    expect(result.isError).toBe(false);
    expect(imageContent(result)).toMatchObject({ data: 'dGlsZWQ=', mimeType: 'image/png' });
    expect(captureCount).toBe(3);
    expect(mocks.stitchImages).toHaveBeenCalled();
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('retries an unavailable surface through the rendered view', async () => {
    mocks.sendCommand.mockImplementation(async (_tabId, method, params) => {
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      if (method === 'Page.captureScreenshot' && params.fromSurface) {
        throw new Error('surface unavailable');
      }
      if (method === 'Page.captureScreenshot') return { data: 'dmlldw==' };
      return {};
    });

    const result = await screenshotTool.execute({ tabId: 42, background: true });

    expect(result.isError).toBe(false);
    expect(imageContent(result)).toMatchObject({ data: 'dmlldw==', mimeType: 'image/png' });
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('captures an active tab in its exact unfocused window without changing focus', async () => {
    (chrome.tabs.get as any).mockResolvedValue({ ...inactiveTab, active: true, windowId: 20 });
    (chrome.tabs.query as any).mockResolvedValue([{ id: 42, active: true, windowId: 20 }]);
    (chrome.tabs.captureVisibleTab as any).mockResolvedValue('data:image/png;base64,d2luZG93');
    mocks.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      if (method === 'Page.captureScreenshot') throw new Error('surface unavailable');
      return {};
    });

    const result = await screenshotTool.execute({ tabId: 42, background: true });

    expect(result.isError).toBe(false);
    expect(imageContent(result)).toMatchObject({ data: 'd2luZG93', mimeType: 'image/png' });
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(20, { format: 'png' });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });

  it('fails safely instead of capturing or activating the user tab when CDP is unavailable', async () => {
    mocks.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      if (method === 'Page.captureScreenshot') throw new Error('debugger occupied');
      return {};
    });

    const result = await screenshotTool.execute({ tabId: 42, background: true, fullPage: true });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('failed without changing browser focus'),
    });
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('keeps oversized captures inside the MCP transport envelope', async () => {
    const oversized = 'a'.repeat(8 * 1024 * 1024 + 1);
    mocks.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      if (method === 'Page.captureScreenshot') return { data: oversized };
      return {};
    });
    mocks.createImageBitmapFromUrl
      .mockResolvedValueOnce({ width: 1280, height: 720 })
      .mockResolvedValueOnce({ width: 1280, height: 720 })
      .mockResolvedValueOnce({ width: 1280, height: 720 });

    const result = await screenshotTool.execute({ tabId: 42, background: true });

    expect(result.isError).toBe(false);
    expect(imageContent(result)).toMatchObject({
      data: 'anBlZw==',
      mimeType: 'image/jpeg',
    });
    expect(mocks.compressImage).toHaveBeenCalledWith(
      expect.stringMatching(/^data:image\/png;base64,/),
      expect.objectContaining({ scale: 1, quality: 0.9, format: 'image/jpeg' }),
    );
  });
});
