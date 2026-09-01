import { describe, expect, test, jest } from '@jest/globals';

jest.mock('../native-messaging-host', () => ({
  __esModule: true,
  default: {
    sendRequestToExtensionAndWait: () => Promise.resolve({ status: 'success', items: [] }),
    sendMessage: () => {},
  },
}));

import { createMcpServer } from './mcp-server';

describe('createMcpServer', () => {
  test('returns a distinct protocol server for every connection', () => {
    const first = createMcpServer({ sessionId: 'first', transport: 'streamable-http' });
    const second = createMcpServer({ sessionId: 'second', transport: 'streamable-http' });
    expect(first).not.toBe(second);
  });

  test('keeps simultaneous transports independent', async () => {
    const first = createMcpServer({ sessionId: 'first', transport: 'streamable-http' });
    const second = createMcpServer({ sessionId: 'second', transport: 'streamable-http' });
    const makeTransport = () => ({
      start: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
      send: jest.fn(async () => {}),
      onmessage: undefined as ((message: unknown) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
    });
    const firstTransport = makeTransport();
    const secondTransport = makeTransport();

    await first.connect(firstTransport as any);
    await second.connect(secondTransport as any);
    firstTransport.onmessage?.({ jsonrpc: '2.0', id: 'request-1', method: 'tools/list' });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(firstTransport.send).toHaveBeenCalled();
    expect(secondTransport.send).not.toHaveBeenCalled();
    await Promise.all([first.close(), second.close()]);
  });
});
