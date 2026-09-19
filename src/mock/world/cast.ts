// Seeded casting. OpenAI for dialogue, the free local Kokoro for the Narrator on two books (cheap
// narration, premium dialogue); one Drowned character sits on the paused Azure proxy, which is a
// routing blocker the Cast page exists to show you how to fix.
//
// Every entry is built fresh, `aliases` included, so a merge or a rename in one world can never
// reach back into the read-only seeds in `fixtures/books.ts`.
import { voiceRef } from "@/mock/fixtures/voices";
import { PALETTE } from "@/mock/fixtures/style";
import type { BookSeed } from "@/mock/fixtures/books";
import type { Character, Gender, VoiceRef } from "@/types";

const oa = (v: string): VoiceRef => voiceRef("openai", v);
const kk = (v: string): VoiceRef => voiceRef("local", v);
const fish = (v: string): VoiceRef => voiceRef("fish", v);
const gem = (v: string): VoiceRef => voiceRef("gemini", v);

/**
 * Speakers seeded onto a particular endpoint because of how that endpoint **bills**, not because of
 * how it sounds.
 *
 * One book is deliberately spread across three billing models, so a single narration run produces
 * character-billed, byte-billed and token-billed requests side by side and the estimate has to add
 * three different kinds of arithmetic into one figure. Elder Mo's lines are the ones the
 * pronunciation dictionary rewrites into Hanzi, which is what makes his UTF-8 byte count diverge
 * from his character count — the whole reason byte billing is a separate model.
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

// A walk-on speaker is defined once, in `@/lib/cast`, so the server's scripting job and this
// world bring one in the same way.
export { newSpeaker } from "@/lib/cast";
