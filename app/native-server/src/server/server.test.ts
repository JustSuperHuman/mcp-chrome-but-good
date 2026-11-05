import { describe, expect, test, afterAll, beforeAll, jest } from '@jest/globals';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

jest.mock('../agent/engines/codex', () => ({ CodexEngine: jest.fn() }));
jest.mock('../agent/engines/claude', () => ({ ClaudeEngine: jest.fn() }));
jest.mock('../agent/db', () => ({ closeDb: jest.fn() }));

import Server from './index';
import * as mcpServerModule from '../mcp/mcp-server';
import { CHROME_MCP_SESSION_IDLE_MS_ENV } from '../constant';

const transportsOf = () =>
  (Server as unknown as { transportsMap: Map<string, StreamableHTTPServerTransport> })
    .transportsMap;

const mcpPost = (sessionId: string | undefined, body: unknown) => {
  let request = supertest(Server.getInstance().server)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  if (sessionId) request = request.set('mcp-session-id', sessionId);
  return request.send(JSON.stringify(body));
};

// ping is answered by the SDK itself, so it proves the session is live without needing Chrome.
const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });

const initialize = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'codex-mcp-client', version: '0.0.0' },
  },
};

/** The SDK answers POSTs as a short SSE stream; pull out the JSON-RPC message it carries. */
const sseMessage = (text: string) => {
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  if (!data) throw new Error(`No SSE data in response: ${text}`);
  return JSON.parse(data.slice('data: '.length));
};

describe('Server tests', () => {
  // Start the server test instance
  beforeAll(async () => {
    await Server.getInstance().ready();
  });

  // Shut down the server
  afterAll(async () => {
    await Server.stop();
    await Server.getInstance().close();
  });

  test.each(['GET', 'POST', 'DELETE', 'OPTIONS'] as const)(
    '%s /mcp rejects an untrusted origin before transport handling',
    async (method) => {
      const response = await Server.getInstance().inject({
        method,
        url: '/mcp',
        headers: { origin: 'http://127.0.0.1.attacker.example' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Origin not allowed' });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    },
  );

  test.each(['/ask-extension', '/sse', '/agent/sessions'])(
    'rejects untrusted simple GET requests to %s before side effects',
    async (url) => {
      const response = await Server.getInstance().inject({
        method: 'GET',
        url,
        headers: { origin: 'https://attacker.example' },
      });
      expect(response.statusCode).toBe(403);
    },
  );

  test.each(['http://127.0.0.1:5173', 'chrome-extension://pafdmkonlckfdodnpmdbpjmnjnjglihe'])(
    'preserves API access and CORS preflight for %s',
    async (origin) => {
      const response = await Server.getInstance().inject({
        method: 'GET',
        url: '/ping',
        headers: { origin },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-credentials']).toBe('true');

      const preflight = await Server.getInstance().inject({
        method: 'OPTIONS',
        url: '/mcp',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,mcp-session-id',
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    },
  );

  test('GET /ping reports a disconnected extension instead of a false pong', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/ping')
      .expect(503)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      status: 'error',
      message: 'Extension bridge not available',
      extensionConnected: false,
    });
  });

  test('GET /mcp lets the transport own the raw SSE response', async () => {
    const sessionId = 'raw-response-ownership-test';
    const handleRequest = jest.fn(async (_request: unknown, response: ServerResponse) => {
      expect(response.headersSent).toBe(false);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.end(': ready\n\n');
    });
    const serverWithTransports = Server as unknown as {
      transportsMap: Map<string, StreamableHTTPServerTransport>;
    };
    serverWithTransports.transportsMap.set(sessionId, {
      handleRequest,
    } as unknown as StreamableHTTPServerTransport);

    try {
      const response = await supertest(Server.getInstance().server)
        .get('/mcp')
        .set('Accept', 'text/event-stream')
        .set('mcp-session-id', sessionId)
        .expect(200)
        .expect('Content-Type', /text\/event-stream/);
      expect(response.text).toBe(': ready\n\n');
      expect(handleRequest).toHaveBeenCalledTimes(1);
    } finally {
      serverWithTransports.transportsMap.delete(sessionId);
    }
  });

  describe('sessions the bridge no longer holds', () => {
    test('a new session still starts with initialize', async () => {
      const response = await mcpPost(undefined, initialize).expect(200);
      const sessionId = response.headers['mcp-session-id'];
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(sseMessage(response.text).result.serverInfo.name).toBe('JustBrowseMCP');

      const pong = await mcpPost(sessionId, ping(1)).expect(200);
      expect(sseMessage(pong.text)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    });

    test('a call after the idle timeout resumes the same session instead of failing', async () => {
      process.env[CHROME_MCP_SESSION_IDLE_MS_ENV] = '50';
      try {
        const opened = await mcpPost(undefined, initialize).expect(200);
        const sessionId = opened.headers['mcp-session-id'];
        await mcpPost(sessionId, ping(1)).expect(200);

        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(transportsOf().has(sessionId)).toBe(false);

        // Before the fix: HTTP 400 "Invalid MCP request or session." on every call.
        const response = await mcpPost(sessionId, ping(2)).expect(200);
        expect(response.headers['mcp-session-id']).toBe(sessionId);
        expect(sseMessage(response.text)).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
      } finally {
        delete process.env[CHROME_MCP_SESSION_IDLE_MS_ENV];
      }
    });

    test('a session ID from before a bridge restart is resumed under the same ID', async () => {
      const sessionId = randomUUID();
      const response = await mcpPost(sessionId, ping(1)).expect(200);
      expect(response.headers['mcp-session-id']).toBe(sessionId);
      expect(sseMessage(response.text)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
      expect(transportsOf().has(sessionId)).toBe(true);

      // The resumed session keeps working, and it is the one the next call reaches.
      const again = await mcpPost(sessionId, ping(2)).expect(200);
      expect(sseMessage(again.text).id).toBe(2);
    });

    test('parallel calls on one expired session resume it once', async () => {
      const createServer = jest.spyOn(mcpServerModule, 'createMcpServer');
      try {
        const sessionId = randomUUID();
        const responses = await Promise.all(
          [1, 2, 3].map((id) => mcpPost(sessionId, ping(id)).expect(200)),
        );
        expect(responses.map((response) => sseMessage(response.text).id).sort()).toEqual([1, 2, 3]);
        expect(createServer).toHaveBeenCalledTimes(1);
      } finally {
        createServer.mockRestore();
      }
    });

    test('initialize with a stale session ID starts a new session', async () => {
      const staleId = randomUUID();
      const response = await mcpPost(staleId, initialize).expect(200);
      const sessionId = response.headers['mcp-session-id'];
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(sessionId).not.toBe(staleId);
    });

    test.each([
      ['POST', () => mcpPost('not-a-session', ping(1))],
      [
        'GET',
        () =>
          supertest(Server.getInstance().server)
            .get('/mcp')
            .set('Accept', 'text/event-stream')
            .set('mcp-session-id', 'not-a-session'),
      ],
      [
        'DELETE',
        () =>
          supertest(Server.getInstance().server)
            .delete('/mcp')
            .set('mcp-session-id', 'not-a-session'),
      ],
    ])('%s with a session ID it never issued answers 404 Session not found', async (_, send) => {
      const response = await send().expect(404);
      expect(response.body).toEqual({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      });
    });

    test('a call with no session ID and no initialize is still a bad request', async () => {
      const response = await mcpPost(undefined, ping(1)).expect(400);
      expect(response.body).toEqual({ error: 'Invalid MCP request or session.' });
    });

    test('DELETE for an expired session succeeds, so the client can end it cleanly', async () => {
      await supertest(Server.getInstance().server)
        .delete('/mcp')
        .set('mcp-session-id', randomUUID())
        .expect(200);
    });
  });
});
