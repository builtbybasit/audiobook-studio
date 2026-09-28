// Voices, and how a speaker is resolved to one. A character stores a `VoiceRef`; everything else
// here is what the pickers and the routing checks read back out of it.
import type { Gender, VoiceRef } from "@/types/common";
import type { Endpoint } from "@/types/endpoint";

export interface Voice {
  id: string;
  gender: Gender;
  label: string;
}

/**
 * A voice a provider's catalogue answered with, before anyone adds it to an endpoint. Fish Audio's
 * public voices come with a recording of their own; adding one keeps only the `Voice`.
 */
export interface FoundVoice extends Voice {
  /** the provider's own recording of this voice — free to play, nothing is rendered */
  sample?: { url: string; text: string };
}

/** A voice made here from recordings, as the provider answered; `samplesKept` says whether they were. */
export interface ClonedVoice extends Voice {
  samplesKept: boolean;
}

/** One kept recording a voice was made from. */
export interface KeptSample {
  /** `<sha>.<ext>`, the name the server keeps and serves it under */
  file: string;
  /** the name the picked file had */
  name: string;
  format: "wav" | "mp3" | "m4a" | "opus" | "flac";
  bytes: number;
}

/** The recordings kept for one voice, and the consent they were kept under. */
export interface KeptVoiceSamples {
  voiceId: string;
  /** what the voice was called when its recordings were kept */
  title: string;
  /** epoch ms */
  madeAt: number;
  /** epoch ms the person ticked the box, and the sentence they ticked */
  consentAt: number;
  consentText: string;
  samples: KeptSample[];
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
