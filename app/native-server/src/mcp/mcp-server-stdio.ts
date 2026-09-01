#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';

let stdioMcpServer: Server | null = null;
let mcpClient: Client | null = null;
let cleanupStarted = false;

// Read configuration from stdio-config.json
const loadConfig = () => {
  try {
    const configPath = path.join(__dirname, 'stdio-config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    console.error('Failed to load stdio-config.json:', error);
    throw new Error('Configuration file stdio-config.json not found or invalid');
  }
};

export const getStdioMcpServer = () => {
  if (stdioMcpServer) {
    return stdioMcpServer;
  }
  stdioMcpServer = new Server(
    {
      name: 'StdioChromeMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  setupTools(stdioMcpServer);
  return stdioMcpServer;
};

async function closeMcpClient(): Promise<void> {
  const client = mcpClient;
  mcpClient = null;
  if (!client) return;
  try {
    await client.close();
  } catch {
    // The transport is already unusable; reconnect will create a fresh one.
  }
}

export const ensureMcpClient = async (forceNew = false) => {
  try {
    if (mcpClient && !forceNew) {
      try {
        const pingResult = await mcpClient.ping();
        if (pingResult) return mcpClient;
      } catch {
        console.error('[justbrowse-stdio] Existing MCP connection is stale; reconnecting');
      }
    }

    await closeMcpClient();
    const config = loadConfig();
    mcpClient = new Client({ name: 'Mcp Chrome Proxy', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {});
    await mcpClient.connect(transport);
    return mcpClient;
  } catch (error) {
    await closeMcpClient();
    console.error('Failed to connect to MCP server:', error);
    throw error;
  }
};

export const setupTools = (server: Server) => {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SCHEMAS }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(request.params.name, request.params.arguments || {}),
  );

  // List resources handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  // List prompts handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
};

const handleToolCall = async (name: string, args: any): Promise<CallToolResult> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const client = await ensureMcpClient(attempt > 0);
      // Use a sane default of 2 minutes; the previous value mistakenly used 2*6*1000 (12s)
      const DEFAULT_CALL_TIMEOUT_MS = 2 * 60 * 1000;
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: DEFAULT_CALL_TIMEOUT_MS,
      });
      return result as CallToolResult;
    } catch (error: any) {
      const message = error?.message || String(error);
      const connectionFailure = /EOF|closed|ECONNREFUSED|fetch failed|client is closing/i.test(
        message,
      );
      if (attempt === 0 && connectionFailure) {
        console.error(`[justbrowse-stdio] Tool connection failed; retrying once: ${message}`);
        continue;
      }
      return {
        content: [{ type: 'text', text: `Error calling tool: ${message}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: 'Error calling tool: retry loop exhausted' }],
    isError: true,
  };
};

async function cleanup(): Promise<void> {
  if (cleanupStarted) return;
  cleanupStarted = true;
  await closeMcpClient();
  try {
    await stdioMcpServer?.close();
  } catch {
    // Process shutdown should not hang on an already-closed stdio transport.
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await getStdioMcpServer().connect(transport);
  process.stdin.once('end', () => void cleanup());
  process.stdin.once('close', () => void cleanup());
}

main().catch((error) => {
  console.error('Fatal error Chrome MCP Server main():', error);
  process.exit(1);
});
