// Seeded casting. OpenAI for dialogue, the free local Kokoro for the Narrator on two books (cheap
// narration, premium dialogue); one Drowned character sits on the paused Azure proxy, which is a
// routing blocker the Cast page exists to show you how to fix.
//
// Every entry is built fresh, `aliases` included, so a merge or a rename in one world can never
// reach back into the read-only seeds in `fixtures/books.ts`.
import { voiceRef } from "../fixtures/voices";
import { PALETTE } from "../fixtures/style";
import type { BookSeed } from "../fixtures/books";
import type { Character, Gender, VoiceRef } from "@/types";

const oa = (v: string): VoiceRef => voiceRef("openai", v);
const kk = (v: string): VoiceRef => voiceRef("local", v);

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
          : oa(SEED_VOICE[c.gender][i % SEED_VOICE[c.gender].length]),
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

/** A walk-on speaker the LLM turned up that the cast has no entry for yet. */
export const newSpeaker = (name: string, castSize: number): Character => ({
  name,
  aliases: [],
  gender: "?",
  description: "",
  voice: null,
  style: "",
  color: PALETTE[castSize % PALETTE.length],
  major: false,
  isNew: true,
});
