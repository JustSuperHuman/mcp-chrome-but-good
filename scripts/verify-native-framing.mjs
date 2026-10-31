// Exercise the compiled host over real pipes, including fragmented input and
// a burst larger than its per-tick message budget. No browser or HTTP port is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../app/native-server/dist/index.js', import.meta.url));
const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const expected = 350;
let received = 0;
let buffered = Buffer.alloc(0);
let stderr = '';

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

let timeout;
try {
  await new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Native framing check timed out')), 15000);
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on('close', (code) => {
      try {
        assert.equal(code, 0, stderr);
        assert.equal(received, expected, `Native host dropped messages: ${stderr}`);
        assert.equal(buffered.length, 0, 'Native host returned a partial frame');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    child.stdout.on('data', (chunk) => {
      try {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4) {
          const length = buffered.readUInt32LE(0);
          assert.ok(length > 0 && length < 1024, 'Native stdout contains an invalid frame');
          if (buffered.length < 4 + length) break;
          const response = JSON.parse(buffered.subarray(4, 4 + length).toString());
          buffered = buffered.subarray(4 + length);
          assert.deepEqual(response, { type: 'pong_to_extension' });
          received++;
        }
        if (received === expected) child.stdin.end();
      } catch (error) {
        reject(error);
      }
    });
    (async () => {
      const large = frame({
        responseToRequestId: 'framing-check',
        payload: 'x'.repeat(1024 * 1024),
      });
      for (let offset = 0; offset < large.length; offset += 4096) {
        if (!child.stdin.write(large.subarray(offset, offset + 4096)))
          await once(child.stdin, 'drain');
      }
      const burst = Buffer.concat(
        Array.from({ length: expected }, () => frame({ type: 'ping_from_extension' })),
      );
      child.stdin.write(burst);
    })().catch(reject);
  });
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) child.kill();
}
console.log(
  JSON.stringify(
    {
      ok: true,
      fragmentedPayloadBytes: 1024 * 1024,
      receivedMessages: received,
      browserUsed: false,
    },
    null,
    2,
  ),
);
