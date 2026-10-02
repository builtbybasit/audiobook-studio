// Which provider a speech endpoint's base URL speaks, and what that provider is.
//
// The one list of providers, read in order: the first whose `matches` says yes to the base URL is
// the endpoint's, and `compatible` — OpenAI's shape, which the local servers copy — says yes to
// anything, so it is last. Adding a provider is a file beside this one, a line here, and its wire
// module under `server/providers/speech/`; the server's registry is keyed by the same ids, so it
// will not compile until the wire module is there too.
import type { Endpoint } from "@/types";
import { breezeblue } from "@/lib/providers/breezeblue";
import { cartesia } from "@/lib/providers/cartesia";
import { elevenlabs } from "@/lib/providers/elevenlabs";
import { fish } from "@/lib/providers/fish";
import { gemini } from "@/lib/providers/gemini";
import { minimax } from "@/lib/providers/minimax";
import { compatible, openai } from "@/lib/providers/openai";
import { qwen } from "@/lib/providers/qwen";
import { simulated } from "@/lib/providers/simulated";
import type { CloneSupport, SpeechProviderShape, TagSyntax } from "@/lib/providers/types";
export {
  isSimulated,
  SIMULATED_BASE_URL,
  SIMULATED_SCRIPTING_MODEL,
  SIMULATED_SPEECH_MODEL,
  SIMULATED_VOICES,
} from "@/lib/providers/simulated";

export type {
  CloneFee,
  CloneSupport,
  FormatSupport,
  SampleFormat,
  SpeechProviderId,
  SpeechProviderShape,
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
  compatible,
];

/** The provider a speech endpoint's base URL speaks; `compatible` when no other claims it. */
export const speechProviderOf = (e: Pick<Endpoint, "baseUrl">): SpeechProviderShape =>
  SPEECH_PROVIDERS.find((p) => p.matches(e.baseUrl)) ?? compatible;

/**
 * How an endpoint makes a voice from samples, or null when it cannot: its provider has no cloning,
 * clones only for other models than the endpoint's (`cloning.models`), or clones only where the
 * endpoint says its server makes voices (`cloning.optIn`) and this one does not.
 */
export function cloningOf(
  e: Pick<Endpoint, "baseUrl" | "model" | "makesVoices">,
): CloneSupport | null {
  const cloning = speechProviderOf(e).cloning;
  if (cloning?.optIn && !e.makesVoices) return null;
  if (!cloning?.models) return cloning;
  return cloning.models.includes(e.model.trim()) ? cloning : null;
}

/**
 * The models to switch the endpoint to for it to clone, when its provider clones only for others
 * than the endpoint's; empty when it clones already, or its provider never does.
 */
export function cloneModelsFor(e: Pick<Endpoint, "baseUrl" | "model">): readonly string[] {
  const cloning = speechProviderOf(e).cloning;
  return cloning?.models && !cloningOf(e) ? cloning.models : [];
}

/** How an endpoint's model takes expression tags, or null when it takes none. */
export const tagSyntaxOf = (e: Pick<Endpoint, "baseUrl" | "model">): TagSyntax | null =>
  speechProviderOf(e).tags(e.model ?? "");
