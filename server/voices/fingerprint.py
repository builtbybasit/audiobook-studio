# A speaker fingerprint per file, run by `fingerprint.ts` as
# `uv run … python -I fingerprint.py <ffmpeg> <model>` with the paths on stdin, one per line:
# stdout one unit-length JSON array per path, in order, or `null` for a file that can't be used
# (its reason on stderr); exits 1 with one stderr line when nothing can run.
# The model is read in place from the Hugging Face cache.
import json
import os
import subprocess
import sys

import numpy as np
import torch
from speechbrain.inference.speaker import EncoderClassifier
from speechbrain.utils.fetching import LocalStrategy

RATE = 16000


def samples(path, ffmpeg):
    done = subprocess.run(
        [ffmpeg, "-v", "error", "-i", path, "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
        capture_output=True,
    )
    if done.returncode != 0:
        raise ValueError(f"{os.path.basename(path)} could not be read")
    # under a tenth of a second the model has too few frames to say anything
    if len(done.stdout) < RATE // 5:
        raise ValueError(f"{os.path.basename(path)} is too short")
    return torch.from_numpy(np.frombuffer(done.stdout, dtype="<i2").astype(np.float32) / 32768)


def fingerprints(paths, ffmpeg, source):
    # NO_LINK: no symlinks, which Windows only allows admins to make
    model = EncoderClassifier.from_hparams(
        source=source, local_strategy=LocalStrategy.NO_LINK, run_opts={"device": "cpu"}
    )
    with torch.inference_mode():
        for path in paths:
            try:
                wave = samples(path, ffmpeg)
            except ValueError as e:
                print(e, file=sys.stderr)
                yield None
                continue
            v = model.encode_batch(wave).flatten()
            yield torch.nn.functional.normalize(v, dim=0).tolist()


if __name__ == "__main__":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    try:
        paths = [p for p in sys.stdin.buffer.read().decode("utf-8").splitlines() if p]
        for v in fingerprints(paths, sys.argv[1], sys.argv[2]):
            print(json.dumps(v and [round(x, 6) for x in v]), flush=True)
    except Exception as e:
        print(str(e).strip().splitlines()[-1] if str(e).strip() else type(e).__name__, file=sys.stderr)
        sys.exit(1)
