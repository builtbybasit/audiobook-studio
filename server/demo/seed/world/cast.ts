// Seeded casting: OpenAI for dialogue, local Kokoro for two books' Narrators, and one Drowned
// character on the paused Azure proxy (a routing blocker). Entries are built fresh, `aliases` too.
import { voiceRef } from "~/demo/seed/fixtures/voices";
import { PALETTE } from "~/demo/seed/fixtures/style";
import type { BookSeed } from "~/demo/seed/fixtures/books";
import type { Character, Gender, VoiceRef } from "@/types";

const oa = (v: string): VoiceRef => voiceRef("openai", v);
const kk = (v: string): VoiceRef => voiceRef("local", v);
const fish = (v: string): VoiceRef => voiceRef("fish", v);
const gem = (v: string): VoiceRef => voiceRef("gemini", v);

/**
 * Speakers routed by how the endpoint bills: one book spans character, byte and token billing.
 * Elder Mo's lines get Hanzi from the dictionary, so his bytes diverge from his characters.
 */
const SEED_ROUTE: Record<string, Record<string, VoiceRef>> = {
  cliche: {
    "Elder Mo": fish("fish0000000000000000000000000003"),
    "Xiao Lan": gem("Kore"),
  },
};

const SEED_VOICE: Record<Gender, string[]> = {
  m: ["onyx", "echo", "ash", "ballad", "verse"],
  f: ["nova", "shimmer", "coral", "sage"],
  n: ["alloy", "fable"],
  "?": ["alloy"],
};

const NARRATOR_VOICE: Record<string, VoiceRef> = {
  cliche: kk("bm_george"),
  starforge: oa("sage"),
  drowned: kk("bf_emma"),
  gates: kk("af_heart"),
};

export function makeCharacters(b: BookSeed): Character[] {
  return [
    ...b.cast.map((c, i) => ({
      ...c,
      aliases: [...c.aliases],
      voice:
        c.name === "Narrator"
          ? NARRATOR_VOICE[b.id]
          : (SEED_ROUTE[b.id]?.[c.name] ??
            oa(SEED_VOICE[c.gender][i % SEED_VOICE[c.gender].length])),
      style: "",
      color: PALETTE[i % PALETTE.length],
      major: true,
    })),
    ...b.minor.map(([name, gender], i) => ({
      name,
      aliases: [],
      gender,
      description: "",
      voice: null,
      style: "",
      color: PALETTE[(i + 5) % PALETTE.length],
      major: false,
    })),
  ];
}

export { newSpeaker } from "@/lib/cast";
