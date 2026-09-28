// The provider presets, one catalogue per kind of endpoint (`speech.ts`, `scripting.ts`), and the
// lookups the pages and the store use. `lib/endpoints.ts` re-exports all of it, which is where
// callers import it from.
import type { EndpointKind } from "@/types";
import type { ScriptingPreset, TtsPreset } from "@/lib/presets/preset";
import { SCRIPTING_PRESETS } from "@/lib/presets/scripting";
import { TTS_PRESETS } from "@/lib/presets/speech";

export type { Preset, ScriptingPreset, TtsPreset } from "@/lib/presets/preset";
export { SCRIPTING_PRESETS, TTS_PRESETS };

/** The presets for one kind of endpoint. */
export function presetsOf(kind: "tts"): TtsPreset[];
export function presetsOf(kind: "scripting"): ScriptingPreset[];
export function presetsOf(kind: EndpointKind): (TtsPreset | ScriptingPreset)[];
export function presetsOf(kind: EndpointKind): (TtsPreset | ScriptingPreset)[] {
  return kind === "tts" ? TTS_PRESETS : SCRIPTING_PRESETS;
}

export const presetById = (id: string): TtsPreset | undefined =>
  TTS_PRESETS.find((p) => p.id === id);

export const scriptingPresetById = (id: string): ScriptingPreset | undefined =>
  SCRIPTING_PRESETS.find((p) => p.id === id);
