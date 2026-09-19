// The domain shapes as request bodies.
//
// A route validates what arrives against these before an operation sees it, so a body with a
// speaker whose gender is "male" or a line with no text is a 400 naming the field rather than a
// row the app cannot read back. They are deliberately no stricter than the types in `@/types`:
// a field the domain leaves optional is optional here, and the audio a line carries is checked for
// the fields every reader relies on and passed through otherwise.
import * as v from "valibot";

import type { Character, LexEntry, Segment, VersionOrigin } from "@/types";

const Gender = v.picklist(["m", "f", "n", "?"]);

export const CharacterSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
  aliases: v.array(v.pipe(v.string(), v.trim(), v.nonEmpty())),
  gender: Gender,
  description: v.string(),
  voice: v.nullable(v.string()),
  style: v.string(),
  color: v.string(),
  major: v.boolean(),
  isNew: v.optional(v.boolean()),
  keep: v.optional(v.boolean()),
}) satisfies v.GenericSchema<unknown, Character>;

export const LexEntrySchema = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  term: v.string(),
  say: v.string(),
  ipa: v.optional(v.string()),
  note: v.optional(v.string()),
  matchCase: v.optional(v.boolean()),
  enabled: v.boolean(),
}) satisfies v.GenericSchema<unknown, LexEntry>;

const SegmentType = v.picklist(["dialogue", "narration", "thought"]);
const AudioStatus = v.picklist(["none", "queued", "generating", "done", "failed", "stale"]);

/** A clip, checked for what every reader of one relies on and passed through otherwise. */
const Audio = v.looseObject({
  status: AudioStatus,
  endpoint: v.nullable(v.string()),
  ms: v.number(),
  duration: v.number(),
});

export const SegmentSchema = v.looseObject({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  type: SegmentType,
  speaker: v.pipe(v.string(), v.nonEmpty("must name a speaker")),
  text: v.pipe(v.string(), v.nonEmpty("must not be empty")),
  direction: v.string(),
  audio: Audio,
  candidate: v.optional(Audio),
  fallback: v.optional(v.boolean()),
  fallbackCount: v.optional(v.number()),
  fallbackMismatch: v.optional(v.string()),
  edited: v.optional(v.boolean()),
  flag: v.optional(
    v.looseObject({
      kind: v.picklist(["pronunciation", "delivery", "pause", "other"]),
      note: v.string(),
      at: v.number(),
    }),
  ),
  pause: v.optional(v.number()),
  sep: v.optional(v.string()),
  expressions: v.optional(
    v.array(
      v.looseObject({
        id: v.string(),
        label: v.string(),
        token: v.string(),
        kind: v.picklist(["sound", "delivery"]),
        annotationId: v.number(),
        at: v.pipe(v.number(), v.integer(), v.minValue(0)),
        omitted: v.optional(v.boolean()),
        needsReview: v.optional(v.boolean()),
      }),
    ),
  ),
});

/** The body a script arrives as; `satisfies` keeps it from drifting from the domain type. */
export type SegmentBody = v.InferOutput<typeof SegmentSchema>;
const _segmentIsASegment: Segment = null as unknown as SegmentBody;
void _segmentIsASegment;

export const VersionOriginSchema = v.variant("kind", [
  v.object({
    kind: v.literal("scripted"),
    profile: v.optional(v.string()),
    model: v.optional(v.string()),
    again: v.optional(v.boolean()),
  }),
  v.object({ kind: v.literal("edited"), edits: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
  v.object({
    kind: v.literal("bulk"),
    label: v.string(),
    lines: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.object({
    kind: v.literal("restored"),
    from: v.pipe(v.number(), v.integer(), v.minValue(1)),
    fromAt: v.number(),
  }),
]) satisfies v.GenericSchema<unknown, VersionOrigin>;

/** Lines of one chapter, named by number: what a re-attribution or its undo points at. */
export const ChapterLinesSchema = v.object({
  chapterId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});
