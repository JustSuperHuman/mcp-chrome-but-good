import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';

interface MoveTabToolParams {
  tabId: number;
  windowId?: number;
  index?: number;
  newWindow?: boolean;
  focused?: boolean;
}

class MoveTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.MOVE_TAB;

  async execute(args: MoveTabToolParams): Promise<ToolResult> {
    const { tabId, windowId, index, newWindow = false, focused = false } = args;
    if (!Number.isInteger(tabId)) return createErrorResponse('tabId is required');
    if (newWindow && windowId !== undefined) {
      return createErrorResponse('Cannot specify both newWindow and windowId');
    }
    if (!newWindow && windowId === undefined) {
      return createErrorResponse('Either windowId or newWindow=true must be provided');
    }

    try {
      let movedTab: chrome.tabs.Tab;
      if (newWindow) {
        const createdWindow = await chrome.windows.create({ tabId, focused });
        if (typeof createdWindow.id !== 'number') {
          return createErrorResponse('Failed to create destination window');
        }
        movedTab = await chrome.tabs.get(tabId);
      } else {
        const result = await chrome.tabs.move(tabId, {
          windowId,
          index: typeof index === 'number' ? index : -1,
        });
        movedTab = Array.isArray(result) ? result[0] : result;
        if (focused) await chrome.windows.update(windowId as number, { focused: true });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              tabId: movedTab.id,
              windowId: movedTab.windowId,
              index: movedTab.index,
              url: movedTab.url,
              focused,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error moving tab: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const moveTabTool = new MoveTabTool();
