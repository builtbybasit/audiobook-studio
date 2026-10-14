// Zips that lie, for the tests of what the server refuses before it inflates anything.

/**
 * The same zip, claiming the named entry unzips to `size` bytes. Both the local and central headers
 * are rewritten so only inflating shows the lie: too big is refused up front, too small is caught
 * inflating. Returns the same kind of bytes it was given.
 */
export function claiming(bytes: ArrayBuffer, name: string, size: number): ArrayBuffer;
export function claiming(bytes: Uint8Array, name: string, size: number): Uint8Array;
export function claiming(
  bytes: ArrayBuffer | Uint8Array,
  name: string,
  size: number,
): ArrayBuffer | Uint8Array {
  const out = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const named = (at: number, length: number) => out.toString("utf8", at, at + length) === name;
  for (let i = 0; i + 46 <= out.length; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50 && named(i + 30, out.readUInt16LE(i + 26)))
      out.writeUInt32LE(size, i + 22);
    if (sig === 0x02014b50 && named(i + 46, out.readUInt16LE(i + 28)))
      out.writeUInt32LE(size, i + 24);
  }
  return bytes instanceof Uint8Array
    ? new Uint8Array(out)
    : out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}
