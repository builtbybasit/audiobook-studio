// The provider presets, one catalogue per kind of endpoint (`speech.ts`, `scripting.ts`,
// `transcription.ts`), and the lookups the pages and the store use. `lib/endpoints.ts` re-exports
// all of it, which is where callers import it from.
import type { EndpointKind } from "@/types";
import type { ScriptingPreset, TranscriptionPreset, TtsPreset } from "@/lib/presets/preset";
import { SCRIPTING_PRESETS } from "@/lib/presets/scripting";
import { TTS_PRESETS } from "@/lib/presets/speech";
import { TRANSCRIPTION_PRESETS } from "@/lib/presets/transcription";

export type {
  AnyPreset,
  Preset,
  ScriptingPreset,
  TranscriptionPreset,
  TtsPreset,
} from "@/lib/presets/preset";
export { SCRIPTING_PRESETS, TRANSCRIPTION_PRESETS, TTS_PRESETS };

/** Every kind's catalogue, so a kind added to `EndpointKind` cannot compile without one. */
const CATALOGUES = {
  scripting: SCRIPTING_PRESETS,
  tts: TTS_PRESETS,
  transcription: TRANSCRIPTION_PRESETS,
} satisfies Record<EndpointKind, unknown[]>;

/** The presets for one kind of endpoint. */
export const presetsOf = <K extends EndpointKind>(kind: K): (typeof CATALOGUES)[K] =>
  CATALOGUES[kind];

export const presetById = (id: string): TtsPreset | undefined =>
  TTS_PRESETS.find((p) => p.id === id);

export const scriptingPresetById = (id: string): ScriptingPreset | undefined =>
  SCRIPTING_PRESETS.find((p) => p.id === id);

export const transcriptionPresetById = (id: string): TranscriptionPreset | undefined =>
  TRANSCRIPTION_PRESETS.find((p) => p.id === id);
