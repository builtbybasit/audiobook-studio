// Chapter script history, pure: what a version is (`scriptSignature`, never the audio), what two
// disagree on (`compareScripts`), and what a restore does to rendered clips (`planRestore`). The
// store applies exactly what the plan counted, so the panel's promise and the result agree.
import { diffArrays, diffWords } from "diff";
import type {
  ChangeGroup,
  ChangeKind,
  Book,
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
import { describeOrigin } from "@/lib/prompt";
import { markName, markSuffix } from "@/lib/scriptFile";
import { chapterNarration } from "@/lib/runPlan";
import { isSpoken } from "@/lib/siteText";
import { clone } from "@/lib/utils";

/** Edits less than this apart are the same editing session. */
export const SESSION_IDLE_MS = 10_000;

// ---------- what a version preserves ----------

const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
/** For comparing a line against two halves of itself. */
const tight = (t: string): string => t.replace(/\s+/g, "");

const exprSignature = (s: Segment): string =>
  (s.expressions ?? []).map((a) => `${markName(a)}@${a.at}${markSuffix(a)}`).join(",");

/**
 * Everything a version keeps about one line. The clip is left out so a background render does not
 * look like a script change; spacing is not normalised, so a spacing-only edit is a new version.
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

/** Without the clip, the flag or anything else about the audio. */
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

/** Shares nothing with the live script. */
export const snapshotScript = (segments: Segment[]): Segment[] => segments.map(scriptOnly);

/** A demo situation's versions as a history, ids in the order given. */
export const seededHistory = (seeded: {
  versions: Omit<ScriptVersion, "id">[];
  head: HistoryHead;
}): ChapterHistory => ({
  versions: seeded.versions.map((v, i) => ({
    ...v,
    id: i + 1,
    segments: snapshotScript(v.segments),
  })),
  head: clone(seeded.head),
  nextId: seeded.versions.length + 1,
});

// ---------- preserving a script before it is replaced ----------

export interface Capture {
  added: ScriptVersion | null;
  head: HistoryHead;
  nextId: number;
}

/**
 * The rule behind every history entry, shared by store and server: the working script is kept
 * before `origin` replaces it, labelled by what produced it, and never twice. Nothing is added for
 * an empty script, a no-op (`next` equals it), or a script already the newest entry.
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

/** Whether an edit now joins the head's session. The server's clock check for the store's timer. */
export const sessionOpen = (head: HistoryHead, now: number): boolean =>
  !!head.open && head.origin.kind === "edited" && now - head.at < SESSION_IDLE_MS;

// ---------- what an entry is called ----------

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
    case "imported":
      return origin.file ? `Imported from ${origin.file}` : "Imported";
    case "checkpoint":
      return `“${origin.name}”`;
  }
}

/** For the badge beside the label. */
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
    case "imported":
      return "imported";
    case "checkpoint":
      return "checkpoint";
  }
}

/**
 * "library prompt · 3f2a9c01", so two runs with the same model and different prompts read
 * differently. Empty when not scripted or no prompt was recorded.
 */
export function originPrompt(origin: VersionOrigin): string {
  if (origin.kind !== "scripted" || !origin.prompt) return "";
  const from =
    origin.prompt.from === "endpoint" && origin.profile
      ? `${origin.profile}'s prompt`
      : describeOrigin(origin.prompt);
  return `${from} · ${origin.prompt.fingerprint}`;
}

/** The second line: the detail that does not fit the label. */
export function originNote(origin: VersionOrigin): string {
  switch (origin.kind) {
    case "scripted":
      return [origin.model, originPrompt(origin)].filter(Boolean).join(" · ");
    case "edited":
      return "one editing session";
    case "bulk":
      return `${origin.lines} line${origin.lines === 1 ? "" : "s"} in one batch`;
    case "restored":
      return "the script as that version left it";
    case "imported":
      return origin.chapters
        ? `${origin.chapters} chapter${origin.chapters === 1 ? "" : "s"} in one import`
        : "read in from a script file";
    case "checkpoint":
      return origin.was ? `saved by hand · ${originLabel(origin.was)}` : "saved by hand";
  }
}

// ---------- comparing two scripts ----------

const WORD = /\S+\s*/g;
const wordsOf = (text: string): string[] => text.match(WORD) ?? [];

/** Word overlap, 0–1. */
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

/** Index pairs of a common subsequence of two key arrays: callers align what the keys came from. */
export function alignPairs(a: string[], b: string[]): [number, number][] {
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

/** Word-level runs. `diffWords` ignores whitespace when matching, so rewrapping reads unchanged. */
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
    ? s
        .expressions!.map(
          (a) => (a.kind === "pause" ? markName(a) : a.label) + (a.omitted ? " (omitted)" : ""),
        )
        .join(" · ")
    : "none";

function fieldChanges(from: Segment, to: Segment): FieldChange[] {
  const out: FieldChange[] = [];
  if (norm(from.text) !== norm(to.text)) out.push({ field: "text", from: from.text, to: to.text });
  // spacing or paragraph break only: no word diff can show it, so it is named rather than drawn
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

/** Length of a run (2–8) of `arr` from `start` reading as exactly `one` sans whitespace; else 0. */
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
 * What changed between two scripts of a chapter, in reading order. Lines match on words first;
 * the leftovers are checked for splits and joins, then paired as rewrites where the words mostly
 * agree, and only otherwise called new or gone.
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
  cast: Set<string>;
  /** `readNotes` decides which lines want a clip (`isSpoken`) */
  book: Pick<Book, "readNotes"> | undefined;
}

const clipText = (a: SegmentAudio): string => norm(a.text ?? "");
const worthKeeping = (s: Segment): boolean =>
  s.audio.status !== "none" || !!s.audio.takes?.length || !!s.candidate || !!s.flag;

/**
 * What restoring `version` over `current` would do to the script and the rendered audio. A clip
 * follows a restored line whose text matches the line's or the clip's own text (so a line since
 * joined into its neighbour gets its clip back), then is re-judged: done or stale. Clips whose line
 * the version lacks are dropped.
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
    // a line the book does not read is not missing its audio
    if (next.audio.duration <= 0 && narrated && isSpoken(next, opts.book)) unrendered++;
    segments.push(next);
  }

  const dropped = pool.filter((s) => !claimed.has(s) && s.audio.duration > 0).length;
  // the same rule every run writes, so the next run does not overwrite a different answer
  const narration = chapterNarration(segments, opts.book);

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

/** The sentences the panel shows before a restore is pressed. */
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
