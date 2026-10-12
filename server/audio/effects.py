# Voice effects run on a clip: Pedalboard chains (docs/audio.md, "Voice effects"). `effects.ts`
# starts it as `uv run -q --no-project --with pedalboard==… python -I effects.py <mode>`, so the
# server needs no Python environment of its own, only uv.
#
#   render <ffmpeg>   stdin: one JSON line {"format", "chains"}, then the clip's bytes
#                     stdout: a 16-bit WAV at the clip's own rate
#   batch <ffmpeg>    stdin: one JSON line per item {"input", "output", "chains"}, both paths
#                     stdout: one line per item as it ends, {"i": n, "ok": true} | {"i": n, "error"}
#   parse             stdin: Pedalboard Python; stdout: the chain it builds, as JSON
#
# render and parse exit 1 with one line on stderr when they cannot; batch carries on past an item
# it cannot do, so one bad clip never costs the rest of a book.
#
# Chains are user input — typed into the editor, or pasted as Python — so nothing in them is ever
# run as code: `parse` reads the text with `ast` and never executes it, and only the plugins named
# in POSITIONAL, with only the arguments it lists, are ever built.
import ast
import io
import json
import os
import subprocess
import sys
import tempfile
import wave

# Each plugin's arguments in the order Pedalboard takes them, so `HighpassFilter(170)` reads as well
# as the keyword. Every argument listed takes a number; Resample's `quality` (an enum) is left out.
POSITIONAL = {
    "Gain": ["gain_db"],
    "Compressor": ["threshold_db", "ratio", "attack_ms", "release_ms"],
    "Limiter": ["threshold_db", "release_ms"],
    "NoiseGate": ["threshold_db", "ratio", "attack_ms", "release_ms"],
    "HighpassFilter": ["cutoff_frequency_hz"],
    "LowpassFilter": ["cutoff_frequency_hz"],
    "HighShelfFilter": ["cutoff_frequency_hz", "gain_db", "q"],
    "LowShelfFilter": ["cutoff_frequency_hz", "gain_db", "q"],
    "PeakFilter": ["cutoff_frequency_hz", "gain_db", "q"],
    "Delay": ["delay_seconds", "feedback", "mix"],
    "Reverb": ["room_size", "damping", "wet_level", "dry_level", "width", "freeze_mode"],
    "Chorus": ["rate_hz", "depth", "centre_delay_ms", "feedback", "mix"],
    "Phaser": ["rate_hz", "depth", "centre_frequency_hz", "feedback", "mix"],
    "Distortion": ["drive_db"],
    "Bitcrush": ["bit_depth"],
    "Clipping": ["threshold_db"],
    "PitchShift": ["semitones"],
    "Resample": ["target_sample_rate"],
    "MP3Compressor": ["vbr_quality"],
    "Invert": [],
}

# Pedalboard gives back as many samples as it is given, so a reverb or a delay ringing on past the
# last word would be cut off: this much silence goes on the end first, and whatever of it is still
# silent afterwards comes off again — never more, so a clip is never shorter than it came.
PAD_SECONDS = 0.4
QUIET = 10 ** (-60 / 20)


def number(name, key, v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{name}'s {key} must be a number, not {v!r}")
    return v


def board(chains):
    """The chains, in order, as one Pedalboard. Off steps and layers are left out."""
    import pedalboard as pb

    def build(steps):
        out = []
        for s in steps:
            if not s.get("on", True):
                continue
            if "mix" in s:
                layers = [pb.Pedalboard(build(l["steps"])) for l in s["mix"] if l.get("on", True)]
                if layers:
                    out.append(pb.Mix(layers))
                continue
            name, params = s.get("plugin"), s.get("params", {})
            if name not in POSITIONAL:
                raise ValueError(f"{name} is not a plugin this editor knows")
            for k, v in params.items():
                if k not in POSITIONAL[name]:
                    raise ValueError(f"{name} has no {k}")
                number(name, k, v)
            out.append(getattr(pb, name)(**params))
        return out

    return pb.Pedalboard([p for chain in chains for p in build(chain)])


def load(src, wav, ffmpeg):
    """
    A clip's samples (channels × frames, float) and its rate; `src` is a path or the bytes. A WAV is
    read as it is. Anything else is decoded by ffmpeg first: Pedalboard reads Opus only where the
    OS lends it a decoder, and keeps an MP3's encoder padding as silence where ffmpeg drops it. It
    decodes to a file, not a pipe, because a WAV written to a pipe says it is 4 GB long.
    """
    from pedalboard.io import AudioFile

    if not wav:
        piped = isinstance(src, bytes)
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "clip.wav")
            cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error"]
            cmd += ["-i", "pipe:0" if piped else src, "-c:a", "pcm_f32le", out]
            try:
                r = subprocess.run(cmd, input=src if piped else None, capture_output=True)
            except FileNotFoundError:
                raise ValueError("there is no ffmpeg to decode it with") from None
            if r.returncode:
                raise ValueError(f"ffmpeg could not read it: {last_line(r.stderr.decode())}")
            return load(out, True, ffmpeg)
    with AudioFile(io.BytesIO(src) if isinstance(src, bytes) else src) as f:
        return f.read(f.frames), f.samplerate


def process(audio, rate, chains):
    import numpy as np

    frames = audio.shape[1]
    pad = np.zeros((audio.shape[0], int(rate * PAD_SECONDS)), audio.dtype)
    wet = board(chains)(np.concatenate([audio, pad], axis=1), rate)
    loud = np.flatnonzero(np.abs(wet).max(axis=0) > QUIET)
    return wet[:, : max(frames, loud[-1] + 1 if loud.size else 0)]


def wav_bytes(audio, rate):
    """16-bit PCM under the plain 44-byte header the server writes (Pedalboard's own adds a JUNK chunk)."""
    import numpy as np

    pcm = (np.clip(audio, -1, 1) * 32767).round().astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(audio.shape[0])
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.T.tobytes())
    return buf.getvalue()


def render(ffmpeg):
    head = json.loads(sys.stdin.buffer.readline())
    audio, rate = load(sys.stdin.buffer.read(), head["format"] == "wav", ffmpeg)
    sys.stdout.buffer.write(wav_bytes(process(audio, rate, head["chains"]), rate))


def batch(ffmpeg):
    for i, line in enumerate(sys.stdin):
        try:
            item = json.loads(line)
            src = item["input"]
            audio, rate = load(src, src.lower().endswith(".wav"), ffmpeg)
            data = wav_bytes(process(audio, rate, item["chains"]), rate)
            with open(item["output"], "wb") as f:
                f.write(data)
            print(json.dumps({"i": i, "ok": True}), flush=True)
        except Exception as e:  # noqa: BLE001 — the item's error is its answer; the next one runs
            print(json.dumps({"i": i, "error": last_line(str(e)) or type(e).__name__}), flush=True)


def parse(text):
    """The chain pasted Pedalboard code builds: read with `ast`, never run."""
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        raise ValueError(f"line {e.lineno}: {e.msg}") from None
    names = {}  # a variable -> the expression it was given

    def called(node):
        f = node.func
        return f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else ""

    def is_board(node):
        return isinstance(node, ast.Call) and called(node) in ("Pedalboard", "Chain")

    def lookup(node):
        if node.id not in names:
            raise ValueError(f"line {node.lineno}: {node.id} is not given a value above")
        return names[node.id]

    def steps_of(node):
        """A list, a Pedalboard([...]), a plugin, or a name for one: its steps, flattened."""
        if isinstance(node, ast.Name):
            return steps_of(lookup(node))
        if isinstance(node, (ast.List, ast.Tuple)):
            return [s for e in node.elts for s in steps_of(e)]
        if is_board(node):
            return steps_of(node.args[0]) if node.args else []
        return [step(node)]

    def literal(name, key, node):
        try:
            return number(name, key, ast.literal_eval(node))
        except ValueError:
            raise ValueError(f"line {node.lineno}: {name}'s {key} must be a number, not {ast.unparse(node)}") from None

    def step(node):
        if not isinstance(node, ast.Call):
            raise ValueError(f"line {node.lineno}: expected a plugin, found {ast.unparse(node)}")
        name = called(node)
        if name == "Mix":
            layers = node.args[0] if node.args else None
            if isinstance(layers, ast.Name):
                layers = lookup(layers)
            if not isinstance(layers, (ast.List, ast.Tuple)):
                raise ValueError(f"line {node.lineno}: Mix takes a list of chains")
            return {
                "mix": [{"name": chr(65 + i), "steps": steps_of(l), "on": True} for i, l in enumerate(layers.elts)],
                "on": True,
            }
        if name not in POSITIONAL:
            raise ValueError(f"line {node.lineno}: {name or ast.unparse(node.func)} is not a plugin this editor knows")
        keys = POSITIONAL[name]
        if len(node.args) > len(keys):
            raise ValueError(f"line {node.lineno}: {name} takes at most {len(keys)} values in order")
        params = {k: literal(name, k, a) for k, a in zip(keys, node.args)}
        for kw in node.keywords:
            if kw.arg not in keys:
                raise ValueError(f"line {node.lineno}: {name} has no {kw.arg}")
            params[kw.arg] = literal(name, kw.arg, kw.value)
        return {"plugin": name, "params": params, "on": True}

    # The board is the last Pedalboard(...) built, so `board(audio, sample_rate)` after it is
    # passed over; with none, the last thing written (a list, a Mix, one plugin) is.
    found = last = None
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            names[stmt.targets[0].id] = last = stmt.value
        elif isinstance(stmt, ast.Expr):
            last = stmt.value
        else:
            continue
        if is_board(last):
            found = last
    if (found or last) is None:
        raise ValueError("no Pedalboard found")
    return steps_of(found or last)


def last_line(text):
    lines = text.strip().splitlines()
    return lines[-1].strip() if lines else ""


if __name__ == "__main__":
    mode = sys.argv[1]
    try:
        if mode == "render":
            render(sys.argv[2])
        elif mode == "batch":
            batch(sys.argv[2])
        elif mode == "parse":
            print(json.dumps(parse(sys.stdin.read())))
        else:
            raise ValueError(f"no mode {mode}")
    except Exception as e:  # noqa: BLE001 — the caller shows the one line
        print(last_line(str(e)) or type(e).__name__, file=sys.stderr)
        sys.exit(1)
