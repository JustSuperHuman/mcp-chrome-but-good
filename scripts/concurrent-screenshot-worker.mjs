import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '../app/native-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../app/native-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const endpoint = new URL(process.env.JUSTBROWSE_MCP_URL || 'http://127.0.0.1:12306/mcp');
const label = process.env.JUSTBROWSE_TEST_LABEL;
const testUrl = process.env.JUSTBROWSE_TEST_URL;
const barrierDirectory = resolve(process.env.JUSTBROWSE_BARRIER_DIR || 'live-test-output/barrier');
const outputDirectory = resolve(
  process.env.JUSTBROWSE_SCREENSHOT_OUTPUT || `live-test-output/${label}`,
);
const expectedWorkers = Number(process.env.JUSTBROWSE_EXPECTED_WORKERS || 3);

if (!label || !testUrl)
  throw new Error('JUSTBROWSE_TEST_LABEL and JUSTBROWSE_TEST_URL are required');

function textPayload(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('Tool response did not contain JSON metadata');
  return JSON.parse(text);
}

async function sessionTab(client, tabId) {
  const result = await client.callTool({ name: 'get_windows_and_tabs', arguments: {} });
  const view = textPayload(result);
  return view.windows?.flatMap((window) => window.tabs || []).find((tab) => tab.tabId === tabId);
}

async function waitForBarrier() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = (await readdir(barrierDirectory)).filter((name) => name.endsWith('.ready.json'));
    if (ready.length >= expectedWorkers) return ready.sort();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${expectedWorkers} concurrent tabs`);
}

await Promise.all([
  mkdir(barrierDirectory, { recursive: true }),
  mkdir(outputDirectory, { recursive: true }),
]);

const client = new Client({ name: `justbrowse-concurrent-${label}`, version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(endpoint);
let tabId;

try {
  await client.connect(transport);
  const navigation = await client.callTool({
    name: 'chrome_navigate',
    arguments: { url: testUrl },
  });
  if (navigation.isError)
    throw new Error(`Navigation failed: ${JSON.stringify(navigation.content)}`);
  tabId = textPayload(navigation).tabId;
  const before = await sessionTab(client, tabId);
  if (!before || before.chromeActive !== false)
    throw new Error('Tab was physically active before barrier');

  const readyAt = new Date().toISOString();
  await writeFile(
    resolve(barrierDirectory, `${label}.ready.json`),
    JSON.stringify({ label, tabId, testUrl, readyAt }),
  );
  const readyWorkers = await waitForBarrier();

  const captureStartedAt = new Date().toISOString();
  const result = await client.callTool({
    name: 'chrome_screenshot',
    arguments: { tabId, background: true },
  });
  const captureFinishedAt = new Date().toISOString();
  if (result.isError) throw new Error(`Screenshot failed: ${JSON.stringify(result.content)}`);
  const image = result.content?.find((item) => item.type === 'image');
  if (!image?.data || image.mimeType !== 'image/png')
    throw new Error('No PNG image block returned');
  const bytes = Buffer.from(image.data, 'base64');
  const metadata = textPayload(result);
  const after = await sessionTab(client, tabId);
  if (!after || after.chromeActive !== false)
    throw new Error('Tab became physically active during capture');
  const outputPath = resolve(outputDirectory, `${label}.png`);
  await writeFile(outputPath, bytes);

  const summary = {
    ok: true,
    label,
    tabId,
    testUrl,
    readyAt,
    readyWorkers,
    captureStartedAt,
    captureFinishedAt,
    chromeActiveBefore: before.chromeActive,
    chromeActiveAfter: after.chromeActive,
    mimeType: image.mimeType,
    byteLength: bytes.length,
    width: metadata.width,
    height: metadata.height,
    outputPath,
  };
  await writeFile(
    resolve(barrierDirectory, `${label}.done.json`),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (Number.isInteger(tabId)) {
    await client
      .callTool({ name: 'chrome_close_tabs', arguments: { tabIds: [tabId] } })
      .catch(() => {});
  }
  await client.close().catch(() => {});
}
