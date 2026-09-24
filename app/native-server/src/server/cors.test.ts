import { describe, expect, test } from '@jest/globals';
import { isOriginAllowed } from './cors-origin';
import { SERVER_CONFIG } from '../constant';

describe('isOriginAllowed', () => {
  test('allows the exact configured origin', () => {
    expect(isOriginAllowed('http://127.0.0.1', SERVER_CONFIG.CORS_ORIGIN)).toBe(true);
  });

  test('allows the configured origin on any port', () => {
    expect(isOriginAllowed('http://127.0.0.1:5173', SERVER_CONFIG.CORS_ORIGIN)).toBe(true);
  });

  test('allows a chrome-extension origin', () => {
    expect(
      isOriginAllowed(
        'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        SERVER_CONFIG.CORS_ORIGIN,
      ),
    ).toBe(true);
  });

  // Regression test: SERVER_CONFIG.CORS_ORIGIN's 'http://127.0.0.1' string
  // entry used to be matched with origin.startsWith(pattern), a substring
  // match rather than an origin match. Verified live against the actual
  // @fastify/cors plugin with this exact config: this origin got
  // access-control-allow-origin reflected back with
  // access-control-allow-credentials: true, i.e. any page hosted at a
  // domain an attacker fully controls (they own evil.com and can create
  // any subdomain under it, including this one) could make credentialed
  // cross-origin requests to the native server's full MCP surface.
  test('rejects an attacker-controlled domain that merely starts with the allowed string', () => {
    expect(isOriginAllowed('http://127.0.0.1.evil.com', SERVER_CONFIG.CORS_ORIGIN)).toBe(false);
  });

  test('rejects an attacker-controlled domain with the allowed string as a path segment', () => {
    expect(isOriginAllowed('http://evil.com/http://127.0.0.1', SERVER_CONFIG.CORS_ORIGIN)).toBe(
      false,
    );
  });

  test('rejects a different scheme against the same host', () => {
    expect(isOriginAllowed('https://127.0.0.1', SERVER_CONFIG.CORS_ORIGIN)).toBe(false);
  });

  test('rejects an unrelated origin', () => {
    expect(isOriginAllowed('http://attacker.example', SERVER_CONFIG.CORS_ORIGIN)).toBe(false);
  });

  test('rejects a malformed origin instead of throwing', () => {
    expect(isOriginAllowed('not-a-url', SERVER_CONFIG.CORS_ORIGIN)).toBe(false);
  });

  test.each([
    'null',
    '',
    'http://127.0.0.1@attacker.example',
    'http://attacker.example@127.0.0.1',
    'http://127.0.0.1/private',
    'http://127.0.0.1?redirect=attacker.example',
    'http://127.0.0.1#attacker.example',
    'http://127.0.0.1:5173.attacker.example',
  ])('rejects non-origin URL %s', (origin) => {
    expect(isOriginAllowed(origin, SERVER_CONFIG.CORS_ORIGIN)).toBe(false);
  });

  test('honors an explicitly configured port', () => {
    expect(isOriginAllowed('http://127.0.0.1:5173', ['http://127.0.0.1:5173'])).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:8080', ['http://127.0.0.1:5173'])).toBe(false);
  });

  test('ignores malformed allowlist entries', () => {
    expect(isOriginAllowed('http://127.0.0.1', ['not-a-url'])).toBe(false);
  });
});
