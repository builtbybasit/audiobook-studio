// The domain shapes as request-body schemas, so a bad body is a 400 naming the field. No stricter
// than `@/types`: what the domain leaves optional is optional here.
import * as v from "valibot";

import { isFolder } from "@/lib/localServers";
import { SPEAKER_SPEED } from "@/lib/providers";

import type {
  BookPrompt,
  Character,
  Credential,
  ExportSettings,
  LexEntry,
  Profile,
  ProfilePrompt,
  PromptTemplate,
  ScriptFileBook,
  ScriptFileChapter,
  ScriptFileEffect,
  ScriptFileSpeaker,
  ScriptFileTerm,
  ScriptManifest,
  ScriptSettings,
  Segment,
  Step,
  Transcriber,
  VersionOrigin,
} from "@/types";
import { AGES } from "@/lib/cast";
import { REASONING_EFFORTS } from "@/lib/prompt";
import { SAMPLE_RATES } from "@/lib/speech";
import type { StoredEndpoint } from "@/lib/endpointTelemetry";
import { badRequest } from "~/lib/errors";

const Gender = v.picklist(["m", "f", "n", "?"]);

// ---- voice effects ----
// A chain goes to Python as written (`server/audio/effects.ts`): plugin names are looked up on the
// `pedalboard` module and params become keyword arguments, so both are held to safe identifiers.

/** An effect's id, or "none" where a choice is asked for; the op checks it exists. */
export const EffectIdSchema = v.pipe(v.string(), v.nonEmpty("must not be empty"), v.maxLength(64));

const PluginStepSchema = v.strictObject({
  plugin: v.pipe(
    v.string(),
    v.regex(/^[A-Za-z0-9]+$/, "must be a plugin's name: letters and digits"),
    v.maxLength(64),
  ),
  params: v.record(
    v.pipe(
      v.string(),
      v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a parameter's name"),
      v.maxLength(64),
    ),
    v.pipe(v.number(), v.finite()),
  ),
  on: v.boolean(),
});

/** Picks the schema by the `mix` key, so a refusal names the right fields. */
const StepSchema: v.GenericSchema<Step> = v.lazy((input) =>
  typeof input === "object" && input !== null && "mix" in input ? MixStepSchema : PluginStepSchema,
);

const LayerSchema = v.strictObject({
  name: v.pipe(v.string(), v.maxLength(100)),
  steps: v.pipe(v.array(StepSchema), v.maxLength(64)),
  on: v.boolean(),
});

const MixStepSchema = v.strictObject({
  mix: v.pipe(v.array(LayerSchema), v.minLength(1), v.maxLength(16)),
  on: v.boolean(),
});

function chainSize(steps: readonly Step[]): { depth: number; steps: number } {
  let depth = 0;
  let count = steps.length;
  for (const s of steps)
    if ("mix" in s)
      for (const layer of s.mix) {
        const inner = chainSize(layer.steps);
        depth = Math.max(depth, inner.depth + 1);
        count += inner.steps;
      }
  return { depth, steps: count };
}

/** `ExistingScope`; absent `chapters` = all of them, unknown ids reach nothing. */
export const ExistingScopeSchema = v.object({
  chapters: v.optional(v.array(v.pipe(v.number(), v.integer(), v.minValue(1)))),
  speaker: v.optional(v.pipe(v.string(), v.nonEmpty("must not be empty"))),
  speakers: v.optional(v.array(v.pipe(v.string(), v.nonEmpty("must not be empty")))),
});

export const ChainSchema = v.pipe(
  v.array(StepSchema),
  v.check((c) => chainSize(c).depth <= 4, "nests mixes more than four deep"),
  v.check((c) => chainSize(c).steps <= 256, "has more than 256 steps"),
) satisfies v.GenericSchema<unknown, Step[]>;

export const EffectBodySchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty"), v.maxLength(100)),
  chain: ChainSchema,
  /** `Effect.useWhen`; blank, null or absent = not offered to the scripting model */
  useWhen: v.optional(
    v.pipe(
      v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(300))),
      v.transform((x) => x || undefined),
    ),
  ),
});

/** null = left to the next level; read as absent. */
const unset = <T>(schema: v.GenericSchema<T>) =>
  v.optional(
    v.pipe(
      v.nullable(schema),
      v.transform((x) => x ?? undefined),
    ),
  );

const SpeakerSpeed = v.pipe(
  v.number(),
  v.minValue(SPEAKER_SPEED.min),
  v.maxValue(SPEAKER_SPEED.max),
);

export const CharacterSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
  aliases: v.array(v.pipe(v.string(), v.trim(), v.nonEmpty())),
  gender: Gender,
  /** null or absent = unknown */
  age: unset(v.picklist(AGES)),
  description: v.string(),
  voice: v.nullable(v.string()),
  style: v.string(),
  /** null or absent = their voice's (`speakerSpeed`) */
  speed: unset(SpeakerSpeed),
  color: v.string(),
  major: v.boolean(),
  isNew: v.optional(v.boolean()),
  keep: v.optional(v.boolean()),
  /** the effect on all their lines; null or absent = none */
  effect: unset(EffectIdSchema),
  /** their thought effect, an id or "none"; null or absent = the book's */
  thoughts: unset(EffectIdSchema),
  /** the character they are a persona of, by name; null or absent = none */
  personaOf: unset(v.pipe(v.string(), v.trim(), v.nonEmpty())),
  /** a disguise the scripting model found; kept through an edit that leaves the link alone */
  masked: v.optional(v.boolean()),
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

const SegmentType = v.picklist(["dialogue", "narration", "thought", "watermark", "note"]);
const AudioStatus = v.picklist(["none", "queued", "generating", "done", "failed", "stale"]);

/** A clip: the fields every reader relies on are checked, the rest passed through. */
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
  siteCheck: v.optional(
    v.object({ suggest: v.picklist(["watermark", "narration"]), why: v.string() }),
  ),
  flag: v.optional(
    v.looseObject({
      kind: v.picklist(["pronunciation", "delivery", "pause", "other", "heard"]),
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
        kind: v.picklist(["sound", "delivery", "pause"]),
        /** a pause's own length, in seconds */
        seconds: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(60))),
        annotationId: v.number(),
        at: v.pipe(v.number(), v.integer(), v.minValue(0)),
        omitted: v.optional(v.boolean()),
        needsReview: v.optional(v.boolean()),
        scripted: v.optional(v.boolean()),
      }),
    ),
  ),
  effects: v.optional(v.pipe(v.array(EffectIdSchema), v.maxLength(16))),
});

/** Assigning to `Segment` keeps the schema from drifting from the domain type. */
export type SegmentBody = v.InferOutput<typeof SegmentSchema>;
const _segmentIsASegment: Segment = null as unknown as SegmentBody;
void _segmentIsASegment;

export const VersionOriginSchema = v.variant("kind", [
  v.object({
    kind: v.literal("scripted"),
    profile: v.optional(v.string()),
    model: v.optional(v.string()),
    again: v.optional(v.boolean()),
    prompt: v.optional(
      v.object({
        from: v.picklist(["built-in", "library", "endpoint", "book"]),
        fingerprint: v.string(),
      }),
    ),
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
  v.object({
    kind: v.literal("imported"),
    file: v.optional(v.string()),
    chapters: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  }),
]) satisfies v.GenericSchema<unknown, VersionOrigin>;

// ---------- a script file ----------
// `<book>.script.zip`, checked piece by piece: a broken chapter file refuses that chapter, not the
// import. Unknown fields are ignored.

const FileText = v.pipe(v.string(), v.nonEmpty("must not be empty"));
const Hash = v.pipe(
  v.string(),
  v.regex(/^sha256:[0-9a-f]{64}$/, "must be sha256: and 64 hex digits"),
);
const WordCount = v.pipe(v.number(), v.integer(), v.minValue(0));

/** An effect as a script file names it; matched by name on import. */
const EffectName = v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty"), v.maxLength(100));

const VoiceHintSchema = v.looseObject({
  endpoint: v.string(),
  provider: v.string(),
  voiceId: FileText,
  voiceLabel: v.string(),
});

export const ScriptManifestSchema = v.looseObject({
  format: v.literal("audiobook-studio/script"),
  version: v.literal(2),
  title: v.string(),
  author: v.string(),
  chapters: v.array(
    v.looseObject({ file: FileText, title: v.string(), sourceHash: Hash, words: WordCount }),
  ),
}) satisfies v.GenericSchema<unknown, ScriptManifest>;

export const ScriptChapterSchema = v.looseObject({
  format: v.literal("audiobook-studio/script-chapter"),
  version: v.literal(2),
  title: v.string(),
  sourceHash: Hash,
  words: WordCount,
  lines: v.array(
    v.looseObject({
      speaker: v.pipe(v.string(), v.trim(), v.nonEmpty("must name a speaker")),
      type: SegmentType,
      text: FileText,
      direction: v.optional(v.string()),
      pause: v.optional(v.pipe(v.number(), v.minValue(0))),
      sep: v.optional(v.string()),
      edited: v.optional(v.boolean()),
      fallback: v.optional(v.boolean()),
      fallbackCount: v.optional(v.number()),
      fallbackMismatch: v.optional(v.string()),
      effects: v.optional(v.array(EffectName)),
    }),
  ),
  recap: v.optional(v.string()),
}) satisfies v.GenericSchema<unknown, ScriptFileChapter>;

export const CastFileSchema = v.array(
  v.looseObject({
    name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
    aliases: v.optional(v.array(v.pipe(v.string(), v.trim(), v.nonEmpty())), []),
    gender: v.optional(Gender, "?"),
    description: v.optional(v.string(), ""),
    style: v.optional(v.string(), ""),
    speed: v.optional(SpeakerSpeed),
    color: v.optional(v.string()),
    major: v.optional(v.boolean()),
    personaOf: v.optional(v.pipe(v.string(), v.trim())),
    voice: v.optional(VoiceHintSchema),
    effect: v.optional(EffectName),
    thoughts: v.optional(EffectName),
  }),
) satisfies v.GenericSchema<unknown, ScriptFileSpeaker[]>;

export const EffectsFileSchema = v.array(
  v.looseObject({
    name: EffectName,
    chain: ChainSchema,
    useWhen: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(300))),
  }),
) satisfies v.GenericSchema<unknown, ScriptFileEffect[]>;

export const LexiconFileSchema = v.array(
  v.looseObject({
    term: FileText,
    say: v.string(),
    ipa: v.optional(v.string()),
    note: v.optional(v.string()),
    matchCase: v.optional(v.boolean()),
    enabled: v.optional(v.boolean(), true),
  }),
) satisfies v.GenericSchema<unknown, ScriptFileTerm[]>;

/** Lines of one chapter, by number: what a re-attribution or its undo points at. */
export const ChapterLinesSchema = v.object({
  chapterId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});

/**
 * `useStale` is consent from the blocker panel to build with stale clips; the build refuses without
 * it, and it is stored with the export.
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
// Configuration only: `v.object` drops telemetry fields, so the page can send what it holds.

/** A price: `null` is "not known", which is never `0`. */
const Rate = v.nullable(v.pipe(v.number(), v.minValue(0)));
const Id = v.pipe(v.string(), v.nonEmpty("must not be empty"));
const Count = v.pipe(v.number(), v.integer(), v.minValue(0));
const Percent = v.pipe(v.number(), v.minValue(0), v.maxValue(100));
const SplitMode = v.picklist(["paragraph", "sentence", "clause", "word", "char"]);
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

/** Optional field by field: older endpoints have none. */
const Ops = {
  timeoutSec: v.optional(Count),
  maxRetries: v.optional(Count),
  cooldownSec: v.optional(Count),
  spendLimit: v.optional(Rate),
  credentialId: v.optional(v.nullable(Id)),
  quotaGroup: v.optional(v.nullable(v.string())),
};

/** Absolute: the server's process resolves nothing against the app's own folder. */
const LocalServerSchema = v.object({
  dir: v.pipe(v.string(), v.trim(), v.check(isFolder, "must be an absolute folder, or empty")),
  command: v.pipe(v.string(), v.trim(), v.nonEmpty("must name a command")),
  stopCommand: v.optional(v.pipe(v.string(), v.trim())),
  heavy: v.boolean(),
  readySec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

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
  /** accepted so a page can send back what it read, and ignored */
  hasKey: v.optional(v.boolean()),
  maxChars: Count,
  splitAt: SplitMode,
  pricing: v.optional(PricingSchema),
  launch: v.optional(v.nullable(LocalServerSchema)),
  ...Ops,
};

export const EndpointSchema = v.object({
  ...Common,
  latency: v.pipe(v.number(), v.minValue(0)),
  failRate: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  price: v.pipe(v.number(), v.minValue(0)),
  voices: v.array(
    v.object({ id: Id, gender: Gender, label: v.string(), speed: unset(SpeakerSpeed) }),
  ),
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
      brackets: v.array(v.picklist(["round", "square", "angle"])),
      open: v.boolean(),
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
  // speech only; dropped on a scripting profile
  sampleRate: v.optional(
    v.nullable(v.picklist(SAMPLE_RATES, `must be one of ${SAMPLE_RATES.join(", ")} Hz`)),
  ),
  encoding: v.optional(
    v.nullable(
      v.object({
        format: v.picklist(["wav", "mp3", "opus"]),
        bitrate: v.optional(v.pipe(v.number(), v.integer())),
      }),
    ),
  ),
  batch: v.optional(v.boolean()),
  makesVoices: v.optional(v.boolean()),
  server: v.optional(v.nullable(v.picklist(["breezecpp"]))),
}) satisfies v.GenericSchema<unknown, StoredEndpoint>;

// ---- the scripting prompt ----
// Only shapes here; a prompt's content is checked by `@/lib/prompt` and refused with
// `refusePrompt`, so the page gets a sentence saying what to change.

export const PromptTemplateSchema = v.object({
  system: v.string(),
  user: v.string(),
}) satisfies v.GenericSchema<unknown, PromptTemplate>;

export const ProfilePromptSchema = v.object({
  mode: v.picklist(["default", "replace"]),
  notes: v.string(),
  ...PromptTemplateSchema.entries,
}) satisfies v.GenericSchema<unknown, ProfilePrompt>;

export const BookPromptSchema = v.object({
  notes: v.string(),
  replace: v.boolean(),
  ...PromptTemplateSchema.entries,
}) satisfies v.GenericSchema<unknown, BookPrompt>;

/** `book.json` of a script file: the book's own settings, voices as hints, effects by name. */
const FileSeconds = v.pipe(v.number(), v.minValue(0), v.maxValue(60));

export const BookFileSchema = v.looseObject({
  pacing: v.optional(
    v.object({
      line: FileSeconds,
      turn: FileSeconds,
      inlineShort: FileSeconds,
      inlineLong: FileSeconds,
    }),
  ),
  prompt: v.optional(BookPromptSchema),
  readNotes: v.optional(v.boolean()),
  thoughts: v.optional(EffectName),
  characterVoice: v.optional(
    v.object({
      by: v.picklist(["one", "gender"]),
      one: v.optional(VoiceHintSchema),
      male: v.optional(VoiceHintSchema),
      female: v.optional(VoiceHintSchema),
      other: v.optional(VoiceHintSchema),
    }),
  ),
}) satisfies v.GenericSchema<unknown, ScriptFileBook>;

/** Which profile scripting runs go to; see `~/db/settings`. Other fields are dropped. */
export const ScriptSettingsSchema = v.object({
  profile: v.nullable(v.pipe(v.string(), v.nonEmpty())),
}) satisfies v.GenericSchema<unknown, ScriptSettings>;

/** Refuse a prompt that has problems, naming whose it is: “OpenAI”'s prompt: … */
export function refusePrompt(whose: string, problems: readonly string[]): void {
  if (problems.length) throw badRequest(`${whose}: ${problems.join(" ")}`);
}

export const ProfileSchema = v.object({
  ...Common,
  inPrice: v.pipe(v.number(), v.minValue(0)),
  outPrice: v.pipe(v.number(), v.minValue(0)),
  maxOutputTokens: Count,
  secPerChunk: v.pipe(v.number(), v.minValue(0)),
  reasoning: v.optional(v.nullable(v.picklist(REASONING_EFFORTS))),
  prompt: v.optional(v.nullable(ProfilePromptSchema)),
}) satisfies v.GenericSchema<unknown, Profile>;

export const TranscriberSchema = v.object({
  id: Id,
  name: v.string(),
  baseUrl: v.string(),
  model: v.string(),
  enabled: v.boolean(),
  concurrency: v.pipe(v.number(), v.integer(), v.minValue(1)),
  needsKey: v.boolean(),
  apiKey: Common.apiKey,
  hasKey: Common.hasKey,
  perMinute: v.pipe(v.number(), v.minValue(0)),
  hotwordLambda: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100))),
  resample16k: v.optional(v.boolean()),
  pricing: v.optional(PricingSchema),
  launch: Common.launch,
  ...Ops,
}) satisfies v.GenericSchema<unknown, Transcriber>;

export const CredentialSchema = v.object({
  id: Id,
  label: v.string(),
  note: v.string(),
}) satisfies v.GenericSchema<unknown, Credential>;
