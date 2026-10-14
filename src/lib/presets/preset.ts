import type { Endpoint, PricingConfig, Profile, Transcriber } from "@/types";
import { newPricing } from "@/lib/pricing";

/** A starting point the user can edit; only fields a provider pins down are set. */
export interface Preset<T> {
  id: string;
  label: string;
  hint: string;
  /** shown under the picker once chosen */
  note?: string;
  /** the picker heading */
  group?: string;
  apply: Partial<T>;
}
export type TtsPreset = Preset<Endpoint>;
export type ScriptingPreset = Preset<Profile>;
export type TranscriptionPreset = Preset<Transcriber>;
export type AnyPreset = TtsPreset | ScriptingPreset | TranscriptionPreset;

/** In UTC, not the timezone of whichever machine loaded the catalogue. */
export const presetPricing = (over: Partial<PricingConfig> = {}): PricingConfig =>
  newPricing({ timezone: "UTC", ...over });
