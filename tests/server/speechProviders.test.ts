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

// ---------- BreezeBlue, MiniMax, Cartesia and Qwen ----------

const breeze: ProviderTarget = {
  ...eleven,
  id: "breeze",
  name: "Breeze TTS 2",
  baseUrl: "https://api.breeze.blue/v1",
  model: "breeze-tts-2",
  apiKey: "brz-key",
};
const minimax: ProviderTarget = {
  ...gemini,
  id: "minimax",
  name: "MiniMax",
  baseUrl: "https://api.minimax.io/v1",
  model: "speech-2.8-hd",
  apiKey: "mm-key",
};
const cartesia: ProviderTarget = {
  ...gemini,
  id: "cartesia",
  name: "Cartesia",
  baseUrl: "https://api.cartesia.ai",
  model: "sonic-3.6",
  apiKey: "sk_car_key",
};
const qwen: ProviderTarget = {
  ...gemini,
  id: "qwen",
  name: "Qwen-Audio 3.0 TTS Flash",
  baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1",
  model: "qwen-audio-3.0-tts-flash",
  apiKey: "sk-qwen",
};

const wavResponse = (bytes: Uint8Array) =>
  new Response(bytes, { headers: { "content-type": "audio/wav" } });

describe("which API the newer base URLs speak", () => {
  test("each is known by its host and shows its own request line", () => {
    expect(ttsRequestPath(breeze)).toBe("/text-to-speech/<voice>");
    expect(ttsRequestPath(minimax)).toBe("/t2a_v2");
    expect(ttsRequestPath(cartesia)).toBe("/tts/bytes");
    expect(ttsRequestPath(qwen)).toBe("/services/audio/tts/SpeechSynthesizer");
    // a workspace's own Model Studio host is Qwen too
    expect(
      ttsRequestPath({ baseUrl: "https://ws123.ap-southeast-1.maas.aliyuncs.com/api/v1" }),
    ).toBe("/services/audio/tts/SpeechSynthesizer");
  });

  test("each offers only what it has been asked for", () => {
    expect(
      encodingProblems({ ...minimax, encoding: { format: "wav" }, sampleRate: 48000 }),
    ).toHaveLength(1);
    expect(
      encodingProblems({
        ...minimax,
        encoding: { format: "mp3", bitrate: 256 },
        sampleRate: 44100,
      }),
    ).toEqual([]);
    expect(encodingProblems({ ...cartesia, encoding: { format: "opus" } })).toHaveLength(1);
    expect(
      encodingProblems({ ...qwen, encoding: { format: "wav" }, sampleRate: 16000 }),
    ).toHaveLength(1);
    expect(encodingProblems({ ...breeze, encoding: { format: "wav" }, sampleRate: 48000 })).toEqual(
      [],
    );
  });
});

describe("BreezeBlue", () => {
  test("is asked as ElevenLabs is, with the line's instructions beside the words", async () => {
    const f = scripted(() => wavResponse(wav(24000, 2400)));
    const r = reports();
    await provider(f.fetch).speak(
      line(breeze, { voiceRef: "breeze/voc_xeh3w54cqvnp", instructions: "Softly.", sent: r.sent }),
    );
    expect(f.sent[0].url).toBe(
      "https://api.breeze.blue/v1/text-to-speech/voc_xeh3w54cqvnp?output_format=wav_24000",
    );
    expect(headersOf(f.sent[0].init).get("xi-api-key")).toBe("brz-key");
    expect(f.body()).toEqual({
      text: "Come in.",
      model_id: "breeze-tts-2",
      instructions: "Softly.",
    });
    expect(r.got[0].instructions).toBe("Softly.");
  });

  test("its Test button accepts a model list wrapped in `models`", async () => {
    const f = scripted(() => Response.json({ models: [{ model_id: "breeze-tts-2" }] }));
    const result = await provider(f.fetch).probe!(breeze, new AbortController().signal);
    expect(f.sent[0].url).toBe("https://api.breeze.blue/v1/models");
    expect(result).toMatchObject({ ok: true });
  });
});

describe("MiniMax", () => {
  const answer = (bytes: Uint8Array, extra: Record<string, unknown> = {}) =>
    Response.json({
      data: { audio: Buffer.from(bytes).toString("hex"), status: 2 },
      extra_info: { usage_characters: 8, audio_format: "wav" },
      base_resp: { status_code: 0, status_msg: "success" },
      ...extra,
    });

  test("is sent the model, words, voice and format its docs give, and its hex comes back as audio", async () => {
    const f = scripted(() => answer(wav(32000, 16000)));
    const r = reports();
    const clip = await provider(f.fetch).speak(
      line(minimax, { voiceRef: "minimax/English_expressive_narrator", sent: r.sent }),
    );
    expect(f.sent[0].url).toBe("https://api.minimax.io/v1/t2a_v2");
    expect(headersOf(f.sent[0].init).get("authorization")).toBe("Bearer mm-key");
    expect(f.body()).toEqual({
      model: "speech-2.8-hd",
      text: "Come in.",
      stream: false,
      output_format: "hex",
      voice_setting: { voice_id: "English_expressive_narrator" },
      audio_setting: { sample_rate: 32000, format: "wav", channel: 1 },
    });
    expect(clip.duration).toBeCloseTo(0.5);
    expect(r.got[0].reported).toMatchObject({ chars: 8 });
  });

  test("an MP3's bitrate is sent in bits a second", async () => {
    const mp3 = silentMp3(38, { kbps: 128 });
    const f = scripted(() => answer(mp3));
    await provider(f.fetch).speak(
      line(minimax, { sampleRate: 44100, encoding: { format: "mp3", bitrate: 128 } }),
    );
    expect(f.body().audio_setting).toEqual({
      sample_rate: 44100,
      format: "mp3",
      channel: 1,
      bitrate: 128000,
    });
  });

  test("a refusal inside a 200 is a failure that says so, and a rate limit is marked retryable", async () => {
    const refused = (code: number, msg: string) => () =>
      Response.json({ data: null, base_resp: { status_code: code, status_msg: msg } });
    const r = reports();
    await expect(
      provider(scripted(refused(1004, "auth failed")).fetch).speak(line(minimax, { sent: r.sent })),
    ).rejects.toMatchObject({
      message: "MiniMax refused the request (1004: auth failed)",
      retryable: false,
    });
    await expect(
      provider(scripted(refused(1002, "rate limit")).fetch).speak(line(minimax)),
    ).rejects.toMatchObject({ retryable: true });
    expect(r.got[0].status).toBe("failed");
  });
});

describe("Cartesia", () => {
  test("is sent its version header and the body its reference gives", async () => {
    const f = scripted(() => wavResponse(wav(44100, 44100)));
    const r = reports();
    await provider(f.fetch).speak(
      line(cartesia, { voiceRef: "cartesia/db6b0ed5", instructions: "Calm.", sent: r.sent }),
    );
    expect(f.sent[0].url).toBe("https://api.cartesia.ai/tts/bytes");
    const h = headersOf(f.sent[0].init);
    expect(h.get("authorization")).toBe("Bearer sk_car_key");
    expect(h.get("cartesia-version")).toBe("2026-08-14");
    expect(f.body()).toEqual({
      model_id: "sonic-3.6",
      transcript: "Come in.",
      voice: { id: "db6b0ed5" },
      output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 44100 },
    });
    // no instructions field: the tags go in the transcript
    expect(r.got[0].instructions).toBe("");
  });

  test("an MP3 names its bitrate in bits a second", async () => {
    const f = scripted(
      () =>
        new Response(silentMp3(38, { kbps: 192 }), { headers: { "content-type": "audio/mpeg" } }),
    );
    await provider(f.fetch).speak(line(cartesia, { encoding: { format: "mp3", bitrate: 192 } }));
    expect(f.body().output_format).toEqual({
      container: "mp3",
      sample_rate: 44100,
      bit_rate: 192000,
    });
  });

  test("its Test button reads one voice", async () => {
    const f = scripted(() =>
      Response.json({ data: [{ id: "v1", name: "Katie" }], has_more: true }),
    );
    const result = await provider(f.fetch).probe!(cartesia, new AbortController().signal);
    expect(f.sent[0].url).toBe("https://api.cartesia.ai/voices?limit=1");
    expect(result).toMatchObject({ ok: true });
  });
});

describe("Qwen-Audio 3.0", () => {
  test("is sent Model Studio's body, and the audio is fetched from the link it answers with", async () => {
    const f = scripted(
      () => Response.json({ output: { audio: { url: "http://oss.example/a.wav", data: "" } } }),
      () => wavResponse(wav(24000, 24000)),
    );
    const r = reports();
    const clip = await provider(f.fetch).speak(
      line(qwen, { voiceRef: "qwen/longanhuan_v3.6", sent: r.sent }),
    );
    expect(f.sent[0].url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
    );
    expect(headersOf(f.sent[0].init).get("authorization")).toBe("Bearer sk-qwen");
    expect(f.body()).toEqual({
      model: "qwen-audio-3.0-tts-flash",
      input: { text: "Come in.", voice: "longanhuan_v3.6", format: "wav", sample_rate: 24000 },
    });
    // the link is signed: fetched without the key
    expect(f.sent[1].url).toBe("http://oss.example/a.wav");
    expect(headersOf(f.sent[1].init).has("authorization")).toBe(false);
    expect(clip.duration).toBeCloseTo(1);
    expect(r.got).toHaveLength(1);
    expect(r.got[0].status).toBe("done");
  });

  test("an answer with no link says what Model Studio said", async () => {
    const f = scripted(() =>
      Response.json({ code: "InvalidParameter", message: "voice not found" }),
    );
    await expect(provider(f.fetch).speak(line(qwen))).rejects.toThrow(
      "no audio link: InvalidParameter, voice not found",
    );
  });
});
