# How a voice measures, run by `measure.ts` as `uv run … python -I measure.py <ffmpeg> <file>…`:
# the files joined, stdout {"f0", "hnr", "rangeSt", "voicedSec"}; exits 1 with one stderr line.
# Praat settings are the ones checked by ear against 73 real voices: pitch 60–600 Hz (ac),
# clarity as cross-correlation harmonicity, intonation as the p5–p95 spread in semitones.
import json
import math
import os
import subprocess
import sys
import tempfile

import numpy as np
import parselmouth
from parselmouth.praat import call

FLOOR, CEILING = 60, 600


def sound(path, ffmpeg, tmp):
    """Praat reads WAV, MP3 and FLAC; anything else (m4a, opus) goes through ffmpeg first."""
    try:
        return parselmouth.Sound(path).convert_to_mono()
    except parselmouth.PraatError:
        wav = os.path.join(tmp, f"{len(os.listdir(tmp))}.wav")
        done = subprocess.run([ffmpeg, "-v", "error", "-i", path, "-ac", "1", wav], capture_output=True)
        if done.returncode != 0:
            raise ValueError(f"{os.path.basename(path)} could not be read")
        return parselmouth.Sound(wav)


def measure(paths, ffmpeg):
    with tempfile.TemporaryDirectory() as tmp:
        sounds = [sound(p, ffmpeg, tmp) for p in paths]
    rate = sounds[0].sampling_frequency
    joined = parselmouth.Sound.concatenate(
        [s if s.sampling_frequency == rate else s.resample(rate) for s in sounds]
    )
    pitch = joined.to_pitch_ac(pitch_floor=FLOOR, pitch_ceiling=CEILING)
    f0 = pitch.selected_array["frequency"]
    f0 = f0[f0 > 0]
    if not len(f0):
        raise ValueError("no voiced speech was found in the samples")
    st = 12 * np.log2(f0 / 100)
    hnr = call(joined.to_harmonicity_cc(), "Get mean", 0, 0)
    return {
        "f0": round(float(np.median(f0)), 1),
        "hnr": round(float(hnr), 1) if math.isfinite(hnr) else 0,
        "rangeSt": round(float(np.percentile(st, 95) - np.percentile(st, 5)), 1),
        "voicedSec": round(len(f0) * pitch.time_step, 1),
    }


if __name__ == "__main__":
    try:
        print(json.dumps(measure(sys.argv[2:], sys.argv[1])))
    except Exception as e:
        print(str(e).strip().splitlines()[-1] if str(e).strip() else type(e).__name__, file=sys.stderr)
        sys.exit(1)
