// A voice meter that runs no Python: every measure answers `measured` and is recorded, and it can
// be told to fail or to report itself unavailable.
import type { MeasuredVoice } from "@/types";
import type { VoiceMeter } from "~/voices/measure";

export interface FakeMeter extends VoiceMeter {
  /** the paths of every measure, in order */
  calls: string[][];
  measured: MeasuredVoice;
  /** set: every measure after fails with it */
  fail: Error | null;
  /** set: `unavailable()` says this */
  why: string | null;
}

export function fakeMeter(): FakeMeter {
  const fake: FakeMeter = {
    calls: [],
    measured: { f0: 230, hnr: 15.2, rangeSt: 16.4, voicedSec: 42 },
    fail: null,
    why: null,
    unavailable: async () => fake.why,
    async measure(paths) {
      fake.calls.push([...paths]);
      if (fake.fail) throw fake.fail;
      return { ...fake.measured };
    },
  };
  return fake;
}
