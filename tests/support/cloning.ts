// Cloning test helpers: endpoints and targets, sample files by their first bytes, the clone form
// and route, fake cloners, and the failures a clone must never be retried after.
import { expect } from "bun:test";

import type { ClonedVoice, Endpoint, MadeVoice } from "@/types";
import {
  endpointVoiceCloner,
  type CloneRequest,
  type VoiceCloner,
  type VoiceClonerOptions,
} from "~/providers/clone";
import type { ProviderTarget } from "~/providers/target";
import { jsonBody, type TestApi } from "./server";

/** A saved speech endpoint that can clone a voice; Fish Audio's unless `over` says otherwise. */
export const cloneEndpoint = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: "fish",
  name: "Fish Audio",
  baseUrl: "https://api.fish.audio/v1",
  model: "s2.1-pro",
  concurrency: 1,
  enabled: true,
  latency: 0,
  failRate: 0,
  price: 0,
  needsKey: true,
  maxChars: 0,
  splitAt: "sentence",
  voices: [],
  history: [],
  failures: 0,
  rateLimits: 0,
  backoffUntil: 0,
  apiKey: "sk-fish",
  ...over,
});

/** Fish Audio's unless `over` says otherwise. A clone ignores its narration retries/cooldown. */
export const cloneTarget = (over: Partial<ProviderTarget> = {}): ProviderTarget => ({
  id: "fish",
  name: "Fish Audio",
  baseUrl: "https://api.fish.audio/v1",
  model: "s2.1-pro",
  apiKey: "sk-fish",
  needsKey: true,
  timeoutSec: 5,
  maxRetries: 2,
  cooldownSec: 0,
  ...over,
});

// ---------- the first bytes of each kind of file ----------

const ascii = (text: string): number[] => Array.from(new TextEncoder().encode(text));
const bytes = (...parts: (string | number[])[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? ascii(p) : p)));

/** An Ogg stream's first page, one segment long, whose packet starts with `packet`. */
const oggPage = (packet: string | number[]) =>
  bytes("OggS", [0, 2, ...Array<number>(20).fill(0), 1, 19], packet);

export const HEADS = {
  wav: bytes("RIFF", [36, 0, 0, 0], "WAVEfmt "),
  mp3Tagged: bytes("ID3", [4, 0, 0, 0, 0, 0, 0]),
  mp3Frame: bytes([0xff, 0xfb, 0x90, 0x64]),
  m4a: bytes([0, 0, 0, 32], "ftypM4A ", [0, 0, 0, 0]),
  m4aAndroid: bytes([0, 0, 0, 24], "ftypisom", [0, 0, 2, 0]),
  opus: oggPage("OpusHead"),
  flac: bytes("fLaC", [0, 0, 0, 34]),
  // and what is none of those
  vorbis: oggPage([1, ...ascii("vorbis")]),
  aac: bytes([0xff, 0xf1, 0x50, 0x80]),
  webm: bytes([0x1a, 0x45, 0xdf, 0xa3]),
  heic: bytes([0, 0, 0, 24], "ftypheic", [0, 0, 0, 0]),
  text: bytes("Hello, this is not audio."),
};

/** A sample file whose first bytes are `head`, padded to `size`. */
export const sampleFile = (
  name = "take-1.wav",
  head: Uint8Array = HEADS.wav,
  type = "audio/wav",
  size = 1024,
): File => {
  const body = new Uint8Array(Math.max(size, head.length)).fill(7);
  body.set(head);
  return new File([body], name, { type });
};

// ---------- the route ----------

export async function saved(api: TestApi, ...endpoints: Endpoint[]): Promise<void> {
  const { status } = await api.request("/api/endpoints", {
    ...jsonBody({ endpoints, profiles: [], credentials: [] }),
    method: "PUT",
  });
  expect(status).toBe(200);
}

/**
 * The clone form: fields, files under `samples`, and one `transcripts` entry per file when given.
 */
export function cloneForm(
  fields: Record<string, string>,
  samples: File[],
  transcripts?: string[],
): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const [i, s] of samples.entries()) {
    f.append("samples", s, s.name);
    if (transcripts) f.append("transcripts", transcripts[i] ?? "");
  }
  return f;
}

/** The clone form's fields for endpoint `id`. */
export const cloneFields = (id = "fish") => ({ id, title: "Mara" });

export const postClone = (api: TestApi, body: FormData) =>
  api.request<ClonedVoice & { error?: { message: string } }>("/api/endpoints/voices/clone", {
    method: "POST",
    body,
  });

// ---------- cloners ----------

/** A cloner that remembers what it was asked and answers with `voice`, or a voice by its title. */
export function remembering(voice?: Partial<MadeVoice>): {
  cloner: VoiceCloner;
  asked: CloneRequest[];
} {
  const asked: CloneRequest[] = [];
  return {
    asked,
    cloner: {
      async clone(_target, request) {
        asked.push(request);
        return { id: "new-voice-id", label: request.title, gender: "?", ...voice };
      },
    },
  };
}

/** A `fetch` that remembers each request and answers it with `answer`, and the real cloner over it. */
export function answering(
  answer: (init: RequestInit, n: number) => Response | Promise<Response>,
  options: VoiceClonerOptions = {},
) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return answer(init, sent.length);
  }) as unknown as typeof globalThis.fetch;
  return { sent, cloner: endpointVoiceCloner({ fetch, backoffMs: () => 0, ...options }) };
}

/**
 * Failures a retry could fix (5xx, rate limit, no answer) and what `name`'s cloner should say. A
 * clone is never retried after them.
 */
export const unlucky = (name: string): [() => Response | Promise<Response>, string][] => [
  [() => new Response("busy", { status: 503 }), `${name} answered 503: busy`],
  [() => new Response("slow down", { status: 429 }), `${name} answered 429`],
  [
    () => Promise.reject(new TypeError("connection reset")),
    `${name} could not be reached: connection reset`,
  ],
];
