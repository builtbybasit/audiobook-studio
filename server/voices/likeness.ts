// Which cloned voices sound alike: each kept sample is fingerprinted once, the first time a
// comparison finds it without one, and the report is cosine maths over those vectors.
import type { AlikeVoice, VoiceLikeness, VoiceLikenessReport } from "@/types";
import { ALIKE_AT, MIXED_BELOW, NEAREST, TWIN_AT } from "@/lib/voiceLikeness";
import type { Db } from "~/db/client";
import {
  comparedSamples,
  dropUnkept,
  readFingerprints,
  writeFingerprints,
  type ComparedSample,
} from "~/db/fingerprints";
import { fail } from "~/lib/errors";
import type { VoiceFiles } from "~/voices/files";
import { FINGERPRINT_MODEL, type VoiceFingerprinter } from "~/voices/fingerprint";

export interface ComparedVoice {
  endpointId: string;
  voiceId: string;
  files: readonly string[];
}

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

function meanUnit(vs: readonly Float32Array[]): Float32Array {
  const m = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < m.length; i++) m[i] += v[i];
  const norm = Math.sqrt(dot(m, m)) || 1;
  return m.map((x) => x / norm);
}

/** A file whose vector is missing or empty is left out; a voice with none is not compared. */
export function compareVoices(
  voices: readonly ComparedVoice[],
  vectors: ReadonlyMap<string, Float32Array>,
): VoiceLikeness[] {
  const all = voices.flatMap((v) => {
    // an empty vector marks a file that couldn't be fingerprinted
    const samples = v.files
      .map((f) => vectors.get(f))
      .filter((x): x is Float32Array => !!x?.length);
    return samples.length ? [{ ...v, samples, vector: meanUnit(samples) }] : [];
  });
  type One = (typeof all)[number];
  const twinned = (a: One, b: One): boolean =>
    a.files.some((f) => b.files.includes(f)) ||
    a.samples.some((x) => b.samples.some((y) => dot(x, y) >= TWIN_AT));
  const mixed = (a: One): boolean =>
    a.samples.some((x, i) => a.samples.slice(i + 1).some((y) => dot(x, y) < MIXED_BELOW));

  return all.map((v) => {
    const others = all
      .filter((o) => o !== v)
      .map((o) => ({ o, score: dot(v.vector, o.vector) }))
      .sort((a, b) => b.score - a.score);
    const alike = ({ o, score }: { o: One; score: number }): AlikeVoice => ({
      endpointId: o.endpointId,
      voiceId: o.voiceId,
      score,
    });
    return {
      endpointId: v.endpointId,
      voiceId: v.voiceId,
      nearest: others
        .filter((x) => x.score >= ALIKE_AT)
        .slice(0, NEAREST)
        .map(alike),
      twins: others.filter((x) => twinned(v, x.o)).map(alike),
      mixed: mixed(v),
    };
  });
}

function voicesOf(samples: readonly ComparedSample[]): ComparedVoice[] {
  const by = new Map<string, { endpointId: string; voiceId: string; files: string[] }>();
  for (const s of samples) {
    const key = `${s.endpointId}\0${s.voiceId}`;
    const v = by.get(key) ?? { endpointId: s.endpointId, voiceId: s.voiceId, files: [] };
    v.files.push(s.file);
    by.set(key, v);
  }
  return [...by.values()];
}

export interface LikenessRun {
  report: VoiceLikenessReport;
  /** sample files fingerprinted for this report */
  fingerprinted: number;
}

/** One per library: requests that overlap wait for the fingerprinting under way, then reuse it. */
export function voiceLikeness(
  db: Db,
  files: VoiceFiles,
  fingerprinter?: VoiceFingerprinter,
): (signal: AbortSignal) => Promise<LikenessRun> {
  let filling: Promise<void> | null = null;

  /** Fingerprints the files without a row of this model, all in one call: each loads the model. */
  async function fill(samples: readonly ComparedSample[], signal: AbortSignal): Promise<number> {
    const have = readFingerprints(db, FINGERPRINT_MODEL);
    const paths = new Map<string, string>();
    for (const s of samples) {
      if (have.has(s.file) || paths.has(s.file)) continue;
      const path = files.path(s.endpointId, s.voiceId, s.file);
      if (path) paths.set(s.file, path);
    }
    if (!paths.size) return 0;
    const made = await fingerprinter!.fingerprint([...paths.values()], signal);
    writeFingerprints(
      db,
      FINGERPRINT_MODEL,
      new Map([...paths.keys()].map((f, i) => [f, made[i] ?? new Float32Array(0)])),
    );
    return paths.size;
  }

  return async (signal) => {
    const why = fingerprinter
      ? await fingerprinter.unavailable()
      : "comparing voices needs uv on this machine";
    if (why) return { report: { voices: [], unavailable: why }, fingerprinted: 0 };

    while (filling) await filling;
    const samples = comparedSamples(db);
    const run = fill(samples, signal);
    const done = (): void => {
      filling = null;
    };
    filling = run.then(done, done);
    let fingerprinted: number;
    try {
      fingerprinted = await run;
    } catch (e) {
      if (signal.aborted) throw e;
      fail(503, `The voices could not be compared: ${(e as Error).message}`);
    }
    dropUnkept(db);
    const voices = compareVoices(voicesOf(samples), readFingerprints(db, FINGERPRINT_MODEL));
    return { report: { voices }, fingerprinted };
  };
}
