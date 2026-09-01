type OwnerTag = string;

interface TabSessionState {
  refCount: number;
  owners: Map<OwnerTag, number>;
  attachedByUs: boolean;
}

const DEBUGGER_PROTOCOL_VERSION = '1.3';
const CDP_OPERATION_TIMEOUT_MS = 15_000;

async function withCdpTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = CDP_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

class CDPSessionManager {
  private sessions = new Map<number, TabSessionState>();
  private tabLocks = new Map<number, Promise<void>>();

  constructor() {
    chrome.debugger.onDetach.addListener(({ tabId }) => {
      if (typeof tabId === 'number') this.sessions.delete(tabId);
    });
  }

  private getState(tabId: number): TabSessionState | undefined {
    return this.sessions.get(tabId);
  }

  private setState(tabId: number, state: TabSessionState) {
    this.sessions.set(tabId, state);
  }

  private async withTabLock<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tabLocks.get(tabId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tabLocks.set(tabId, current);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tabLocks.get(tabId) === current) this.tabLocks.delete(tabId);
    }
  }

  private async attachUnsafe(tabId: number, owner: OwnerTag): Promise<void> {
    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      state.refCount += 1;
      state.owners.set(owner, (state.owners.get(owner) ?? 0) + 1);
      return;
    }

    // Check existing attachments
    const targets = await withCdpTimeout(
      chrome.debugger.getTargets(),
      `CDP target discovery for tab ${tabId}`,
    );
    const existing = targets.find((t) => t.tabId === tabId && t.attached);
    if (existing) {
      if (existing.extensionId === chrome.runtime.id) {
        // Already attached by us (e.g., previous tool). Adopt and refcount.
        this.setState(tabId, {
          refCount: state ? state.refCount + 1 : 1,
          owners: new Map(state?.owners ?? []).set(owner, (state?.owners.get(owner) ?? 0) + 1),
          attachedByUs: true,
        });
        return;
      }
      // Another client (DevTools/other extension) is attached
      throw new Error(
        `Debugger is already attached to tab ${tabId} by another client (e.g., DevTools/extension)`,
      );
    }

    // Attach freshly
    try {
      await withCdpTimeout(
        chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION),
        `CDP attach for tab ${tabId}`,
      );
    } catch (error) {
      // A timed-out attach can still complete later in Chromium. Best-effort
      // detachment prevents that late completion from leaking a debugger lock.
      void chrome.debugger.detach({ tabId }).catch(() => {});
      this.sessions.delete(tabId);
      throw error;
    }
    this.setState(tabId, {
      refCount: 1,
      owners: new Map([[owner, 1]]),
      attachedByUs: true,
    });
  }

  async attach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    return await this.withTabLock(tabId, () => this.attachUnsafe(tabId, owner));
  }

  private async detachUnsafe(tabId: number, owner: OwnerTag): Promise<void> {
    const state = this.getState(tabId);
    if (!state) return; // Nothing to do

    // Update ownership/refcount
    const ownerCount = state.owners.get(owner);
    if (!ownerCount) return;
    if (ownerCount === 1) state.owners.delete(owner);
    else state.owners.set(owner, ownerCount - 1);
    state.refCount = Math.max(0, state.refCount - 1);

    if (state.refCount > 0) {
      // Still in use by other owners
      return;
    }

    // We are the last owner
    try {
      if (state.attachedByUs) {
        await withCdpTimeout(chrome.debugger.detach({ tabId }), `CDP detach for tab ${tabId}`);
      }
    } catch (e) {
      // Best-effort detach; ignore
    } finally {
      if (this.sessions.get(tabId) === state) this.sessions.delete(tabId);
    }
  }

  async detach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    return await this.withTabLock(tabId, () => this.detachUnsafe(tabId, owner));
  }

  async abortOwner(tabId: number, owner: OwnerTag): Promise<void> {
    const state = this.getState(tabId);
    if (!state) return;
    const ownerCount = state.owners.get(owner);
    if (!ownerCount) return;
    if (ownerCount === 1) state.owners.delete(owner);
    else state.owners.set(owner, ownerCount - 1);
    state.refCount = Math.max(0, state.refCount - 1);
    if (state.refCount > 0 || !state.attachedByUs) return;
    if (this.sessions.get(tabId) === state) this.sessions.delete(tabId);

    try {
      await Promise.race([
        chrome.debugger.detach({ tabId }),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    } catch {
      // The onDetach listener also clears local state.
    }
  }

  /**
   * Convenience wrapper: ensures attach before fn, and balanced detach after.
   */
  async withSession<T>(tabId: number, owner: OwnerTag, fn: () => Promise<T>): Promise<T> {
    await this.attach(tabId, owner);
    try {
      return await fn();
    } finally {
      await this.detach(tabId, owner);
    }
  }

  /**
   * Send a CDP command. Requires that this manager has attached to the tab.
   * If not attached by us, will attempt a one-shot attach around the call.
   */
  async sendCommand<T = any>(
    tabId: number,
    method: string,
    params?: object,
    timeoutMs = CDP_OPERATION_TIMEOUT_MS,
  ): Promise<T> {
    return await this.withTabLock(tabId, async () => {
      const send = async (owner: OwnerTag): Promise<T> => {
        const state = this.getState(tabId);
        const temporary = !state?.attachedByUs;
        if (temporary) await this.attachUnsafe(tabId, owner);
        try {
          return (await withCdpTimeout(
            chrome.debugger.sendCommand({ tabId }, method, params),
            `CDP ${method} for tab ${tabId}`,
            timeoutMs,
          )) as T;
        } finally {
          if (temporary) await this.detachUnsafe(tabId, owner);
        }
      };

      try {
        return await send(`send:${method}`);
      } catch (error) {
        if (
          !/Debugger is not attached/i.test(error instanceof Error ? error.message : String(error))
        ) {
          throw error;
        }
        this.sessions.delete(tabId);
        return await send(`retry:${method}`);
      }
    });
  }
}

export const cdpSessionManager = new CDPSessionManager();
