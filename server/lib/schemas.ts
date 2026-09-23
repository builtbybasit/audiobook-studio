// The domain shapes as request bodies.
//
// A route validates what arrives against these before an operation sees it, so a body with a
// speaker whose gender is "male" or a line with no text is a 400 naming the field rather than a
// row the app cannot read back. They are deliberately no stricter than the types in `@/types`:
// a field the domain leaves optional is optional here, and the audio a line carries is checked for
// the fields every reader relies on and passed through otherwise.
import * as v from "valibot";

import type { Character, ExportSettings, LexEntry, Profile, Segment, VersionOrigin } from "@/types";
import type { Credential } from "@/lib/credentials";
import { SAMPLE_RATES } from "@/lib/speech";
import type { EndpointSettings } from "~/db/rows";

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

/**
 * Everything a build runs with, checked here so a settings object that would make a nonsense of
 * the plan is a 400 naming the field rather than an audiobook called `undefined.m4b`.
 *
 * `useStale` is a consent and not a preference: it is the listener saying, in the blocker panel,
 * that they want clips the script has moved under in the file anyway. It arrives with the request
 * because the build refuses without it, and it is stored with the export so the page can say later
 * that this version was built that way.
 */
export const ExportSettingsSchema = v.object({
  filename: v.string(),
  title: v.string(),
  series: v.string(),
  author: v.string(),
  narrator: v.string(),
  year: v.pipe(v.number(), v.integer()),
  description: v.string(),
  cover: v.nullable(v.string()),
  format: v.picklist(["m4b", "mp3"]),
  grouping: v.picklist(["single", "volume", "chapter"]),
  bitrate: v.pipe(v.number(), v.integer(), v.minValue(8), v.maxValue(320)),
  markers: v.boolean(),
  markerPattern: v.string(),
  volPrefix: v.boolean(),
  chapterGap: v.pipe(v.number(), v.minValue(0), v.maxValue(60)),
  normalize: v.boolean(),
  loudness: v.picklist([-23, -18, -16]),
  useStale: v.boolean(),
}) satisfies v.GenericSchema<unknown, ExportSettings>;

// ---- endpoints ----
//
// The Endpoints page saves its whole configuration at once, so these are the domain's endpoint
// shapes minus what an endpoint *observed* — its latency history, its failure counts, a backoff —
// which is this session's telemetry and not configuration. `v.object` drops those fields rather
// than refusing them, so the page can send the objects it holds as they are.

/** A price: `null` is "not known", which is never `0`. */
const Rate = v.nullable(v.pipe(v.number(), v.minValue(0)));
const Id = v.pipe(v.string(), v.nonEmpty("must not be empty"));
const Count = v.pipe(v.number(), v.integer(), v.minValue(0));
const Percent = v.pipe(v.number(), v.minValue(0), v.maxValue(100));
const SplitMode = v.picklist(["sentence", "clause", "word", "char"]);
const BillingUnit = v.picklist(["chars", "bytes", "tokens", "audio-tokens", "minute", "request"]);
const Rates = v.partial(
  v.object({
    input: Rate,
    output: Rate,
    cachedInput: Rate,
    cacheWrite: Rate,
    speech: Rate,
    textTokens: Rate,
    audioTokens: Rate,
  }),
);
const Minute = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1440));

const RateWindowSchema = v.object({
  id: Id,
  label: v.string(),
  days: v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6))),
  from: Minute,
  to: Minute,
  percent: v.optional(Percent),
  rates: v.optional(Rates),
});

const PromotionSchema = v.object({
  id: Id,
  label: v.string(),
  from: v.nullable(v.number()),
  until: v.nullable(v.number()),
  scope: v.array(
    v.picklist([
      "input",
      "cachedInput",
      "cacheWrite",
      "output",
      "speech",
      "textTokens",
      "audioTokens",
      "model",
    ]),
  ),
  percent: v.optional(Percent),
  rates: v.optional(Rates),
  note: v.optional(v.string()),
});

const PricingSchema = v.object({
  cachedInput: Rate,
  cacheWrite: Rate,
  timezone: v.pipe(v.string(), v.nonEmpty("must name a timezone")),
  windows: v.array(RateWindowSchema),
  promotions: v.array(PromotionSchema),
});

/** The operational block; optional field by field, as an endpoint saved before it existed has none. */
const Ops = {
  timeoutSec: v.optional(Count),
  maxRetries: v.optional(Count),
  cooldownSec: v.optional(Count),
  spendLimit: v.optional(Rate),
  credentialId: v.optional(v.nullable(Id)),
  quotaGroup: v.optional(v.nullable(v.string())),
};

const Common = {
  id: Id,
  name: v.string(),
  baseUrl: v.string(),
  model: v.string(),
  enabled: v.boolean(),
  concurrency: v.pipe(v.number(), v.integer(), v.minValue(1)),
  needsKey: v.boolean(),
  /** write-only: absent keeps the stored key, "" forgets it — see `replaceEndpoints` */
  apiKey: v.optional(v.string()),
  /** what a read said; accepted so a page can send back what it was given, and ignored */
  hasKey: v.optional(v.boolean()),
  maxChars: Count,
  splitAt: SplitMode,
  pricing: v.optional(PricingSchema),
  ...Ops,
};

export const EndpointSchema = v.object({
  ...Common,
  latency: v.pipe(v.number(), v.minValue(0)),
  failRate: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  price: v.pipe(v.number(), v.minValue(0)),
  voices: v.array(v.object({ id: Id, gender: Gender, label: v.string() })),
  billing: v.optional(
    v.object({
      unit: BillingUnit,
      rate: Rate,
      audioRate: v.optional(Rate),
      audioTokensPerSecond: v.optional(v.pipe(v.number(), v.minValue(0))),
      billsInstructions: v.optional(v.boolean()),
      parked: v.optional(
        v.record(BillingUnit, v.object({ rate: Rate, audioRate: v.optional(Rate) })),
      ),
    }),
  ),
  expressions: v.optional(
    v.object({
      status: v.picklist(["unknown", "unsupported", "supported"]),
      model: v.string(),
      baseUrl: v.string(),
      tags: v.array(
        v.object({
          id: Id,
          label: v.string(),
          token: v.string(),
          kind: v.picklist(["sound", "delivery"]),
        }),
      ),
    }),
  ),
  // speech only: a scripting profile has no rate, and one sent on a profile is dropped with the
  // other fields a profile does not have
  sampleRate: v.optional(
    v.nullable(v.picklist(SAMPLE_RATES, `must be one of ${SAMPLE_RATES.join(", ")} Hz`)),
  ),
}) satisfies v.GenericSchema<unknown, EndpointSettings>;

export const ProfileSchema = v.object({
  ...Common,
  inPrice: v.pipe(v.number(), v.minValue(0)),
  outPrice: v.pipe(v.number(), v.minValue(0)),
  maxOutputTokens: Count,
  secPerChunk: v.pipe(v.number(), v.minValue(0)),
}) satisfies v.GenericSchema<unknown, Profile>;

export const CredentialSchema = v.object({
  id: Id,
  label: v.string(),
  note: v.string(),
}) satisfies v.GenericSchema<unknown, Credential>;
