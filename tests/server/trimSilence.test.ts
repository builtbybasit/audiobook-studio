// Trimming the silence a voice leaves on a clip's ends: the ffmpeg filter (where this machine has
// ffmpeg), the pauses a line keeps, narration landing trimmed clips, and the one-time pass.
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import type { ExpressionAnnotation, Segment } from "@/types";
import { DEFAULT_PACING } from "@/lib/speech";
import { fileName } from "~/audio/files";
import { probeClip } from "~/audio/probe";
import { edgePauses, ffmpegTrim, trimClip, type TrimSilence } from "~/audio/trim";
import { trimStored } from "~/audio/trimStored";
import { getJob, listJobs } from "~/db/jobs";
import { clips, heard } from "~/db/schema";
import { readScript } from "~/db/script";
import { toneWav } from "~/providers/fakeSpeech";
import { ffmpegAvailable } from "~/providers/ffmpegEncoder";
import { joinWav } from "~/providers/wav";
import { line } from "../support/epub";
import { narratedBook, testApi } from "../support/server";

const signal = new AbortController().signal;
const seconds = async (bytes: Uint8Array) => (await probeClip(bytes, "wav")).duration;

describe.skipIf(!(await ffmpegAvailable()))("ffmpeg's trim", () => {
  const padded = joinWav([0.3, toneWav(440, 0.5, 24000), 0.25]);
  const clip = { bytes: padded, format: "wav" as const, duration: 1.05 };

  test.each([
    [{ start: 0, end: 0 }, 0.58],
    // an edge pause stays on top of the margin
    [{ start: 0.2, end: 0 }, 0.78],
    [{ start: 0, end: 0.1 }, 0.68],
  ])("keeps %o beyond the margin", async (keep, left) => {
    const cut = await trimClip(ffmpegTrim(), clip, keep, signal);
    expect(cut!.duration).toBeCloseTo(left, 1);
  });

  test("a trimmed clip has nothing more to cut, and silence is left alone", async () => {
    const once = (await trimClip(ffmpegTrim(), clip, { start: 0, end: 0 }, signal))!;
    expect(await trimClip(ffmpegTrim(), once, { start: 0, end: 0 }, signal)).toBeNull();
    const silent = joinWav([toneWav(440, 0.01, 24000), 1]).fill(0, 44);
    const quiet = { bytes: silent, format: "wav" as const, duration: await seconds(silent) };
    expect(await trimClip(ffmpegTrim(), quiet, { start: 0, end: 0 }, signal)).toBeNull();
  });
});

const pause = (at: number, over: Partial<ExpressionAnnotation> = {}): ExpressionAnnotation => ({
  id: "pause",
  label: "pause",
  token: "",
  kind: "pause",
  annotationId: at,
  at,
  ...over,
});

test.each([
  ["no pauses", [], { start: 0, end: 0 }],
  ["one inside", [pause(5)], { start: 0, end: 0 }],
  ["one at the start", [pause(0)], { start: DEFAULT_PACING.inlineShort, end: 0 }],
  ["a long one at the end", [pause(12, { id: "long pause" })], { start: 0, end: 1 }],
  ["its own length, past spaces", [pause(13, { seconds: 2 })], { start: 0, end: 2 }],
  ["an omitted one", [pause(0, { omitted: true })], { start: 0, end: 0 }],
])("edgePauses: %s", (_, expressions, want) => {
  expect(edgePauses({ text: "Hello there." + " ", expressions }, DEFAULT_PACING)).toEqual(want);
});

/** Cuts 0.1 s off the start and 0.05 s off the end of whatever it is given. */
const fakeTrim: TrimSilence = async (bytes, keep) => {
  const d = await seconds(bytes);
  return toneWav(440, keep.end >= d ? d - 0.1 : d - 0.15);
};

const spoken = (api: ReturnType<typeof testApi>, id: string): Segment[] =>
  readScript(api.db, id, 1).filter((s) => s.audio.url);

describe("narration", () => {
  const narrated = async (api: ReturnType<typeof testApi>) =>
    spoken(api, (await narratedBook(api, { chapters: [["One", line("One")]] })).id);

  test("lands each clip trimmed, as WAV", async () => {
    const sent = await narrated(testApi());
    const lines = await narrated(testApi({ trim: fakeTrim }));
    expect(lines.length).toBe(sent.length);
    for (const [i, s] of lines.entries()) {
      expect(s.audio.url).toEndWith(".wav");
      expect(s.audio.duration).toBeCloseTo(sent[i].audio.duration - 0.15, 3);
    }
  });

  test("a trim that fails keeps the clip as sent, with a warning", async () => {
    const api = testApi({
      trim: async () => {
        throw new Error("ffmpeg failed");
      },
    });
    const { id } = await narratedBook(api, { chapters: [["One", line("One")]] });
    const lines = spoken(api, id);
    expect(lines.length).toBeGreaterThan(0);
    for (const s of lines) expect(s.audio.status).toBe("done");
    const job = getJob(api.db, listJobs(api.db).find((j) => j.kind === "narration")!.id)!;
    expect(job.status).toBe("done");
    const told = job.activity?.filter((e) => e.message.includes("silence was not trimmed")) ?? [];
    expect(told.length).toBe(lines.length);
    expect(told[0].level).toBe("warning");
  });
});

describe("trimStored", () => {
  test("swaps in trimmed files, moves heard word times, and removes the old files", async () => {
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: [["One", line("One")]] });
    const [s] = spoken(api, id);
    const was = s.audio.url!;
    api.db
      .insert(heard)
      .values({
        bookId: id,
        file: fileName(was),
        text: s.text,
        heard: s.text,
        words: [[0, 5, 0.3, 0.6]],
        score: 0,
        mismatch: false,
        endpoint: "asr",
        at: 1,
      })
      .run();
    const oldPath = (await api.files.find(was, id))!;

    const done = await trimStored(api.db, api.files, fakeTrim);

    const now = spoken(api, id).find((l) => l.id === s.id)!;
    expect(done.clips).toBe(spoken(api, id).length);
    expect(now.audio.url).not.toBe(was);
    expect(now.audio.duration).toBeCloseTo(s.audio.duration - 0.15, 3);
    const moved = api.db
      .select()
      .from(heard)
      .where(and(eq(heard.bookId, id), eq(heard.file, fileName(now.audio.url!))))
      .get();
    expect(moved?.words?.[0][2]).toBeCloseTo(0.2, 3);
    expect(await Bun.file(oldPath).exists()).toBe(false);
    expect(api.db.select().from(clips).where(eq(clips.url, was)).all()).toHaveLength(0);
  });
});
