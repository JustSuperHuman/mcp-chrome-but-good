import { describe, expect, test, afterAll, beforeAll, jest } from '@jest/globals';
import supertest from 'supertest';
import type { ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

jest.mock('../agent/engines/codex', () => ({ CodexEngine: jest.fn() }));
jest.mock('../agent/engines/claude', () => ({ ClaudeEngine: jest.fn() }));
jest.mock('../agent/db', () => ({ closeDb: jest.fn() }));

import Server from './index';

describe('服务器测试', () => {
  // 启动服务器测试实例
  beforeAll(async () => {
    await Server.getInstance().ready();
  });

  // 关闭服务器
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
});
