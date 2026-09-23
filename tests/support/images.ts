// Pictures for the cover tests: real enough to be read as what they claim to be.
//
// A PNG is spelled out here — one pixel, every chunk and checksum as the format asks — so that the
// tests that only sniff and store a cover need nothing installed. A JPEG is harder to write by hand
// and only matters where ffmpeg reads it, so it is made by ffmpeg, in the tests that have one.

/** A valid 1×1 PNG. */
export const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** The first bytes of a JPEG and nothing a decoder would accept: enough for a sniff. */
export const JPEG_HEAD = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);

/** A GIF, which is an image and not a cover this server keeps. */
export const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00\x00\x00\x00;");

/** A real JPEG, `size` pixels square, made by ffmpeg. */
export async function ffmpegJpeg(size = 64, bin = "ffmpeg"): Promise<Uint8Array> {
  const proc = Bun.spawn(
    [
      bin,
      "-v",
      "quiet",
      "-f",
      "lavfi",
      "-i",
      `color=c=orange:s=${size}x${size}`,
      "-frames:v",
      "1",
      "-f",
      "mjpeg",
      "-",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  return new Uint8Array(await new Response(proc.stdout).arrayBuffer());
}
