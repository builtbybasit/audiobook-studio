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
# run as code: `parse` reads the text with `ast` and never executes it, and only the plugins in
# `plugins()`, with only the number arguments it lists, are ever built.
import ast
import functools
import io
import json
import os
import subprocess
import sys
import tempfile
import wave

# Pedalboard classes that are never built from a chain: the containers (a chain's structure, not a
# step), the abstract bases, and the plugins that load a file or someone else's code.
NEVER = {
    "Pedalboard", "Chain", "Mix", "PluginContainer",
    "Plugin", "IIRFilter", "ExternalPlugin",
    "Convolution", "VST3Plugin", "AudioUnitPlugin",
}
NUMBER = ("float", "int")

# Pedalboard gives back as many samples as it is given, so a reverb or a delay ringing on past the
# last word would be cut off: this much silence goes on the end first, and whatever of it is still
# silent afterwards comes off again — never more, so a clip is never shorter than it came.
PAD_SECONDS = 0.4
QUIET = 10 ** (-60 / 20)
# A tail still ringing where the pad runs out (a big room, a long echo) would stop dead, with a
# click: it fades out over this much of its end instead.
FADE_SECONDS = 0.03


def number(name, key, v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{name}'s {key} must be a number, not {v!r}")
    return v


def signature(cls):
    """
    A plugin's arguments after `self`, as (name, type, has a default), read from the first line of
    its `__init__` docstring, where pybind11 writes the signature: `__init__(self: …, room_size:
    float = 0.5, …) -> None`. A comma inside brackets (`Union[str, …]`, `<Mode.LPF12: 0>`) is part
    of an argument, not between two.
    """
    line = cls.__init__.__doc__.strip().splitlines()[0]
    inner = line[line.index("(") + 1 : line.rindex(")")]
    parts, depth, start = [], 0, 0
    for i, c in enumerate(inner + ","):
        depth += (c in "[(<") - (c in "])>")
        if c == "," and depth == 0:
            parts.append(inner[start:i])
            start = i + 1
    out = []
    for part in parts[1:]:
        name, _, rest = part.partition(":")
        kind, default, _ = rest.partition("=")
        out.append((name.strip(), kind.strip(), bool(default)))
    return out


@functools.cache
def plugins():
    """
    Every plugin this Pedalboard offers that a chain may build, read from Pedalboard itself:
    name -> (its number arguments in order, how many of them may be given in order, its other
    arguments). Numbers go in order only up to the first argument that is not one (an enum, a
    flag); past it they must be named. A plugin needing anything but a number to be built at all
    is left out, as is one whose signature cannot be read.
    """
    import pedalboard as pb

    out = {}
    for name in dir(pb):
        cls = getattr(pb, name)
        if name.startswith("_") or name in NEVER or not (isinstance(cls, type) and issubclass(cls, pb.Plugin)):
            continue
        try:
            args = signature(cls)
        except (AttributeError, IndexError, ValueError):
            continue
        if any(kind not in NUMBER and not default for _, kind, default in args):
            continue
        numbers = [a for a, kind, _ in args if kind in NUMBER]
        fixed = [a for a, kind, _ in args if kind not in NUMBER]
        ordered = next((i for i, (_, kind, _) in enumerate(args) if kind not in NUMBER), len(args))
        out[name] = (numbers, ordered, fixed)
    return out


def settable(name, key):
    """Refuses an argument the plugin has but a chain may not set, or one it does not have."""
    numbers, _, fixed = plugins()[name]
    if key in fixed:
        raise ValueError(f"{name}'s {key} can't be set here; it keeps its default")
    if key not in numbers:
        raise ValueError(f"{name} has no {key}")


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
            if name not in plugins():
                raise ValueError(f"{name} is not a plugin this editor knows")
            for k, v in params.items():
                settable(name, k)
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
    end = max(frames, loud[-1] + 1 if loud.size else 0)
    out = wet[:, :end]
    if end == wet.shape[1]:
        # nothing at the end fell quiet: fade the tail, never into the voice's own samples
        n = min(int(rate * FADE_SECONDS), end - frames)
        out[:, end - n :] *= np.linspace(1, 0, n, dtype=out.dtype)
    return out


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
        if name not in plugins():
            raise ValueError(f"line {node.lineno}: {name or ast.unparse(node.func)} is not a plugin this editor knows")
        keys, ordered, fixed = plugins()[name]
        if len(node.args) > ordered:
            # the value past the last number in order would set the first argument that is not one
            if not fixed:
                raise ValueError(f"line {node.lineno}: {name} takes at most {ordered} values in order")
            named = f", so name the numbers, like {keys[ordered]}=…" if ordered < len(keys) else ""
            raise ValueError(f"line {node.lineno}: {name}'s {fixed[0]} can't be set here; it keeps its default{named}")
        params = {k: literal(name, k, a) for k, a in zip(keys, node.args)}
        for kw in node.keywords:
            try:
                settable(name, kw.arg)
            except ValueError as e:
                raise ValueError(f"line {node.lineno}: {e}") from None
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
