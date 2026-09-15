// Voices, and how a speaker is resolved to one. A character stores a `VoiceRef`; everything else
// here is what the pickers and the routing checks read back out of it.
import type { Gender, VoiceRef } from "./common";
import type { Endpoint } from "./endpoint";

export interface Voice {
  id: string;
  gender: Gender;
  label: string;
}

/** One option row in the voice pickers. */
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

/** Which voice actually renders a speaker, after falling back to the Narrator's. */
export interface EffectiveVoice {
  ref: VoiceRef | null;
  /** false when the speaker is borrowing the Narrator's voice */
  own: boolean;
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
