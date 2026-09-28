// Gemini and ElevenLabs through the real speech provider, against an injected `fetch`: what each is
// sent — its own path, key header and body, shaped as its docs give them — what is made of the
// answer, what either refuses before sending anything, and what reaches the ledger. Fish Audio and
// the OpenAI shape are `endpointSpeech.test.ts`.
import { describe, expect, test } from "bun:test";

import { encodingProblems, isElevenLabs, isGemini, ttsRequestPath } from "@/lib/endpointShapes";
import { elevenLabsOutputFormat } from "~/providers/elevenLabsSpeech";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { isLegacyGeminiSpeech } from "~/providers/geminiSpeech";
import type { SentSpeech } from "~/providers/sent";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { readWavHeader } from "~/providers/wavEncoder";
import { silentMp3 } from "../support/encoded";

const gemini: ProviderTarget = {
  id: "gemini",
  name: "Gemini 3.8 Flash TTS",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  model: "gemini-3.8-flash-tts",
  apiKey: "g-key",
  needsKey: true,
  timeoutSec: 5,
  maxRetries: 2,
  cooldownSec: 0,
};
const legacy: ProviderTarget = {
  ...gemini,
  name: "Gemini 3.1 Flash TTS",
  model: "gemini-3.1-flash-tts-preview",
};
const eleven: ProviderTarget = {
  ...gemini,
  id: "eleven",
  name: "ElevenLabs",
  baseUrl: "https://api.elevenlabs.io/v1",
  model: "eleven_multilingual_v2",
  apiKey: "xi-key",
};

const line = (target: ProviderTarget, over: Partial<SpeechInput> = {}): SpeechInput => ({
  text: "Come in.",
  speaker: "Mara",
  type: "dialogue",
  direction: "",
  instructions: "",
  voiceRef: `${target.id}/Kore`,
  sampleRate: null,
  encoding: { format: "wav" },
  target,
  signal: new AbortController().signal,
  ...over,
});

/** A plain 16-bit mono WAV of `frames` silent samples at `rate`. */
function wav(rate: number, frames: number): Uint8Array {
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) =>
    [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, frames * 2, true);
  return bytes;
}

/** Gemini's answer: the audio base64 in the first candidate, and what it counted. */
const geminiAnswer = (bytes: Uint8Array, mimeType: string, usage?: Record<string, unknown>) =>
  Response.json({
    candidates: [
      {
        content: {
          parts: [{ inlineData: { mimeType, data: Buffer.from(bytes).toString("base64") } }],
        },
      },
    ],
    ...(usage ? { usageMetadata: usage } : {}),
  });

/** A fetch that answers from a list in turn, and remembers what it was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return answers[Math.min(sent.length, answers.length) - 1]();
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch, body: (i = 0) => JSON.parse(String(sent[i].init.body)) };
}

function reports() {
  const got: SentSpeech[] = [];
  return { got, sent: (r: SentSpeech) => void got.push(r) };
}

const headersOf = (init: RequestInit) => new Headers(init.headers);
const provider = (fetch: typeof globalThis.fetch) =>
  endpointSpeechProvider({ fetch, backoffMs: () => 0 });

describe("which API a base URL speaks", () => {
  test("Gemini and ElevenLabs are known by their hosts, and each shows its own request line", () => {
    expect(isGemini(gemini)).toBe(true);
    expect(isElevenLabs(eleven)).toBe(true);
    expect(isGemini(eleven) || isElevenLabs(gemini)).toBe(false);
    expect(ttsRequestPath(gemini)).toBe("/models/gemini-3.8-flash-tts:generateContent");
    expect(ttsRequestPath(eleven)).toBe("/text-to-speech/<voice>");
  });

  test("a model before 3.8 is a legacy preview", () => {
    expect(isLegacyGeminiSpeech("gemini-3.1-flash-tts-preview")).toBe(true);
    expect(isLegacyGeminiSpeech("gemini-2.5-flash-preview-tts")).toBe(true);
    expect(isLegacyGeminiSpeech("gemini-3.8-flash-lite-tts")).toBe(false);
  });

  test("Gemini is WAV only; ElevenLabs takes WAV at its rates and MP3 at 44.1 kHz", () => {
    expect(encodingProblems({ ...gemini, encoding: { format: "wav" }, sampleRate: 16000 })).toEqual(
      [],
    );
    expect(encodingProblems({ ...gemini, encoding: { format: "mp3" } })).toHaveLength(1);
    expect(encodingProblems({ ...eleven, encoding: { format: "wav" }, sampleRate: 22050 })).toEqual(
      [],
    );
    expect(
      encodingProblems({ ...eleven, encoding: { format: "mp3", bitrate: 192 }, sampleRate: 44100 }),
    ).toEqual([]);
    expect(encodingProblems({ ...eleven, encoding: { format: "opus" } })).toHaveLength(1);
  });
});

describe("Gemini 3.8", () => {
  test("is asked for WAV in one voice, with the line's instructions as its style, not its text", async () => {
    const f = scripted(() =>
      geminiAnswer(wav(24000, 12000), "audio/wav", {
        promptTokenCount: 9,
        candidatesTokenCount: 13,
        candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 13 }],
      }),
    );
    const r = reports();
    const clip = await provider(f.fetch).speak(
      line(gemini, { sampleRate: 24000, instructions: "Warm, unhurried.", sent: r.sent }),
    );
    expect(f.sent[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent",
    );
    const h = headersOf(f.sent[0].init);
    expect(h.get("x-goog-api-key")).toBe("g-key");
    expect(h.has("authorization")).toBe(false);
    expect(f.body()).toEqual({
      contents: [
        {
          role: "user",
          parts: [{ text: "Come in.", speechMetadata: { style: "Warm, unhurried." } }],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        responseFormat: { audio: { mimeType: "AUDIO_WAV", sampleRate: 24000 } },
        speechConfig: { voiceConfig: { voice: "Kore" } },
      },
    });
    expect(clip).toMatchObject({ format: "wav", mime: "audio/wav", voice: "Kore" });
    expect(clip.duration).toBeCloseTo(0.5);
    // what Google counted reaches the ledger, beside the style that was sent
    expect(r.got).toHaveLength(1);
    expect(r.got[0]).toMatchObject({ status: "done", instructions: "Warm, unhurried." });
    expect(r.got[0].reported).toMatchObject({ textTokens: 9, audioTokens: 13 });
  });

  test("with no rate set, none is named, and no style is sent when there is none", async () => {
    const f = scripted(() => geminiAnswer(wav(24000, 2400), "audio/wav"));
    await provider(f.fetch).speak(line(gemini));
    expect(f.body().generationConfig.responseFormat).toEqual({ audio: { mimeType: "AUDIO_WAV" } });
    expect(f.body().contents[0].parts[0]).toEqual({ text: "Come in." });
  });

  test("an answer with no audio says why, and is not tried again", async () => {
    const f = scripted(() => Response.json({ promptFeedback: { blockReason: "SAFETY" } }));
    const r = reports();
    await expect(provider(f.fetch).speak(line(gemini, { sent: r.sent }))).rejects.toThrow(
      "the prompt was blocked (SAFETY)",
    );
    expect(f.sent).toHaveLength(1);
    expect(r.got[0].status).toBe("failed");
  });

  test("MP3 is refused before a request", async () => {
    const f = scripted(() => geminiAnswer(wav(24000, 10), "audio/wav"));
    await expect(
      provider(f.fetch).speak(line(gemini, { encoding: { format: "mp3" } })),
    ).rejects.toThrow("cannot be asked for");
    expect(f.sent).toEqual([]);
  });
});

describe("a legacy Gemini preview", () => {
  test("is asked in its own shape, and its raw PCM comes back as a WAV", async () => {
    const pcm = new Uint8Array(24000 * 2); // one second
    const f = scripted(() => geminiAnswer(pcm, "audio/L16;codec=pcm;rate=24000"));
    const r = reports();
    const clip = await provider(f.fetch).speak(
      line(legacy, { instructions: "Warm.", sent: r.sent }),
    );
    expect(f.body()).toEqual({
      contents: [{ role: "user", parts: [{ text: "Come in." }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
    });
    expect(readWavHeader(clip.bytes)).toMatchObject({ sampleRate: 24000, channels: 1, bits: 16 });
    expect(clip.duration).toBeCloseTo(1);
    // a preview is sent no style, so none is billed
    expect(r.got[0].instructions).toBe("");
  });

  test("cannot be asked for another rate than its own", async () => {
    const f = scripted(() => geminiAnswer(new Uint8Array(10), "audio/L16"));
    await expect(provider(f.fetch).speak(line(legacy, { sampleRate: 16000 }))).rejects.toThrow(
      "answers at 24 kHz",
    );
    expect(f.sent).toEqual([]);
  });
});

describe("ElevenLabs", () => {
  test("is sent the voice in the path, the model in the body and the key in its own header", async () => {
    const f = scripted(
      () =>
        new Response(wav(24000, 6000), {
          headers: { "content-type": "audio/wav", "character-cost": "8" },
        }),
    );
    const r = reports();
    const clip = await provider(f.fetch).speak(
      line(eleven, { voiceRef: "eleven/JBFqnCBsd6RMkjVDRZzb", instructions: "Sly.", sent: r.sent }),
    );
    expect(f.sent[0].url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=wav_24000",
    );
    const h = headersOf(f.sent[0].init);
    expect(h.get("xi-api-key")).toBe("xi-key");
    expect(h.has("authorization")).toBe(false);
    expect(f.body()).toEqual({ text: "Come in.", model_id: "eleven_multilingual_v2" });
    expect(clip.duration).toBeCloseTo(0.25);
    // no instructions field, so none are billed; its own character count is reported
    expect(r.got[0]).toMatchObject({ status: "done", instructions: "" });
    expect(r.got[0].reported).toMatchObject({ chars: 8 });
  });

  test("an MP3 is asked for by rate and bitrate, and kept as it came", async () => {
    const mp3 = silentMp3(38, { kbps: 192 });
    const f = scripted(() => new Response(mp3, { headers: { "content-type": "audio/mpeg" } }));
    const clip = await provider(f.fetch).speak(
      line(eleven, { encoding: { format: "mp3", bitrate: 192 } }),
    );
    expect(new URL(f.sent[0].url).searchParams.get("output_format")).toBe("mp3_44100_192");
    expect(clip.format).toBe("mp3");
    expect(clip.bytes).toEqual(mp3);
    // with nothing named, a WAV is 24 kHz — every plan may ask for it — and an MP3 128 kbps
    expect(elevenLabsOutputFormat({ encoding: { format: "wav" }, sampleRate: null })).toBe(
      "wav_24000",
    );
    expect(elevenLabsOutputFormat({ encoding: { format: "mp3" }, sampleRate: null })).toBe(
      "mp3_44100_128",
    );
    expect(elevenLabsOutputFormat({ encoding: { format: "wav" }, sampleRate: 44100 })).toBe(
      "wav_44100",
    );
  });

  test("a refused key is read out and not tried again", async () => {
    const f = scripted(() =>
      Response.json(
        {
          detail: {
            type: "authentication_error",
            code: "invalid_api_key",
            message: "Invalid API key",
          },
        },
        { status: 401 },
      ),
    );
    await expect(provider(f.fetch).speak(line(eleven))).rejects.toThrow("ElevenLabs answered 401");
    expect(f.sent).toHaveLength(1);
  });
});

describe("the Test button", () => {
  test("Gemini is asked about the model, with its key", async () => {
    const f = scripted(() => Response.json({ displayName: "Gemini 3.8 Flash TTS" }));
    const result = await provider(f.fetch).probe!(gemini, new AbortController().signal);
    expect(f.sent[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts",
    );
    expect(headersOf(f.sent[0].init).get("x-goog-api-key")).toBe("g-key");
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain("Gemini 3.8 Flash TTS");
  });

  test("ElevenLabs is asked for its models, and a model it does not list is said", async () => {
    const f = scripted(() =>
      Response.json([
        { model_id: "eleven_v3", can_do_text_to_speech: true },
        { model_id: "eleven_flash_v2_5", can_do_text_to_speech: true },
      ]),
    );
    const result = await provider(f.fetch).probe!(eleven, new AbortController().signal);
    expect(f.sent[0].url).toBe("https://api.elevenlabs.io/v1/models");
    expect(headersOf(f.sent[0].init).get("xi-api-key")).toBe("xi-key");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("“eleven_multilingual_v2” is not among the 2");
  });
});
