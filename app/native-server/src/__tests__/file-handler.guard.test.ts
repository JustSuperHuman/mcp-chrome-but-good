import { describe, expect, test, afterAll, afterEach, beforeAll, jest } from '@jest/globals';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as dns from 'dns';
import * as https from 'https';
import fetch, { Response } from 'node-fetch';
import { FileHandler } from '../file-handler';

jest.mock('node-fetch', () => ({
  ...jest.requireActual<typeof import('node-fetch')>('node-fetch'),
  __esModule: true,
  default: jest.fn(),
}));
type FetchCall = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
const mockFetch = jest.mocked<FetchCall>(fetch);
/**
 * Regression tests for the file-upload SSRF / path-traversal / arbitrary-read
 * fixes (hangwin/mcp-chrome#380).
 *
 * FileHandler's guards are private, so tests reach them via casts; behavior is
 * exercised end-to-end through handleFileRequest wherever possible.
 */
const anyHandler = (h: FileHandler) => h as any;

// Constructor only mkdirs the shared temp dir - safe at collection time, and
// describe-level assertions below read its fields before beforeAll runs.
const handler = new FileHandler();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'justbrowse-upload-tests-'));
anyHandler(handler).tempDir = fs.realpathSync(fixture);
afterEach(() => {
  jest.restoreAllMocks();
  mockFetch.mockReset();
});
afterAll(() => {
  expect(path.dirname(fixture)).toBe(os.tmpdir());
  expect(path.basename(fixture)).toMatch(/^justbrowse-upload-tests-/);
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe('file handling guards (issue #380)', () => {
  describe('validateFileUrl - scheme allow-list', () => {
    test.each([
      ['http://8.8.8.8/x', true],
      ['https://8.8.8.8/x', true],
      ['ftp://example.com/x', false],
      ['file:///etc/passwd', false],
      ['gopher://example.com/x', false],
      ['not a url', false],
    ])('%s -> %s', async (url, ok) => {
      const p = anyHandler(handler)
        .validateFileUrl(url)
        .then(
          () => true,
          () => false,
        );
      await expect(p).resolves.toBe(ok);
    });
  });

  describe('validateFileUrl - protected ranges rejected (SSRF guard)', () => {
    test.each([
      ['http://127.0.0.1:1/x', 'loopback v4'],
      ['http://169.254.169.254/x', 'cloud metadata'],
      ['http://10.0.0.7/x', 'private 10/8'],
      ['http://172.16.0.3/x', 'private 172.16/12'],
      ['http://192.168.1.4/x', 'private 192.168/16'],
      ['http://100.64.0.1/x', 'CGNAT'],
      ['http://0.0.0.3/x', 'this-host'],
      ['http://224.0.0.4/x', 'multicast'],
      ['http://240.0.0.1/x', 'reserved'],
      ['http://[::1]/x', 'loopback v6'],
      ['http://[fe80::1]/x', 'link-local v6'],
      ['http://[fd00::1]/x', 'ULA v6'],
      ['http://[ff02::1]/x', 'multicast v6'],
      ['http://[::ffff:127.0.0.1]/x', 'mapped loopback'],
    ])('%s (%s)', async (url) => {
      await expect(anyHandler(handler).validateFileUrl(url)).rejects.toThrow(/Non-public|Invalid/);
    });
  });

  describe('validateFileUrl - public literal addresses accepted', () => {
    test.each([
      'http://93.184.216.34/x',
      'http://8.8.8.8:8080/x',
      'http://172.32.0.9/x', // just outside 172.16/12
      'http://100.128.0.1/x', // just outside CGNAT /10
      'http://[2606:4700:4700::1111]/x',
    ])('%s', async (url) => {
      await expect(anyHandler(handler).validateFileUrl(url)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ address: expect.any(String) })]),
      );
    });
  });

  describe('isProtectedAddress predicate matrix', () => {
    const cases: Array<[string, number, boolean]> = [
      // family 4
      ['93.184.216.34', 4, false],
      ['8.8.8.8', 4, false],
      ['127.0.0.1', 4, true],
      ['169.254.169.254', 4, true],
      ['10.1.2.3', 4, true],
      ['172.16.0.9', 4, true],
      ['172.31.255.255', 4, true],
      ['172.32.0.9', 4, false],
      ['192.168.1.1', 4, true],
      ['100.64.0.1', 4, true],
      ['100.127.255.255', 4, true],
      ['100.128.0.1', 4, false],
      ['0.0.0.0', 4, true],
      ['239.1.2.3', 4, true],
      ['240.0.0.1', 4, true],
      ['255.255.255.255', 4, true],
      // family 6
      ['::1', 6, true],
      ['::', 6, true],
      ['fe80::1', 6, true],
      ['febf::1', 6, true],
      ['fec0::1', 6, true],
      ['fd00::1', 6, true],
      ['fdff::1', 6, true],
      ['fcff::1', 6, true],
      ['ff02::1', 6, true],
      ['ffff::1', 6, true],
      ['2001:db8::1', 6, true],
      ['2001:4860:4860::8888', 6, false],
      ['::ffff:127.0.0.1', 6, true],
      ['::ffff:169.254.169.254', 6, true],
      ['::ffff:8.8.8.8', 6, false],
      ['::ffff:127.0.0.0', 6, true],
      ['::ffff:7f00:0', 6, true],
      ['::127.0.0.1', 6, true],
      ['64:ff9b::7f00:1', 6, true],
      ['2002:7f00:1::', 6, true], // 6to4 embedding 127.0.0.1
      ['2002:80c:f802::', 6, true], // Reject deprecated tunnel ranges entirely.
      ['2001:0:0:0:0:0:7f00:1', 6, true], // Teredo embedding 127.0.0.1
      ['2001:0:808:402:0:0:0:0', 6, true], // Teredo embedding 0.0.0.0 (unspecified->protected)
      ['192.0.2.1', 4, true],
      ['198.18.0.1', 4, true],
      ['203.0.113.1', 4, true],
      ['not-an-address', 4, true],
    ];

    test.each(cases)('%s (family %i) protected=%s', (address, family, expected) => {
      expect(anyHandler(handler).isProtectedAddress(address, family)).toBe(expected);
    });
  });

  describe('sanitizeFileName - traversal containment', () => {
    test.each([
      ['../../../escape.txt', 'escape.txt'],
      ['/var/tmp/absolute.png', 'absolute.png'],
      ['..\\..\\windows.png', 'windows.png'],
      ['ok.png', 'ok.png'],
      ['.hidden', '.hidden'],
    ])('%p -> %p', (input, expected) => {
      expect(anyHandler(handler).sanitizeFileName(input)).toBe(expected);
    });
  });

  test.each([
    '.',
    '..',
    '/',
    'file:stream',
    'NUL',
    'con.txt',
    'trailing.',
    'trailing ',
    'bad\u0000name',
  ])('rejects unsafe file name %p without writing a file', async (fileName) => {
    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: 'eA==',
      fileName,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid upload file name/);
  });

  describe('DNS validation and redirect downloads', () => {
    const publicAddress = { address: '93.184.216.34', family: 4 };

    test('rejects mixed public IPv6 and private IPv4 DNS answers before fetch', async () => {
      const lookup = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ] as any);
      const result = await handler.handleFileRequest({
        action: 'prepareFile',
        fileUrl: 'https://files.example/a',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Non-public address/);
      expect(lookup).toHaveBeenCalledWith('files.example', { all: true, verbatim: true });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test.each(['http:', 'https:'])(
      'pins the %s socket to the validated DNS answer',
      async (protocol) => {
        const lookup = jest
          .spyOn(dns.promises, 'lookup')
          .mockResolvedValueOnce([publicAddress] as any)
          .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
        mockFetch.mockImplementationOnce(async (_url, options) => {
          const agent = options!.agent as http.Agent;
          expect(agent).toBeInstanceOf(protocol === 'https:' ? https.Agent : http.Agent);
          const pinnedLookup = (agent as http.Agent & { options: http.AgentOptions }).options
            .lookup!;
          const allCallback = jest.fn();
          pinnedLookup('files.example', { all: true }, allCallback);
          expect(allCallback).toHaveBeenCalledWith(null, [publicAddress]);
          const singleCallback = jest.fn();
          pinnedLookup('files.example', { family: 4 }, singleCallback);
          expect(singleCallback).toHaveBeenCalledWith(null, publicAddress.address, 4);
          return new Response('downloaded file');
        });
        const result = await handler.handleFileRequest({
          action: 'prepareFile',
          fileUrl: `${protocol}//files.example/file.bin`,
        });
        expect(result.success).toBe(true);
        expect(fs.readFileSync(result.filePath, 'utf8')).toBe('downloaded file');
        expect(lookup).toHaveBeenCalledTimes(1);
      },
    );

    test.each([
      'http://127.0.0.1/internal',
      'http://[::ffff:127.0.0.1]/internal',
      'file:///etc/hosts',
    ])('rejects a public download redirect to %s', async (target) => {
      jest.spyOn(dns.promises, 'lookup').mockResolvedValue([publicAddress] as any);
      mockFetch.mockResolvedValueOnce(
        new Response(undefined, { status: 302, headers: { location: target } }),
      );
      const result = await handler.handleFileRequest({
        action: 'prepareFile',
        fileUrl: 'https://files.example/a',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Non-public|Unsupported protocol/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('follows a relative public redirect and saves the result', async () => {
      jest.spyOn(dns.promises, 'lookup').mockResolvedValue([publicAddress] as any);
      mockFetch
        .mockResolvedValueOnce(
          new Response(undefined, { status: 302, headers: { location: '/final' } }),
        )
        .mockResolvedValueOnce(new Response('redirected file'));
      const result = await handler.handleFileRequest({
        action: 'prepareFile',
        fileUrl: 'https://files.example/start',
      });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(result.filePath, 'utf8')).toBe('redirected file');
      expect(mockFetch.mock.calls[1][0]).toBe('https://files.example/final');
    });

    test('rejects redirect loops after five hops', async () => {
      jest.spyOn(dns.promises, 'lookup').mockResolvedValue([publicAddress] as any);
      mockFetch.mockImplementation(
        async () => new Response(undefined, { status: 302, headers: { location: '/again' } }),
      );
      const result = await handler.handleFileRequest({
        action: 'prepareFile',
        fileUrl: 'https://files.example/start',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Too many.*redirects/);
      expect(mockFetch).toHaveBeenCalledTimes(6);
    });

    test('rejects credentials embedded in a URL before fetch', async () => {
      const result = await handler.handleFileRequest({
        action: 'prepareFile',
        fileUrl: 'https://user:secret@8.8.8.8/file',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Credentials/);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('isInsideTempDir - lexical trap and escapes', () => {
    const tempDir = anyHandler(handler).tempDir as string;

    test('accepts paths inside the temp dir', () => {
      expect(anyHandler(handler).isInsideTempDir(path.join(tempDir, 'a.bin'))).toBe(true);
      expect(anyHandler(handler).isInsideTempDir('a.bin')).toBe(true);
    });

    test('rejects the string-prefix trap the legacy startsWith check misses', () => {
      const siblingPrefix = `${tempDir}-evil/x.bin`; // startsWith(tempDir) is true, but it is another dir
      expect(siblingPrefix.startsWith(`${tempDir}`)).toBe(true); // legacy check passes...
      expect(anyHandler(handler).isInsideTempDir(siblingPrefix)).toBe(false); // ...resolved check is stricter
    });

    test('rejects sibling and parent escapes', () => {
      const sibling = path.join(path.dirname(tempDir), 'elsewhere.bin');
      expect(anyHandler(handler).isInsideTempDir(sibling)).toBe(false);
      expect(anyHandler(handler).isInsideTempDir('../outside.bin')).toBe(false);
    });
  });

  describe('handleFileRequest end-to-end (loopback HTTP origin)', () => {
    let server: http.Server;
    let port = 0;
    const ORIGIN = 'origin-body-380';
    const FINAL = 'final-body-380';

    beforeAll(async () => {
      // hop-1 origin: redirects to hop-2 on a different port; hop-2 serves bytes
      const hop2 = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(FINAL);
      });
      await new Promise<void>((r) => hop2.listen(0, '127.0.0.1', () => r()));
      const hop2Port = (hop2.address() as { port: number }).port;

      server = http.createServer((req, res) => {
        if (req.url === '/finalDirect') {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(ORIGIN);
          return;
        }
        if (req.url === '/chain') {
          res.writeHead(302, { Location: `http://127.0.0.1:${hop2Port}/final` });
          res.end();
          return;
        }
        if (req.url === '/loop') {
          res.writeHead(302, { Location: 'http://127.0.0.1:1/never' });
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      port = (server.address() as { port: number }).port;
      (globalThis as any).__hop2 = hop2;
    }, 15000);

    afterAll(async () => {
      (globalThis as any).__hop2?.close();
      await new Promise<void>((r) => server.close(() => r()));
    });

    test('rejects a direct loopback download before fetch', async () => {
      const res = await handler.handleFileRequest({
        action: 'prepareFile',
        fileUrl: `http://127.0.0.1:${port}/finalDirect`,
        fileName: 'direct.bin',
      });
      // loopback origins are REJECTED by the SSRF guard post-fix; expect the
      // documented policy error, shaped { success:false, error }
      expect(res.success).toBe(false);
      expect(String(res.error)).toMatch(/Non-public address/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('readBase64File: outside-temp rejected, inside-temp round-trips', async () => {
      const outside = await handler.handleFileRequest({
        action: 'readBase64File',
        filePath: '/etc/hostname',
      });
      expect(outside.success).toBe(false);

      const probe = path.join(anyHandler(handler).tempDir, 'roundtrip.bin');
      fs.writeFileSync(probe, Buffer.from('payload-380'));
      const inside = await handler.handleFileRequest({ action: 'readBase64File', filePath: probe });
      expect(inside.success).toBe(true);
      expect((inside as any).base64Data).toBe(Buffer.from('payload-380').toString('base64'));
      fs.unlinkSync(probe);
    });

    test('verifyFile: outside-temp rejected', async () => {
      const res = await handler.handleFileRequest({
        action: 'prepareFile',
        filePath: '/etc/hosts',
      });
      expect(res.success).toBe(false);
      expect(String(res.error)).toMatch(/temp directory/i);
    });

    test('cleanupFile still works for its own temp files', async () => {
      const probe = path.join(anyHandler(handler).tempDir, 'cleanupme.bin');
      fs.writeFileSync(probe, 'x');
      const res = await handler.handleFileRequest({ action: 'cleanupFile', filePath: probe });
      expect(res.success).toBe(true);
      expect(fs.existsSync(probe)).toBe(false);
    });

    test('unknown action reported', async () => {
      const res = await handler.handleFileRequest({ action: 'nope' } as any);
      expect(res.success).toBe(false);
      expect(String(res.error)).toMatch(/Unknown file action/);
    });

    test('normalizes traversal names and keeps repeated uploads separate', async () => {
      const request = {
        action: 'prepareFile',
        base64Data: Buffer.from('first').toString('base64'),
        fileName: '../../same.bin',
      };
      const first = await handler.handleFileRequest(request);
      const second = await handler.handleFileRequest({
        ...request,
        base64Data: Buffer.from('second').toString('base64'),
      });
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(first.fileName).toBe('same.bin');
      expect(second.filePath).not.toBe(first.filePath);
      expect(path.dirname(first.filePath)).toBe(fs.realpathSync(fixture));
      expect(fs.readFileSync(first.filePath, 'utf8')).toBe('first');
      expect(fs.readFileSync(second.filePath, 'utf8')).toBe('second');
    });

    test('relative temp paths read and clean up the same file', async () => {
      const saved = await handler.handleFileRequest({
        action: 'prepareFile',
        base64Data: 'eA==',
        fileName: 'relative.bin',
      });
      const relative = path.basename(saved.filePath);
      const read = await handler.handleFileRequest({
        action: 'readBase64File',
        filePath: relative,
      });
      expect(read.success).toBe(true);
      expect(read.base64Data).toBe('eA==');
      const removed = await handler.handleFileRequest({
        action: 'cleanupFile',
        filePath: relative,
      });
      expect(removed.success).toBe(true);
      expect(fs.existsSync(saved.filePath)).toBe(false);
    });

    test('rejects reading, verifying or deleting through an escaping directory link', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'justbrowse-outside-tests-'));
      const secret = path.join(outside, 'probe.bin');
      const link = path.join(fixture, 'outside-link');
      try {
        fs.writeFileSync(secret, 'keep this file');
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        for (const action of ['readBase64File', 'prepareFile', 'cleanupFile']) {
          const result = await handler.handleFileRequest({
            action,
            filePath: path.join(link, 'probe.bin'),
          });
          expect(result.success).toBe(false);
        }
        expect(fs.readFileSync(secret, 'utf8')).toBe('keep this file');
      } finally {
        if (fs.existsSync(link)) fs.unlinkSync(link);
        expect(path.dirname(outside)).toBe(os.tmpdir());
        expect(path.basename(outside)).toMatch(/^justbrowse-outside-tests-/);
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});
