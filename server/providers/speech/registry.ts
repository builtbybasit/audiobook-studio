// Which wire module speaks to which provider.
//
// Keyed by the ids in `lib/providers/`, and a `Record` of them, so a provider described there and
// given no wire module here does not compile. The speech provider and the voice lister ask this
// for the module an endpoint's base URL speaks and go through it; neither knows one provider from
// another. The one id with no module is `simulated`: nothing is sent for a simulated endpoint, so
// both answer it themselves (`simulatedSpeech.ts`) before they would ask.
import { speechProviderOf, type SpeechProviderId } from "@/lib/providers";
import type { ProviderTarget } from "~/providers/target";
import { breezeBlueWire } from "~/providers/speech/breezeblue";
import { cartesiaWire } from "~/providers/speech/cartesia";
import { elevenLabsWire } from "~/providers/speech/elevenlabs";
import { fishWire } from "~/providers/speech/fish";
import { geminiWire } from "~/providers/speech/gemini";
import { miniMaxWire } from "~/providers/speech/minimax";
import { compatibleWire, openaiWire } from "~/providers/speech/openai";
import { qwenWire } from "~/providers/speech/qwen";
import type { SpeechWire } from "~/providers/speech/wire";

/** The providers a request is sent to. */
type WiredProviderId = Exclude<SpeechProviderId, "simulated">;

export const SPEECH_WIRES: Record<WiredProviderId, SpeechWire> = {
  fish: fishWire,
  openai: openaiWire,
  gemini: geminiWire,
  elevenlabs: elevenLabsWire,
  breezeblue: breezeBlueWire,
  minimax: miniMaxWire,
  cartesia: cartesiaWire,
  qwen: qwenWire,
  compatible: compatibleWire,
};

/**
 * The provider a target's base URL speaks, and the module that speaks to it. A simulated target has
 * none, and asking is a mistake here rather than a request anywhere.
 */
export function wireOf(target: ProviderTarget) {
  const shape = speechProviderOf(target);
  if (shape.id === "simulated")
    throw new Error(`${target.name} is simulated: it is answered here and has no wire`);
  return { shape, wire: SPEECH_WIRES[shape.id] };
}
