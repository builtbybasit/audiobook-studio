// How alike two voices are, from speaker fingerprints of their kept samples (ECAPA cosine).
// Cut points from the user's 72 game voices, 2026-10-27: the same character's two samples scored
// 0.60–0.83, one actor's two characters 0.60–0.71, unrelated voices at most 0.64 (p99 0.51).
import type { VoiceLikeness } from "@/types";

/** At or above: one voice (another sample, or the same actor). */
export const SAME_AT = 0.7;
/** At or above: very alike; shared actors land here too. Below it a voice is not offered as alike. */
export const ALIKE_AT = 0.55;
/** At or above, or the very same file: one recording kept twice. */
export const TWIN_AT = 0.95;
/** A voice whose own samples score below this against each other sounds like two voices. */
export const MIXED_BELOW = 0.45;
/** Matches listed per voice. */
export const NEAREST = 3;

export type LikenessBand = "same" | "alike";

export function bandOf(score: number): LikenessBand | null {
  return score >= SAME_AT ? "same" : score >= ALIKE_AT ? "alike" : null;
}

export const likenessKey = (endpointId: string, voiceId: string): string =>
  `${endpointId}/${voiceId}`;

/** The report entry for one voice, if it has one. */
export function likenessOf(
  report: readonly VoiceLikeness[],
  endpointId: string,
  voiceId: string,
): VoiceLikeness | undefined {
  return report.find((r) => r.endpointId === endpointId && r.voiceId === voiceId);
}
