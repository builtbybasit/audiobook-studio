// Chapter script history: the part that can be decided from two scripts alone.
//
// Nothing here mutates and nothing here reaches a store. The history store captures and installs
// versions; this file says what a version *is* (`scriptSignature` — the script, never the audio),
// what two of them disagree on (`compareScripts`), and what restoring one would do to the clips
// already rendered (`planRestore`). The panel renders these and the store applies exactly what the
// plan counted, so what is promised and what happens are the same calculation.
import { diffArrays, diffWords } from "diff";
import type {
  ChangeGroup,
  ChangeKind,
  ChapterHistory,
  ComparisonCounts,
  DiffRun,
  FieldChange,
  HistoryHead,
  LineChange,
  RestorePlan,
  ScriptComparison,
  ScriptVersion,
  Segment,
  SegmentAudio,
  VersionOrigin,
} from "@/types";
import { chapterNarration } from "@/lib/runPlan";
import { clone } from "@/lib/utils";

/** Edits less than this apart are the same editing session. */
export const SESSION_IDLE_MS = 10_000;

// ---------- what a version preserves ----------

const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
/** Whitespace-free, for comparing a line against two halves of itself. */
const tight = (t: string): string => t.replace(/\s+/g, "");

/** The expression annotations of a line, as they would be rendered: tag, position, omitted. */
const exprSignature = (s: Segment): string =>
  (s.expressions ?? [])
    .map((a) => `${a.id}@${a.at}${a.omitted ? "!" : ""}${a.needsReview ? "?" : ""}`)
    .join(",");

/**
 * Everything a version keeps about one line, exactly as it keeps it. The clip rendered from it is
 * deliberately absent — a render finishing in the background must not make the script look as if it
 * had changed — but nothing about the *words* is normalised away: two scripts that differ only in
 * their spacing are two scripts, and the one being replaced is worth keeping. (Alignment is the
 * other question, and `compareScripts` normalises for that itself.)
 */
export const lineSignature = (s: Segment): string =>
  JSON.stringify([
    s.text,
    s.sep ?? null,
    s.speaker,
    s.type,
    s.direction || "",
    exprSignature(s),
    s.pause ?? null,
  ]);

export const scriptSignature = (segments: Segment[]): string =>
  JSON.stringify(segments.map(lineSignature));

/** The script content of a line, without the clip, the flag or anything else about the audio. */
export function scriptOnly(s: Segment): Segment {
  const out: Segment = {
    id: s.id,
    type: s.type,
    speaker: s.speaker,
    text: s.text,
    direction: s.direction,
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
  };
  if (s.expressions?.length) out.expressions = s.expressions.map((a) => ({ ...a }));
  if (s.pause != null) out.pause = s.pause;
  if (s.sep != null) out.sep = s.sep;
  if (s.edited) out.edited = true;
  if (s.fallback) {
    out.fallback = true;
    out.fallbackCount = s.fallbackCount;
    out.fallbackMismatch = s.fallbackMismatch;
  }
  return out;
}

/** A version's own copy of a script: script content only, and nothing shared with the live one. */
export const snapshotScript = (segments: Segment[]): Segment[] => segments.map(scriptOnly);

// ---------- preserving a script before it is replaced ----------

/** What preserving the working script comes to: the entry added, if any, and the head after it. */
export interface Capture {
  added: ScriptVersion | null;
  head: HistoryHead;
  nextId: number;
}

/**
 * The one rule behind every entry in a chapter's history: the working script is preserved
 * **before** `origin` replaces it, labelled by whatever produced it, and never twice.
 *
 * Pure, so the history store and the server apply the same rule to the same inputs. No entry is
 * added for an empty script, for an operation that leaves the script exactly as it found it (`next`
 * is what is about to be written, when it is known), or for a script that is already the newest
 * entry. The head afterwards says how the script now came to be; an edit opens a session that later
 * edits join.
 */
export function planCapture(
  h: ChapterHistory,
  current: Segment[],
  origin: VersionOrigin,
  next: Segment[] | undefined,
  now: number,
): Capture {
  const signature = scriptSignature(current);
  const last = h.versions.at(-1);
  const changesNothing = next ? scriptSignature(next) === signature : false;
  let added: ScriptVersion | null = null;
  let nextId = h.nextId;
  if (current.length && !changesNothing && (!last || scriptSignature(last.segments) !== signature))
    added = {
      id: nextId++,
      at: h.head.at,
      origin: clone(h.head.origin),
      segments: snapshotScript(current),
    };
  return { added, head: { at: now, origin, open: origin.kind === "edited" }, nextId };
}

/**
 * Whether an edit made now joins the editing session the head describes rather than opening one.
 *
 * The store closes a session with a timer; the server has no timer and asks the clock instead.
 * Both say the same thing: a session is open while its last edit is less than `SESSION_IDLE_MS` old.
 */
export const sessionOpen = (head: HistoryHead, now: number): boolean =>
  !!head.open && head.origin.kind === "edited" && now - head.at < SESSION_IDLE_MS;

// ---------- what an entry is called ----------

/** The one line the history list reads: what made this script. */
export function originLabel(origin: VersionOrigin): string {
  switch (origin.kind) {
    case "scripted":
      return origin.profile
        ? `${origin.again ? "Re-scripted" : "Scripted"} with ${origin.profile}`
        : "Scripted";
    case "edited":
      return `${origin.edits} manual edit${origin.edits === 1 ? "" : "s"}`;
    case "bulk":
      return origin.label;
    case "restored":
      return `Restored from v${origin.from}`;
    case "checkpoint":
      return `“${origin.name}”`;
  }
}

/** The word under the entry saying what kind of thing it was, for the badge beside the label. */
export function originKindLabel(origin: VersionOrigin): string {
  switch (origin.kind) {
    case "scripted":
      return "scripted";
    case "edited":
      return "edited by hand";
    case "bulk":
      return "bulk correction";
    case "restored":
      return "restored";
    case "checkpoint":
      return "checkpoint";
  }
}

/** The second line: the detail that does not fit the label. */
export function originNote(origin: VersionOrigin): string {
  switch (origin.kind) {
    case "scripted":
      return origin.model ?? "";
    case "edited":
      return "one editing session";
    case "bulk":
      return `${origin.lines} line${origin.lines === 1 ? "" : "s"} in one batch`;
    case "restored":
      return "the script as that version left it";
    case "checkpoint":
      return origin.was ? `saved by hand · ${originLabel(origin.was)}` : "saved by hand";
  }
}

// ---------- comparing two scripts ----------

const WORD = /\S+\s*/g;
const wordsOf = (text: string): string[] => text.match(WORD) ?? [];

/** How much two lines have in common, 0–1, over their words. */
function similarity(a: string, b: string): number {
  const wa = wordsOf(norm(a).toLowerCase());
  const wb = wordsOf(norm(b).toLowerCase());
  if (!wa.length || !wb.length) return 0;
  const left = new Map<string, number>();
  for (const w of wa) left.set(w, (left.get(w) ?? 0) + 1);
  let hits = 0;
  for (const w of wb) {
    const n = left.get(w) ?? 0;
    if (n > 0) {
      left.set(w, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (wa.length + wb.length);
}
/** Below this two lines are different lines rather than one line rewritten. */
const SAME_LINE = 0.35;

/** Index pairs of a common subsequence of two key arrays.
 *
 * `diffArrays` reports the alignment as runs of added, removed and common tokens; what both callers
 * want is the *positions* those common runs sit at, because the key is never the thing being
 * aligned — it is the segment, or the untrimmed word, that the key was derived from. So the runs are
 * counted back into index pairs and their values discarded.
 *
 * Myers costs what the edit distance costs rather than what the two lengths multiply to, and it
 * allocates nothing of the order of the old dynamic-programming table, so the million-cell guard
 * that table needed — and the greedy alignment it fell back to — went with it. */
function alignPairs(a: string[], b: string[]): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  for (const run of diffArrays(a, b)) {
    if (run.added) j += run.count;
    else if (run.removed) i += run.count;
    else {
      for (let k = 0; k < run.count; k++) out.push([i + k, j + k]);
      i += run.count;
      j += run.count;
    }
  }
  return out;
}

/** A word-level comparison of two lines, as runs to be rendered in order.
 *
 * `diffWords` ignores whitespace when it matches words but keeps it in what it returns, which is
 * what the runs want: a line rewrapped around the same words reads as unchanged, and the spacing
 * drawn is the newer line's. A change that is *only* spacing never reaches here — `lineChange`
 * leaves `runs` empty and `fieldChanges` names it instead — so matching that way loses nothing. */
export function wordDiff(from: string, to: string): DiffRun[] {
  return diffWords(from, to).map((run): DiffRun => ({
    kind: run.added ? "add" : run.removed ? "remove" : "same",
    text: run.value,
  }));
}

const PAUSE = (s: Segment): string =>
  s.pause == null ? "the book’s pause" : s.pause === 0 ? "runs straight on" : `${s.pause}s`;
const EXPR = (s: Segment): string =>
  (s.expressions ?? []).length
    ? s.expressions!.map((a) => a.label + (a.omitted ? " (omitted)" : "")).join(" · ")
    : "none";

/** What two lines disagree on, field by field. */
function fieldChanges(from: Segment, to: Segment): FieldChange[] {
  const out: FieldChange[] = [];
  if (norm(from.text) !== norm(to.text)) out.push({ field: "text", from: from.text, to: to.text });
  // the same words with the paragraph break moved: a real difference, and one no word-level diff
  // can show, so it is named rather than drawn
  else if (from.text !== to.text || (from.sep ?? null) !== (to.sep ?? null))
    out.push({
      field: "text",
      from: from.text,
      to: to.text,
      detail: "the same words, spaced differently",
    });
  if (from.speaker !== to.speaker)
    out.push({ field: "speaker", from: from.speaker, to: to.speaker });
  if (from.type !== to.type) out.push({ field: "type", from: from.type, to: to.type });
  if ((from.direction || "") !== (to.direction || ""))
    out.push({
      field: "direction",
      from: from.direction || "no direction",
      to: to.direction || "no direction",
    });
  if (exprSignature(from) !== exprSignature(to)) {
    const same = EXPR(from) === EXPR(to);
    out.push({
      field: "expressions",
      from: EXPR(from),
      to: EXPR(to),
      // the same tags in a different place read as one unchanged string, so say what moved
      detail: same ? "the same tags, in a different place" : undefined,
    });
  }
  if ((from.pause ?? null) !== (to.pause ?? null))
    out.push({ field: "pause", from: PAUSE(from), to: PAUSE(to) });
  return out;
}

const groupsOf = (kind: ChangeKind, fields: FieldChange[]): ChangeGroup[] =>
  kind === "changed"
    ? [...new Set(fields.map((f) => f.field as ChangeGroup))]
    : ["structure", ...new Set(fields.map((f) => f.field as ChangeGroup))];

function lineChange(
  kind: ChangeKind,
  from: Segment[],
  to: Segment[],
  fields: FieldChange[],
  at: number,
): LineChange {
  // a spacing-only change has no words to draw either side of, so it carries its `detail` instead
  const textChanged = fields.some((f) => f.field === "text" && !f.detail);
  const fromText = from.map((s) => s.text).join(" ");
  const toText = to.map((s) => s.text).join(" ");
  return {
    kind,
    fromIds: from.map((s) => s.id),
    toIds: to.map((s) => s.id),
    fromText,
    toText,
    fromParts: from.map((s) => s.text),
    toParts: to.map((s) => s.text),
    speaker: (to[0] ?? from[0])?.speaker ?? "",
    fields,
    groups: groupsOf(kind, fields),
    runs: textChanged && kind === "changed" ? wordDiff(fromText, toText) : [],
    at,
  };
}

/** A run of `arr` from `start` that reads as exactly `one` once the whitespace is taken out. */
function runMatch(one: Segment, arr: Segment[], start: number): number {
  const whole = tight(one.text);
  let text = "";
  for (let k = 0; k < 8 && start + k < arr.length; k++) {
    text += tight(arr[start + k].text);
    if (text.length > whole.length) return 0;
    if (k >= 1 && text === whole) return k + 1;
  }
  return 0;
}

const emptyCounts = (): ComparisonCounts => ({
  text: 0,
  speaker: 0,
  direction: 0,
  type: 0,
  expressions: 0,
  pause: 0,
  added: 0,
  removed: 0,
  split: 0,
  joined: 0,
});

/**
 * What changed between two scripts of the same chapter, in reading order.
 *
 * Lines are matched on their words first, so a line that only changed speaker, direction, pacing or
 * expressions is recognised as the same line. What is left over is looked at for the two structural
 * edits the reader can make — a line cut in two, two lines joined — then paired off as rewrites
 * where the words still mostly agree, and only otherwise called new or gone.
 */
export function compareScripts(from: Segment[], to: Segment[]): ScriptComparison {
  const changes: LineChange[] = [];
  const counts = emptyCounts();
  const note = (change: LineChange) => {
    changes.push(change);
    if (change.kind === "added") counts.added++;
    else if (change.kind === "removed") counts.removed++;
    else if (change.kind === "split") counts.split++;
    else if (change.kind === "joined") counts.joined++;
    for (const f of change.fields) counts[f.field]++;
  };

  const gap = (F: Segment[], T: Segment[], at: number) => {
    let a = 0;
    let b = 0;
    while (a < F.length || b < T.length) {
      if (a < F.length) {
        const k = runMatch(F[a], T, b);
        if (k) {
          note(lineChange("split", [F[a]], T.slice(b, b + k), [], at + b));
          a++;
          b += k;
          continue;
        }
      }
      if (b < T.length) {
        const k = runMatch(T[b], F, a);
        if (k) {
          note(lineChange("joined", F.slice(a, a + k), [T[b]], [], at + b));
          a += k;
          b++;
          continue;
        }
      }
      if (a < F.length && b < T.length) {
        if (similarity(F[a].text, T[b].text) >= SAME_LINE) {
          note(lineChange("changed", [F[a]], [T[b]], fieldChanges(F[a], T[b]), at + b));
          a++;
          b++;
        } else if (b + 1 < T.length && similarity(F[a].text, T[b + 1].text) >= SAME_LINE) {
          note(lineChange("added", [], [T[b]], [], at + b));
          b++;
        } else if (a + 1 < F.length && similarity(F[a + 1].text, T[b].text) >= SAME_LINE) {
          note(lineChange("removed", [F[a]], [], [], at + b));
          a++;
        } else {
          note(lineChange("removed", [F[a]], [], [], at + b));
          note(lineChange("added", [], [T[b]], [], at + b));
          a++;
          b++;
        }
      } else if (a < F.length) {
        note(lineChange("removed", [F[a]], [], [], at + b));
        a++;
      } else {
        note(lineChange("added", [], [T[b]], [], at + b));
        b++;
      }
    }
  };

  const pairs = alignPairs(
    from.map((s) => norm(s.text)),
    to.map((s) => norm(s.text)),
  );
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [from.length, to.length] as [number, number]]) {
    gap(from.slice(i, pi), to.slice(j, pj), j);
    if (pi < from.length) {
      const fields = fieldChanges(from[pi], to[pj]);
      if (fields.length) note(lineChange("changed", [from[pi]], [to[pj]], fields, pj));
    }
    i = pi + 1;
    j = pj + 1;
  }
  changes.sort((a, b) => a.at - b.at);
  return {
    changes,
    counts,
    lines: changes.length,
    fromCount: from.length,
    toCount: to.length,
    identical: !changes.length,
  };
}

/** The comparison's summary, as the phrases the panel lists before any detail. */
export function comparisonSummary(c: ScriptComparison): string[] {
  const n = (count: number, one: string, many = one + "s") =>
    `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (c.counts.text) parts.push(n(c.counts.text, "line rewritten", "lines rewritten"));
  if (c.counts.speaker) parts.push(n(c.counts.speaker, "speaker change"));
  if (c.counts.direction) parts.push(n(c.counts.direction, "direction change"));
  if (c.counts.type) parts.push(n(c.counts.type, "type change"));
  if (c.counts.expressions) parts.push(n(c.counts.expressions, "expression change"));
  if (c.counts.pause) parts.push(n(c.counts.pause, "pause change"));
  if (c.counts.split) parts.push(n(c.counts.split, "line split"));
  if (c.counts.joined) parts.push(n(c.counts.joined, "line joined"));
  if (c.counts.added) parts.push(n(c.counts.added, "new line"));
  if (c.counts.removed) parts.push(n(c.counts.removed, "line gone"));
  return parts;
}

// ---------- restoring ----------

export interface RestoreOptions {
  /** what a clip records that a line no longer says; empty means it still matches */
  drift(segment: Segment, audio: SegmentAudio): string[];
  /** the speakers the book's cast has now */
  cast: Set<string>;
}

const clipText = (a: SegmentAudio): string => norm(a.text ?? "");
const worthKeeping = (s: Segment): boolean =>
  s.audio.status !== "none" || !!s.audio.takes?.length || !!s.candidate || !!s.flag;

/**
 * What restoring `version` over `current` would do — the script it would leave, and what becomes of
 * the audio already rendered.
 *
 * Clips are carried across line by line rather than thrown away: a clip belongs to a restored line
 * when that line reads as the clip's own text does — either because the script says so, or because
 * the clip itself was rendered from those exact words, which is how a line that has since been
 * joined into its neighbour finds its way back. A carried clip is then re-judged against the
 * restored line: still current, or stale because the speaker, direction, expressions or dictionary
 * have moved on. A clip whose line this version does not have goes with the line.
 */
export function planRestore(
  current: Segment[],
  version: Segment[],
  opts: RestoreOptions,
): RestorePlan {
  const pool = current.filter(worthKeeping);
  const claimed = new Set<Segment>();
  const index = (key: (s: Segment) => string): Map<string, Segment[]> => {
    const m = new Map<string, Segment[]>();
    for (const s of pool) {
      const k = key(s);
      if (!k) continue;
      (m.get(k) ?? m.set(k, []).get(k)!).push(s);
    }
    return m;
  };
  const byText = index((s) => norm(s.text));
  const byClip = index((s) => clipText(s.audio));
  const take = (m: Map<string, Segment[]>, k: string): Segment | undefined => {
    const queue = m.get(k);
    while (queue?.length) {
      const s = queue.shift()!;
      if (!claimed.has(s)) return s;
    }
    return undefined;
  };

  const narrated = current.some((s) => s.audio.duration > 0);
  const segments: Segment[] = [];
  let kept = 0;
  let stale = 0;
  let unrendered = 0;
  let takes = 0;
  let candidates = 0;
  for (const line of version) {
    const next = scriptOnly(line);
    const key = norm(next.text);
    const owner = take(byText, key) ?? take(byClip, key);
    if (owner) {
      claimed.add(owner);
      next.audio = JSON.parse(JSON.stringify(owner.audio)) as SegmentAudio;
      if (owner.candidate) {
        next.candidate = JSON.parse(JSON.stringify(owner.candidate)) as SegmentAudio;
        candidates++;
      }
      if (owner.flag) next.flag = { ...owner.flag };
      takes += owner.audio.takes?.length ?? 0;
      if (next.audio.status === "queued" || next.audio.status === "generating")
        next.audio = { status: "none", endpoint: null, ms: 0, duration: 0 };
      if (next.audio.status === "done" || next.audio.status === "stale") {
        const moved = opts.drift(next, next.audio);
        next.audio.status = moved.length ? "stale" : "done";
        if (moved.length) stale++;
        else kept++;
      }
    }
    if (next.audio.duration <= 0 && narrated) unrendered++;
    segments.push(next);
  }

  const dropped = pool.filter((s) => !claimed.has(s) && s.audio.duration > 0).length;
  // What the restored chapter's narration reads as is the run's question, not a second opinion:
  // `chapterNarration` is what a finished run, a cancelled one and a cancelled queued job all write,
  // so a restore that answered it differently would be overwritten by the next thing that happened.
  const narration = chapterNarration(segments);

  const missing = new Map<string, number>();
  for (const s of segments)
    if (!opts.cast.has(s.speaker)) missing.set(s.speaker, (missing.get(s.speaker) ?? 0) + 1);

  return {
    segments,
    comparison: compareScripts(current, version),
    kept,
    stale,
    dropped,
    unrendered,
    takes,
    candidates,
    narration,
    scripting: segments.some((s) => s.fallback) ? "fallback" : "done",
    missingSpeakers: [...missing].map(([name, lines]) => ({ name, lines })),
  };
}

/** The consequences of a restore, as the sentences the panel shows before it is pressed. */
export function restoreConsequences(plan: RestorePlan): string[] {
  const n = (count: number, one: string, many = one + "s") =>
    `${count} ${count === 1 ? one : many}`;
  const out: string[] = [];
  const c = plan.comparison;
  out.push(
    `${n(c.lines, "line")} change, and the chapter goes from ${n(c.fromCount, "line")} to ${c.toCount}`,
  );
  if (plan.kept) out.push(`${n(plan.kept, "clip")} still match the restored lines and stay usable`);
  if (plan.stale)
    out.push(`${n(plan.stale, "clip")} carry over but no longer match, so they become stale`);
  if (plan.dropped)
    out.push(
      `${n(plan.dropped, "clip")} belong to lines this version does not have, so they are dropped`,
    );
  if (plan.unrendered) out.push(`${n(plan.unrendered, "restored line")} have no audio at all`);
  if (plan.takes || plan.candidates)
    out.push(
      `${n(plan.takes, "earlier take")} and ${n(plan.candidates, "retake")} travel with the clips they belong to`,
    );
  return out;
}
