import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '../app/native-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../app/native-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const endpoint = new URL(process.env.JUSTBROWSE_MCP_URL || 'http://127.0.0.1:12306/mcp');
const testUrl = process.env.JUSTBROWSE_TEST_URL || 'https://example.com/';
const outputDirectory = resolve(
  process.env.JUSTBROWSE_SCREENSHOT_OUTPUT || 'live-test-output/screenshots',
);

function textPayload(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('Tool response did not contain JSON metadata');
  return JSON.parse(text);
}

function imagePayload(result, label) {
  if (result.isError) {
    throw new Error(`${label} failed: ${result.content?.map((item) => item.text || '').join(' ')}`);
  }
  const image = result.content?.find((item) => item.type === 'image');
  if (!image?.data || !image.mimeType?.startsWith('image/')) {
    throw new Error(`${label} did not return an MCP image content block`);
  }
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length < 100) throw new Error(`${label} returned an implausibly small image`);
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpeg) throw new Error(`${label} returned invalid PNG/JPEG bytes`);
  return { image, bytes, extension: isPng ? 'png' : 'jpg' };
}

async function saveCapture(result, label) {
  const capture = imagePayload(result, label);
  await writeFile(resolve(outputDirectory, `${label}.${capture.extension}`), capture.bytes);
  const metadata = textPayload(result);
  return {
    label,
    mimeType: capture.image.mimeType,
    byteLength: capture.bytes.length,
    width: metadata.width,
    height: metadata.height,
    captureMode: metadata.captureMode || metadata.action,
    background: metadata.background,
    transportCompressed: metadata.transportCompressed,
  };
}

async function assertInactive(client, expectedTabId, stage) {
  const result = await client.callTool({ name: 'get_windows_and_tabs', arguments: {} });
  if (result.isError) throw new Error(`get_windows_and_tabs failed during ${stage}`);
  const view = textPayload(result);
  const tabs = view.windows?.flatMap((window) => window.tabs || []) || [];
  const tab = tabs.find((candidate) => candidate.tabId === expectedTabId);
  if (!tab) throw new Error(`Session tab ${expectedTabId} disappeared during ${stage}`);
  if (tab.chromeActive !== false) {
    throw new Error(`Session tab became physically active during ${stage}`);
  }
  return { stage, logicalActive: tab.active, chromeActive: tab.chromeActive };
}

await mkdir(outputDirectory, { recursive: true });
const client = new Client({ name: 'justbrowse-live-screenshot-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(endpoint);
let tabId;

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  for (const required of ['chrome_navigate', 'chrome_screenshot', 'chrome_computer']) {
    if (!toolNames.has(required)) throw new Error(`Required MCP tool is missing: ${required}`);
  }

  const navigation = await client.callTool({
    name: 'chrome_navigate',
    arguments: { url: testUrl },
  });
  if (navigation.isError)
    throw new Error(`Navigation failed: ${JSON.stringify(navigation.content)}`);
  tabId = textPayload(navigation).tabId;
  if (!Number.isInteger(tabId)) throw new Error('Navigation did not return a tab ID');

  const focusChecks = [await assertInactive(client, tabId, 'navigation')];
  const captures = [];
  captures.push(
    await saveCapture(
      await client.callTool({
        name: 'chrome_screenshot',
        arguments: { tabId, background: true },
      }),
      'viewport',
    ),
  );
  focusChecks.push(await assertInactive(client, tabId, 'viewport screenshot'));

  captures.push(
    await saveCapture(
      await client.callTool({
        name: 'chrome_screenshot',
        arguments: { tabId, background: true, fullPage: true },
      }),
      'full-page',
    ),
  );
  focusChecks.push(await assertInactive(client, tabId, 'full-page screenshot'));

  captures.push(
    await saveCapture(
      await client.callTool({
        name: 'chrome_screenshot',
        arguments: { tabId, background: true, selector: 'h1' },
      }),
      'element-h1',
    ),
  );
  focusChecks.push(await assertInactive(client, tabId, 'element screenshot'));

  captures.push(
    await saveCapture(
      await client.callTool({
        name: 'chrome_computer',
        arguments: { tabId, background: true, action: 'screenshot' },
      }),
      'computer-viewport',
    ),
  );
  focusChecks.push(await assertInactive(client, tabId, 'computer screenshot'));

  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoint: endpoint.href,
        testUrl,
        listedToolCount: listed.tools.length,
        tabId,
        captures,
        focusChecks,
        outputDirectory,
      },
      null,
      2,
    ),
  );
} finally {
  if (Number.isInteger(tabId)) {
    try {
      await client.callTool({ name: 'chrome_close_tabs', arguments: { tabIds: [tabId] } });
    } catch {
      // Best-effort cleanup; preserve the original test failure.
    }
  }
  await client.close().catch(() => {});
}
