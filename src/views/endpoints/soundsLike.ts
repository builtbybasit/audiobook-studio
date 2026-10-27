// What a voice row says of the likeness report: chips for the nearest voices, warnings for a kept
// recording shared with another voice or samples of different people, and the clone check's line.
import { bandOf, likenessKey, likenessOf, NEAREST, type LikenessBand } from "@/lib/voiceLikeness";
import type { AlikeVoice, VoiceLikeness } from "@/types";

/** A voice's label and its endpoint's name; ids where nothing saved names them. */
export type FindVoice = (
  endpointId: string,
  voiceId: string,
) => { label: string; endpoint: string };

export interface SoundsLike {
  chips: { key: string; text: string; tip: string; same: boolean }[];
  warnings: string[];
}

const BAND_WORD: Record<LikenessBand, string> = { same: "same voice", alike: "very alike" };

/** "Mara", or "Mara on Fish Audio" when it is another endpoint's. */
function nameOf(a: AlikeVoice, here: string, find: FindVoice): string {
  const { label, endpoint } = find(a.endpointId, a.voiceId);
  return a.endpointId === here ? label : `${label} on ${endpoint}`;
}

/** Null when there is nothing to show. */
export function soundsLike(l: VoiceLikeness, find: FindVoice): SoundsLike | null {
  const here = l.endpointId;
  // a twin is said as a warning, not again as a chip
  const twins = new Set(l.twins.map((t) => likenessKey(t.endpointId, t.voiceId)));
  const chips = l.nearest
    .flatMap((a) => {
      const band = bandOf(a.score);
      const key = likenessKey(a.endpointId, a.voiceId);
      if (!band || twins.has(key)) return [];
      const away = a.endpointId === here ? "" : ` · on ${find(a.endpointId, a.voiceId).endpoint}`;
      return [
        {
          key,
          text: `${nameOf(a, here, find)} · ${BAND_WORD[band]}`,
          tip: `${a.score.toFixed(2)}${away}`,
          same: band === "same",
        },
      ];
    })
    .slice(0, NEAREST);
  const warnings = [
    l.twins.length
      ? `Same recording as ${l.twins.map((t) => nameOf(t, here, find)).join(", ")}`
      : "",
    l.mixed ? "Its samples sound like different voices" : "",
  ].filter(Boolean);
  return chips.length || warnings.length ? { chips, warnings } : null;
}

/** After a voice's samples changed: the one line to toast when it now doubles another, else null. */
export function doubleOf(
  report: readonly VoiceLikeness[],
  endpointId: string,
  voiceId: string,
  find: FindVoice,
): string | null {
  const l = likenessOf(report, endpointId, voiceId);
  if (!l) return null;
  const own = find(endpointId, voiceId).label;
  const twin = l.twins[0];
  if (twin) return `${own} keeps the same recording as ${nameOf(twin, endpointId, find)}`;
  const same = l.nearest.find((a) => bandOf(a.score) === "same");
  return same ? `${own} sounds like ${nameOf(same, endpointId, find)} — same voice` : null;
}
