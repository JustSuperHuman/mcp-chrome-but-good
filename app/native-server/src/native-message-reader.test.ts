import { describe, expect, test } from '@jest/globals';
import { NativeMessageReader } from './native-message-reader';

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

describe('NativeMessageReader', () => {
  test.each([1, 2, 3, 4, 7, 64, 4096])(
    'handles headers and UTF-8 bodies split every %i bytes',
    (size) => {
      const values = [
        { text: 'hello \u00e9 \ud83d\udcaa' },
        { payload: 'x'.repeat(17000) },
        [1, 2, 3],
      ];
      const input = Buffer.concat(values.map(frame));
      const reader = new NativeMessageReader();
      const output = [];
      for (let offset = 0; offset < input.length; offset += size) {
        reader.append(input.subarray(offset, offset + size));
        let message;
        while ((message = reader.readMessage()) !== null)
          output.push(JSON.parse(message.toString()));
      }
      expect(output).toEqual(values);
      expect(reader.hasPendingData).toBe(false);
    },
  );

  test('drains a burst larger than the host per-tick budget in order', () => {
    const values = Array.from({ length: 350 }, (_, id) => ({ id }));
    const reader = new NativeMessageReader();
    reader.append(Buffer.concat(values.map(frame)));
    for (const value of values) expect(JSON.parse(reader.readMessage()!.toString())).toEqual(value);
    expect(reader.readMessage()).toBeNull();
    reader.append(frame({ next: true }));
    expect(JSON.parse(reader.readMessage()!.toString())).toEqual({ next: true });
  });

  test.each([0, 1025, 0xffffffff])(
    'rejects invalid length %i and recovers on the next packet',
    (length) => {
      const reader = new NativeMessageReader(1024);
      const header = Buffer.alloc(4);
      header.writeUInt32LE(length);
      reader.append(header);
      expect(() => reader.readMessage()).toThrow(`Invalid message length: ${length}`);
      reader.append(frame({ valid: true }));
      expect(JSON.parse(reader.readMessage()!.toString())).toEqual({ valid: true });
    },
  );

  test('waits for a complete body and accepts the exact size limit', () => {
    const reader = new NativeMessageReader(8);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(8);
    reader.append(header);
    expect(reader.readMessage()).toBeNull();
    reader.append(Buffer.from('1234'));
    expect(reader.readMessage()).toBeNull();
    reader.append(Buffer.from('5678'));
    expect(reader.readMessage()!.toString()).toBe('12345678');
  });

  test('empty chunks and partially received next headers do not lose messages', () => {
    const reader = new NativeMessageReader();
    const first = frame('first');
    const second = frame('second');
    reader.append(Buffer.alloc(0));
    reader.append(Buffer.concat([first, second.subarray(0, 2)]));
    expect(JSON.parse(reader.readMessage()!.toString())).toBe('first');
    expect(reader.readMessage()).toBeNull();
    reader.append(second.subarray(2));
    expect(JSON.parse(reader.readMessage()!.toString())).toBe('second');
  });
});
