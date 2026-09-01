import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  canvasToDataURL,
  createImageBitmapFromUrl,
  cropAndResizeImage,
  stitchImages,
  compressImage,
} from '../../../../utils/image-utils';
import { screenshotContextManager } from '@/utils/screenshot-context';

// Screenshot-specific constants
const SCREENSHOT_CONSTANTS = {
  SCROLL_DELAY_MS: 350, // Time to wait after scroll for rendering and lazy loading
  CAPTURE_STITCH_DELAY_MS: 50, // Small delay between captures in a scroll sequence
  MAX_CAPTURE_PARTS: 50, // Maximum number of parts to capture (for infinite scroll pages)
  MAX_CAPTURE_HEIGHT_PX: 50000, // Maximum height in pixels to capture
  PIXEL_TOLERANCE: 1,
  SCRIPT_INIT_DELAY: 100, // Delay for script initialization
  MAX_MCP_BASE64_CHARS: 8 * 1024 * 1024, // stay comfortably below MCP/native envelopes
} as {
  readonly SCROLL_DELAY_MS: number;
  CAPTURE_STITCH_DELAY_MS: number; // This one is mutable
  readonly MAX_CAPTURE_PARTS: number;
  readonly MAX_CAPTURE_HEIGHT_PX: number;
  readonly PIXEL_TOLERANCE: number;
  readonly SCRIPT_INIT_DELAY: number;
  readonly MAX_MCP_BASE64_CHARS: number;
};

// Adjust CAPTURE_STITCH_DELAY_MS to respect Chrome's capture rate if available in runtime
// Some TS typings don't expose MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND; use a safe cast with a sane fallback.
const __MAX_CAP_RATE: number | undefined = (chrome.tabs as any)
  ?.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND;
if (typeof __MAX_CAP_RATE === 'number' && __MAX_CAP_RATE > 0) {
  // Minimum interval between consecutive captureVisibleTab calls (ms)
  const minIntervalMs = Math.ceil(1000 / __MAX_CAP_RATE);
  // Our capture loop already waits SCROLL_DELAY_MS between scroll and capture; add any extra delay needed
  const requiredExtraDelay = Math.max(0, minIntervalMs - SCREENSHOT_CONSTANTS.SCROLL_DELAY_MS);
  SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS = Math.max(
    requiredExtraDelay,
    SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS,
  );
}

interface ScreenshotToolParams {
  name?: string;
  selector?: string;
  tabId?: number;
  background?: boolean;
  windowId?: number;
  width?: number;
  height?: number;
  storeBase64?: boolean;
  fullPage?: boolean;
  savePng?: boolean;
  maxHeight?: number; // Maximum height to capture in pixels (for infinite scroll pages)
}

interface CapturedScreenshot {
  dataUrl: string;
  widthCss: number;
  heightCss: number;
  viewportWidthCss: number;
  viewportHeightCss: number;
  devicePixelRatio: number;
  mode: 'viewport' | 'fullPage' | 'element';
}

interface DeliverableImage {
  base64Data: string;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  transportCompressed: boolean;
}

/** Page details returned by screenshot-helper content script */
interface ScreenshotPageDetails {
  totalWidth: number;
  totalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  currentScrollX: number;
  currentScrollY: number;
}

const PAGE_DETAILS_REQUIRED_FIELDS: Array<keyof ScreenshotPageDetails> = [
  'totalWidth',
  'totalHeight',
  'viewportWidth',
  'viewportHeight',
  'devicePixelRatio',
  'currentScrollX',
  'currentScrollY',
];

/**
 * Validates and asserts that the response from content script contains valid page details
 */
function assertValidPageDetails(details: unknown): ScreenshotPageDetails {
  if (!details || typeof details !== 'object') {
    throw new Error(
      'Screenshot helper did not respond. The content script may not be injected or cannot run on this page.',
    );
  }

  const candidate = details as Partial<ScreenshotPageDetails>;
  const invalidFields = PAGE_DETAILS_REQUIRED_FIELDS.filter(
    (field) => typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field]),
  );

  if (invalidFields.length > 0) {
    throw new Error(
      `Screenshot helper returned invalid page details (missing/invalid: ${invalidFields.join(', ')}).`,
    );
  }

  return candidate as ScreenshotPageDetails;
}

/**
 * Tool for capturing screenshots of web pages
 */
class ScreenshotTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SCREENSHOT;

  /**
   * Execute screenshot operation
   */
  async execute(args: ScreenshotToolParams): Promise<ToolResult> {
    const {
      name = 'screenshot',
      selector,
      storeBase64 = true,
      fullPage = false,
      savePng = false,
    } = args;

    console.log(`Starting screenshot with options:`, args);

    // Resolve target tab (explicit or active)
    const explicit = await this.tryGetTab(args.tabId);
    const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));

    // Check URL restrictions
    if (
      tab.url?.startsWith('chrome://') ||
      tab.url?.startsWith('edge://') ||
      tab.url?.startsWith('https://chrome.google.com/webstore') ||
      tab.url?.startsWith('https://microsoftedge.microsoft.com/')
    ) {
      return createErrorResponse(
        'Cannot capture special browser pages or web store pages due to security restrictions.',
      );
    }

    let finalImageDataUrl: string | undefined;
    let finalImageWidthCss: number | undefined;
    let finalImageHeightCss: number | undefined;
    let finalImageWidthPx: number | undefined;
    let finalImageHeightPx: number | undefined;
    let deliverableImage: DeliverableImage | undefined;
    const results: any = { fileSaved: false };
    let originalScroll: { x: number; y: number } | null = null;
    let didPreparePage = false;
    let pageDetails: ScreenshotPageDetails | undefined;
    let captureMode: CapturedScreenshot['mode'] = selector
      ? 'element'
      : fullPage
        ? 'fullPage'
        : 'viewport';

    try {
      const background = args.background === true;
      // Background capture is strict: every mode uses CDP against the resolved tab.
      // Never fall back to captureVisibleTab here because it captures Chrome's
      // physically active tab and would either return the wrong page or require
      // stealing focus from the user.
      if (background) {
        try {
          const captured = await this._captureBackgroundWithCdp(tab.id!, args);
          finalImageDataUrl = captured.dataUrl;
          finalImageWidthCss = captured.widthCss;
          finalImageHeightCss = captured.heightCss;
          captureMode = captured.mode;
          pageDetails = {
            totalWidth: captured.widthCss,
            totalHeight: captured.heightCss,
            viewportWidth: captured.viewportWidthCss,
            viewportHeight: captured.viewportHeightCss,
            devicePixelRatio: captured.devicePixelRatio,
            currentScrollX: 0,
            currentScrollY: 0,
          };
        } catch (e) {
          throw new Error(
            `Background CDP capture failed without changing browser focus: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // Legacy foreground path. Isolated JustBrowse sessions always set
      // background=true; this remains only for explicit foreground callers.
      if (!finalImageDataUrl) {
        // Always inject helper when we need pageDetails
        await this.injectContentScript(tab.id!, ['inject-scripts/screenshot-helper.js']);
        await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));

        // Prepare page (hide scrollbars, handle fixed elements)
        const prepareResp = await this.sendMessageToTab(tab.id!, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE,
          options: { fullPage },
        });
        if (!prepareResp || prepareResp.success !== true) {
          throw new Error(
            'Screenshot helper did not acknowledge page preparation. The content script may not be injected or cannot run on this page.',
          );
        }
        didPreparePage = true;

        // Get page details with validation
        const rawPageDetails = await this.sendMessageToTab(tab.id!, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS,
        });
        pageDetails = assertValidPageDetails(rawPageDetails);
        originalScroll = { x: pageDetails.currentScrollX, y: pageDetails.currentScrollY };

        if (fullPage) {
          this.logInfo('Capturing full page...');
          finalImageDataUrl = await this._captureFullPage(tab.id!, args, pageDetails);
          // Compute final CSS size
          if (args.width && args.height) {
            finalImageWidthCss = args.width;
            finalImageHeightCss = args.height;
          } else if (args.width && !args.height) {
            finalImageWidthCss = args.width;
            const ratio = pageDetails.totalHeight / pageDetails.totalWidth;
            finalImageHeightCss = Math.round(args.width * ratio);
          } else if (!args.width && args.height) {
            finalImageHeightCss = args.height;
            const ratio = pageDetails.totalWidth / pageDetails.totalHeight;
            finalImageWidthCss = Math.round(args.height * ratio);
          } else {
            finalImageWidthCss = pageDetails.totalWidth;
            finalImageHeightCss = pageDetails.totalHeight;
          }
        } else if (selector) {
          this.logInfo(`Capturing element: ${selector}`);
          finalImageDataUrl = await this._captureElement(
            tab.id!,
            args,
            pageDetails.devicePixelRatio,
          );
          if (args.width && args.height) {
            finalImageWidthCss = args.width;
            finalImageHeightCss = args.height;
          } else {
            finalImageWidthCss = pageDetails.viewportWidth;
            finalImageHeightCss = pageDetails.viewportHeight;
          }
        } else {
          // Visible area only
          this.logInfo('Capturing visible area...');
          finalImageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          finalImageWidthCss = pageDetails.viewportWidth;
          finalImageHeightCss = pageDetails.viewportHeight;
        }
      }

      if (!finalImageDataUrl) {
        throw new Error('Failed to capture image data');
      }

      const outputBitmap = await createImageBitmapFromUrl(finalImageDataUrl);
      finalImageWidthPx = outputBitmap.width;
      finalImageHeightPx = outputBitmap.height;
      if (storeBase64) {
        deliverableImage = await this._prepareDeliverableImage(finalImageDataUrl);
        finalImageWidthPx = deliverableImage.width;
        finalImageHeightPx = deliverableImage.height;
      }

      // 2. Process output
      // Update screenshot context for coordinate scaling by tools like chrome_computer
      try {
        if (typeof finalImageWidthCss === 'number' && typeof finalImageHeightCss === 'number') {
          let hostname = '';
          try {
            hostname = tab.url ? new URL(tab.url).hostname : '';
          } catch {
            // ignore
          }
          // Use pageDetails if available, otherwise fall back to final image dimensions
          const viewportWidth = pageDetails?.viewportWidth ?? finalImageWidthCss;
          const viewportHeight = pageDetails?.viewportHeight ?? finalImageHeightCss;
          screenshotContextManager.setContext(tab.id!, {
            screenshotWidth: finalImageWidthPx,
            screenshotHeight: finalImageHeightPx,
            viewportWidth,
            viewportHeight,
            devicePixelRatio: pageDetails?.devicePixelRatio,
            hostname,
          });
        }
      } catch (e) {
        console.warn('Failed to set screenshot context:', e);
      }
      if (savePng === true) {
        // Save PNG file to downloads
        this.logInfo('Saving PNG...');
        try {
          // Generate filename
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `${name.replace(/[^a-z0-9_-]/gi, '_') || 'screenshot'}_${timestamp}.png`;

          // Use Chrome's download API to save the file
          const downloadId = await chrome.downloads.download({
            url: finalImageDataUrl,
            filename: filename,
            saveAs: false,
          });

          results.downloadId = downloadId;
          results.filename = filename;
          results.fileSaved = true;

          // Try to get the full file path
          try {
            // Wait a moment to ensure download info is updated
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Search for download item to get full path
            const [downloadItem] = await chrome.downloads.search({ id: downloadId });
            if (downloadItem && downloadItem.filename) {
              // Add full path to response
              results.fullPath = downloadItem.filename;
            }
          } catch (pathError) {
            console.warn('Could not get full file path:', pathError);
          }
        } catch (error) {
          console.error('Error saving PNG file:', error);
          results.saveError = String(error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      console.error('Error during screenshot execution:', error);
      return createErrorResponse(
        `Screenshot error: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
    } finally {
      // 3. Reset page only if we prepared it
      if (didPreparePage) {
        try {
          // Only include scroll position if we successfully captured it
          const resetMessage: Record<string, unknown> = {
            action: TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE,
          };
          if (originalScroll) {
            resetMessage.scrollX = originalScroll.x;
            resetMessage.scrollY = originalScroll.y;
          }
          await this.sendMessageToTab(tab.id!, resetMessage);
        } catch (err) {
          console.warn('Failed to reset page, tab might have closed:', err);
        }
      }
    }

    this.logInfo('Screenshot completed!');

    const metadata = {
      success: true,
      message: `Screenshot [${name}] captured successfully`,
      tabId: tab.id,
      url: tab.url,
      name,
      mimeType: deliverableImage?.mimeType ?? 'image/png',
      captureMode,
      background: args.background === true,
      width: finalImageWidthPx,
      height: finalImageHeightPx,
      transportCompressed: deliverableImage?.transportCompressed ?? false,
      ...results,
    };

    return {
      content: [
        ...(storeBase64
          ? ([
              {
                type: 'image',
                data: deliverableImage!.base64Data,
                mimeType: deliverableImage!.mimeType,
              },
            ] as const)
          : []),
        { type: 'text', text: JSON.stringify(metadata) },
      ],
      isError: false,
    };
  }

  /**
   * Keep screenshots within the existing native-messaging envelope while
   * preserving full resolution whenever possible. Large photographic/full-page
   * PNGs are converted to progressively smaller high-quality JPEGs; callers are
   * told the exact returned dimensions and MIME type.
   */
  private async _prepareDeliverableImage(dataUrl: string): Promise<DeliverableImage> {
    const pngBase64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    const original = await createImageBitmapFromUrl(dataUrl);
    if (pngBase64.length <= SCREENSHOT_CONSTANTS.MAX_MCP_BASE64_CHARS) {
      return {
        base64Data: pngBase64,
        mimeType: 'image/png',
        width: original.width,
        height: original.height,
        transportCompressed: false,
      };
    }

    const attempts = [
      { scale: 1, quality: 0.9 },
      { scale: 0.85, quality: 0.88 },
      { scale: 0.7, quality: 0.85 },
      { scale: 0.55, quality: 0.82 },
    ];
    for (const attempt of attempts) {
      const compressed = await compressImage(dataUrl, {
        ...attempt,
        format: 'image/jpeg',
      });
      const base64Data = compressed.dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
      if (base64Data.length <= SCREENSHOT_CONSTANTS.MAX_MCP_BASE64_CHARS) {
        const bitmap = await createImageBitmapFromUrl(compressed.dataUrl);
        return {
          base64Data,
          mimeType: 'image/jpeg',
          width: bitmap.width,
          height: bitmap.height,
          transportCompressed: true,
        };
      }
    }

    throw new Error(
      'Screenshot is too large for the MCP transport. Use maxHeight or width to request a smaller image.',
    );
  }

  /**
   * Capture any screenshot mode without activating a tab or focusing a window.
   * Full-page and element modes are CDP-only. Viewport mode has one guarded
   * captureVisibleTab fallback for a target already active in its exact window.
   */
  private async _captureBackgroundWithCdp(
    tabId: number,
    options: ScreenshotToolParams,
  ): Promise<CapturedScreenshot> {
    const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
    return await cdpSessionManager.withSession(tabId, 'screenshot', async () => {
      await cdpSessionManager.sendCommand(tabId, 'Page.enable', {});
      const metrics: any = await cdpSessionManager.sendCommand(tabId, 'Page.getLayoutMetrics', {});
      const viewport = metrics?.cssLayoutViewport ||
        metrics?.layoutViewport ||
        metrics?.cssVisualViewport ||
        metrics?.visualViewport || {
          clientWidth: 800,
          clientHeight: 600,
          pageX: 0,
          pageY: 0,
        };
      const viewportWidth = Math.max(1, Number(viewport.clientWidth || 800));
      const viewportHeight = Math.max(1, Number(viewport.clientHeight || 600));
      const dprResponse: any = await cdpSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: 'window.devicePixelRatio || 1',
        returnByValue: true,
      });
      const devicePixelRatio = Math.max(1, Number(dprResponse?.result?.value || 1));

      let clip: { x: number; y: number; width: number; height: number; scale: number };
      let mode: CapturedScreenshot['mode'];

      if (options.selector) {
        mode = 'element';
        const selectorExpression = JSON.stringify(options.selector);
        const elementResponse: any = await cdpSessionManager.sendCommand(
          tabId,
          'Runtime.evaluate',
          {
            expression: `(() => {
              const element = document.querySelector(${selectorExpression});
              if (!element) return { error: 'Element not found' };
              const rect = element.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return { error: 'Element has no visible box' };
              return {
                // CDP captureBeyondViewport accepts document-space clips. Do not
                // scroll here: scrolling can make fixed/sticky overlays cover the
                // requested element and it unnecessarily mutates an inactive tab.
                x: rect.left + window.scrollX,
                y: rect.top + window.scrollY,
                width: rect.width,
                height: rect.height
              };
            })()`,
            awaitPromise: true,
            returnByValue: true,
          },
        );
        if (elementResponse?.exceptionDetails) {
          throw new Error(elementResponse.exceptionDetails.text || 'Element lookup failed');
        }
        const element = elementResponse?.result?.value;
        if (element?.error) throw new Error(`${element.error}: ${options.selector}`);
        if (
          !element ||
          ![element.x, element.y, element.width, element.height].every(Number.isFinite)
        ) {
          throw new Error(`Could not resolve element bounds: ${options.selector}`);
        }
        clip = {
          x: Math.max(0, Number(element.x)),
          y: Math.max(0, Number(element.y)),
          width: Math.max(1, Number(element.width)),
          height: Math.max(1, Number(element.height)),
          scale: 1,
        };
      } else if (options.fullPage) {
        mode = 'fullPage';
        const content = metrics?.cssContentSize || metrics?.contentSize || {};
        const contentWidth = Math.max(viewportWidth, Number(content.width || viewportWidth));
        const contentHeight = Math.max(viewportHeight, Number(content.height || viewportHeight));
        clip = {
          x: Math.max(0, Number(content.x || 0)),
          y: Math.max(0, Number(content.y || 0)),
          width: contentWidth,
          height: Math.min(
            contentHeight,
            Math.max(1, options.maxHeight || SCREENSHOT_CONSTANTS.MAX_CAPTURE_HEIGHT_PX),
          ),
          scale: 1,
        };
      } else {
        mode = 'viewport';
        clip = {
          x: Math.max(0, Number(viewport.pageX || 0)),
          y: Math.max(0, Number(viewport.pageY || 0)),
          width: viewportWidth,
          height: viewportHeight,
          scale: 1,
        };
      }

      let dataUrl: string;
      try {
        dataUrl = await this._captureCdpClip(
          tabId,
          clip,
          options.fullPage === true || !!options.selector,
        );
      } catch (error) {
        if (mode !== 'fullPage') throw error;
        this.logInfo('Single-shot full-page CDP capture failed; retrying with CDP tiles.');
        dataUrl = await this._captureCdpFullPageTiles(tabId, clip);
      }

      let widthCss = clip.width;
      let heightCss = clip.height;
      if (options.width || options.height) {
        const image = await createImageBitmapFromUrl(dataUrl);
        const targetWidth =
          options.width || Math.round((image.width * options.height!) / image.height);
        const targetHeight =
          options.height || Math.round((image.height * options.width!) / image.width);
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Unable to create screenshot resize canvas');
        context.drawImage(image, 0, 0, targetWidth, targetHeight);
        dataUrl = await canvasToDataURL(canvas);
        widthCss = targetWidth;
        heightCss = targetHeight;
      }

      return {
        dataUrl,
        widthCss,
        heightCss,
        viewportWidthCss: viewportWidth,
        viewportHeightCss: viewportHeight,
        devicePixelRatio,
        mode,
      };
    });
  }

  private async _captureCdpClip(
    tabId: number,
    clip: { x: number; y: number; width: number; height: number; scale: number },
    captureBeyondViewport: boolean,
  ): Promise<string> {
    const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
    const capture = async (fromSurface: boolean) =>
      await cdpSessionManager.sendCommand(
        tabId,
        'Page.captureScreenshot',
        {
          format: 'png',
          fromSurface,
          captureBeyondViewport,
          clip,
        },
        7_000,
      );

    let shot: any;
    try {
      shot = await capture(true);
    } catch (surfaceError) {
      if (captureBeyondViewport) throw surfaceError;

      // Chrome may stop producing compositor frames for an unfocused window.
      // Wake the page and emulate focus inside DevTools only; neither command
      // activates the Chrome tab nor focuses its native window.
      try {
        await cdpSessionManager.sendCommand(tabId, 'Page.setWebLifecycleState', {
          state: 'active',
        });
        await cdpSessionManager.sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', {
          enabled: true,
        });
        try {
          shot = await capture(true);
        } finally {
          await cdpSessionManager
            .sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false })
            .catch(() => {});
        }
      } catch {
        try {
          return await this._captureVerifiedWindowActiveTab(tabId);
        } catch {
          // The target is not safely capturable through captureVisibleTab (for
          // example, it is inactive within its window). Keep trying CDP-only
          // fallbacks without activating or focusing it.
        }
      }

      if (!shot) {
        this.logInfo('Surface capture was unavailable; retrying from the rendered view.');
        try {
          shot = await capture(false);
        } catch {
          this.logInfo('Rendered-view capture was unavailable; retrying through CDP screencast.');
          return await this._captureCdpScreencastFrame(tabId, clip);
        }
      }
    }
    const base64Data = typeof shot?.data === 'string' ? shot.data : '';
    if (!base64Data) throw new Error('CDP Page.captureScreenshot returned empty data');
    return `data:image/png;base64,${base64Data}`;
  }

  private async _captureVerifiedWindowActiveTab(tabId: number): Promise<string> {
    const target = await chrome.tabs.get(tabId);
    if (!target.active || typeof target.windowId !== 'number') {
      throw new Error('Target tab is not active in its own window');
    }
    const [windowActiveTab] = await chrome.tabs.query({
      active: true,
      windowId: target.windowId,
    });
    if (windowActiveTab?.id !== tabId) {
      throw new Error('Window active tab changed before capture');
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: 'png' });
    if (!dataUrl) throw new Error('Verified window capture returned empty data');
    return dataUrl;
  }

  private async _captureCdpScreencastFrame(
    tabId: number,
    clip: { width: number; height: number },
  ): Promise<string> {
    const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
    let listener:
      | ((source: chrome.debugger.Debuggee, method: string, params?: object) => void)
      | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const frame = new Promise<string>((resolve, reject) => {
      listener = (source, method, params) => {
        if (source.tabId !== tabId || method !== 'Page.screencastFrame') return;
        const payload = params as { data?: unknown; sessionId?: unknown } | undefined;
        if (typeof payload?.data !== 'string' || payload.data.length === 0) return;
        if (typeof payload.sessionId === 'number') {
          void cdpSessionManager
            .sendCommand(tabId, 'Page.screencastFrameAck', { sessionId: payload.sessionId }, 2_000)
            .catch(() => {});
        }
        resolve(payload.data);
      };
      chrome.debugger.onEvent.addListener(listener);
      timeoutId = setTimeout(
        () => reject(new Error(`CDP screencast frame for tab ${tabId} timed out after 7000ms`)),
        7_000,
      );
    });

    try {
      await cdpSessionManager.sendCommand(
        tabId,
        'Page.startScreencast',
        {
          format: 'png',
          maxWidth: Math.max(1, Math.ceil(clip.width)),
          maxHeight: Math.max(1, Math.ceil(clip.height)),
          everyNthFrame: 1,
          sendLastFrame: true,
        },
        7_000,
      );
      const data = await frame;
      return `data:image/png;base64,${data}`;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (listener) chrome.debugger.onEvent.removeListener(listener);
      await cdpSessionManager.sendCommand(tabId, 'Page.stopScreencast', {}, 2_000).catch(() => {});
    }
  }

  private async _captureCdpFullPageTiles(
    tabId: number,
    fullClip: { x: number; y: number; width: number; height: number; scale: number },
  ): Promise<string> {
    const tileHeightCss = 8000;
    const rawParts: Array<{ dataUrl: string; yCss: number }> = [];
    for (let y = 0; y < fullClip.height; y += tileHeightCss) {
      const height = Math.min(tileHeightCss, fullClip.height - y);
      rawParts.push({
        dataUrl: await this._captureCdpClip(
          tabId,
          { ...fullClip, y: fullClip.y + y, height },
          true,
        ),
        yCss: y,
      });
    }
    if (rawParts.length === 0) throw new Error('Full-page capture produced no tiles');
    const first = await createImageBitmapFromUrl(rawParts[0].dataUrl);
    const scale = first.width / fullClip.width;
    const canvas = await stitchImages(
      rawParts.map((part) => ({ dataUrl: part.dataUrl, y: Math.round(part.yCss * scale) })),
      first.width,
      Math.round(fullClip.height * scale),
    );
    return await canvasToDataURL(canvas);
  }

  /**
   * Log information
   */
  private logInfo(message: string) {
    console.log(`[Screenshot Tool] ${message}`);
  }

  /**
   * Capture specific element
   */
  async _captureElement(
    tabId: number,
    options: ScreenshotToolParams,
    pageDpr: number,
  ): Promise<string> {
    const elementDetails = await this.sendMessageToTab(tabId, {
      action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_ELEMENT_DETAILS,
      selector: options.selector,
    });

    const dpr = elementDetails.devicePixelRatio || pageDpr || 1;

    // Element rect is viewport-relative, in CSS pixels
    // captureVisibleTab captures in physical pixels
    const cropRectPx = {
      x: elementDetails.rect.x * dpr,
      y: elementDetails.rect.y * dpr,
      width: elementDetails.rect.width * dpr,
      height: elementDetails.rect.height * dpr,
    };

    // Small delay to ensure element is fully rendered after scrollIntoView
    await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));

    const visibleCaptureDataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
    if (!visibleCaptureDataUrl) {
      throw new Error('Failed to capture visible tab for element cropping');
    }

    const croppedCanvas = await cropAndResizeImage(
      visibleCaptureDataUrl,
      cropRectPx,
      dpr,
      options.width, // Target output width in CSS pixels
      options.height, // Target output height in CSS pixels
    );
    return canvasToDataURL(croppedCanvas);
  }

  /**
   * Capture full page
   */
  async _captureFullPage(
    tabId: number,
    options: ScreenshotToolParams,
    initialPageDetails: any,
  ): Promise<string> {
    const dpr = initialPageDetails.devicePixelRatio;
    const totalWidthCss = options.width || initialPageDetails.totalWidth; // Use option width if provided
    const totalHeightCss = initialPageDetails.totalHeight; // Full page always uses actual height

    // Apply maximum height limit for infinite scroll pages
    const maxHeightPx = options.maxHeight || SCREENSHOT_CONSTANTS.MAX_CAPTURE_HEIGHT_PX;
    const limitedHeightCss = Math.min(totalHeightCss, maxHeightPx / dpr);

    const totalWidthPx = totalWidthCss * dpr;
    const totalHeightPx = limitedHeightCss * dpr;

    // Viewport dimensions (CSS pixels) - logged for debugging
    this.logInfo(
      `Viewport size: ${initialPageDetails.viewportWidth}x${initialPageDetails.viewportHeight} CSS pixels`,
    );
    this.logInfo(
      `Page dimensions: ${totalWidthCss}x${totalHeightCss} CSS pixels (limited to ${limitedHeightCss} height)`,
    );

    const viewportHeightCss = initialPageDetails.viewportHeight;

    const capturedParts = [];
    let currentScrollYCss = 0;
    let capturedHeightPx = 0;
    let partIndex = 0;

    while (capturedHeightPx < totalHeightPx && partIndex < SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS) {
      this.logInfo(
        `Capturing part ${partIndex + 1}... (${Math.round((capturedHeightPx / totalHeightPx) * 100)}%)`,
      );

      if (currentScrollYCss > 0) {
        // Don't scroll for the first part if already at top
        const scrollResp = await this.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_SCROLL_PAGE,
          x: 0,
          y: currentScrollYCss,
          scrollDelay: SCREENSHOT_CONSTANTS.SCROLL_DELAY_MS,
        });
        // Update currentScrollYCss based on actual scroll achieved
        currentScrollYCss = scrollResp.newScrollY;
      }

      // Ensure rendering after scroll
      await new Promise((resolve) =>
        setTimeout(resolve, SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS),
      );

      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
      if (!dataUrl) throw new Error('captureVisibleTab returned empty during full page capture');

      const yOffsetPx = currentScrollYCss * dpr;
      capturedParts.push({ dataUrl, y: yOffsetPx });

      const imgForHeight = await createImageBitmapFromUrl(dataUrl); // To get actual captured height
      const lastPartEffectiveHeightPx = Math.min(imgForHeight.height, totalHeightPx - yOffsetPx);

      capturedHeightPx = yOffsetPx + lastPartEffectiveHeightPx;

      if (capturedHeightPx >= totalHeightPx - SCREENSHOT_CONSTANTS.PIXEL_TOLERANCE) break;

      currentScrollYCss += viewportHeightCss;
      // Prevent overscrolling past the document height for the next scroll command
      if (
        currentScrollYCss > totalHeightCss - viewportHeightCss &&
        currentScrollYCss < totalHeightCss
      ) {
        currentScrollYCss = totalHeightCss - viewportHeightCss;
      }
      partIndex++;
    }

    // Check if we hit any limits
    if (partIndex >= SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS) {
      this.logInfo(
        `Reached maximum number of capture parts (${SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS}). This may be an infinite scroll page.`,
      );
    }
    if (totalHeightCss > limitedHeightCss) {
      this.logInfo(
        `Page height (${totalHeightCss}px) exceeds maximum capture height (${maxHeightPx / dpr}px). Capturing limited portion.`,
      );
    }

    this.logInfo('Stitching image...');
    const finalCanvas = await stitchImages(capturedParts, totalWidthPx, totalHeightPx);

    // If user specified width but not height (or vice versa for full page), resize maintaining aspect ratio
    let outputCanvas = finalCanvas;
    if (options.width && !options.height) {
      const targetWidthPx = options.width * dpr;
      const aspectRatio = finalCanvas.height / finalCanvas.width;
      const targetHeightPx = targetWidthPx * aspectRatio;
      outputCanvas = new OffscreenCanvas(targetWidthPx, targetHeightPx);
      const ctx = outputCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(finalCanvas, 0, 0, targetWidthPx, targetHeightPx);
      }
    } else if (options.height && !options.width) {
      const targetHeightPx = options.height * dpr;
      const aspectRatio = finalCanvas.width / finalCanvas.height;
      const targetWidthPx = targetHeightPx * aspectRatio;
      outputCanvas = new OffscreenCanvas(targetWidthPx, targetHeightPx);
      const ctx = outputCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(finalCanvas, 0, 0, targetWidthPx, targetHeightPx);
      }
    } else if (options.width && options.height) {
      // Both specified, direct resize
      const targetWidthPx = options.width * dpr;
      const targetHeightPx = options.height * dpr;
      outputCanvas = new OffscreenCanvas(targetWidthPx, targetHeightPx);
      const ctx = outputCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(finalCanvas, 0, 0, targetWidthPx, targetHeightPx);
      }
    }

    return canvasToDataURL(outputCanvas);
  }
}

export const screenshotTool = new ScreenshotTool();
