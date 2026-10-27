// A speaker fingerprint per kept sample: ECAPA (SpeechBrain) run by `fingerprint.py` under uv, one
// process for a batch so the model loads once. Not probed at boot: the first use downloads torch
// (about 1 GB) and the model, so it waits until someone opens the voice comparison.
export const FINGERPRINT_MODEL = "speechbrain/spkrec-ecapa-voxceleb";

export interface VoiceFingerprinter {
  /** Null when fingerprinting can run, else why not. Only a yes is remembered. */
  unavailable(): Promise<string | null>;
  /** One unit-length vector per path, in order; throws the script's one-line reason. */
  fingerprint(paths: readonly string[], signal: AbortSignal): Promise<Float32Array[]>;
}

export function ecapaFingerprinter(
  _opts: { uv?: string; ffmpeg?: string } = {},
): VoiceFingerprinter {
  return {
    unavailable: async () => "not built yet",
    fingerprint: async () => {
      throw new Error("not built yet");
    },
  };
}
