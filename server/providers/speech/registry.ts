// Which wire module speaks to which provider. A `Record` over the ids in `lib/providers/`, so a
// provider with no module does not compile. `simulated` has none: it is answered before asking.
import { speechProviderOf, type SpeechProviderId } from "@/lib/providers";
import type { ProviderTarget } from "~/providers/target";
import { breezeBlueWire } from "~/providers/speech/breezeblue";
import { breezeCppWire } from "~/providers/speech/breezecpp";
import { cartesiaWire } from "~/providers/speech/cartesia";
import { elevenLabsWire } from "~/providers/speech/elevenlabs";
import { fishWire } from "~/providers/speech/fish";
import { geminiWire } from "~/providers/speech/gemini";
import { miniMaxWire } from "~/providers/speech/minimax";
import { compatibleWire, openaiWire } from "~/providers/speech/openai";
import { qwenWire } from "~/providers/speech/qwen";
import type { SpeechWire } from "~/providers/speech/wire";

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
  breezecpp: breezeCppWire,
  compatible: compatibleWire,
};

/** Throws for a simulated target, which has no wire. */
export function wireOf(target: ProviderTarget) {
  const shape = speechProviderOf(target);
  if (shape.id === "simulated")
    throw new Error(`${target.name} is simulated: it is answered here and has no wire`);
  return { shape, wire: SPEECH_WIRES[shape.id] };
}
