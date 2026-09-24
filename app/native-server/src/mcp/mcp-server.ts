import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { setupTools } from './register-tools';

export interface McpConnectionContext {
  sessionId: string;
  transport: 'sse' | 'streamable-http' | 'stdio';
}

/**
 * Create one MCP protocol server per connected transport.
 *
 * The MCP SDK Server owns exactly one transport. Sharing a singleton here made
 * a second Claude/Codex session fail with "Already connected to a transport"
 * and also left us with no trustworthy connection identity for tab isolation.
 */
export const createMcpServer = (context: McpConnectionContext) => {
  const mcpServer = new Server(
    {
      name: 'JustBrowseMCP',
      version: require('../../package.json').version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  setupTools(mcpServer, context);
  return mcpServer;
};
