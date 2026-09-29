// Chapter script history: the versions a chapter's script has been through, and restoring one.
//
// The history is the server's — what makes an entry is tested against it in
// `tests/server/scriptEdit.test.ts` — so what is tested here is the page's side of it. A comparison
// says what really moved between two scripts. A restore keeps the audio that still belongs to the
// restored lines, marks what no longer matches, and can be undone whole. An imported script file
// is written the way a restore is, behind one Undo. They run against the demo library, whose first
// chapter of The Cliché Cultivation World is scripted and narrated; a comparison needs no library,
// and a test that puts the demo into a situation is handed it rebuilt, so only the rest reset it.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { readinessOf } from "@/lib/exports";
import {
  compareScripts,
  originLabel,
  scriptOnly,
  scriptSignature,
  wordDiff,
} from "@/lib/scriptHistory";
import { ApiError, libraryService, type LibraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useSpeakerSamplesStore } from "@/stores/speakerSamples";
import { useTransferStore } from "@/stores/transfer";
import { useUiStore } from "@/stores/ui";
import type {
  ImportChapter,
  Job,
  ScriptImportPlan,
  Segment,
  SpeakerSamples,
  VoiceRow,
} from "@/types";
import { demoServer, type DemoServer } from "./support/demoServer";
import { testPinia, type TestPinia } from "./support/pinia";

let demo: DemoServer;
let pinia: TestPinia;
let castStore: ReturnType<typeof useCastStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let historyStore: ReturnType<typeof useHistoryStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let transferStore: ReturnType<typeof useTransferStore>;
let samplesStore: ReturnType<typeof useSpeakerSamplesStore>;
let uiStore: ReturnType<typeof useUiStore>;
/** every undo a toast was given, in order */
let undos: (() => void | Promise<void>)[] = [];
const undoLast = async () => await undos.at(-1)!();

const segments = (chId = 1) => scriptsStore.segmentsOf("cliche", chId);
const versions = (chId = 1) => historyStore.versionsOf("cliche", chId);
const head = (chId = 1) => historyStore.headOf("cliche", chId);
const speaker = (name: string) => castStore.charactersOf("cliche").find((c) => c.name === name);
/** Let every chapter's script write land, and the history it answered with with it. */
const settled = (...chIds: number[]) =>
  Promise.all(chIds.map((chId) => scriptsStore._settled("cliche", chId)));
/** A run on this chapter that has not finished. */
const inFlight = (chId: number): Job =>
  ({
    id: 99,
    kind: "narration",
    bookId: "cliche",
    chapterId: chId,
    label: `Narrate chapter ${chId}`,
    status: "running",
  }) as Job;

/** Read the book, its cast and endpoints, and these chapters' scripts and histories, as a page would. */
async function open(...chIds: number[]) {
  const svc = libraryService();
  await Promise.all([libraryStore.loadBook("cliche"), endpointsStore.load()]);
  castStore._install("cliche", await svc.cast("cliche"));
  for (const chId of chIds) {
    scriptsStore._install("cliche", chId, await svc.chapterScript("cliche", chId));
    historyStore._install("cliche", chId, await svc.chapterHistory("cliche", chId));
  }
}

beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  demo = await demoServer();
});
beforeEach(() => {
  pinia = testPinia();
  castStore = useCastStore();
  endpointsStore = useEndpointsStore();
  historyStore = useHistoryStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  scriptsStore = useScriptsStore();
  transferStore = useTransferStore();
  samplesStore = useSpeakerSamplesStore();
  uiStore = useUiStore();
  // the real toast needs a DOM; this stub also keeps the last undo it was offered, which is how the
  // tests below take back a restore or an import exactly as the toast's Undo button would
  undos = [];
  uiStore.toast = (_msg, opts = {}) => {
    if (opts.undo) undos.push(opts.undo);
    return "test";
  };
});
// writes are still on their way when a test ends; they must not land on the next test's demo
afterEach(async () => {
  const chapters = Object.keys(scriptsStore.segments).map((k) => Number(k.split(":")[1]));
  await settled(...chapters);
  await new Promise((r) => setTimeout(r, 10));
  pinia.stop();
});

describe("comparing two scripts", () => {
  const seg = (id: number, patch: Partial<Segment> = {}): Segment => ({
    id,
    type: "dialogue",
    speaker: "Ji Ning",
    text: `Line number ${id} as it was first written.`,
    direction: "",
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
    ...patch,
  });

  test("it tells a rewrite from a new line, and says which words moved", () => {
    const from = [seg(1), seg(2), seg(3)];
    const to = [
      seg(1),
      seg(2, { text: "Line number 2 as it was rewritten by hand." }),
      seg(3),
      seg(4, { text: "An entirely different sentence appears here." }),
    ];
    const c = compareScripts(from, to);
    expect(c.counts).toMatchObject({ text: 1, added: 1, removed: 0 });
    expect(c.lines).toBe(2);
    const rewritten = c.changes.find((x) => x.kind === "changed")!;
    expect(rewritten.fromIds).toEqual([2]);
    // the full stop ends both versions, so it is not part of what moved
    expect(rewritten.runs.filter((r) => r.kind === "remove").map((r) => r.text.trim())).toEqual([
      "first written",
    ]);
    expect(rewritten.runs.filter((r) => r.kind === "add").map((r) => r.text.trim())).toEqual([
      "rewritten by hand",
    ]);
  });

  test("a word keeps its place when only the punctuation after it changes", () => {
    // "shut," and "shut;" are the same word differently punctuated; marking the whole clause as
    // rewritten would hide that, so the word and its punctuation are compared separately
    const runs = wordDiff(
      "The gate was shut, and the road beyond it empty.",
      "The gate stood shut; the road beyond lay empty.",
    );
    expect(runs.filter((r) => r.kind === "same").map((r) => r.text.trim())).toContain("shut");
    expect(runs.filter((r) => r.kind === "remove").map((r) => r.text.trim())).toEqual([
      "was",
      ", and",
      "it",
    ]);
    expect(runs.filter((r) => r.kind === "add").map((r) => r.text.trim())).toEqual([
      "stood",
      ";",
      "lay",
    ]);
  });

  test("the same words spaced differently is a change, and says so in words", () => {
    const from = [seg(1)];
    const to = [seg(1, { text: "Line number 1 as it was\n\nfirst written." })];
    const c = compareScripts(from, to);
    expect(c.identical).toBe(false);
    expect(c.counts.text).toBe(1);
    // there is no word to mark either side of, so the change is named rather than drawn
    expect(c.changes[0].runs).toHaveLength(0);
    expect(c.changes[0].fields[0].detail).toContain("spaced differently");
  });

  test("speaker, direction, type, expressions and pauses are each their own change", () => {
    const from = [
      seg(1),
      seg(2, { direction: "wary" }),
      seg(3, {
        expressions: [
          { id: "sighs", label: "Sighs", token: "[sighs]", kind: "sound", annotationId: 1, at: 0 },
        ],
      }),
      seg(4, { pause: 1.5 }),
      seg(5, { type: "thought" }),
    ];
    const to = [seg(1, { speaker: "Elder Mo" }), seg(2, { direction: "" }), seg(3), seg(4), seg(5)];
    const c = compareScripts(from, to);
    expect(c.counts).toMatchObject({
      speaker: 1,
      direction: 1,
      expressions: 1,
      pause: 1,
      type: 1,
      added: 0,
      removed: 0,
    });
    const pause = c.changes.find((x) => x.groups.includes("pause"))!.fields[0];
    expect([pause.from, pause.to]).toEqual(["1.5s", "the book’s pause"]);
  });

  test("a line cut in two and two lines joined are recognised as such", () => {
    const whole = seg(1, {
      type: "narration",
      speaker: "Narrator",
      text: "The bell rang three times. Nobody moved.",
    });
    const halves = [
      seg(1, { type: "narration", speaker: "Narrator", text: "The bell rang three times." }),
      seg(2, { type: "narration", speaker: "Narrator", text: "Nobody moved." }),
    ];
    const split = compareScripts([whole, seg(9)], [...halves, seg(9)]);
    expect(split.counts).toMatchObject({ split: 1, added: 0, removed: 0 });
    expect(split.changes[0].toIds).toEqual([1, 2]);
    const joined = compareScripts([...halves, seg(9)], [whole, seg(9)]);
    expect(joined.counts).toMatchObject({ joined: 1, added: 0, removed: 0 });
    expect(joined.changes[0].fromIds).toEqual([1, 2]);
  });
});

describe("restoring", () => {
  /** The demo's chapter with a history: a first pass, a checkpoint, and a re-script over it. */
  async function withHistory() {
    await demo.situate("script-history");
    await open(1);
    return versions().find((v) => v.origin.kind === "checkpoint")!;
  }
  /** The demo's first chapter as it is seeded, scripted and narrated, with no history yet. */
  async function asSeeded() {
    await demo.reset();
    await open(1);
  }

  test("it keeps the clips that still match, marks the rest, and leaves later versions alone", async () => {
    const checkpoint = await withHistory();
    expect(versions().map((v) => v.origin.kind)).toEqual(["edited", "checkpoint", "scripted"]);
    expect(head().origin).toMatchObject({ kind: "scripted", again: true, profile: "DeepSeek" });
    const c = historyStore.comparisonOf("cliche", 1, checkpoint.id)!;
    expect(c.counts.speaker).toBeGreaterThan(0);
    expect(c.counts.direction).toBeGreaterThan(0);
    expect(c.counts.split).toBe(1);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");

    const plan = historyStore.restorePlanOf("cliche", 1, checkpoint.id)!;
    expect(plan.stale).toBe(0);
    expect(plan.dropped).toBe(0);
    expect(plan.unrendered).toBe(0);
    expect(plan.kept).toBeGreaterThan(5);
    expect(plan.narration).toBe("done");

    expect(historyStore.restore("cliche", 1, checkpoint.id)).toBe(true);
    expect(segments().some((s) => s.audio.status === "stale")).toBe(false);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");
    // the restore is one more entry; the version restored from is still there, and so is the
    // script that was current a moment ago
    await settled(1);
    expect(head().origin).toMatchObject({ kind: "restored", from: checkpoint.id });
    expect(versions().some((v) => v.id === checkpoint.id)).toBe(true);
    expect(versions()[0].origin).toMatchObject({ kind: "scripted", profile: "DeepSeek" });
  });

  test("undo puts the script, the audio and the chapter back, on the server too", async () => {
    const checkpoint = await withHistory();
    const before = JSON.stringify(segments());
    historyStore.restore("cliche", 1, checkpoint.id);
    await settled(1);
    await undoLast();
    expect(JSON.stringify(segments())).toBe(before);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");
    const server = await libraryService().chapterScript("cliche", 1);
    expect(scriptSignature(server.segments)).toBe(scriptSignature(segments()));
  });

  test("undoing a restore leaves work done elsewhere in the book alone", async () => {
    const checkpoint = await withHistory();
    await open(2);
    historyStore.restore("cliche", 1, checkpoint.id);
    const undoRestore = undos.at(-1)!;
    // while the toast is still up: another chapter edited, and the book's cast changed
    scriptsStore.setSpeaker("cliche", 2, segments(2)[1].id, "Elder Mo");
    castStore.addAlias("cliche", "Elder Mo", "the old man on the step");
    const elsewhere = JSON.stringify(segments(2));
    const aliases = speaker("Elder Mo")!.aliases;

    await undoRestore();
    expect(JSON.stringify(segments(2))).toBe(elsewhere);
    expect(speaker("Elder Mo")!.aliases).toEqual(aliases);
  });

  test("a clip from a line that was joined away comes back to the line it was rendered for", async () => {
    await asSeeded();
    const version = (await historyStore.saveCheckpoint("cliche", 1, "Before the join"))!;
    const first = segments()[0];
    const firstText = first.text;
    const rendered = segments()[1].audio.text;
    scriptsStore.joinSegments("cliche", 1, first.id);
    expect(segments().some((s) => s.audio.text === rendered && s.audio.duration > 0)).toBe(false);
    await settled(1);

    const plan = historyStore.restorePlanOf("cliche", 1, version.id)!;
    expect(plan.comparison.counts.split).toBe(1);
    // the first half's clip was rendered from the first half's words, so it finds its way back;
    // the second half's clip went with the line the join swallowed and cannot
    expect(plan.kept).toBe(version.segments.length - 1);
    expect(plan.unrendered).toBe(1);
    historyStore.restore("cliche", 1, version.id);
    expect(segments()).toHaveLength(version.segments.length);
    expect(segments().filter((s) => s.audio.status === "done")).toHaveLength(
      version.segments.length - 1,
    );
    expect(segments().find((s) => s.text === firstText)!.audio.duration).toBeGreaterThan(0);
    // one restored line has no clip of its own, so the chapter is part rendered — the same reading a
    // cancelled run leaves, and the one the export turns into its "Partly narrated" blocker rather
    // than a stale-audio warning somebody can wave through
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("failed");
    expect(readinessOf(libraryStore.chapter("cliche", 1)!)).toBe("partial");
  });

  test("restoring the same script again does nothing at all", async () => {
    await asSeeded();
    const version = (await historyStore.saveCheckpoint("cliche", 1, "Untouched"))!;
    expect(historyStore.restore("cliche", 1, version.id)).toBe(false);
    expect(versions()).toHaveLength(1);
    expect(head().origin.kind).toBe("checkpoint");
  });

  test("a speaker the book's cast has lost comes back as one to review, and undo takes it off again", async () => {
    await withHistory();
    // the first pass named the main character by an alias the cast no longer has
    const first = versions().at(-1)!;
    expect(first.origin).toMatchObject({ kind: "scripted", profile: "OpenAI" });
    const cast = castStore.charactersOf("cliche").map((c) => c.name);
    const plan = historyStore.restorePlanOf("cliche", 1, first.id)!;
    expect(plan.comparison.counts.text).toBeGreaterThan(0);
    const [lost] = plan.missingSpeakers.map((m) => m.name);
    expect(lost).toBeDefined();

    historyStore.restore("cliche", 1, first.id);
    expect(speaker(lost)?.isNew).toBe(true);
    await undoLast();
    expect(castStore.charactersOf("cliche").map((c) => c.name)).toEqual(cast);
  });

  test("a run in flight is not raced: the restore waits for it", async () => {
    const checkpoint = await withHistory();
    jobsStore.jobs = [inFlight(1)];
    expect(historyStore.busyJobs("cliche", 1)).toHaveLength(1);
    expect(historyStore.restore("cliche", 1, checkpoint.id)).toBe(false);
    expect(head().origin.kind).not.toBe("restored");

    jobsStore.jobs = [];
    expect(historyStore.restore("cliche", 1, checkpoint.id)).toBe(true);
  });
});

describe("importing a script file", () => {
  // The server matches a file's chapters and answers with a plan; applying it is the store's. A plan
  // is built here by hand from the chapter as it stands — what an export would carry, read back —
  // so each test states only what its file says differently.
  const NAME = "The Cliche.script.zip";
  function fileChapter(chId: number, edit?: (lines: Segment[]) => void): ImportChapter {
    const lines = segments(chId).map((s, i) => ({ ...scriptOnly(s), id: i + 1 }));
    edit?.(lines);
    const title = libraryStore.chapter("cliche", chId)!.title;
    return {
      chapterId: chId,
      title,
      fileTitle: title,
      file: `chapters/${chId}.json`,
      segments: lines,
    };
  }
  function readIn(chapters: ImportChapter[], extra: Partial<ScriptImportPlan> = {}) {
    transferStore.plans.cliche = {
      title: "The Cliche",
      author: "",
      name: NAME,
      chapters,
      refused: [],
      ignored: [],
      cast: { add: [], differ: [], aliases: [] },
      lexicon: { add: [], differ: [] },
      voices: [],
      ...extra,
    };
  }
  const dialogue = (lines: Segment[]) => lines.filter((s) => s.type === "dialogue");
  beforeEach(() => demo.reset());

  test("the script read back into the book it came from changes nothing", async () => {
    await open(1, 2);
    readIn([fileChapter(1), fileChapter(2)]);
    const report = transferStore.apply("cliche", [1, 2])!;
    expect(report.applied).toEqual([]);
    expect(report.skipped.map((s) => s.why)).toEqual(["identical", "identical"]);
    expect(undos).toHaveLength(0);
  });

  test("a corrected word stales that line's clip, keeps the rest, and the history names the file", async () => {
    await open(1, 2);
    const target = dialogue(segments())[0];
    const at = segments().indexOf(target);
    // chapter 2 comes back as it is, so it is ticked but skipped — and must not be counted
    readIn([
      fileChapter(1, (lines) => (lines[at].text = lines[at].text.replace(/\w+/, "Truly"))),
      fileChapter(2),
    ]);
    const preview = transferStore.previewOf("cliche", transferStore.plans.cliche.chapters[0]);
    expect(preview.stale).toBe(1);
    expect(preview.dropped).toBe(0);

    transferStore.apply("cliche", [1, 2]);
    expect(segments()[at].text.startsWith("Truly")).toBe(true);
    expect(segments()[at].audio.status).toBe("stale");
    expect(segments().filter((s) => s.audio.status === "done")).toHaveLength(segments().length - 1);
    await settled(1);
    expect(head().origin).toEqual({ kind: "imported", file: NAME, chapters: 1 });
    expect(originLabel(head().origin)).toBe(`Imported from ${NAME}`);
  });

  test("a chapter with a run in flight is left alone", async () => {
    await open(1);
    readIn([fileChapter(1, (lines) => (dialogue(lines)[0].speaker = "Elder Mo"))]);
    jobsStore.jobs = [inFlight(1)];
    const before = JSON.stringify(segments());
    const report = transferStore.apply("cliche", [1])!;
    expect(report.skipped).toMatchObject([{ chapterId: 1, why: "busy" }]);
    expect(JSON.stringify(segments())).toBe(before);
  });

  test("one Undo takes back the scripts, the speakers, the dictionary and the voices", async () => {
    await open(1);
    const fish = endpointsStore.endpoints.find((e) => e.id === "fish")!;
    const kept = endpointsStore.endpoints.find((e) => e.voices.length && e.id !== "fish")!;
    readIn(
      [
        fileChapter(1, (lines) => {
          dialogue(lines)[0].speaker = "Stranger";
          dialogue(lines)[1].speaker = "Ferryman";
        }),
      ],
      {
        cast: {
          add: [
            {
              name: "Stranger",
              aliases: ["the man in grey"],
              gender: "m",
              description: "A traveller",
              style: "hushed",
            },
            { name: "Ferryman", aliases: [], gender: "m", description: "", style: "" },
            { name: "Nobody Here", aliases: [], gender: "f", description: "", style: "" },
          ],
          differ: [],
          aliases: [{ name: "Elder Mo", add: ["Old Mo"] }],
        },
        lexicon: { add: [{ term: "Zhenwu", say: "Jen-woo", enabled: true }], differ: [] },
      },
    );
    const cast = JSON.stringify(castStore.charactersOf("cliche"));
    const lexicon = JSON.stringify(castStore.lexiconOf("cliche"));
    const script = JSON.stringify(segments());
    const fishVoices = fish.voices.length;
    const ref = `${kept.id}/${kept.voices[0].id}`;

    const report = transferStore.apply(
      "cliche",
      [1],
      [
        { speaker: "Stranger", ref },
        {
          speaker: "Ferryman",
          ref: "fish/public-ferry",
          add: { endpointId: "fish", voice: { id: "public-ferry", label: "Ferry", gender: "m" } },
        },
      ],
    )!;
    expect(speaker("Stranger")).toMatchObject({
      description: "A traveller",
      style: "hushed",
      voice: ref,
    });
    expect(speaker("Stranger")!.aliases).toEqual(["the man in grey"]);
    expect(speaker("Ferryman")!.voice).toBe("fish/public-ferry");
    expect(fish.voices).toHaveLength(fishVoices + 1);
    expect(report.unused).toEqual(["Nobody Here"]);
    expect(speaker("Elder Mo")!.aliases).toContain("Old Mo");
    expect(castStore.lexiconOf("cliche").some((e) => e.term === "Zhenwu")).toBe(true);

    await undoLast();
    expect(JSON.stringify(castStore.charactersOf("cliche"))).toBe(cast);
    expect(JSON.stringify(castStore.lexiconOf("cliche"))).toBe(lexicon);
    expect(JSON.stringify(segments())).toBe(script);
    expect(fish.voices).toHaveLength(fishVoices);
  });

  test("the book keeps its own speakers and terms until one is taken from the file", async () => {
    await open(1);
    const described = () => [speaker("Elder Mo")!.description, speaker("Xiao Lan")!.description];
    const differ = ["Elder Mo", "Xiao Lan"].map((name) => {
      const c = speaker(name)!;
      return {
        name,
        book: { gender: c.gender, description: c.description, style: c.style },
        file: { gender: c.gender, description: `${name}, as the file has it`, style: "brisk" },
      };
    });
    const term = castStore.lexiconOf("cliche")[0];
    readIn([fileChapter(1, (lines) => (dialogue(lines)[0].direction = "quietly"))], {
      cast: { add: [], differ, aliases: [] },
      lexicon: {
        add: [],
        differ: [
          {
            term: term.term,
            book: { say: term.say, enabled: true },
            file: { say: "Jih Ning", enabled: true },
          },
        ],
      },
    });
    const before = described();
    transferStore.apply("cliche", [1]);
    expect(described()).toEqual(before);
    expect(castStore.lexiconOf("cliche")[0].say).not.toBe("Jih Ning");

    expect(transferStore.useFileSpeakers("cliche", [differ[0]])).toBe(1);
    expect(speaker("Elder Mo")).toMatchObject({
      description: "Elder Mo, as the file has it",
      style: "brisk",
    });
    await undoLast();
    expect(described()).toEqual(before);

    expect(transferStore.useFileSpeakers("cliche", differ)).toBe(2);
    expect(speaker("Xiao Lan")!.description).toBe("Xiao Lan, as the file has it");
    await undoLast();
    expect(described()).toEqual(before);

    const was = term.say;
    expect(transferStore.useFileTerms("cliche", transferStore.plans.cliche.lexicon.differ)).toBe(1);
    expect(castStore.lexiconOf("cliche")[0].say).toBe("Jih Ning");
    await undoLast();
    expect(castStore.lexiconOf("cliche")[0].say).toBe(was);
  });
});

describe("voice samples a script file carries", () => {
  // Only the samples store is handed a server of its own, which answers from memory and writes
  // down what it was asked; the book, its cast and its scripts are the demo library's.
  const calls: string[] = [];
  let held: SpeakerSamples[] = [];
  /** what the next store says it put aside: the rows the same speakers already had */
  let replacing: number[] = [];
  /** the server has already lost these rows — gone with a speaker, say */
  let lost: number[] = [];
  const waiting = (id: number, speaker: string): SpeakerSamples => ({
    id,
    speaker,
    title: `${speaker} (cloned)`,
    consentAt: 1_700_000_000_000,
    consentText: "This is my voice.",
    source: "The Cliche.script.zip",
    samples: [{ file: "a".repeat(32) + ".wav", name: "one.wav", format: "wav", bytes: 2048 }],
  });
  const server = {
    storeSpeakerSamples: async (_book: string, _file: File, speakers: string[]) => {
      calls.push(`store ${speakers.join(",")}`);
      return { stored: speakers.map((s, i) => waiting(i + 1, s)), replaced: replacing };
    },
    discardSpeakerSamples: async (_book: string, id: number) => {
      calls.push(`discard ${id}`);
      if (lost.includes(id)) throw new ApiError("There are no recordings waiting by that id", 404);
    },
    restoreSpeakerSamples: async (_book: string, id: number) => {
      calls.push(`restore ${id}`);
      return held.find((x) => x.id === id)!;
    },
  } as unknown as LibraryService;
  /** Let the requests this store sent settle. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  beforeEach(async () => {
    calls.length = 0;
    held = [];
    replacing = [];
    lost = [];
    samplesStore._service = () => server;
    await demo.reset();
    await open(1);
  });
  const row = (speaker: string, match: VoiceRow["match"]): VoiceRow => ({
    speaker,
    isNew: false,
    current: null,
    hint: { endpoint: "Fish", provider: "api.fish.audio", voiceId: "v", voiceLabel: "Theirs" },
    match,
    ticked: false,
    samples: {
      kind: "ok",
      count: 1,
      bytes: 2048,
      consentAt: "2026-09-12T10:00:00Z",
      consentText: "This is my voice.",
    },
  });

  /** A plan whose one chapter changes and whose voice rows carry samples; the file held to apply. */
  const planWithSamples = (voices: (speaker: string) => VoiceRow[]) => {
    const chapter = segments(1).map((x, i) => ({ ...x, id: i + 1 }));
    chapter.find((x) => x.type === "narration")!.direction = "slowly";
    const speaker = chapter.find((x) => x.type === "dialogue")!.speaker;
    const title = libraryStore.chapter("cliche", 1)!.title;
    transferStore.plans.cliche = {
      title: "The Cliche",
      author: "",
      name: "The Cliche.script.zip",
      chapters: [{ chapterId: 1, title, fileTitle: title, file: "c/1.json", segments: chapter }],
      refused: [],
      ignored: [],
      cast: { add: [], differ: [], aliases: [] },
      lexicon: { add: [], differ: [] },
      voices: voices(speaker),
    };
    transferStore._hold("cliche", new File(["zip"], "The Cliche.script.zip"));
    return speaker;
  };

  test("an import's samples replace what the speaker had waiting, and its Undo brings that back", async () => {
    const speaker = planWithSamples((sp) => [row(sp, { kind: "private" })]);
    held = [waiting(9, speaker)];
    samplesStore.waiting.cliche = [...held];
    replacing = [9];

    transferStore.apply("cliche", [1]);
    await settled(1);
    await settle();
    expect(samplesStore.waitingOf("cliche").map((x) => x.id)).toEqual([1]);

    await undoLast();
    // what the import kept goes aside before what it replaced comes back
    expect(calls).toEqual([`store ${speaker}`, "discard 1", "restore 9"]);
    expect(samplesStore.waitingOf("cliche").map((x) => x.id)).toEqual([9]);
  });

  test("a row the server already lost is not a failure when the import is undone", async () => {
    const errors: string[] = [];
    uiStore.toast = (msg, opts = {}) => {
      if (opts.undo) undos.push(opts.undo);
      if (opts.kind === "error") errors.push(msg);
      return "test";
    };
    const speaker = planWithSamples((sp) => [row(sp, { kind: "private" })]);
    lost = [1];

    transferStore.apply("cliche", [1]);
    await undoLast();
    expect(calls).toEqual([`store ${speaker}`, "discard 1"]);
    expect(errors).toEqual([]);
    expect(samplesStore.waitingOf("cliche")).toEqual([]);
  });

  test("they wait with a speaker whose voice is private, and the import's Undo lets them go", async () => {
    const speaker = planWithSamples((sp) => [
      row(sp, { kind: "private" }),
      // reachable here, so nothing waits: the voice itself can be used
      row("Narrator", { kind: "here", options: [] }),
      // no such speaker in the book: a sample has no one to wait with
      row("Nobody Here", { kind: "unchecked", reason: "timed out" }),
    ]);

    const report = transferStore.apply("cliche", [1])!;
    expect(report.samples).toEqual([speaker]);
    await settled(1);
    await settle();
    expect(calls).toEqual([`store ${speaker}`]);
    expect(samplesStore.waitingFor("cliche", speaker)?.id).toBe(1);

    await undoLast();
    expect(calls).toEqual([`store ${speaker}`, "discard 1"]);
    expect(samplesStore.waitingOf("cliche")).toEqual([]);
  });

  test("a voice made from them goes to the speaker only if their voice has not moved since", async () => {
    const [mo, lan] = ["Elder Mo", "Xiao Lan"];
    const was = speaker(mo)!.voice;
    samplesStore.waiting.cliche = [waiting(1, mo), waiting(2, lan)];

    expect(
      await samplesStore.afterClone(
        { bookId: "cliche", sampleId: 1, speaker: mo, was },
        "fish/new-voice",
      ),
    ).toBe("assigned");
    expect(speaker(mo)!.voice).toBe("fish/new-voice");
    await undoLast();
    expect(speaker(mo)!.voice).toBe(was);

    // chosen on the Cast page after the link was opened: left as chosen
    speaker(lan)!.voice = "fish/picked-meanwhile";
    expect(
      await samplesStore.afterClone(
        { bookId: "cliche", sampleId: 2, speaker: lan, was: null },
        "fish/other-voice",
      ),
    ).toBe("kept");
    expect(speaker(lan)!.voice).toBe("fish/picked-meanwhile");
    // either way the recordings stop waiting: the voice keeps them now
    expect(calls).toEqual(["discard 1", "discard 2"]);
    expect(samplesStore.waitingOf("cliche")).toEqual([]);
  });

  test("discarded samples come back with Undo", async () => {
    held = [waiting(7, "Elder Mo")];
    samplesStore.waiting.cliche = [...held];
    expect(await samplesStore.discard("cliche", held[0])).toBe(true);
    expect(samplesStore.waitingOf("cliche")).toEqual([]);
    await undoLast();
    await settle();
    expect(calls).toEqual(["discard 7", "restore 7"]);
    expect(samplesStore.waitingFor("cliche", "Elder Mo")?.id).toBe(7);
  });
});

describe("the book the history belongs to", () => {
  beforeEach(() => demo.reset());

  test("renumbering a book's chapters takes each history with its own chapter", async () => {
    await open();
    const first = libraryStore.bookById("cliche")!.volumes[0];
    const gone = libraryStore.chaptersOf("cliche").filter((c) => c.volumeId === first.id).length;
    const chId = gone + 2; // a chapter in a volume that stays, two along from the join
    await open(chId);
    const mark = (await historyStore.saveCheckpoint("cliche", chId, "Before the volume went"))!;
    expect(mark).toBeTruthy();
    const script = scriptSignature(segments(chId));

    await libraryStore.removeVolume("cliche", first.id);
    const now = chId - gone;
    expect(scriptSignature(segments(now))).toBe(script);
    // the history followed the script, and nothing was left behind under the old number for the
    // chapter that now carries it to inherit
    expect(versions(now).map((v) => v.origin)).toEqual([mark.origin]);
    expect(versions(chId)).toHaveLength(0);
  });

  test("a novel that is removed takes its chapters' histories with it", async () => {
    await open(1, 2);
    await historyStore.saveCheckpoint("cliche", 1, "Kept");
    await historyStore.saveCheckpoint("cliche", 2, "Kept too");
    await libraryStore.removeBook("cliche");
    expect(Object.keys(historyStore.chapters).filter((k) => k.startsWith("cliche:"))).toHaveLength(
      0,
    );
  });
});
