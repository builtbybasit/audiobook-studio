// The Pedalboard plugins the effects editor offers, with the range and unit of each number it
// takes, and the few words a step is shown in. The server reads any plugin it knows
// (`server/audio/effects.py`, POSITIONAL); a pasted chain may hold one this catalog has no entry
// for, and the editor then shows its numbers without sliders rather than refusing it.
import type { Layer, MixStep, PluginStep, Step } from "@/types";

export interface Param {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  default: number;
}

export const GROUPS = ["Tone", "Loudness", "Space", "Pitch", "Character"] as const;
export type Group = (typeof GROUPS)[number];

export interface PluginDef {
  label: string;
  group: Group;
  blurb: string;
  params: Record<string, Param>;
}

const p = (label: string, min: number, max: number, step: number, unit: string, d: number) =>
  ({ label, min, max, step, unit, default: d }) satisfies Param;

export const PLUGINS: Record<string, PluginDef> = {
  HighpassFilter: {
    label: "Highpass",
    group: "Tone",
    blurb: "Cuts the lows below the cutoff",
    params: { cutoff_frequency_hz: p("Cutoff", 20, 2000, 5, "Hz", 120) },
  },
  LowpassFilter: {
    label: "Lowpass",
    group: "Tone",
    blurb: "Cuts the highs above the cutoff",
    params: { cutoff_frequency_hz: p("Cutoff", 1000, 20000, 50, "Hz", 8000) },
  },
  PeakFilter: {
    label: "Peak EQ",
    group: "Tone",
    blurb: "Raises or lowers one band",
    params: {
      cutoff_frequency_hz: p("Frequency", 40, 16000, 10, "Hz", 2500),
      gain_db: p("Gain", -24, 24, 0.5, "dB", -4),
      q: p("Sharpness", 0.1, 10, 0.05, "", 1),
    },
  },
  LowShelfFilter: {
    label: "Low shelf",
    group: "Tone",
    blurb: "Tilts everything below the frequency",
    params: {
      cutoff_frequency_hz: p("Frequency", 40, 2000, 10, "Hz", 250),
      gain_db: p("Gain", -24, 24, 0.5, "dB", 3),
      q: p("Sharpness", 0.1, 4, 0.05, "", 0.707),
    },
  },
  HighShelfFilter: {
    label: "High shelf",
    group: "Tone",
    blurb: "Tilts everything above the frequency",
    params: {
      cutoff_frequency_hz: p("Frequency", 1000, 16000, 50, "Hz", 6000),
      gain_db: p("Gain", -24, 24, 0.5, "dB", -3),
      q: p("Sharpness", 0.1, 4, 0.05, "", 0.707),
    },
  },
  Compressor: {
    label: "Compressor",
    group: "Loudness",
    blurb: "Evens out loud and quiet",
    params: {
      threshold_db: p("Threshold", -60, 0, 0.5, "dB", -20),
      ratio: p("Ratio", 1, 20, 0.1, ":1", 3),
      attack_ms: p("Attack", 0.1, 100, 0.1, "ms", 1),
      release_ms: p("Release", 10, 1000, 5, "ms", 100),
    },
  },
  Limiter: {
    label: "Limiter",
    group: "Loudness",
    blurb: "A ceiling nothing goes over",
    params: {
      threshold_db: p("Ceiling", -30, 0, 0.5, "dB", -3),
      release_ms: p("Release", 10, 1000, 5, "ms", 100),
    },
  },
  NoiseGate: {
    label: "Noise gate",
    group: "Loudness",
    blurb: "Silences what is under the threshold",
    params: {
      threshold_db: p("Threshold", -100, 0, 1, "dB", -50),
      ratio: p("Ratio", 1, 20, 0.5, ":1", 10),
      attack_ms: p("Attack", 0.1, 100, 0.1, "ms", 1),
      release_ms: p("Release", 10, 1000, 5, "ms", 100),
    },
  },
  Gain: {
    label: "Gain",
    group: "Loudness",
    blurb: "Louder or quieter",
    params: { gain_db: p("Gain", -24, 24, 0.5, "dB", 0) },
  },
  Reverb: {
    label: "Reverb",
    group: "Space",
    blurb: "A room around the voice",
    params: {
      room_size: p("Room size", 0, 1, 0.01, "", 0.35),
      damping: p("Damping", 0, 1, 0.01, "", 0.5),
      wet_level: p("Room level", 0, 1, 0.01, "", 0.22),
      dry_level: p("Voice level", 0, 1, 0.01, "", 0.78),
      width: p("Width", 0, 1, 0.01, "", 1),
    },
  },
  Delay: {
    label: "Delay",
    group: "Space",
    blurb: "Echoes",
    params: {
      delay_seconds: p("Time", 0.001, 2, 0.001, "s", 0.25),
      feedback: p("Repeats", 0, 0.95, 0.01, "", 0.2),
      mix: p("Amount", 0, 1, 0.01, "", 0.3),
    },
  },
  Chorus: {
    label: "Chorus",
    group: "Space",
    blurb: "Doubles and wobbles",
    params: {
      rate_hz: p("Speed", 0.05, 10, 0.05, "Hz", 1),
      depth: p("Depth", 0, 1, 0.01, "", 0.25),
      centre_delay_ms: p("Delay", 1, 30, 0.5, "ms", 7),
      feedback: p("Repeats", 0, 0.95, 0.01, "", 0),
      mix: p("Amount", 0, 1, 0.01, "", 0.5),
    },
  },
  Phaser: {
    label: "Phaser",
    group: "Space",
    blurb: "A sweeping hollow",
    params: {
      rate_hz: p("Speed", 0.05, 10, 0.05, "Hz", 1),
      depth: p("Depth", 0, 1, 0.01, "", 0.5),
      centre_frequency_hz: p("Centre", 100, 5000, 10, "Hz", 1300),
      feedback: p("Repeats", 0, 0.95, 0.01, "", 0),
      mix: p("Amount", 0, 1, 0.01, "", 0.5),
    },
  },
  PitchShift: {
    label: "Pitch shift",
    group: "Pitch",
    blurb: "Higher or lower, same speed",
    params: { semitones: p("Semitones", -12, 12, 0.1, "st", 0) },
  },
  Distortion: {
    label: "Distortion",
    group: "Character",
    blurb: "Grit",
    params: { drive_db: p("Drive", 0, 60, 0.5, "dB", 12) },
  },
  Bitcrush: {
    label: "Bitcrush",
    group: "Character",
    blurb: "Fewer bits, more crunch",
    params: { bit_depth: p("Bits", 2, 16, 0.5, "bit", 8) },
  },
  Clipping: {
    label: "Clipping",
    group: "Character",
    blurb: "Hard ceiling, harsh edge",
    params: { threshold_db: p("Threshold", -30, 0, 0.5, "dB", -6) },
  },
  Resample: {
    label: "Resample",
    group: "Character",
    blurb: "Lo-fi, like an old phone line",
    params: { target_sample_rate: p("Rate", 2000, 44100, 100, "Hz", 8000) },
  },
  MP3Compressor: {
    label: "MP3 squash",
    group: "Character",
    blurb: "The smear of a low-quality MP3",
    params: { vbr_quality: p("Quality", 0, 10, 0.5, "", 2) },
  },
  Invert: {
    label: "Invert",
    group: "Character",
    blurb: "Flips the wave; heard only beside another layer",
    params: {},
  },
};

export const isMix = (s: Step): s is MixStep => "mix" in s;

/** A step with its catalog defaults filled in, ready to go into a chain. */
export function newStep(plugin: string): PluginStep {
  const params = Object.fromEntries(
    Object.entries(PLUGINS[plugin]?.params ?? {}).map(([k, v]) => [k, v.default]),
  );
  return { plugin, params, on: true };
}

/** A Mix of two layers: the voice lowered beside the voice as it is. */
export function newMix(): MixStep {
  const layer = (name: string, steps: Step[]): Layer => ({ name, steps, on: true });
  return {
    on: true,
    mix: [
      layer("Layer A", [{ ...newStep("PitchShift"), params: { semitones: -3 } }]),
      layer("Layer B", []),
    ],
  };
}

/** A number in its unit, as a reader would write it: "1.2 kHz", "−4 dB", "5:1", "250 ms". */
export function formatParam(plugin: string, key: string, v: number): string {
  const unit = PLUGINS[plugin]?.params[key]?.unit ?? "";
  const r = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
  if (unit === "Hz" && v >= 1000) return `${Math.round(v / 100) / 10} kHz`;
  if (unit === "s") return `${Math.round(v * 1000)} ms`;
  if (unit === ":1") return `${r}:1`;
  if (unit === "st" || unit === "dB")
    return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(r)} ${unit}`;
  return unit ? `${r} ${unit}` : `${r}`;
}

export const labelOf = (s: Step): string =>
  isMix(s) ? "Mix" : (PLUGINS[s.plugin]?.label ?? s.plugin);

/** A step in a few words: "−14 dB · 5:1", "170 Hz", "4 layers". */
export function describe(s: Step): string {
  if (isMix(s)) return `${s.mix.length} layers`;
  const def = PLUGINS[s.plugin];
  const keys = def ? Object.keys(def.params) : Object.keys(s.params);
  return keys
    .slice(0, s.plugin === "Reverb" ? 3 : 2)
    .map((k) => formatParam(s.plugin, k, s.params[k] ?? def?.params[k]?.default ?? 0))
    .join(" · ");
}

/** A whole chain on one line, for a row of the list: "Compressor › Highpass › Mix ×4". */
export const summaryOf = (chain: Step[]): string =>
  chain.length
    ? chain.map((s) => (isMix(s) ? `Mix ×${s.mix.length}` : labelOf(s))).join(" › ")
    : "No steps yet";
