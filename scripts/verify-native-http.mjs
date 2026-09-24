// Exercise the compiled bridge over real HTTP without touching the installed browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import serverModule from '../app/native-server/dist/server/index.js';
import { Client } from '../app/native-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../app/native-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { SSEClientTransport } from '../app/native-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/sse.js';

const { Server } = serverModule;
const server = new Server();
let extensionRequests = 0;
const releasedSessions = [];
const nativeHost = {
  async sendRequestToExtensionAndWait(payload) {
    extensionRequests++;
    if (payload.name === '__justbrowse_release_session') {
      releasedSessions.push(payload.args.__justBrowse);
    }
    return { pong: true };
  },
};
const connections = [];
const version = JSON.parse(
  await readFile(new URL('../app/native-server/package.json', import.meta.url), 'utf8'),
).version;

try {
  await server.start(0, nativeHost);
  const { port } = server.getInstance().server.address();
  const base = `http://127.0.0.1:${port}`;
  const request = (path, options = {}) =>
    fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(5000) });

  for (const origin of ['http://127.0.0.1.attacker.example', 'https://attacker.example', 'null']) {
    for (const [path, method] of [
      ['/ping', 'GET'],
      ['/ask-extension', 'GET'],
      ['/sse', 'GET'],
      ['/mcp', 'POST'],
      ['/mcp', 'GET'],
      ['/mcp', 'DELETE'],
      ['/mcp', 'OPTIONS'],
    ]) {
      const response = await request(path, { method, headers: { origin } });
      assert.equal(response.status, 403, `${method} ${path} accepted ${origin}`);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.deepEqual(await response.json(), { error: 'Origin not allowed' });
    }
  }
  assert.equal(extensionRequests, 0, 'Rejected requests reached the native bridge');

  const allowedOrigins = [
    'http://127.0.0.1:5173',
    'chrome-extension://pafdmkonlckfdodnpmdbpjmnjnjglihe',
  ];
  for (const origin of allowedOrigins) {
    const response = await request('/ping', { headers: { origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    await response.json();
    const preflight = await request('/mcp', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  }

  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: `release-check-${index}`, version: '1.0.0' });
    const origin = index === 1 ? allowedOrigins[1] : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: origin ? { headers: { origin } } : undefined,
      fetch: async (url, options) => {
        const response = await fetch(url, options);
        if (origin) {
          assert.equal(response.headers.get('access-control-allow-origin'), origin);
          assert.ok(
            response.headers.get('access-control-expose-headers').includes('mcp-session-id'),
          );
        }
        return response;
      },
    });
    connections.push({ client, transport });
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, version);
  }
  assert.notEqual(connections[0].transport.sessionId, connections[1].transport.sessionId);
  await Promise.all(connections.map(({ client }) => client.ping()));
  const invalidDelete = await request('/mcp', {
    method: 'DELETE',
    headers: {
      'mcp-session-id': connections[1].transport.sessionId,
      'mcp-protocol-version': 'invalid-version',
    },
  });
  assert.equal(invalidDelete.status, 400);
  await invalidDelete.json();
  await connections[1].client.ping();
  await connections[0].transport.terminateSession();
  await connections[0].client.close();
  await connections[1].client.ping();

  const sseClient = new Client({ name: 'legacy-sse-release-check', version: '1.0.0' });
  const origin = allowedOrigins[1];
  const corsFetch = async (url, options) => {
    const headers = new Headers(options?.headers);
    headers.set('origin', origin);
    const response = await fetch(url, { ...options, headers });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    return response;
  };
  const sseTransport = new SSEClientTransport(new URL(`${base}/sse`), {
    fetch: corsFetch,
    eventSourceInit: { fetch: corsFetch },
  });
  connections.push({ client: sseClient, transport: sseTransport });
  await sseClient.connect(sseTransport);
  await sseClient.ping();
  await server.stop();
  assert.equal(
    releasedSessions.filter((session) => session.transport === 'streamable-http').length,
    2,
  );
  assert.equal(releasedSessions.filter((session) => session.transport === 'sse').length, 1);
  assert.equal(new Set(releasedSessions.map((session) => session.sessionId)).size, 3);
} finally {
  for (const { client, transport } of connections) {
    if (server.isRunning && transport.terminateSession) {
      await transport.terminateSession().catch(() => {});
    }
    await client.close().catch(() => {});
  }
  await server.stop();
}
console.log(
  JSON.stringify(
    {
      ok: true,
      bridgeVersion: version,
      rejectedRequests: 21,
      simultaneousSessions: 2,
      survivingSessionAfterPeerDisconnect: true,
      invalidDeletePreservesSession: true,
      browserClientCors: true,
      legacySse: true,
      shutdownReleasedSessions: releasedSessions.length,
      browserUsed: false,
    },
    null,
    2,
  ),
);
