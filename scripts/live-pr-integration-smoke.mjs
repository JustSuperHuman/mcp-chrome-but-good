import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '../app/native-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../app/native-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const endpoint = new URL(process.env.JUSTBROWSE_MCP_URL || 'http://127.0.0.1:12306/mcp');
const outputDirectory = resolve(
  process.env.JUSTBROWSE_SCREENSHOT_OUTPUT || 'live-test-output/pr-integration-smoke',
);
const client = new Client({ name: 'justbrowse-pr-integration-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(endpoint);

function textPayload(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('Tool response did not contain JSON metadata');
  return JSON.parse(text);
}

async function ownedTab(tabId) {
  const result = await client.callTool({ name: 'get_windows_and_tabs', arguments: {} });
  if (result.isError) throw new Error('get_windows_and_tabs failed');
  return textPayload(result)
    .windows?.flatMap((window) => window.tabs || [])
    .find((tab) => tab.tabId === tabId);
}

await mkdir(outputDirectory, { recursive: true });
let tabId;
let originalWindowId;

try {
  console.log('step: connect');
  await client.connect(transport);
  console.log('step: list tools');
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const name of ['chrome_move_tab', 'chrome_network_request', 'chrome_screenshot']) {
    if (!names.has(name)) throw new Error(`Required MCP tool is missing: ${name}`);
  }

  console.log('step: navigate');
  const navigation = await client.callTool({
    name: 'chrome_navigate',
    arguments: { url: 'https://example.com/' },
  });
  if (navigation.isError) throw new Error('Navigation failed');
  tabId = textPayload(navigation).tabId;
  console.log('step: inspect initial tab');
  const initial = await ownedTab(tabId);
  if (!initial || initial.chromeActive !== false) throw new Error('Owned tab was visibly active');
  originalWindowId = initial.windowId;

  console.log('step: targeted network request');
  const request = await client.callTool({
    name: 'chrome_network_request',
    arguments: { url: 'https://httpbin.org/get', tabId, background: true },
  });
  if (request.isError) {
    throw new Error(`Targeted network request failed: ${JSON.stringify(request.content)}`);
  }
  const requestMetadata = textPayload(request);

  console.log('step: detach tab');
  const detached = await client.callTool({
    name: 'chrome_move_tab',
    arguments: { tabId, newWindow: true, focused: false },
  });
  if (detached.isError) throw new Error(`Detach failed: ${JSON.stringify(detached.content)}`);
  const detachedMetadata = textPayload(detached);
  if (detachedMetadata.windowId === originalWindowId) throw new Error('Tab was not moved');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));

  console.log('step: screenshot detached tab');
  const capture = await client.callTool({
    name: 'chrome_screenshot',
    arguments: { tabId, background: true },
  });
  if (capture.isError)
    throw new Error(`Post-move screenshot failed: ${JSON.stringify(capture.content)}`);
  const image = capture.content?.find((item) => item.type === 'image');
  if (!image?.data || image.mimeType !== 'image/png') throw new Error('Post-move PNG is missing');
  const screenshotPath = resolve(outputDirectory, 'after-move.png');
  await writeFile(screenshotPath, Buffer.from(image.data, 'base64'));

  console.log('step: restore tab');
  const restored = await client.callTool({
    name: 'chrome_move_tab',
    arguments: { tabId, windowId: originalWindowId, index: -1, focused: false },
  });
  if (restored.isError) throw new Error(`Restore failed: ${JSON.stringify(restored.content)}`);
  console.log('step: inspect restored tab');
  const finalTab = await ownedTab(tabId);
  if (!finalTab || finalTab.windowId !== originalWindowId || finalTab.chromeActive !== false) {
    throw new Error('Restored tab did not return inactive to its original window');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        listedToolCount: listed.tools.length,
        tabId,
        originalWindowId,
        detachedWindowId: detachedMetadata.windowId,
        requestStatus: requestMetadata.response?.status,
        requestSuccess: requestMetadata.success,
        screenshotPath,
        chromeActiveAfterRestore: finalTab.chromeActive,
      },
      null,
      2,
    ),
  );
} finally {
  if (Number.isInteger(tabId)) {
    await client
      .callTool({ name: 'chrome_close_tabs', arguments: { tabIds: [tabId] } })
      .catch(() => {});
  }
  await client.close().catch(() => {});
}
