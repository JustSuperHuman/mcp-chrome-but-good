import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

const DEFAULT_NETWORK_REQUEST_TIMEOUT = 30000; // For sending a single request via content script
const NEW_TAB_LOAD_DELAY_MS = 3000;
const FORBIDDEN_REQUEST_HEADERS =
  /^(accept-charset|accept-encoding|access-control-request-|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|proxy-|sec-|te|trailer|transfer-encoding|upgrade|via)$/i;

function browserSafeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !FORBIDDEN_REQUEST_HEADERS.test(name)),
  );
}

function isSameOrigin(left: string, right?: string): boolean {
  try {
    return new URL(left).origin === new URL(right || '').origin;
  } catch {
    return false;
  }
}

interface NetworkRequestToolParams {
  url: string; // URL is always required
  method?: string; // Defaults to GET
  headers?: Record<string, string>; // User-provided headers
  body?: any; // User-provided body
  timeout?: number; // Timeout for the network request itself
  // Optional multipart/form-data descriptor. When provided, overrides body and lets the helper build FormData.
  // Shape: { fields?: Record<string, string|number|boolean>, files?: Array<{ name: string, fileUrl?: string, filePath?: string, base64Data?: string, filename?: string, contentType?: string }> }
  // Or a compact array: [ [name, fileSpec, filename?], ... ] where fileSpec can be 'url:...', 'file:/abs/path', 'base64:...'
  formData?: any;
  tabId?: number;
  tabUrl?: string;
  windowId?: number;
  background?: boolean;
}

async function readResponse(response: Response) {
  const responseData: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: unknown;
  } = {
    status: response.status,
    statusText: response.statusText,
    headers: {},
  };
  response.headers.forEach((value, key) => {
    responseData.headers[key] = value;
  });
  const contentType = response.headers.get('content-type') || '';
  try {
    responseData.body = contentType.includes('application/json')
      ? await response.json()
      : contentType.includes('text/') ||
          contentType.includes('application/xml') ||
          contentType.includes('application/javascript')
        ? await response.text()
        : '[Binary data not displayed]';
  } catch (error) {
    responseData.body = `[Error parsing response body: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return responseData;
}

async function requestFromExtension(args: NetworkRequestToolParams) {
  const method = (args.method || 'GET').toUpperCase();
  const timeout = Number.isFinite(args.timeout)
    ? Math.max(0, args.timeout!)
    : DEFAULT_NETWORK_REQUEST_TIMEOUT;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(args.url, {
      method,
      headers: browserSafeHeaders(args.headers || {}),
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      ...(method !== 'GET' && method !== 'HEAD' && args.body !== undefined
        ? { body: typeof args.body === 'string' ? args.body : JSON.stringify(args.body) }
        : {}),
      signal: controller.signal,
    });
    return { success: true, response: await readResponse(response) };
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? `Request timed out after ${timeout}ms`
        : error instanceof Error
          ? error.message || error.name
          : String(error);
    return {
      success: false,
      error: `Network request failed for ${args.url}: ${message || 'Failed to fetch'}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * NetworkRequestTool - Sends network requests based on provided parameters.
 */
class NetworkRequestTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_REQUEST;

  async execute(args: NetworkRequestToolParams): Promise<ToolResult> {
    const {
      url,
      method = 'GET',
      headers = {},
      body,
      timeout = DEFAULT_NETWORK_REQUEST_TIMEOUT,
      tabId,
      tabUrl,
      windowId,
      background = true,
    } = args;

    console.log(`NetworkRequestTool: Executing with options:`, args);

    if (!url) {
      return createErrorResponse('URL parameter is required.');
    }

    try {
      const target = await resolveTargetTab({ tabId, tabUrl, windowId, background });
      if (typeof target !== 'number') {
        return createErrorResponse(target.error);
      }
      const targetTab = await chrome.tabs.get(target);
      const safeHeaders = browserSafeHeaders(headers);

      // Page-context fetch preserves same-origin cookies and multipart file
      // support. Cross-origin requests use the extension service worker so a
      // page's CORS policy cannot turn an otherwise permitted request into the
      // opaque "Failed to fetch" error.
      if (!args.formData && !isSameOrigin(url, targetTab.url)) {
        const extensionResult = await requestFromExtension({
          ...args,
          method: method.toUpperCase(),
          headers: safeHeaders,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(extensionResult) }],
          isError: !extensionResult.success,
        };
      }

      // Ensure content script is available in the target tab
      await this.injectContentScript(target, ['inject-scripts/network-helper.js']);

      console.log(
        `NetworkRequestTool: Sending to content script: URL=${url}, Method=${method}, Headers=${Object.keys(headers).join(',')}, BodyType=${typeof body}`,
      );

      const resultFromContentScript = await this.sendMessageToTab(target, {
        action: TOOL_MESSAGE_TYPES.NETWORK_SEND_REQUEST,
        url: url,
        method: method.toUpperCase(),
        headers: safeHeaders,
        body: body,
        formData: args.formData || null,
        timeout: timeout,
      });

      console.log(`NetworkRequestTool: Response from content script:`, resultFromContentScript);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(resultFromContentScript),
          },
        ],
        isError: !resultFromContentScript?.success,
      };
    } catch (error: any) {
      console.error('NetworkRequestTool: Error sending network request:', error);
      return createErrorResponse(
        `Error sending network request: ${error.message || String(error)}`,
      );
    }
  }
}

async function resolveTargetTab(options: {
  tabId?: number;
  tabUrl?: string;
  windowId?: number;
  background: boolean;
}): Promise<number | { error: string }> {
  const { tabId, tabUrl, windowId, background } = options;

  if (typeof tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.id ?? { error: `Tab ${tabId} has no ID` };
    } catch {
      return { error: `Tab ${tabId} does not exist` };
    }
  }

  if (typeof tabUrl === 'string' && tabUrl.length > 0) {
    const normalizedTarget = tabUrl.endsWith('/') ? tabUrl.slice(0, -1) : tabUrl;
    const matchingTab = (await chrome.tabs.query({})).find((tab) => {
      const normalizedUrl = tab.url?.endsWith('/') ? tab.url.slice(0, -1) : tab.url;
      return normalizedUrl === normalizedTarget;
    });
    if (matchingTab?.id) return matchingTab.id;

    const created = await chrome.tabs.create({
      url: tabUrl,
      active: !background,
      windowId,
    });
    await new Promise((resolve) => setTimeout(resolve, NEW_TAB_LOAD_DELAY_MS));
    return created.id ?? { error: 'Failed to create target tab' };
  }

  const tabs =
    typeof windowId === 'number'
      ? await chrome.tabs.query({ active: true, windowId })
      : await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? { error: 'No active tab found or tab has no ID.' };
}

export const networkRequestTool = new NetworkRequestTool();
