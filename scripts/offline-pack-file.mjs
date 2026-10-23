import fs from 'node:fs';

/** Bounded file slices with safe numeric offsets. Node 24 on Windows can wrap
 * fs.openAsBlob().size above 4 GiB; never construct a whole-file Node Blob. */
export function openOfflinePackFile(file) {
  const fd = fs.openSync(file, 'r'), initial = fs.fstatSync(fd, { bigint: true });
  if (!initial.isFile() || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) { fs.closeSync(fd); throw Error('Invalid archive file'); }
  const size = Number(initial.size); let closed = false;
  const unchanged = () => {
    if (closed) throw Error('Archive file is closed');
    const current = fs.fstatSync(fd, { bigint: true });
    if (current.size !== initial.size || current.mtimeNs !== initial.mtimeNs || current.ctimeNs !== initial.ctimeNs) throw Error('Archive changed during inspection');
  };
  const offset = (value, fallback) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value)) throw Error('Invalid archive slice offset');
    return value < 0 ? Math.max(size + value, 0) : Math.min(value, size);
  };
  return { size, close() { if (!closed) { closed = true; fs.closeSync(fd); } }, slice(start, end) {
    const from = offset(start, 0), to = offset(end, size), length = Math.max(0, to - from);
    if (length > 32 * 1024 * 1024) throw Error('Archive slice exceeds the source byte limit');
    const read = () => {
      unchanged(); const bytes = new Uint8Array(length); let received = 0;
      while (received < length) {
        const count = fs.readSync(fd, bytes, received, length - received, from + received);
        if (!count) throw Error('Truncated archive slice'); received += count;
      }
      unchanged(); return bytes;
    };
    return { size: length, async arrayBuffer() { return read().buffer; }, stream() {
      return new ReadableStream({ start(controller) { try { controller.enqueue(read()); controller.close(); } catch (error) { controller.error(error); } } });
    } };
  } };
}
