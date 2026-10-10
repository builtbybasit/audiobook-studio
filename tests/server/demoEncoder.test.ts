// The demo's encoder: the file it writes is a few seconds of the book, encoded for real, and what it
// says it wrote — how long the audiobook plays, where each chapter falls — is the whole book's.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { simulatedEncoders } from "~/demo/encoder";
import { toneWav } from "~/providers/fakeSpeech";
import { ffmpegEncoders } from "~/providers/ffmpegEncoder";

/** How long ffprobe says a file plays. */
async function plays(path: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { stdout: "pipe" },
  );
  return Number((await new Response(proc.stdout).text()).trim());
}

test("writes a sample of the book and accounts for all of it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-encoder-"));
  try {
    const clip = (name: string, seconds: number) => {
      writeFileSync(join(dir, name), toneWav(440, seconds));
      return { kind: "clip" as const, path: join(dir, name) };
    };
    const landed: number[] = [];
    const encoder = simulatedEncoders(ffmpegEncoders()).for({
      ...DEFAULT_EXPORT_SETTINGS,
      normalize: false,
    });
    const written = await encoder.encode({
      chapters: [1, 2, 3].map((id) => ({
        id,
        title: `Chapter ${id}`,
        parts: [clip(`${id}a.wav`, 3), { kind: "silence", seconds: 0.5 }, clip(`${id}b.wav`, 3)],
      })),
      gap: 1,
      out: join(dir, "out.m4b"),
      signal: new AbortController().signal,
      onChapter: (c) => void landed.push(c.id),
    });

    expect(written.seconds).toBeCloseTo(3 * 6.5 + 2, 2);
    expect(written.chapters.map((c) => [c.start, c.length])).toEqual([
      [0, 6500],
      [7500, 6500],
      [15000, 6500],
    ]);
    expect(landed).toEqual([1, 2, 3]);
    // the first clip and the pause after it, then the next clip that takes it past five seconds
    expect(await plays(join(dir, "out.m4b"))).toBeCloseTo(6.5, 0);
    expect(written.bytes).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
