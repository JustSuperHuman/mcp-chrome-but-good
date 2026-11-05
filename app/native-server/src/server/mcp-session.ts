/**
 * Resuming Streamable HTTP sessions the bridge no longer holds.
 *
 * A client keeps its MCP session ID for as long as it runs, but the bridge forgets it when the
 * session sits idle past CHROME_MCP_SESSION_IDLE_MS or when the bridge restarts with Chrome.
 * Rather than failing the client's next call, the server rebuilds the session under the same ID.
 * The browser side keys tab ownership by that ID, so after a bridge restart the agent even keeps
 * its tabs.
 */
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** This server issues random UUIDs as session IDs; anything else was never one of ours. */
export function isResumableSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

interface TransportSessionState {
  sessionId?: string;
  _initialized?: unknown;
}

/**
 * Put a new transport into the state it reaches after `initialize`, under a session ID the
 * client already holds.
 *
 * The SDK has no public API for resuming a session, so this sets the two fields its own
 * initialize handler sets. SDK 1.24 keeps them on the transport; later versions keep them on an
 * inner web-standard transport. Returns false when neither layout matches, and the caller then
 * answers 404 so the client starts a new session instead.
 */
export function markSessionInitialized(
  transport: StreamableHTTPServerTransport,
  sessionId: string,
): boolean {
  const outer = transport as unknown as TransportSessionState & {
    _webStandardTransport?: TransportSessionState;
  };
  const state = outer._webStandardTransport ?? outer;
  if (typeof state._initialized !== 'boolean') return false;

  state.sessionId = sessionId;
  state._initialized = true;
  return transport.sessionId === sessionId;
}

/** The status and body the SDK itself sends for an unknown session; clients reconnect on it. */
export const SESSION_NOT_FOUND_BODY = {
  jsonrpc: '2.0',
  error: { code: -32001, message: 'Session not found' },
  id: null,
} as const;
