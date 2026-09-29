// Zips that lie, for the tests of what the server refuses before it inflates anything.

/**
 * The same zip, claiming the named entry unzips to `size` bytes.
 *
 * Both copies of the claim are rewritten — the local header's and the central directory's — so the
 * archive agrees with itself and only inflating it shows the lie. What a zip says it holds is what
 * a guard refuses on first, so a claim too big is refused without inflating, and one too small is
 * caught inflating. Hands back the same kind of bytes it was given.
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
