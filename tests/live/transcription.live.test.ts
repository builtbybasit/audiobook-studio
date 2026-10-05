// The transcription wire against a real server, opt-in: `LIVE=1 bun test tests/live` with
// `TRANSCRIPTION_URL` in `.env` — Fermion's Phonon is `http://127.0.0.1:8001/v1` after
// `fermion serve phonon-2 --port 8001` — and `TRANSCRIPTION_MODEL` (default `phonon-2`),
// `TRANSCRIPTION_TOKEN` for a server that wants a key. The sentence is spoken by macOS `say`, so
// on another machine set `LIVE_SPEECH_WAV` to a WAV of someone saying it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { ProviderTarget } from "~/providers/target";
import { endpointTranscriber } from "~/providers/transcription";

const env = process.env;
const SENTENCE = "The lamp was lit, and the house was quiet.";

/** A WAV of the sentence: the one given, or macOS saying it. */
async function spoken(): Promise<Uint8Array> {
  if (env.LIVE_SPEECH_WAV) return new Uint8Array(await Bun.file(env.LIVE_SPEECH_WAV).arrayBuffer());
  const out = join(mkdtempSync(join(tmpdir(), "said-")), "said.wav");
  const said = Bun.spawnSync(["say", "-o", out, "--data-format=LEI16@16000", SENTENCE]);
  if (said.exitCode !== 0) throw new Error("set LIVE_SPEECH_WAV: there is no `say` to speak with");
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

describe.skipIf(!env.LIVE || !env.TRANSCRIPTION_URL)("a transcription server, for real", () => {
  const target: ProviderTarget = {
    id: "live",
    name: "Transcription (live)",
    baseUrl: (env.TRANSCRIPTION_URL ?? "").replace(/\/+$/, ""),
    model: env.TRANSCRIPTION_MODEL ?? "phonon-2",
    apiKey: env.TRANSCRIPTION_TOKEN ?? null,
    needsKey: false,
    timeoutSec: 60,
    maxRetries: 0,
    cooldownSec: 0,
  };
  const provider = endpointTranscriber();
  const signal = () => new AbortController().signal;

  test("the Test button's probe answers", async () => {
    const probe = await provider.probe(target, signal());
    expect(probe.ok).toBe(true);
  });

  test("hears the sentence, each word with its time", async () => {
    const audio = new Blob([await spoken()], { type: "audio/wav" });
    const heard = await provider.transcribe(
      { audio, name: "said.wav", seconds: 3, words: true, signal: signal() },
      target,
    );
    expect(heard.text.toLowerCase()).toContain("lamp");
    expect(heard.words?.length).toBeGreaterThanOrEqual(6);
    const times = heard.words!.map((w) => w.start);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  }, 60_000);
});
