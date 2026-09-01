import type { ToolResult } from '@/common/tool-handler';
import { createErrorResponse } from '@/common/tool-handler';
import { TOOL_NAMES } from 'chrome-mcp-shared';

export const JUST_BROWSE_CONTEXT_KEY = '__justBrowse';

interface JustBrowseContext {
  sessionId: string;
  transport?: string;
}

interface SessionState {
  tabIds: number[];
  logicalActiveTabId: number | null;
  groupIdsByWindow: Record<string, number>;
  updatedAt: number;
}

interface PersistedState {
  sessions: Record<string, SessionState>;
  tabOwners: Record<string, string>;
}

export interface PreparedToolCall {
  args: Record<string, unknown>;
  immediateResult?: ToolResult;
}

const STORAGE_KEY = 'justBrowseSessionStateV1';
const GROUP_TITLE_PREFIX = 'JustBrowse';

const BACKGROUND_FIRST_TOOLS = new Set<string>([
  TOOL_NAMES.BROWSER.NAVIGATE,
  TOOL_NAMES.BROWSER.SCREENSHOT,
  TOOL_NAMES.BROWSER.COMPUTER,
  TOOL_NAMES.BROWSER.WEB_FETCHER,
  TOOL_NAMES.BROWSER.CONSOLE,
]);

const TAB_SCOPED_TOOLS = new Set<string>([
  TOOL_NAMES.BROWSER.NAVIGATE,
  TOOL_NAMES.BROWSER.MOVE_TAB,
  TOOL_NAMES.BROWSER.SCREENSHOT,
  TOOL_NAMES.BROWSER.COMPUTER,
  TOOL_NAMES.BROWSER.READ_PAGE,
  TOOL_NAMES.BROWSER.WEB_FETCHER,
  TOOL_NAMES.BROWSER.CLICK,
  TOOL_NAMES.BROWSER.FILL,
  TOOL_NAMES.BROWSER.REQUEST_ELEMENT_SELECTION,
  TOOL_NAMES.BROWSER.GET_INTERACTIVE_ELEMENTS,
  TOOL_NAMES.BROWSER.NETWORK_CAPTURE,
  TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START,
  TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP,
  TOOL_NAMES.BROWSER.NETWORK_REQUEST,
  TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
  TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP,
  TOOL_NAMES.BROWSER.KEYBOARD,
  TOOL_NAMES.BROWSER.INJECT_SCRIPT,
  TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT,
  TOOL_NAMES.BROWSER.JAVASCRIPT,
  TOOL_NAMES.BROWSER.CONSOLE,
  TOOL_NAMES.BROWSER.FILE_UPLOAD,
  TOOL_NAMES.BROWSER.HANDLE_DIALOG,
  TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE,
  TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE,
  TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT,
  TOOL_NAMES.BROWSER.GIF_RECORDER,
]);

const makeSession = (): SessionState => ({
  tabIds: [],
  logicalActiveTabId: null,
  groupIdsByWindow: {},
  updatedAt: Date.now(),
});

const isContext = (value: unknown): value is JustBrowseContext =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
  (value as { sessionId: string }).sessionId.length > 0;

export function takeJustBrowseContext(args: unknown): {
  context: JustBrowseContext | null;
  cleanArgs: Record<string, unknown>;
} {
  const cleanArgs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};
  const rawContext = cleanArgs[JUST_BROWSE_CONTEXT_KEY];
  delete cleanArgs[JUST_BROWSE_CONTEXT_KEY];
  return { context: isContext(rawContext) ? rawContext : null, cleanArgs };
}

function textResult(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError: false,
  };
}

class BrowserSessionManager {
  private state: PersistedState = { sessions: {}, tabOwners: {} };
  private initialized: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor() {
    chrome.tabs.onRemoved.addListener((tabId) => {
      void this.removeTabs([tabId]);
    });
    chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
      void this.replaceTab(removedTabId, addedTabId);
    });
  }

  async prepare(sessionId: string, name: string, rawArgs: Record<string, unknown>) {
    await this.ensureInitialized();
    const args = { ...rawArgs };
    const session = this.getOrCreateSession(sessionId);

    if (name === TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS) {
      return { args, immediateResult: await this.sessionView(sessionId) };
    }

    if (name === TOOL_NAMES.BROWSER.SWITCH_TAB) {
      const tabId = Number(args.tabId);
      if (!Number.isInteger(tabId)) {
        return { args, immediateResult: createErrorResponse('tabId is required') };
      }
      const ownershipError = this.ownershipError(sessionId, tabId);
      if (ownershipError) return { args, immediateResult: createErrorResponse(ownershipError) };
      await this.mutate(() => {
        const current = this.getOrCreateSession(sessionId);
        current.logicalActiveTabId = tabId;
        current.updatedAt = Date.now();
      });
      return {
        args,
        immediateResult: textResult({
          success: true,
          message: 'Switched the JustBrowse logical tab without changing Chrome focus',
          tabId,
        }),
      };
    }

    if (name === TOOL_NAMES.BROWSER.CLOSE_TABS) {
      if (typeof args.url === 'string') {
        return {
          args,
          immediateResult: createErrorResponse(
            'URL-wide tab closing is disabled for isolated sessions because it could close user tabs. Pass owned tabIds instead.',
          ),
        };
      }
      const requested = Array.isArray(args.tabIds)
        ? args.tabIds.filter((value): value is number => Number.isInteger(value))
        : session.logicalActiveTabId == null
          ? []
          : [session.logicalActiveTabId];
      if (requested.length === 0) {
        return { args, immediateResult: createErrorResponse('This session has no tab to close') };
      }
      for (const tabId of requested) {
        const ownershipError = this.ownershipError(sessionId, tabId);
        if (ownershipError) return { args, immediateResult: createErrorResponse(ownershipError) };
      }
      args.tabIds = requested;
    }

    if (TAB_SCOPED_TOOLS.has(name)) {
      const explicitTabId = Number.isInteger(args.tabId) ? (args.tabId as number) : null;
      if (explicitTabId !== null) {
        const ownershipError = this.ownershipError(sessionId, explicitTabId, true);
        if (ownershipError) return { args, immediateResult: createErrorResponse(ownershipError) };
        if (!this.state.tabOwners[String(explicitTabId)]) {
          // Reserve an explicitly selected user tab before the tool runs. Doing this in
          // prepare() prevents two concurrent MCP sessions from acting on it first and
          // only discovering the ownership collision after both side effects occurred.
          await this.claimTab(sessionId, explicitTabId);
        }
      } else if (session.logicalActiveTabId !== null) {
        args.tabId = session.logicalActiveTabId;
      } else if (name !== TOOL_NAMES.BROWSER.NAVIGATE) {
        return {
          args,
          immediateResult: createErrorResponse(
            'This JustBrowse session has no tab yet. Call chrome_navigate first.',
          ),
        };
      }
    }

    if (BACKGROUND_FIRST_TOOLS.has(name) && typeof args.background !== 'boolean') {
      args.background = true;
    }

    if (name === TOOL_NAMES.BROWSER.MOVE_TAB && typeof args.focused !== 'boolean') {
      args.focused = false;
    }

    // An isolated session must never silently adopt a matching tab from the user's workspace.
    if (name === TOOL_NAMES.BROWSER.NAVIGATE && !Number.isInteger(args.tabId)) {
      args.reuseExisting = false;
    }

    return { args } satisfies PreparedToolCall;
  }

  async recordResult(
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): Promise<void> {
    if (result.isError) return;

    if (name === TOOL_NAMES.BROWSER.CLOSE_TABS) {
      const closed = this.readJsonResults(result).flatMap((value) =>
        Array.isArray(value.closedTabIds)
          ? value.closedTabIds.filter((id): id is number => Number.isInteger(id))
          : [],
      );
      await this.removeTabs(closed);
      return;
    }

    if (!TAB_SCOPED_TOOLS.has(name)) return;
    const tabIds = new Set<number>();
    if (Number.isInteger(args.tabId)) tabIds.add(args.tabId as number);
    if (name === TOOL_NAMES.BROWSER.NAVIGATE) {
      for (const value of this.readJsonResults(result)) {
        if (Number.isInteger(value.tabId)) tabIds.add(value.tabId as number);
        if (Array.isArray(value.tabs)) {
          for (const tab of value.tabs) {
            if (tab && typeof tab === 'object' && Number.isInteger(tab.tabId)) {
              tabIds.add(tab.tabId as number);
            }
          }
        }
      }
    }

    for (const tabId of tabIds) await this.claimTab(sessionId, tabId);
  }

  async releaseSession(sessionId: string): Promise<ToolResult> {
    await this.ensureInitialized();
    const releasedTabIds = [...(this.state.sessions[sessionId]?.tabIds ?? [])];
    await this.mutate(() => {
      for (const tabId of releasedTabIds) {
        if (this.state.tabOwners[String(tabId)] === sessionId) {
          delete this.state.tabOwners[String(tabId)];
        }
      }
      delete this.state.sessions[sessionId];
    });
    return textResult({ success: true, sessionId, releasedTabIds });
  }

  private async sessionView(sessionId: string): Promise<ToolResult> {
    const session = this.getOrCreateSession(sessionId);
    const liveTabs = (
      await Promise.all(
        session.tabIds.map(async (tabId) => {
          try {
            return await chrome.tabs.get(tabId);
          } catch {
            return null;
          }
        }),
      )
    ).filter((tab): tab is chrome.tabs.Tab => tab !== null && typeof tab.id === 'number');
    const stale = session.tabIds.filter((tabId) => !liveTabs.some((tab) => tab.id === tabId));
    if (stale.length > 0) await this.removeTabs(stale);

    const windows = new Map<number, Array<Record<string, unknown>>>();
    for (const tab of liveTabs) {
      const items = windows.get(tab.windowId) ?? [];
      items.push({
        tabId: tab.id,
        url: tab.url ?? '',
        title: tab.title ?? '',
        active: tab.id === session.logicalActiveTabId,
        chromeActive: tab.active === true,
      });
      windows.set(tab.windowId, items);
    }

    return textResult({
      sessionId,
      windowCount: windows.size,
      tabCount: liveTabs.length,
      windows: [...windows.entries()].map(([windowId, tabs]) => ({ windowId, tabs })),
    });
  }

  private ownershipError(sessionId: string, tabId: number, allowUnowned = false): string | null {
    const owner = this.state.tabOwners[String(tabId)];
    if (!owner) return allowUnowned ? null : `Tab ${tabId} is not owned by this JustBrowse session`;
    return owner === sessionId
      ? null
      : `Tab ${tabId} is already owned by another JustBrowse session`;
  }

  private async claimTab(sessionId: string, tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId);

    await this.mutate(() => {
      const existingOwner = this.state.tabOwners[String(tabId)];
      if (existingOwner && existingOwner !== sessionId) {
        throw new Error(`Tab ${tabId} is already owned by another JustBrowse session`);
      }
      const session = this.getOrCreateSession(sessionId);
      if (!session.tabIds.includes(tabId)) session.tabIds.push(tabId);
      session.logicalActiveTabId = tabId;
      session.updatedAt = Date.now();
      this.state.tabOwners[String(tabId)] = sessionId;
    });
    await this.ensureSessionGroup(sessionId, tab);
  }

  private async ensureSessionGroup(sessionId: string, tab: chrome.tabs.Tab): Promise<void> {
    if (
      typeof tab.id !== 'number' ||
      typeof tab.windowId !== 'number' ||
      !chrome.tabs.group ||
      !chrome.tabGroups
    )
      return;
    const session = this.getOrCreateSession(sessionId);
    const windowKey = String(tab.windowId);
    let groupId = session.groupIdsByWindow[windowKey];

    try {
      if (typeof groupId === 'number') {
        await chrome.tabGroups.get(groupId);
        await chrome.tabs.group({ groupId, tabIds: [tab.id] });
      } else {
        groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      }
      await chrome.tabGroups.update(groupId, {
        title: `${GROUP_TITLE_PREFIX} ${sessionId.slice(0, 8)}`,
        color: 'blue',
        collapsed: tab.active !== true,
      });
      await this.mutate(() => {
        const current = this.getOrCreateSession(sessionId);
        current.groupIdsByWindow[windowKey] = groupId as number;
        current.updatedAt = Date.now();
      });
    } catch (error) {
      console.warn('[JustBrowse] Could not group isolated tab', error);
    }
  }

  private readJsonResults(result: ToolResult): Array<Record<string, any>> {
    const values: Array<Record<string, any>> = [];
    for (const item of result.content) {
      if (item.type !== 'text') continue;
      try {
        const parsed = JSON.parse(item.text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values.push(parsed);
      } catch {
        // Non-JSON tool output has no tab metadata to record.
      }
    }
    return values;
  }

  private getOrCreateSession(sessionId: string): SessionState {
    return (this.state.sessions[sessionId] ??= makeSession());
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        // chrome.storage.session survives MV3 service-worker suspension but is
        // cleared when Chrome restarts, avoiding stale tab IDs being reused.
        const stored = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY] as
          | PersistedState
          | undefined;
        if (stored?.sessions && stored?.tabOwners) this.state = stored;
      })();
    }
    await this.initialized;
  }

  private async mutate(operation: () => void): Promise<void> {
    await this.ensureInitialized();
    const run = async () => {
      operation();
      await chrome.storage.session.set({ [STORAGE_KEY]: this.state });
    };
    this.mutationQueue = this.mutationQueue.then(run, run);
    await this.mutationQueue;
  }

  private async removeTabs(tabIds: number[]): Promise<void> {
    if (tabIds.length === 0) return;
    await this.mutate(() => {
      for (const tabId of tabIds) {
        const owner = this.state.tabOwners[String(tabId)];
        delete this.state.tabOwners[String(tabId)];
        if (!owner) continue;
        const session = this.state.sessions[owner];
        if (!session) continue;
        session.tabIds = session.tabIds.filter((id) => id !== tabId);
        if (session.logicalActiveTabId === tabId) {
          session.logicalActiveTabId = session.tabIds.at(-1) ?? null;
        }
        session.updatedAt = Date.now();
      }
    });
  }

  private async replaceTab(removedTabId: number, addedTabId: number): Promise<void> {
    await this.mutate(() => {
      const owner = this.state.tabOwners[String(removedTabId)];
      if (!owner) return;
      delete this.state.tabOwners[String(removedTabId)];
      this.state.tabOwners[String(addedTabId)] = owner;
      const session = this.state.sessions[owner];
      if (!session) return;
      session.tabIds = session.tabIds.map((id) => (id === removedTabId ? addedTabId : id));
      if (session.logicalActiveTabId === removedTabId) session.logicalActiveTabId = addedTabId;
      session.updatedAt = Date.now();
    });
  }
}

export const browserSessionManager = new BrowserSessionManager();
