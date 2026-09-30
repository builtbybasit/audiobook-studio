// A line of the script as a script file holds it, and back. See docs/script-transfer.md.
//
// **Expression tags travel inside the words.** A line's annotations are UTF-16 offsets into its
// text, and an offset is silently wrong after the first hand edit — which is exactly what a file
// someone opens in an editor is for. So in the file a tag is a marker at its place: `{sigh}`, with
// `{sigh!}` for one that is omitted and `{sigh?}` for one awaiting review, the suffixes
// `exprSignature` already keys on. The name is the tag's shared `id`, never a provider's token:
// each provider spells tags its own way, and the file must not care which one rendered it.
//
// Pure, and in `src/lib` rather than on the server, so the browser can read a chapter file with
// the same scanner the server imports it with.
import type { ExpressionAnnotation, ExpressionTag, ScriptFileLine, Segment } from "@/types";
import { NARRATOR } from "@/lib/cast";
import { isSiteText } from "@/lib/siteText";

export const SCRIPT_FORMAT = "audiobook-studio/script";
export const SCRIPT_CHAPTER_FORMAT = "audiobook-studio/script-chapter";
export const SCRIPT_FORMAT_VERSION = 1;

/** One marker read out of a line: the tag's shared id, where it sits in the plain text, and how. */
export interface Mark {
  id: string;
  at: number;
  omitted?: boolean;
  needsReview?: boolean;
}

/** A line whose markers cannot be read; `at` is where in the marked text it went wrong. */
export class MarkerError extends Error {
  override readonly name = "MarkerError";
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

/**
 * A tag id is whatever the person who configured the tag typed, so the characters a marker is made
 * of are escaped inside it with a backslash: `{huh\?}` is the tag `huh?`, where `{huh?}` is the
 * tag `huh` awaiting review.
 */
const escapeId = (id: string): string => id.replace(/[\\{}!?]/g, "\\$&");

/** The suffixes a marker may carry, in the order `exprSignature` writes them. */
const suffix = (a: { omitted?: boolean; needsReview?: boolean }): string =>
  `${a.omitted ? "!" : ""}${a.needsReview ? "?" : ""}`;

/**
 * A marker that starts a word — at the start of the line, or after whitespace — is written with one
 * space after it, and the reader takes that space back: `{sigh} Don't move.` is how a person types
 * it, and reads as the line `Don't move.` with the tag before its first word. Glued to a word, as in
 * `move{sigh}.`, a marker takes no space. The same test on both sides keeps the round trip exact.
 */
const startsWord = (plain: string): boolean => plain === "" || /\s$/.test(plain);

/**
 * `text` with its tags written in as markers, and any literal `{` doubled so it cannot be read as
 * one. Tags at the same position keep the order the line holds them in, because that order is part
 * of the line's signature.
 */
export function writeMarkers(text: string, expressions?: readonly ExpressionAnnotation[]): string {
  const marks = [...(expressions ?? [])]
    .map((a, i) => ({ a, i }))
    // stable: position first, then the order the line had them in
    .sort((x, y) => x.a.at - y.a.at || x.i - y.i)
    .map(({ a }) => a);
  let out = "";
  let from = 0;
  const escape = (s: string): string => s.replaceAll("{", "{{");
  for (const a of marks) {
    const at = Math.max(from, Math.min(a.at, text.length));
    out += escape(text.slice(from, at)) + `{${escapeId(a.id)}${suffix(a)}}`;
    if (startsWord(text.slice(0, at))) out += " ";
    from = at;
  }
  return out + escape(text.slice(from));
}

/**
 * The plain text of a marked line, and the markers it held with their positions in that text.
 *
 * A scanner rather than a strip-by-regex, so a doubled `{{` is a brace, a marker cannot swallow
 * the words after an unclosed one, and a line that does not parse is refused with where it broke
 * rather than imported with a tag's name read aloud.
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
    // the marker's body, each character marked by whether a backslash escaped it
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
    // `!?` in the order the signature writes them; either alone is fine too
    const last = (c: string): boolean => body.at(-1)?.c === c && !body.at(-1)!.escaped;
    if (last("?")) {
      mark.needsReview = true;
      body.pop();
    }
    if (last("!")) {
      mark.omitted = true;
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

/** What a script file keeps of a line: the script, and nothing local to this install. */
export function toFileLine(s: Segment): ScriptFileLine {
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
  return line;
}

/**
 * A file line as a segment of this install: `id`, no audio, and each marker turned back into an
 * annotation of the tag the speaking endpoint has by that id.
 *
 * A tag the endpoint does not offer is still kept — dropping it would lose a decision someone made
 * — but it arrives needing review, the way a change of model already leaves one, with its id for a
 * label until someone looks. Throws `MarkerError` for a line whose markers do not parse. A line of
 * site text or a note is the Narrator's whoever the file names, as it is when a model or a person
 * marks one, so a hand-edited file cannot bring a speaker into the cast that reads nothing.
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
      const tag = tags.find((t) => t.id === m.id);
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
  return s;
}

/**
 * `chapters/0012-the-gate.json`: numbered so a folder lists in reading order, named so a person
 * can find the chapter they mean to edit. The number is the chapter's place in this export, not
 * an id — nothing matches on it.
 */
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
