# Pedalboard voice effects, run by `effects.ts` as `uv run … python -I effects.py <mode>`:
#   render <ffmpeg>  stdin: JSON line {"format", "chains"}, then the clip; stdout: 16-bit WAV
#   batch <ffmpeg>   stdin: JSON line {"input", "output", "chains"} per item;
#                    stdout: {"i": n, "ok": true} | {"i": n, "error"} per item; a bad item is skipped
#   parse            stdin: Pedalboard Python; stdout: the chain as JSON
# render and parse exit 1 with one stderr line. Chains are user input: `parse` reads them with
# `ast` and never runs them, and only `plugins()` with their number arguments are built.
import ast
import functools
import io
import json
import math
import operator
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
# A speaker's speed, as `stretchEffect` and `SPEAKER_SPEED` in src/lib give it: never a plugin.
STRETCH = "TimeStretch"
SPEED = (0.5, 2)

# Pedalboard returns as many samples as it gets, so this pad lets a reverb ring on; what is still
# silent afterwards comes off again (never more, so a clip never gets shorter).
PAD_SECONDS = 0.4
QUIET = 10 ** (-60 / 20)
# A tail still ringing where the pad runs out fades over this long instead of clicking.
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


def stretch_of(chains):
    """The speed a first chain of one STRETCH step asks for (1 = none), and the chains after it."""
    first = chains[0] if chains else []
    if not (len(first) == 1 and first[0].get("plugin") == STRETCH):
        return 1, chains
    params = first[0].get("params", {})
    if set(params) != {"stretch_factor"}:
        raise ValueError(f"{STRETCH} takes only stretch_factor")
    factor = number(STRETCH, "stretch_factor", params["stretch_factor"])
    if not SPEED[0] <= factor <= SPEED[1]:
        raise ValueError(f"a speed must be {SPEED[0]} to {SPEED[1]}, not {factor}")
    return (factor if first[0].get("on", True) else 1), chains[1:]


def process(audio, rate, chains):
    import numpy as np
    import pedalboard as pb

    factor, chains = stretch_of(chains)
    if factor != 1:
        # before the board, so the pad and the trim below measure the clip at its new length
        audio = pb.time_stretch(audio, rate, stretch_factor=factor)
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


# The arithmetic a pasted value may use. A power's exponent is held to MAX_POWER, and every result
# must be a finite number, so no value can grow without end (`10**10**10`) or take long to work out.
OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
MAX_POWER = 16


def parse(text):
    """
    The chain pasted Pedalboard code builds: read with `ast`, never run. Statements are read top to
    bottom as Python would, each name keeping its value — a number, a plugin, or a list of plugins
    and lists — or why it has none, which is raised only once the name is used.
    """
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        raise ValueError(f"line {e.lineno}: {e.msg}") from None
    names = {}

    def at(node, why):
        return ValueError(f"line {node.lineno}: {why}")

    def called(node):
        f = node.func
        return f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else ""

    def is_board(node):
        return isinstance(node, ast.Call) and called(node) in ("Pedalboard", "Chain")

    def lookup(node):
        if node.id not in names:
            raise at(node, f"{node.id} is not given a value above")
        if isinstance(names[node.id], ValueError):
            raise names[node.id]
        return names[node.id]

    def listy(node):
        """Whether an expression is a list of plugins, so `+` joins it to another rather than adds."""
        if isinstance(node, ast.Name):
            return isinstance(names.get(node.id), list)
        if isinstance(node, ast.BinOp):
            return isinstance(node.op, ast.Add) and listy(node.left)
        return isinstance(node, (ast.List, ast.Tuple)) or is_board(node)

    def num(node, what):
        """A number written out, or worked out from numbers and names given one above."""
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            return node.value
        if isinstance(node, ast.Name) and type(lookup(node)) in (int, float):
            return names[node.id]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            v = num(node.operand, what)
            return -v if isinstance(node.op, ast.USub) else v
        if isinstance(node, ast.BinOp) and type(node.op) in OPS:
            a, b = num(node.left, what), num(node.right, what)
            if isinstance(node.op, ast.Pow) and abs(b) > MAX_POWER:
                raise at(node, f"{ast.unparse(node)} is too big a power; keep it to {MAX_POWER}")
            try:
                v = OPS[type(node.op)](a, b)
                if math.isfinite(v):
                    return v
            except (ArithmeticError, TypeError):  # by zero, too big, or a complex root
                pass
            raise at(node, f"{ast.unparse(node)} does not come to a number")
        raise at(node, f"{what} must be a number, not {ast.unparse(node)}")

    def value(node, what=None):
        """
        What an expression comes to. `what` names it where a number may stand (a name's value), and
        is None where only a plugin or a list may.
        """
        if isinstance(node, ast.Name):
            return lookup(node)
        if isinstance(node, (ast.List, ast.Tuple)):
            return [item(e) for e in node.elts]
        if is_board(node):
            given = plugins_of(node)
            return items(given) if given is not None else []
        if isinstance(node, ast.Call):
            return step(node)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add) and listy(node.left):
            return value(node.left) + items(node.right)
        if what is None:
            raise at(node, f"expected a plugin, found {ast.unparse(node)}")
        return num(node, what)

    def item(node):
        """A plugin, or a list of them: one thing in a board."""
        v = value(node)
        if not isinstance(v, (dict, list)):
            raise at(node, f"expected a plugin, found {ast.unparse(node)}")
        return v

    def items(node):
        v = item(node)
        return v if isinstance(v, list) else [v]

    def steps(v):
        """A plugin, or a list of plugins and lists, flattened into a chain's steps."""
        return [v] if isinstance(v, dict) else [s for e in v for s in steps(e)]

    def literal(name, key, node):
        return number(name, key, num(node, f"{name}'s {key}"))

    def plugins_of(node):
        """What a Pedalboard, Chain or Mix was handed: `Pedalboard([...])` or `plugins=[...]`."""
        if node.args:
            return node.args[0]
        return next((kw.value for kw in node.keywords if kw.arg == "plugins"), None)

    def step(node):
        name = called(node)
        if name == "Mix":
            given = plugins_of(node)
            layers = item(given) if given is not None else None
            if not isinstance(layers, list):
                raise at(node, "Mix takes a list of chains")
            return {
                "mix": [{"name": chr(65 + i), "steps": steps(l), "on": True} for i, l in enumerate(layers)],
                "on": True,
            }
        if name not in plugins():
            raise at(node, f"{name or ast.unparse(node.func)} is not a plugin this editor knows")
        keys, ordered, fixed = plugins()[name]
        if len(node.args) > ordered:
            # the value past the last number in order would set the first argument that is not one
            if not fixed:
                raise at(node, f"{name} takes at most {ordered} values in order")
            named = f", so name the numbers, like {keys[ordered]}=…" if ordered < len(keys) else ""
            raise at(node, f"{name}'s {fixed[0]} can't be set here; it keeps its default{named}")
        params = {k: literal(name, k, a) for k, a in zip(keys, node.args)}
        for kw in node.keywords:
            try:
                settable(name, kw.arg)
            except ValueError as e:
                raise at(node, e) from None
            params[kw.arg] = literal(name, kw.arg, kw.value)
        return {"plugin": name, "params": params, "on": True}

    def changed(stmt):
        """
        A board changed in place by `board.append(p)`, `.insert(i, p)` or `.extend([...])`, as its
        name and its new list; None for any other statement.
        """
        call = stmt.value if isinstance(stmt, ast.Expr) else None
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and not call.keywords):
            return None
        board, how, args = call.func.value, call.func.attr, call.args
        if not (isinstance(board, ast.Name) and isinstance(names.get(board.id), list)):
            return None
        new = list(names[board.id])
        if how == "append" and len(args) == 1:
            new.append(item(args[0]))
        elif how == "extend" and len(args) == 1:
            new += items(args[0])
        elif how == "insert" and len(args) == 2:
            i = num(args[0], "insert's place")
            if not isinstance(i, int):
                raise at(args[0], f"insert's place must be a whole number, not {ast.unparse(args[0])}")
            new.insert(i, item(args[1]))
        else:
            return None
        return board.id, new

    def reaches(stmt, target):
        """Where a statement changes a board in a way this reader does not follow, if it does."""
        boards = {k for k, v in names.items() if isinstance(v, list)}
        for n in ast.walk(stmt):
            if n is target:
                continue
            if isinstance(n, ast.Name) and n.id in boards and not isinstance(n.ctx, ast.Load):
                return n
            inside = isinstance(n, (ast.Attribute, ast.Subscript)) and isinstance(n.value, ast.Name)
            if inside and n.value.id in boards and (isinstance(n, ast.Attribute) or not isinstance(n.ctx, ast.Load)):
                return n
        return None

    # The board is the last Pedalboard(...) built or board changed, so `board(audio, sample_rate)`
    # after it is passed over; with none, the last thing written (a list, a Mix, one plugin) is.
    # Each is kept as (the node it was written as, its value or why it has none).
    found = last = None
    for stmt in tree.body:
        if change := changed(stmt):
            names[change[0]] = change[1]
            found = (stmt, change[1])
            continue
        target = node = None
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            target, node = stmt.targets[0], stmt.value
        elif isinstance(stmt, ast.AugAssign) and isinstance(stmt.target, ast.Name):
            # `x += v` is `x = x + v`, for a number and for a board alike
            target = stmt.target
            read = ast.copy_location(ast.Name(target.id, ast.Load()), stmt)
            node = ast.copy_location(ast.BinOp(read, stmt.op, stmt.value), stmt)
        elif isinstance(stmt, ast.Expr):
            node = stmt.value
        if (bad := reaches(stmt, target)) is not None:
            raise at(bad, "only append, insert, extend and += change a board here")
        if node is None:
            continue
        built = is_board(node) or (isinstance(node, ast.BinOp) and listy(node))
        try:
            v = value(node, target.id if target else None)
        except ValueError as e:
            v = e
        if target:
            names[target.id] = v
        last = (node, v)
        if built:
            found = last
    if (found or last) is None:
        raise ValueError("no Pedalboard found")
    node, v = found or last
    if isinstance(v, ValueError):
        raise v
    if not isinstance(v, (dict, list)):
        raise at(node, f"expected a plugin, found {ast.unparse(node)}")
    return steps(v)


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
