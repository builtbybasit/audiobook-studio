// Which wire module speaks to which provider.
//
// Keyed by the ids in `lib/providers/`, and a `Record` of them, so a provider described there and
// given no wire module here does not compile. The speech provider and the voice lister ask this
// for the module an endpoint's base URL speaks and go through it; neither knows one provider from
// another.
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

export const SPEECH_WIRES: Record<SpeechProviderId, SpeechWire> = {
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

/** The provider a target's base URL speaks, and the module that speaks to it. */
export function wireOf(target: ProviderTarget) {
  const shape = speechProviderOf(target);
  return { shape, wire: SPEECH_WIRES[shape.id] };
}
