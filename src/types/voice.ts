// Voices, and how a speaker resolves to one. A character stores a `VoiceRef`; the rest is what the
// pickers and routing checks read back out of it.
import type { Gender, VoiceRef } from "@/types/common";
import type { Endpoint } from "@/types/endpoint";

/** A multiplier: 1 is the voice's own pace, above 1 faster. */
export interface SpeedRange {
  min: number;
  max: number;
}

export interface Voice {
  id: string;
  gender: Gender;
  label: string;
  /** pace for every speaker on it who sets none (`speakerSpeed`); absent = 1 */
  speed?: number;
}

/** A catalogue result not yet on an endpoint. Adding one keeps only the `Voice`. */
export interface FoundVoice extends Voice {
  /** the provider's own recording (Fish public voices): free to play */
  sample?: { url: string; text: string };
}

export interface MadeVoice extends Voice {
  /** what the person must do before using it, e.g. verify it on the provider */
  warning?: string;
}

export interface ClonedVoice extends MadeVoice {
  samplesKept: boolean;
}

export interface KeptSample {
  /** `<sha>.<ext>`, the name the server keeps and serves it under */
  file: string;
  /** the picked file's name */
  name: string;
  format: "wav" | "mp3" | "m4a" | "opus" | "flac";
  bytes: number;
  /** when given, so the voice can be made again elsewhere */
  transcript?: string;
}

export interface KeptVoiceSamples {
  voiceId: string;
  /** the voice's name when its samples were kept */
  title: string;
  /** epoch ms */
  madeAt: number;
  samples: KeptSample[];
}

export interface VoiceOption {
  value: VoiceRef;
  label: string;
  group: string;
  hint: string;
  disabled: boolean;
}

export interface ResolvedVoice {
  endpoint: Endpoint;
  voice: Voice;
}

/**
 * Which voice renders a speaker: a linked persona with none takes their character's; anyone else
 * with none falls back to the Character voice, then the Narrator's.
 */
export interface EffectiveVoice {
  ref: VoiceRef | null;
  /** false when borrowed */
  own: boolean;
  /** `speakerVoice` */
  from: "own" | "character" | "narrator" | "persona";
  /** for a linked persona, the character whose voice they use */
  of?: string;
  voice: string | null;
  label: string | null;
  endpoint: Endpoint | null;
}

export type RoutingIssueKind = "missing" | "paused" | "nokey";

export interface RoutingIssue {
  name: string;
  ref: VoiceRef;
  reason: string;
  kind: RoutingIssueKind;
  endpoint?: Endpoint;
}
