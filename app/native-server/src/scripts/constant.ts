export const COMMAND_NAME = 'mcp-chrome-bridge';
// The released JustBrowse extension: its manifest key gives it this ID wherever it is unpacked.
export const EXTENSION_ID = 'dgpjcgoidnfedcpaijeelljbppcfhcll';
// Also authorized: a development build loaded from F:\ChromeMCP\JustBrowseMCP (a path-derived ID) and the
// upstream mcp-chrome releases.
export const ALLOWED_EXTENSION_IDS = [
  EXTENSION_ID,
  'pafdmkonlckfdodnpmdbpjmnjnjglihe',
  'dlniejmnclnmndphlmnhbgeehfpoaeme',
  'beiplkpghdbfabdgkadklimbjojmklff',
  'hbdgbgagpkpjffpklnamcljpakneikee',
] as const;
export const HOST_NAME = 'com.chromemcp.nativehost';
export const DESCRIPTION = 'JustBrowseMCP native browser bridge';
