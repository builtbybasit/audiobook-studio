// Which provider a speech endpoint speaks. The first whose `matches` takes the base URL wins;
// `compatible` takes anything, so it is last. A new provider also needs its wire module under
// `server/providers/speech/` (the server registry will not compile without it).
import type { Endpoint } from "@/types";
import { breezeblue } from "@/lib/providers/breezeblue";
import { breezecpp } from "@/lib/providers/breezecpp";
import { cartesia } from "@/lib/providers/cartesia";
import { elevenlabs } from "@/lib/providers/elevenlabs";
import { fish } from "@/lib/providers/fish";
import { gemini } from "@/lib/providers/gemini";
import { minimax } from "@/lib/providers/minimax";
import { compatible, openai } from "@/lib/providers/openai";
import { qwen } from "@/lib/providers/qwen";
import { simulated } from "@/lib/providers/simulated";
import type {
  CloneSupport,
  SpeechProviderShape,
  SpeedRange,
  TagSyntax,
} from "@/lib/providers/types";
export {
  isSimulated,
  SIMULATED_BASE_URL,
  SIMULATED_SCRIPTING_MODEL,
  SIMULATED_SPEECH_MODEL,
  SIMULATED_TRANSCRIPTION_MODEL,
  SIMULATED_VOICES,
} from "@/lib/providers/simulated";

export { BRACKETS } from "@/lib/providers/types";
export type {
  CloneFee,
  CloneSupport,
  FormatSupport,
  SampleFormat,
  SpeechProviderId,
  SpeechProviderShape,
  SpeedRange,
  TagSyntax,
} from "@/lib/providers/types";

export const SPEECH_PROVIDERS: readonly SpeechProviderShape[] = [
  simulated,
  fish,
  gemini,
  elevenlabs,
  breezeblue,
  minimax,
  cartesia,
  qwen,
  openai,
  breezecpp,
  compatible,
];

/** `Endpoint.server` when set, else by base URL. */
export const speechProviderOf = (e: Pick<Endpoint, "baseUrl" | "server">): SpeechProviderShape =>
  (e.server && SPEECH_PROVIDERS.find((p) => p.id === e.server)) ||
  (SPEECH_PROVIDERS.find((p) => p.matches(e.baseUrl)) ?? compatible);

/** Null when the provider cannot clone for this endpoint's model or `makesVoices` opt-in. */
export function cloningOf(
  e: Pick<Endpoint, "baseUrl" | "server" | "model" | "makesVoices">,
): CloneSupport | null {
  const cloning = speechProviderOf(e).cloning;
  if (cloning?.optIn && !e.makesVoices) return null;
  if (!cloning?.models) return cloning;
  return cloning.models.includes(e.model.trim()) ? cloning : null;
}

/** The models to switch to so the endpoint can clone; empty when it already can, or never can. */
export function cloneModelsFor(
  e: Pick<Endpoint, "baseUrl" | "server" | "model">,
): readonly string[] {
  const cloning = speechProviderOf(e).cloning;
  return cloning?.models && !cloningOf(e) ? cloning.models : [];
}

export const tagSyntaxOf = (e: Pick<Endpoint, "baseUrl" | "server" | "model">): TagSyntax | null =>
  speechProviderOf(e).tags(e.model ?? "");

/** What a speaker's `speed` may be; outside an endpoint's own range it is stretched here. */
export const SPEAKER_SPEED: SpeedRange = { min: 0.5, max: 2 };

type SpeedEndpoint = Pick<Endpoint, "baseUrl" | "server" | "model" | "speedRange">;

/** What the server declared, else the provider's docs. */
export const speedOf = (e: SpeedEndpoint): SpeedRange | null =>
  e.speedRange ?? speechProviderOf(e).speed(e.model ?? "");

/**
 * How a speaker's speed is made: `sent` with the request when the endpoint takes it, else
 * `stretched` from the clip here. Both null at 1 or with no endpoint to ask.
 */
export function speedSplit(
  e: SpeedEndpoint | null | undefined,
  speed: number | null | undefined,
): { sent: number | null; stretched: number | null } {
  if (!e || speed == null || speed === 1) return { sent: null, stretched: null };
  const range = speedOf(e);
  return range && speed >= range.min && speed <= range.max
    ? { sent: speed, stretched: null }
    : { sent: null, stretched: speed };
}
