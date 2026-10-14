// BreezeBlue (https://docs.breezeblue.ai) copies ElevenLabs' shape (`elevenlabs.ts`) and adds an
// `instructions` field, kept "within 1,000 characters" per its guide, so a longer one fails before
// any credit is spent.
import type { Voice } from "@/types";
import { BREEZE_INSTRUCTION_CHARS, breezeblue } from "@/lib/providers/breezeblue";
import { call, ProviderError } from "~/providers/http";
import {
  verifyFirst,
  elevenLabsHeaders,
  elevenLabsKeyHeader,
  elevenLabsRequest,
  elevenLabsRoot,
  modelsProbe,
  VOICE_PAGES,
} from "~/providers/speech/elevenlabs";
import type { SpeechWire } from "~/providers/speech/wire";

/** "Up to 80 characters", rejected only after the paid upload, so checked first. */
const BREEZE_NAME_CHARS = 80;
/** Required by the save; BreezeBlue detects but does not answer the language. */
const BREEZE_CLONE_LANGUAGE = "en";

export const breezeBlueWire: SpeechWire = {
  // Two requests (https://docs.breezeblue.ai/guides/voice-clone): the paid preview (100 credits),
  // then a save. A failed save names the preview id so the person can save it rather than pay again.
  async clone(target, request, signal, options) {
    const chars = Array.from(request.title).length;
    if (chars > BREEZE_NAME_CHARS)
      throw new ProviderError(
        `${target.name} takes a voice name of up to ${BREEZE_NAME_CHARS} characters, and this one ` +
          `runs to ${chars}. Shorten it.`,
        0,
        false,
      );
    const root = elevenLabsRoot(target.baseUrl);
    const form = new FormData();
    form.set("name", request.title);
    for (const sample of request.samples) form.append("files", sample.blob, sample.name);
    const made = await call(
      target,
      `${root}/voice-previews/clone`,
      // no content-type: the multipart boundary is the form's to write
      { method: "POST", headers: elevenLabsKeyHeader(target), body: form },
      { signal, ...options },
    );
    const preview = (await made.json().catch(() => null)) as {
      generated_voice_id?: unknown;
      requires_verification?: unknown;
    } | null;
    const previewId = preview?.generated_voice_id;
    if (typeof previewId !== "string" || !previewId)
      throw new ProviderError(
        `${target.name} answered ${made.status} without the new voice's preview id`,
        made.status,
        false,
      );

    const unsaved = (said: string) =>
      `${target.name} made the voice's preview (${previewId}) but did not save it: ` +
      `${said.replace(/\.$/, "")}. ` +
      `The preview is paid for; save it on ${target.name} rather than cloning again.`;
    let saved: Response;
    try {
      saved = await call(
        target,
        `${root}/voice-previews/${encodeURIComponent(previewId)}/save`,
        {
          method: "POST",
          headers: elevenLabsHeaders(target),
          body: JSON.stringify({ voice_name: request.title, language_code: BREEZE_CLONE_LANGUAGE }),
        },
        { signal, ...options },
      );
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      throw new ProviderError(unsaved(e.message), e.status, e.retryable, e.rateLimited);
    }
    const voice = (await saved.json().catch(() => null)) as {
      voice_id?: unknown;
      name?: unknown;
      gender?: unknown;
    } | null;
    if (typeof voice?.voice_id !== "string" || !voice.voice_id)
      throw new ProviderError(
        unsaved(`it answered ${saved.status} without the saved voice's id`),
        saved.status,
        false,
      );
    const name =
      typeof voice.name === "string" && voice.name.trim() ? voice.name.trim() : request.title;
    const gender = (typeof voice.gender === "string" ? voice.gender : "").toLowerCase();
    return {
      id: voice.voice_id,
      label: name,
      gender: gender === "male" ? "m" : gender === "female" ? "f" : "?",
      ...(preview?.requires_verification === true ? { warning: verifyFirst(target) } : {}),
    };
  },

  request(input, target, voice) {
    const instructions = input.instructions.trim();
    const chars = Array.from(instructions).length;
    if (chars > BREEZE_INSTRUCTION_CHARS)
      throw new ProviderError(
        `${target.name} takes up to ${BREEZE_INSTRUCTION_CHARS.toLocaleString("en")} characters ` +
          `of instructions, and this line's style and direction run to ${chars.toLocaleString("en")}. ` +
          "Shorten the speaker's style or the line's direction.",
        0,
        false,
      );
    return elevenLabsRequest(breezeblue, input, target, voice, instructions);
  },
  probe: modelsProbe,

  /** Unlike ElevenLabs, gender is a field of its own. */
  async voices(target, signal, options) {
    const voices: Voice[] = [];
    let token: string | null = null;
    let more = true;
    for (let page = 1; more && page <= VOICE_PAGES; page++) {
      const q = token ? `?${new URLSearchParams({ next_page_token: token }).toString()}` : "";
      const res = await call(
        target,
        `${elevenLabsRoot(target.baseUrl)}/voices${q}`,
        { method: "GET", headers: elevenLabsHeaders(target) },
        { signal, ...options },
      );
      const body = (await res.json().catch(() => null)) as {
        voices?: { voice_id?: unknown; name?: unknown; gender?: unknown }[];
        has_more?: unknown;
        next_page_token?: unknown;
      } | null;
      for (const v of body?.voices ?? []) {
        if (typeof v.voice_id !== "string" || !v.voice_id) continue;
        const gender = (typeof v.gender === "string" ? v.gender : "").toLowerCase();
        voices.push({
          id: v.voice_id,
          label: typeof v.name === "string" && v.name.trim() ? v.name.trim() : v.voice_id,
          gender: gender.startsWith("m") ? "m" : gender.startsWith("f") ? "f" : "?",
        });
      }
      token = typeof body?.next_page_token === "string" ? body.next_page_token : null;
      more = body?.has_more === true && !!token;
    }
    return { voices, total: voices.length, page: 1, hasMore: more };
  },
};
