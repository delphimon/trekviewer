import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { openOfflinePackFile } from '../scripts/offline-pack-file.mjs';
async function fixture(task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-pack-file-')), file = path.join(root, 'pack.tar');
  fs.writeFileSync(file, '0123456789'); let reader;
  try { reader = openOfflinePackFile(file); await task(reader, file); }
  finally { reader?.close(); fs.unlinkSync(file); fs.rmdirSync(root); }
}
it('provides exact bounded slice bytes and stream bytes without a whole-file Blob', async () => {
  await fixture(async reader => {
    expect(reader.size).toBe(10);
    expect(new TextDecoder().decode(await reader.slice(2, 6).arrayBuffer())).toBe('2345');
    expect(await new Response(reader.slice(-3).stream()).text()).toBe('789');
    expect((await reader.slice(8, 4).arrayBuffer()).byteLength).toBe(0);
    expect((await reader.slice(0, 100).arrayBuffer()).byteLength).toBe(10);
  });
});
it('rejects invalid offsets, closed readers and changed files', async () => {
  await fixture(async (reader, file) => {
    expect(() => reader.slice(1.5, 3)).toThrow('Invalid archive slice offset');
    fs.writeFileSync(file, 'changed archive size');
    await expect(reader.slice(0, 1).arrayBuffer()).rejects.toThrow('changed during inspection');
    reader.close(); await expect(reader.slice(0, 1).arrayBuffer()).rejects.toThrow('closed');
  });
});
it('reads real file offsets beyond 4 GiB and rejects an unbounded slice', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-pack-offset-')), file = path.join(root, 'large-file.tar');
  const at = 2 ** 32 + 1024, expected = Buffer.from('exact bytes beyond four GiB'); let reader;
  try {
    const fd = fs.openSync(file, 'wx');
    try { fs.ftruncateSync(fd, at + expected.length + 1024); fs.writeSync(fd, expected, 0, expected.length, at); }
    finally { fs.closeSync(fd); }
    reader = openOfflinePackFile(file); expect(reader.size).toBe(at + expected.length + 1024);
    expect(Buffer.from(await reader.slice(at, at + expected.length).arrayBuffer())).toEqual(expected);
    expect(() => reader.slice(0)).toThrow('source byte limit');
  } finally { reader?.close(); if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(root); }
}, 60000);
