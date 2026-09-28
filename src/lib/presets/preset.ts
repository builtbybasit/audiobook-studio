// What a preset is, shared by both kinds' catalogues.
import type { Endpoint, PricingConfig, Profile } from "@/types";
import { newPricing } from "@/lib/pricing";

/** What a provider's "add this endpoint" form should be filled in with. Everything here is a
 *  starting point the user can still edit; only fields a provider genuinely pins down are set.
 *  Prices are the provider's published card on the date beside them — check them against your
 *  own plan, since a budget is held to them. */
export interface Preset<T> {
  id: string;
  label: string;
  hint: string;
  /** shown under the picker once chosen — the caveat that belongs with this choice */
  note?: string;
  /** the heading it is listed under in the picker, when a kind has enough presets to need them */
  group?: string;
  apply: Partial<T>;
}
export type TtsPreset = Preset<Endpoint>;
/** A chat model the scripting queue can send a chapter to: anything serving OpenAI's
 *  `/chat/completions`, which is the only request shape the scripting provider makes. */
export type ScriptingPreset = Preset<Profile>;

/** A preset's rate card. Its windows and dates are read in UTC, and a card with none records UTC
 *  too, rather than the timezone of whichever machine happened to load the catalogue. */
export const presetPricing = (over: Partial<PricingConfig> = {}): PricingConfig =>
  newPricing({ timezone: "UTC", ...over });
