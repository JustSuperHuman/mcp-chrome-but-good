import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as dns from 'dns';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import { Readable } from 'stream';
import fetch from 'node-fetch';

const protectedAddresses = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  protectedAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 32], // Teredo tunnels can embed private IPv4 addresses.
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 tunnels can embed private IPv4 addresses.
  ['3fff::', 20],
] as const)
  protectedAddresses.addSubnet(address, prefix, 'ipv6');
const publicIpv6Addresses = new net.BlockList();
publicIpv6Addresses.addSubnet('2000::', 3, 'ipv6');
publicIpv6Addresses.addSubnet('::ffff:0:0', 96, 'ipv6');

/**
 * File handler for managing file uploads through the native messaging host
 */
export class FileHandler {
  private tempDir: string;

  constructor() {
    // Create a temp directory for file operations
    this.tempDir = path.join(os.tmpdir(), 'chrome-mcp-uploads');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    this.tempDir = fs.realpathSync(this.tempDir);
  }

  /**
   * Handle file preparation request from the extension
   */
  async handleFileRequest(request: any): Promise<any> {
    const { action, fileUrl, base64Data, fileName, filePath, traceFilePath, insightName } = request;

    try {
      switch (action) {
        case 'prepareFile':
          if (fileUrl) {
            return await this.downloadFile(fileUrl, fileName);
          } else if (base64Data) {
            return await this.saveBase64File(base64Data, fileName);
          } else if (filePath) {
            return await this.verifyFile(filePath);
          }
          break;

        case 'readBase64File': {
          if (!filePath) return { success: false, error: 'filePath is required' };
          return await this.readBase64File(filePath);
        }

        case 'cleanupFile':
          return await this.cleanupFile(filePath);

        case 'analyzeTrace': {
          const targetPath = traceFilePath || filePath;
          if (!targetPath) {
            return { success: false, error: 'traceFilePath is required' };
          }
          try {
            // With tsconfig moduleResolution=NodeNext, relative ESM imports need explicit .js extension
            const { analyzeTraceFile } = await import('./trace-analyzer.js');
            const res = await analyzeTraceFile(targetPath, insightName);
            return { success: true, ...res };
          } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
          }
        }

        default:
          return {
            success: false,
            error: `Unknown file action: ${action}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Download a file from URL and save to temp directory
   */
  private async downloadFile(fileUrl: string, fileName?: string): Promise<any> {
    try {
      const finalFileName = this.sanitizeFileName(fileName || this.generateFileName(fileUrl));
      let currentUrl = new URL(fileUrl).toString();
      for (let hop = 0; hop <= FileHandler.MAX_REDIRECTS; hop++) {
        const addresses = await this.validateFileUrl(currentUrl);
        // Pin the socket lookup to the checked addresses. Resolving again inside
        // fetch would allow DNS rebinding between validation and connection.
        const lookup: net.LookupFunction = (_host, options, callback) => {
          const family = Number(options.family);
          const candidates = family
            ? addresses.filter((entry) => entry.family === family)
            : addresses;
          if (!candidates.length) {
            callback(new Error('No validated address for the requested family'), []);
          } else if (options.all) {
            callback(null, candidates);
          } else {
            callback(null, candidates[0].address, candidates[0].family);
          }
        };
        const Agent = new URL(currentUrl).protocol === 'https:' ? https.Agent : http.Agent;
        const agent = new Agent({ lookup });
        try {
          const response = await fetch(currentUrl, { redirect: 'manual', agent, timeout: 30000 });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            (response.body as Readable | null)?.destroy();
            if (hop === FileHandler.MAX_REDIRECTS)
              throw new Error('Too many file download redirects');
            const location = response.headers.get('location');
            if (!location) throw new Error('File download redirect has no Location header');
            currentUrl = new URL(location, currentUrl).toString();
            continue;
          }
          if (!response.ok) {
            (response.body as Readable | null)?.destroy();
            throw new Error(`Failed to download file: ${response.statusText}`);
          }
          const buffer = await response.buffer();
          const filePath = this.writeTempFile(buffer, finalFileName);
          return { success: true, filePath, fileName: finalFileName, size: buffer.length };
        } finally {
          agent.destroy();
        }
      }
    } catch (error) {
      throw new Error(`Failed to download file from URL: ${error}`);
    }
  }

  private static readonly ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

  private static readonly MAX_REDIRECTS = 5;

  /**
   * SSRF guard for LLM-supplied file_url (see issue #380):
   * allow only http/https, resolve every hostname (A/AAAA) to a public
   * unicast address, and reject loopback / link-local / private / metadata
   * targets. Applied to the initial URL and re-applied to every redirect hop.
   */
  private async validateFileUrl(rawUrl: string): Promise<dns.LookupAddress[]> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid URL: ${rawUrl}`);
    }

    if (!FileHandler.ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(
        `Unsupported protocol '${parsed.protocol}' in fileUrl (allowed: http, https): ${rawUrl}`,
      );
    }
    if (parsed.username || parsed.password)
      throw new Error('Credentials are not allowed in fileUrl');

    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid port in fileUrl: ${rawUrl}`);
    }

    const host =
      parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;

    // Percent-encoded hostnames are ambiguous (a %32%37%.%30%2e%31 label can
    // bypass textual checks while resolving differently) - keep it simple.
    if (host.includes('%')) {
      throw new Error(`Unsupported percent-encoded host in fileUrl: ${rawUrl}`);
    }

    const addresses = await this.resolveHostAddresses(host);

    for (const { address, family } of addresses) {
      if (this.isProtectedAddress(address, family)) {
        throw new Error(
          `Non-public address '${address}' for host '${host}' in fileUrl (SSRF guard rejects ` +
            `loopback/link-local/private ranges; see issue #380): ${rawUrl}`,
        );
      }
    }
    return addresses;
  }

  private async resolveHostAddresses(host: string): Promise<dns.LookupAddress[]> {
    if (net.isIP(host)) {
      return [{ address: host, family: net.isIP(host) }];
    }

    const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    if (addresses.length) return addresses;
    throw new Error(`Unable to resolve host in fileUrl: ${host}`);
  }

  /**
   * True when the address is NOT publicly routable (see issue #380):
   * IPv6 loopback/unspecified/multicast/ULA/link-local/documentation and
   * IPv4 loopback/link-local (cloud metadata)/private/CGNAT/reserved/
   * broadcast/this-host, plus IPv4 embedded in those v6 forms.
   */
  private isProtectedAddress(address: string, family: number): boolean {
    if ((family !== 4 && family !== 6) || net.isIP(address) !== family) return true;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    // BlockList also applies IPv4 rules to IPv4-mapped IPv6 addresses.
    return (
      protectedAddresses.check(address, type) ||
      (family === 6 && !publicIpv6Addresses.check(address, type))
    );
  }

  /**
   * Restrict caller-provided file names to a single path segment inside the
   * temp dir (see issue #380): absolute paths and ../ walks must not escape
   * via path.join(tempDir, fileName).
   */
  private sanitizeFileName(fileName: string): string {
    const name = path.posix.basename(fileName.replace(/\\/g, '/'));
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      /[<>:"|?*]|[. ]$/.test(name) ||
      [...name].some((character) => character.charCodeAt(0) < 32) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ) {
      throw new Error('Invalid upload file name');
    }
    return name;
  }

  private writeTempFile(buffer: Buffer, fileName: string): string {
    const filePath = this.sanitizeFilePath(
      path.join(this.tempDir, `${crypto.randomBytes(8).toString('hex')}-${fileName}`),
    );
    fs.writeFileSync(filePath, buffer, { flag: 'wx' });
    return filePath;
  }

  /**
   * Save base64 data as a file
   */
  private async saveBase64File(base64Data: string, fileName?: string): Promise<any> {
    try {
      // Remove data URL prefix if present
      const base64Content = base64Data.replace(/^data:.*?;base64,/, '');

      // Convert base64 to buffer
      const buffer = Buffer.from(base64Content, 'base64');

      // Generate filename if not provided
      const finalFileName = this.sanitizeFileName(fileName || `upload-${Date.now()}.bin`);
      const filePath = this.writeTempFile(buffer, finalFileName);

      return {
        success: true,
        filePath: filePath,
        fileName: finalFileName,
        size: buffer.length,
      };
    } catch (error) {
      throw new Error(`Failed to save base64 file: ${error}`);
    }
  }

  /**
   * Verify that a file exists and is accessible
   */
  private async verifyFile(filePath: string): Promise<any> {
    try {
      // Only allow verification of files in our temp directory (same policy
      // as cleanupFile - tool-argument paths must not reach arbitrary files)
      filePath = this.sanitizeFilePath(filePath);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      // Get file stats
      const stats = fs.statSync(filePath);

      // Check if it's actually a file
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }

      // Check if file is readable
      fs.accessSync(filePath, fs.constants.R_OK);

      return {
        success: true,
        filePath: filePath,
        fileName: path.basename(filePath),
        size: stats.size,
      };
    } catch (error) {
      throw new Error(`Failed to verify file: ${error}`);
    }
  }

  /**
   * Read file content and return as base64 string
   */
  private async readBase64File(filePath: string): Promise<any> {
    try {
      /**
       * Arbitrary-read guard (see issue #380): only files inside our temp dir
       * may be read. cleanupFile enforces this; readBase64File did not.
       */
      filePath = this.sanitizeFilePath(filePath);
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }
      const buf = fs.readFileSync(filePath);
      const base64 = buf.toString('base64');
      return {
        success: true,
        filePath,
        fileName: path.basename(filePath),
        size: stats.size,
        base64Data: base64,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Lexically-normalizing containment check for tool-supplied paths.
   * Superset of the legacy startsWith(tempDir) check: a path that only
   * *lexically* starts with tempDir (e.g. "..ar/tmp/x" when tempDir is
   * "/tmp/x/chrome-mcp-uploads") must not pass. Resolves .. segments and
   * checks segment-wise against the real temp dir.
   */
  private isInsideTempDir(candidate: string): boolean {
    const inside = (value: string) => {
      const relative = path.relative(this.tempDir, value);
      return (
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    };
    try {
      if (typeof candidate !== 'string' || !candidate) return false;
      const resolved = path.resolve(this.tempDir, candidate);
      if (!inside(resolved)) return false;
      const real = fs.existsSync(resolved)
        ? fs.realpathSync(resolved)
        : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
      return inside(real);
    } catch {
      return false;
    }
  }

  /**
   * Escape-proof a path the caller already scoped to tempDir: .. segments
   * (from '../../x'-style names) are resolved against tempDir, then the
   * result is re-checked so the resolved location is guaranteed inside.
   */
  private sanitizeFilePath(candidate: string): string {
    const resolved = path.resolve(this.tempDir, candidate);
    if (!this.isInsideTempDir(resolved)) {
      throw new Error(`Resolved path escapes temp directory: ${candidate}`);
    }
    return resolved;
  }

  /**
   * Clean up a temporary file
   */
  private async cleanupFile(filePath: string): Promise<any> {
    try {
      // Only allow cleanup of files in our temp directory
      filePath = this.sanitizeFilePath(filePath);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      return {
        success: true,
        message: 'File cleaned up successfully',
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to cleanup file: ${error}`,
      };
    }
  }

  /**
   * Generate a filename from URL or create a unique one
   */
  private generateFileName(url?: string): string {
    if (url) {
      try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const basename = path.basename(pathname);
        if (basename && basename !== '/') {
          // Add random suffix to avoid collisions
          const ext = path.extname(basename);
          const name = path.basename(basename, ext);
          const randomSuffix = crypto.randomBytes(4).toString('hex');
          return `${name}-${randomSuffix}${ext}`;
        }
      } catch {
        // Invalid URL, fall through to generate random name
      }
    }

    // Generate random filename
    return `upload-${crypto.randomBytes(8).toString('hex')}.bin`;
  }

  /**
   * Clean up old temporary files (older than 1 hour)
   */
  cleanupOldFiles(): void {
    try {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > oneHour) {
          fs.unlinkSync(filePath);
          // Use stderr to avoid polluting stdout (Native Messaging protocol)
          console.error(`Cleaned up old temp file: ${file}`);
        }
      }
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }
}

export default new FileHandler();
