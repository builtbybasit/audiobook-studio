// A script line as a script file holds it, and back. Tags are inline markers, not offsets (which
// break on the first hand edit): `{sigh}`, `{sigh!}` omitted, `{sigh?}` awaiting review, `{sigh~}`
// scripted, `{pause 1.5s}`. The name is the tag's shared `id`, never a provider's token.
import type { ExpressionAnnotation, ExpressionTag, ScriptFileLine, Segment } from "@/types";
import { NARRATOR } from "@/lib/cast";
import { PAUSE_WORDS, pauseAnnotation, scriptedAnnotation } from "@/lib/expressions";
import { isSiteText } from "@/lib/siteText";

export const SCRIPT_FORMAT = "audiobook-studio/script";
export const SCRIPT_CHAPTER_FORMAT = "audiobook-studio/script-chapter";
export const SCRIPT_FORMAT_VERSION = 2;
/** Beside `manifest.json`: the effects the file names, and the book's own settings. */
export const EFFECTS_FILE = "effects.json";
export const BOOK_FILE = "book.json";
/** A plan's stand-in id for a file effect the library lacks, until the apply step creates it. */
export const NEW_EFFECT = "new:";

export interface Mark {
  id: string;
  at: number;
  omitted?: boolean;
  needsReview?: boolean;
  scripted?: boolean;
}

/** `at` is where in the marked text it went wrong. */
export class MarkerError extends Error {
  override readonly name = "MarkerError";
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

/** `{huh\?}` is the tag `huh?`; `{huh?}` is the tag `huh` awaiting review. */
const escapeId = (id: string): string => id.replace(/[\\{}!?~]/g, "\\$&");

/** `~!?`: scripted, omitted, awaiting review. The history's line signature uses it too. */
export const markSuffix = (a: {
  scripted?: boolean;
  omitted?: boolean;
  needsReview?: boolean;
}): string => `${a.scripted ? "~" : ""}${a.omitted ? "!" : ""}${a.needsReview ? "?" : ""}`;

/** The tag's id, or `pause 1.5s` for a pause with its own length. */
export const markName = (a: Pick<ExpressionAnnotation, "id" | "kind" | "seconds">): string =>
  a.kind === "pause" && a.seconds != null ? `${a.id} ${a.seconds}s` : a.id;
const PAUSE_MARK = new RegExp(`^(${PAUSE_WORDS.join("|")})(?: (\\d+(?:\\.\\d+)?)s)?$`);

/**
 * A marker starting a word is written with one space after it, which the reader takes back
 * (`{sigh} Don't move.`). The same test on both sides keeps the round trip exact.
 */
const startsWord = (plain: string): boolean => plain === "" || /\s$/.test(plain);

/** Literal `{` is doubled. Tags at one position keep their order: it is part of the signature. */
export function writeMarkers(text: string, expressions?: readonly ExpressionAnnotation[]): string {
  const marks = [...(expressions ?? [])]
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.at - y.a.at || x.i - y.i)
    .map(({ a }) => a);
  let out = "";
  let from = 0;
  const escape = (s: string): string => s.replaceAll("{", "{{");
  for (const a of marks) {
    const at = Math.max(from, Math.min(a.at, text.length));
    out += escape(text.slice(from, at)) + `{${escapeId(markName(a))}${markSuffix(a)}}`;
    if (startsWord(text.slice(0, at))) out += " ";
    from = at;
  }
  return out + escape(text.slice(from));
}

/**
 * A scanner, not a regex strip, so `{{` is a brace and an unclosed marker is refused with where it
 * broke rather than imported with a tag's name read aloud.
 */
export function readMarkers(marked: string): { text: string; marks: Mark[] } {
  let text = "";
  const marks: Mark[] = [];
  let i = 0;
  while (i < marked.length) {
    const ch = marked[i];
    if (ch !== "{") {
      text += ch;
      i++;
      continue;
    }
    if (marked[i + 1] === "{") {
      text += "{";
      i += 2;
      continue;
    }
    const body: { c: string; escaped: boolean }[] = [];
    let j = i + 1;
    for (; j < marked.length && marked[j] !== "}"; j++) {
      if (marked[j] === "{")
        throw new MarkerError("A tag marker is not closed — write a literal { as {{", i);
      const escaped = marked[j] === "\\" && j + 1 < marked.length;
      if (escaped) j++;
      body.push({ c: marked[j], escaped });
    }
    if (j >= marked.length)
      throw new MarkerError("A tag marker is not closed — write a literal { as {{", i);
    const close = j;
    const mark: Mark = { id: "", at: text.length };
    // `~!?` in the order `markSuffix` writes them
    const last = (c: string): boolean => body.at(-1)?.c === c && !body.at(-1)!.escaped;
    if (last("?")) {
      mark.needsReview = true;
      body.pop();
    }
    if (last("!")) {
      mark.omitted = true;
      body.pop();
    }
    if (last("~")) {
      mark.scripted = true;
      body.pop();
    }
    mark.id = body
      .map((b) => b.c)
      .join("")
      .trim();
    if (!mark.id) throw new MarkerError("A tag marker has no tag in it", i);
    marks.push(mark);
    i = close + 1;
    if (marked[i] === " " && startsWord(text)) i++;
  }
  return { text, marks };
}

/** Nothing local to this install: effects go by name, and one `effectName` can't name is left out. */
export function toFileLine(
  s: Segment,
  effectName: (id: string) => string | undefined = (id) => id,
): ScriptFileLine {
  const line: ScriptFileLine = {
    speaker: s.speaker,
    type: s.type,
    text: writeMarkers(s.text, s.expressions),
  };
  if (s.direction) line.direction = s.direction;
  if (s.pause != null) line.pause = s.pause;
  if (s.sep != null) line.sep = s.sep;
  if (s.edited) line.edited = true;
  if (s.fallback) {
    line.fallback = true;
    if (s.fallbackCount != null) line.fallbackCount = s.fallbackCount;
    if (s.fallbackMismatch != null) line.fallbackMismatch = s.fallbackMismatch;
  }
  const effects = (s.effects ?? []).flatMap((id) => effectName(id) ?? []);
  if (effects.length) line.effects = effects;
  return line;
}

/**
 * A file line as a segment, with no audio. A tag the endpoint does not offer is kept but needs
 * review. Site text and notes go to the Narrator whoever the file names. `effects` keep the file's
 * names; the caller swaps in ids. Throws `MarkerError`.
 */
export function fromFileLine(
  line: ScriptFileLine,
  id: number,
  tags: readonly ExpressionTag[],
  nextAnnotationId: () => number,
): Segment {
  const { text, marks } = readMarkers(line.text);
  const s: Segment = {
    id,
    type: line.type,
    speaker: isSiteText(line.type) ? NARRATOR : line.speaker,
    text,
    direction: line.direction ?? "",
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
  };
  if (marks.length)
    s.expressions = marks.map((m) => {
      const pause = m.id.match(PAUSE_MARK);
      if (pause) {
        const a = pauseAnnotation(
          pause[1] as (typeof PAUSE_WORDS)[number],
          m.at,
          nextAnnotationId(),
          pause[2] ? Number(pause[2]) : undefined,
        );
        if (m.scripted) a.scripted = true;
        if (m.omitted) a.omitted = true;
        if (m.needsReview) a.needsReview = true;
        return a;
      }
      const tag = tags.find((t) => t.id === m.id);
      if (m.scripted) {
        const a = scriptedAnnotation({ label: tag?.label ?? m.id, at: m.at }, nextAnnotationId());
        if (m.omitted) a.omitted = true;
        if (m.needsReview) a.needsReview = true;
        return a;
      }
      const a: ExpressionAnnotation = tag
        ? { ...tag, annotationId: nextAnnotationId(), at: m.at }
        : {
            id: m.id,
            label: m.id,
            token: "",
            kind: "delivery",
            annotationId: nextAnnotationId(),
            at: m.at,
          };
      if (m.omitted) a.omitted = true;
      if (m.needsReview || !tag) a.needsReview = true;
      return a;
    });
  if (line.pause != null) s.pause = line.pause;
  if (line.sep != null) s.sep = line.sep;
  if (line.edited) s.edited = true;
  if (line.fallback) {
    s.fallback = true;
    s.fallbackCount = line.fallbackCount;
    s.fallbackMismatch = line.fallbackMismatch;
  }
  if (line.effects?.length) s.effects = [...line.effects];
  return s;
}

/** `chapters/0012-the-gate.json`. The number is the place in this export; nothing matches on it. */
export function chapterFileName(position: number, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return `chapters/${String(position).padStart(4, "0")}-${slug || "chapter"}.json`;
}
