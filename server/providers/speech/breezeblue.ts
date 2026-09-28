// A line spoken by BreezeBlue's hosted API (https://docs.breezeblue.ai), which copies ElevenLabs'
// shape — path, key header, `output_format`, the model list the Test button reads — and adds an
// `instructions` field for delivery, which it is sent when the line has some. Everything but the
// instructions and the voice list is ElevenLabs' module (`elevenlabs.ts`).
//
// Its instructions guide says to "keep `instructions` within 1,000 characters", so a line whose
// speaker's style and direction together run longer fails before a request, saying so, rather than
// being refused or cut by BreezeBlue after the credit is spent.
import type { Voice } from "@/types";
import { BREEZE_INSTRUCTION_CHARS } from "@/lib/providers/breezeblue";
import { call, ProviderError } from "~/providers/http";
import {
  elevenLabsHeaders,
  elevenLabsRequest,
  elevenLabsRoot,
  modelsProbe,
  VOICE_PAGES,
} from "~/providers/speech/elevenlabs";
import type { SpeechWire } from "~/providers/speech/wire";

export const breezeBlueWire: SpeechWire = {
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
