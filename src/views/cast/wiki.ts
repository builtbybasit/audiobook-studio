// What a wiki page would fill, in the words the Cast page shows.
import { GENDER } from "@/lib/scriptReview";
import { wikiPatch } from "@/stores/cast";
import type { Character, SpeakerWikiFill } from "@/types";

/** One chip per field the page would fill; none when it has nothing new. */
export function fillChips(c: Character, fill: SpeakerWikiFill["fill"]): string[] {
  const p = wikiPatch(c, fill);
  const had = c.voiceType ?? {};
  const vt = p.voiceType ?? {};
  return [
    p.gender && GENDER[p.gender],
    p.age,
    !had.pitch && vt.pitch && `${vt.pitch} pitch`,
    !had.texture && vt.texture,
    ...(had.delivery?.length ? [] : (vt.delivery ?? [])),
  ].filter((x): x is string => !!x);
}

/** An http(s) address, as the server takes it. */
export function webAddress(s: string): boolean {
  try {
    return /^https?:$/.test(new URL(s.trim()).protocol);
  } catch {
    return false;
  }
}
