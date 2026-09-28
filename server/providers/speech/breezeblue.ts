// A line spoken by BreezeBlue's hosted API (https://docs.breezeblue.ai), which copies ElevenLabs'
// shape — path, key header, `output_format`, the model list the Test button reads — and adds an
// `instructions` field for delivery, which it is sent when the line has some. Everything but the
// instructions, the voice list and cloning is ElevenLabs' module (`elevenlabs.ts`).
//
// Its instructions guide says to "keep `instructions` within 1,000 characters", so a line whose
// speaker's style and direction together run longer fails before a request, saying so, rather than
// being refused or cut by BreezeBlue after the credit is spent.
//
// A voice is cloned in two requests, as its voice-clone guide gives it
// (https://docs.breezeblue.ai/guides/voice-clone): `POST /v1/voice-previews/clone`, multipart, with
// the voice's `name` and the one sample under `files`, which answers a `generated_voice_id` — a
// preview, not yet a voice — and then `POST /v1/voice-previews/{generated_voice_id}/save`, JSON,
// which answers the saved voice and its `voice_id`. The first is the one billed, 100 credits; the
// second only takes a voice slot. So a save that fails says the preview was made, and its id,
// for the person to save it on BreezeBlue rather than pay for another.
//
// The save requires a `language_code` for the sample's language, which BreezeBlue detects but does
// not answer with; it is sent as English, which is what this app's books are read in. A sample in
// another language is refused at the save with BreezeBlue's own words. A name is held to its 80
// characters before anything is sent, since BreezeBlue rejects a longer one — after the upload.
import type { Voice } from "@/types";
import { BREEZE_INSTRUCTION_CHARS } from "@/lib/providers/breezeblue";
import { call, ProviderError } from "~/providers/http";
import {
  clonedLabel,
  elevenLabsHeaders,
  elevenLabsKeyHeader,
  elevenLabsRequest,
  elevenLabsRoot,
  modelsProbe,
  VOICE_PAGES,
} from "~/providers/speech/elevenlabs";
import type { SpeechWire } from "~/providers/speech/wire";

/** Its save reference: a voice's name is "up to 80 characters", and a longer one is rejected. */
const BREEZE_NAME_CHARS = 80;
/** The language a cloned voice is saved as; see the top of this file. */
const BREEZE_CLONE_LANGUAGE = "en";

export const breezeBlueWire: SpeechWire = {
  async clone(target, request, signal, options) {
    const chars = [...request.title].length;
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
    for (const clip of request.clips) form.append("files", clip.blob, clip.name);
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
    const gender = String(voice.gender ?? "").toLowerCase();
    return {
      id: voice.voice_id,
      label: clonedLabel(target, name, preview?.requires_verification === true),
      gender: gender === "male" ? "m" : gender === "female" ? "f" : "?",
    };
  },

  request(input, target, voice) {
    const instructions = input.instructions.trim();
    const chars = [...instructions].length;
    if (chars > BREEZE_INSTRUCTION_CHARS)
      throw new ProviderError(
        `${target.name} takes up to ${BREEZE_INSTRUCTION_CHARS.toLocaleString("en")} characters ` +
          `of instructions, and this line's style and direction run to ${chars.toLocaleString("en")}. ` +
          "Shorten the speaker's style or the line's direction.",
        0,
        false,
      );
    return elevenLabsRequest(input, target, voice, instructions);
  },
  probe: modelsProbe,

  /**
   * An account's voices, `GET /v1/voices` a page at a time, up to ten pages. Unlike ElevenLabs it
   * gives a voice's gender as a field of its own.
   */
  async voices(target, signal, options) {
    const voices: Voice[] = [];
    let token: string | null = null;
    let more = true;
    for (let page = 1; more && page <= VOICE_PAGES; page++) {
      const q = token ? `?${new URLSearchParams({ next_page_token: token })}` : "";
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
        const gender = String(v.gender ?? "").toLowerCase();
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
