// PROTOTYPE — in-memory state + simulated jobs. Nothing persists.
import { defineStore } from "pinia";
import { makeWorld, generateSegments, PALETTE, DISCOVERABLE_VOICES, voiceRef } from "@/mock/data";
import { splitText, partsFor } from "@/lib/split";
import { speak, silenceOf, pacingOrDefault, hitsIn } from "@/lib/speech";
import { newProfile, profileErrors, scriptParts, tokenEstimate } from "@/lib/scripting";
import { keyring } from "@/lib/keyring";
import { logJob, jobWaiting, startJob } from "@/lib/jobActivity";
import { toast as tf } from "vue-toastflow";
import type { ToastButton } from "vue-toastflow";
import type {
  AudioStatus,
  Book,
  CastStat,
  Chapter,
  Character,
  EffectiveVoice,
  Endpoint,
  EndpointEstimate,
  EndpointLoad,
  Eta,
  ExportItem,
  ExportMeta,
  ExportVolume,
  Gender,
  Job,
  JobKind,
  LexEntry,
  JobStatus,
  MergeSuggestion,
  NarrationEstimate,
  Pacing,
  Profile,
  ReqError,
  ResolvedVoice,
  RoutingIssue,
  ScriptDiff,
  ScriptEstimate,
  ScriptSettings,
  ScriptEndpointTelemetry,
  Segment,
  SegmentAudio,
  SegmentMap,
  SegmentFlag,
  FlagKind,
  SettingsFile,
  Take,
  ToastOptions,
  UndoEntry,
  Voice,
  VoiceOption,
  VoiceRef,
  Volume,
  World,
} from "@/types";
export { keyring };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const AVG_JOB: Record<JobKind, number> = { scripting: 25, narration: 60, export: 120 }; // seconds, until we have history
const ERRORS: ReqError[] = [
  {
    code: 500,
    message: "server error",
    body: '{"error":{"message":"The server had an error while processing your request.","type":"server_error"}}',
  },
  { code: 502, message: "bad gateway", body: "<html><body><h1>502 Bad Gateway</h1></body></html>" },
  {
    code: 400,
    message: "invalid voice",
    body: '{"error":{"message":"voice is not a valid voice for this model","param":"voice"}}',
  },
];

let jobSeq = 100;
export const isScripted = (c: Chapter): boolean =>
  c.scripting === "done" || c.scripting === "fallback";
export const isNarrated = (c: Chapter): boolean =>
  c.narration === "done" || c.narration === "stale";
export const norm = (n: string): string =>
  n
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
export { voiceRef };
export { partsFor };
const GENDER: Partial<Record<Gender, string>> = { m: "male", f: "female", n: "neutral" };
/** Back to the queue without losing the take history or a comparison in progress. */
const requeue = (a: SegmentAudio): SegmentAudio => ({
  status: "queued",
  endpoint: null,
  ms: 0,
  duration: 0,
  ...(a.takes?.length ? { takes: a.takes } : {}),
  ...(a.n ? { n: a.n } : {}),
});
/** Freeze what `audio` currently holds so it survives the next render. */
const snapshotTake = (a: SegmentAudio): Take => ({
  n: a.n ?? 1,
  at: a.at ?? Date.now(),
  ms: a.ms,
  duration: a.duration,
  cost: a.cost,
  endpoint: a.endpoint,
  voiceRef: a.voiceRef,
  voice: a.voice,
  model: a.model,
  direction: a.direction,
  style: a.style,
  type: a.type,
  text: a.text,
  said: a.said,
});
export const FLAG_LABEL: Record<FlagKind, string> = {
  pronunciation: "wrong pronunciation",
  delivery: "bad delivery",
  pause: "awkward pause",
  other: "something else",
};
const ago = (min: number): number => Date.now() - min * 60000;
function collapseChunk(segs: Segment[]): Segment[] {
  const start = 4 + Math.floor(Math.random() * Math.max(1, segs.length - 12)),
    n = 5 + Math.floor(Math.random() * 4);
  const run = segs.slice(start, start + n);
  const merged: Segment = {
    id: 0,
    type: "narration",
    speaker: "Narrator",
    text: run.map((x) => (x.type === "dialogue" ? `“${x.text}”` : x.text)).join(" "),
    direction: "",
    fallback: true,
    fallbackCount: n,
    fallbackMismatch: run[Math.floor(n / 2)].text.slice(0, 40),
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
  };
  const out = [...segs.slice(0, start), merged, ...segs.slice(start + n)];
  out.forEach((x, i) => (x.id = i + 1));
  return out;
}
// History from "earlier today" so the Queue page has done / failed / cancelled rows to act on.
function seedJobs(): Job[] {
  const mk = (
    kind: JobKind,
    bookId: string,
    chapterId: number | null,
    label: string,
    status: JobStatus,
    startMin: number,
    secs: number,
  ): Job => ({
    id: jobSeq++,
    kind,
    bookId,
    chapterId,
    label,
    status,
    progress: status === "done" ? 100 : status === "failed" ? 100 : 40,
    queuedAt: ago(startMin + 1),
    startedAt: ago(startMin),
    finishedAt: ago(startMin) + secs * 1000,
    cancelled: status === "cancelled",
  });
  return [
    mk("export", "starforge", null, "Build M4B · 18 ch", "done", 95, 214),
    mk("narration", "starforge", 18, "Narrate · ch 18", "done", 118, 71),
    mk("narration", "starforge", 17, "Narrate · ch 17", "done", 121, 64),
    mk("scripting", "cliche", 12, "Script · ch 12", "done", 41, 26),
    mk("scripting", "cliche", 11, "Script · ch 11", "done", 42, 24),
    mk("narration", "cliche", 4, "Narrate · ch 4", "failed", 33, 58),
    mk("narration", "cliche", 3, "Narrate · ch 3", "done", 35, 61),
    mk("scripting", "drowned", 2, "Script · ch 2", "failed", 12, 31),
    mk("scripting", "drowned", 1, "Script · ch 1", "done", 13, 27),
    mk("narration", "drowned", 1, "Narrate · ch 1", "cancelled", 9, 12),
  ];
}
const key = (b: string, c: number): string => `${b}:${c}`;
// simulate a re-run of the LLM: same prose, but ~10% of dialogue re-attributed and one narration pair merged
function reseg(segs: Segment[]): Segment[] {
  const speakers = [...new Set(segs.filter((x) => x.type === "dialogue").map((x) => x.speaker))];
  const out = segs.map((x) => ({ ...x }));
  out.forEach((x, i) => {
    if (x.type === "dialogue" && speakers.length > 1 && i % 9 === 3)
      x.speaker = speakers[(speakers.indexOf(x.speaker) + 1) % speakers.length];
  });
  const i = out.findIndex((x, k) => x.type === "narration" && out[k + 1]?.type === "narration");
  if (i >= 0) {
    out[i].text = out[i].text + " " + out[i + 1].text;
    out.splice(i + 1, 1);
  }
  out.forEach((x, k) => {
    x.id = k + 1;
    x.audio = { status: "none", endpoint: null, ms: 0, duration: 0 };
  });
  return out;
}
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

/** One output file of a build: the whole selection, or one volume of it. */
interface ExportGroup {
  vol: Volume | null;
  index: number;
  chapters: Chapter[];
}

interface AppState extends World {
  profiles: Profile[];
  scriptTelemetry: Record<string, ScriptEndpointTelemetry>;
  scriptUsage: {
    bookId: string;
    profileId: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
  }[];
  scriptSettings: ScriptSettings;
  jobs: Job[];
  /** most recent last */
  _undo: UndoEntry[];
  /** `${bookId}:${chId}` → segments before the last re-script, for the diff panel */
  _previous: SegmentMap;
  /** browser notifications when a book's run finishes */
  notify: boolean;
  _kicked: boolean;
  dark: boolean;
  currentBookId: string | null;
}

export const useApp = defineStore("app", {
  state: (): AppState => ({
    ...makeWorld(),
    profiles: [
      newProfile({
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        inPrice: 0.15,
        outPrice: 0.6,
        secPerChunk: 9,
        credentialId: "openai-personal",
        quotaGroup: "openai-account",
        spendLimit: 10,
      }),
      newProfile({
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        inPrice: 0.14,
        outPrice: 0.28,
        secPerChunk: 14,
        credentialId: "deepseek",
      }),
      newProfile({
        id: "antigravity",
        name: "Antigravity (local)",
        baseUrl: "http://localhost:8000/v1",
        model: "gemini-3.6-flash-low",
        needsKey: false,
        secPerChunk: 25,
      }),
    ],
    scriptSettings: { profile: "openai", stripWatermarks: true },
    scriptUsage: [],
    scriptTelemetry: {},
    jobs: seedJobs(),
    _undo: [], // most recent last; each { label, revert, toastId }
    _previous: {}, // `${bookId}:${chId}` → segments before the last re-script (for the diff panel)
    notify: false, // browser notifications when a book's run finishes
    _kicked: false,
    dark: window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
    currentBookId: null,
  }),

  getters: {
    book: (s): Book | undefined => s.books.find((b) => b.id === s.currentBookId),
    bookById:
      (s) =>
      (id: string): Book | undefined =>
        s.books.find((b) => b.id === id),
    chaptersOf:
      (s) =>
      (id: string): Chapter[] =>
        s.chapters[id] ?? [],
    chapter:
      (s) =>
      (bookId: string, chId: number): Chapter | undefined =>
        (s.chapters[bookId] ?? []).find((c) => c.id === chId),
    charactersOf:
      (s) =>
      (id: string): Character[] =>
        s.characters[id] ?? [],
    volumesOf:
      (s) =>
      (id: string): Volume[] =>
        s.books.find((b) => b.id === id)?.volumes ?? [],
    volumeOf:
      (s) =>
      (bookId: string, chId: number): Volume | undefined => {
        const c = (s.chapters[bookId] ?? []).find((c) => c.id === chId);
        return s.books.find((b) => b.id === bookId)?.volumes.find((v) => v.id === c?.volumeId);
      },
    segmentsOf:
      (s) =>
      (bookId: string, chId: number): Segment[] =>
        s.segments[key(bookId, chId)] ?? [],
    lexiconOf:
      (s) =>
      (bookId: string): LexEntry[] =>
        s.lexicon[bookId] ?? [],
    pacingOf:
      (s) =>
      (bookId: string): Pacing =>
        pacingOrDefault(s.books.find((b) => b.id === bookId)?.pacing),
    /** One line as the endpoint will receive it: the book's dictionary applied, the book untouched. */
    spoken: (s) => (bookId: string, text: string) => speak(text, s.lexicon[bookId] ?? []),
    /** How many times each dictionary entry actually occurs in the book's scripted text. */
    lexUses: (s) => (bookId: string) => {
      const list = s.lexicon[bookId] ?? [];
      const uses: Record<number, number> = Object.fromEntries(list.map((e) => [e.id, 0]));
      const prefix = bookId + ":";
      for (const k of Object.keys(s.segments)) {
        if (!k.startsWith(prefix)) continue;
        for (const seg of s.segments[k])
          // one entry at a time, so an entry that is currently shadowed by a longer one reads 0
          for (const e of list) uses[e.id] += hitsIn(seg.text, [e]).length;
      }
      return uses;
    },
    /** A real line from the book that this entry would change, for the dictionary preview. */
    lexSample: (s) => (bookId: string, entry: LexEntry) => {
      const prefix = bookId + ":";
      for (const k of Object.keys(s.segments)) {
        if (!k.startsWith(prefix)) continue;
        for (const seg of s.segments[k]) if (hitsIn(seg.text, [entry]).length) return seg.text;
      }
      return "";
    },
    progress: (s) => (id: string) => {
      const all = s.chapters[id] ?? [];
      const ch = all.filter((c) => !c.excluded);
      return {
        total: ch.length,
        excluded: all.length - ch.length,
        scripted: ch.filter(isScripted).length,
        fallback: ch.filter((c) => c.scripting === "fallback").length,
        narrated: ch.filter(isNarrated).length,
        stale: ch.filter((c) => c.narration === "stale").length,
        exported: s.exports.filter((e) => e.bookId === id && e.status === "done").length,
        running: ch.some((c) => c.scripting === "running" || c.narration === "running"),
      };
    },
    activeJobs: (s) => s.jobs.filter((j) => j.status === "running" || j.status === "queued"),
    endpointLoad: (s): Record<string, EndpointLoad> => {
      const load: Record<string, EndpointLoad> = Object.fromEntries(
        s.endpoints.map((e) => [
          e.id,
          { active: 0, done: 0, failed: 0, backoff: e.backoffUntil > Date.now() },
        ]),
      );
      for (const segs of Object.values(s.segments))
        for (const seg of segs) {
          const l = seg.audio.endpoint ? load[seg.audio.endpoint] : undefined;
          if (!l) continue;
          if (seg.audio.status === "generating") l.active++;
          else if (seg.audio.status === "done") l.done++;
          else if (seg.audio.status === "failed") l.failed++;
        }
      return load;
    },
    recentJobs: (s) => [...s.jobs].reverse().slice(0, 12),
    enabledEndpoints: (s) => s.endpoints.filter((e) => e.enabled),
    // voice ref `<endpointId>/<voiceId>` → { endpoint, voice } or null when either side was removed
    resolveVoice:
      (s) =>
      (ref: VoiceRef | null | undefined): ResolvedVoice | null => {
        if (!ref) return null;
        const i = ref.indexOf("/");
        const ep = s.endpoints.find((e) => e.id === ref.slice(0, i));
        const v = ep?.voices.find((v) => v.id === ref.slice(i + 1));
        return ep && v ? { endpoint: ep, voice: v } : null;
      },
    voiceLabel(): (ref: VoiceRef | null | undefined) => string {
      return (ref) => {
        const r = this.resolveVoice(ref);
        return r
          ? `${r.voice.label} · ${r.endpoint.name}`
          : ref
            ? `${ref.split("/")[1]} (missing)`
            : "";
      };
    },
    // every voice on every endpoint, grouped for the pickers; paused endpoints stay listed but disabled
    voiceOptions: (s): VoiceOption[] =>
      s.endpoints.flatMap((e) =>
        e.voices.map((v) => ({
          value: voiceRef(e.id, v.id),
          label: v.label,
          group: e.enabled ? e.name : `${e.name} · paused`,
          hint: GENDER[v.gender] ?? "",
          disabled: !e.enabled,
        })),
      ),
    // a character with no voice of their own is read in the Narrator's voice
    effectiveVoice(): (bookId: string, name: string) => EffectiveVoice {
      return (bookId, name) => {
        const cast = this.characters[bookId] ?? [];
        const c = cast.find((x) => x.name === name);
        const ref = c?.voice || cast.find((x) => x.name === "Narrator")?.voice || null;
        const r = this.resolveVoice(ref);
        return {
          ref,
          own: !!c?.voice,
          voice: r?.voice.id ?? null,
          label: r ? r.voice.label : ref ? "missing" : null,
          endpoint: r?.endpoint ?? null,
        };
      };
    },
    // speakers whose voice can't be rendered right now: voice/endpoint gone, endpoint paused, key missing
    /** Everything a clip was rendered with that the script no longer says — empty means "still current".
     *  One definition, so the ledger's amber line, a rejected retake and a finished render agree. */
    clipDrift(): (bookId: string, s: Segment, a?: SegmentAudio) => string[] {
      return (bookId, s, a = s.audio) => {
        if (!a.at) return [];
        const out: string[] = [];
        if (a.text != null && a.text !== s.text)
          out.push(
            a.text.length === s.text.length
              ? "text: edited"
              : `text: ${a.text.length} → ${s.text.length} chars`,
          );
        const sent = a.said ?? a.text;
        // the words themselves are unchanged but the dictionary now sends different ones
        if (a.text === s.text && sent != null && this.spoken(bookId, s.text).text !== sent)
          out.push("pronunciation: the dictionary changed after this clip");
        if ((a.direction || "") !== (s.direction || ""))
          out.push(`direction: “${a.direction || "—"}” → “${s.direction || "—"}”`);
        if (a.type && a.type !== s.type) out.push(`type: ${a.type} → ${s.type}`);
        const now = this.effectiveVoice(bookId, s.speaker);
        if (a.voiceRef && now.ref !== a.voiceRef)
          out.push(
            `voice: ${this.voiceLabel(a.voiceRef)} → ${this.voiceLabel(now.ref) || "unset"}`,
          );
        const who = this.charactersOf(bookId).find((c) => c.name === s.speaker);
        if ((a.style ?? "") !== (who?.style ?? ""))
          out.push(`style: “${a.style || "—"}” → “${who?.style || "—"}”`);
        return out;
      };
    },
    routingIssues(): (bookId: string) => RoutingIssue[] {
      return (bookId) => {
        const out: RoutingIssue[] = [];
        for (const c of this.characters[bookId] ?? []) {
          if (!c.voice) continue;
          const r = this.resolveVoice(c.voice);
          if (!r)
            out.push({
              name: c.name,
              ref: c.voice,
              reason: "voice no longer exists",
              kind: "missing" as const,
            });
          else if (!r.endpoint.enabled)
            out.push({
              name: c.name,
              ref: c.voice,
              reason: `${r.endpoint.name} is paused`,
              kind: "paused" as const,
              endpoint: r.endpoint,
            });
          else if (r.endpoint.needsKey && !keyring.has(r.endpoint.id))
            out.push({
              name: c.name,
              ref: c.voice,
              reason: `${r.endpoint.name} has no API key`,
              kind: "nokey" as const,
              endpoint: r.endpoint,
            });
        }
        return out;
      };
    },
    scriptSpent:
      (s) =>
      (bookId: string): number =>
        s.scriptUsage.filter((x) => x.bookId === bookId).reduce((sum, x) => sum + x.cost, 0),
    scriptReserved:
      (s) =>
      (bookId: string): number =>
        s.jobs
          .filter((j) => j.bookId === bookId && !j.finishedAt)
          .reduce((sum, j) => sum + (j.scriptRun?.reserved ?? 0), 0),
    scriptEstimate() {
      return (
        bookId: string,
        ids: number[],
        retrySegmentId: number | null = null,
      ): ScriptEstimate => {
        const chs = this.chaptersOf(bookId).filter(
          (c) => ids.includes(c.id) && !c.excluded && !["running", "queued"].includes(c.scripting),
        );
        const p = this.profiles.find((p) => p.id === this.scriptSettings.profile);
        const blockers = p ? profileErrors(p) : ["Select a scripting endpoint."];
        if (p && !p.enabled) blockers.push("This endpoint is paused. Enable it or select another.");
        if (p?.needsKey && !keyring.has("profile:" + p.id))
          blockers.push("Add an API key in endpoint settings.");
        if (this.bookById(bookId)?.budget?.paused)
          blockers.push("This book is paused. Resume it from the overview.");
        const texts = chs.map((c) =>
          retrySegmentId === null
            ? this.rawText(bookId, c.id)
            : (this.segmentsOf(bookId, c.id).find((x) => x.id === retrySegmentId)?.text ?? ""),
        );
        const parts =
          p && !profileErrors(p).length ? texts.map((text) => scriptParts(text, p)) : [];
        const tokens = parts.flat().map((text) => tokenEstimate(text, p!));
        const inputCost = tokens.reduce((n, t) => n + t.inputCost, 0);
        const outputCost = tokens.reduce((n, t) => n + t.outputCost, 0);
        const scriptingRemaining =
          (this.bookById(bookId)?.scriptBudget ?? Infinity) -
          this.scriptSpent(bookId) -
          this.scriptReserved(bookId);
        const overallRemaining =
          (this.bookById(bookId)?.budget?.cap ?? Infinity) -
          this.spent(bookId) -
          this.scriptReserved(bookId);
        const remaining = Math.min(scriptingRemaining, overallRemaining);
        if (inputCost + outputCost > remaining)
          blockers.push("Estimated cost exceeds the remaining book budget.");
        if (tokens.some((t) => t.outputTokens > p!.maxOutputTokens))
          blockers.push(
            "A chunk may exceed the output token limit. Reduce max characters or increase max output tokens.",
          );
        if (tokens.some((t) => t.reserve > remaining))
          blockers.push("Budget cannot reserve one request at its output token limit.");
        return {
          chapters: chs.length,
          chars: texts.reduce((n, t) => n + t.length, 0),
          chunks: tokens.length,
          inputTokens: tokens.reduce((n, t) => n + t.inputTokens, 0),
          outputTokens: tokens.reduce((n, t) => n + t.outputTokens, 0),
          inputCost,
          outputCost,
          cost: inputCost + outputCost,
          profile: p,
          blockers,
          seconds: parts.reduce(
            (n, xs) => n + Math.ceil(xs.length / p!.concurrency) * p!.secPerChunk,
            0,
          ),
        };
      };
    },
    // raw chapter text (mock: rebuilt from the generator) for the picker's peek
    rawText:
      () =>
      (bookId: string, chId: number): string =>
        generateSegments(bookId, chId)
          .map((x) => x.text)
          .join("\n\n"),
    // what the last re-script changed, by matching segments on text
    scriptDiff:
      (s) =>
      (bookId: string, chId: number): ScriptDiff | null => {
        const prev = s._previous[key(bookId, chId)];
        if (!prev) return null;
        const cur = s.segments[key(bookId, chId)] ?? [];
        const byText = (arr: Segment[]): Map<string, Segment> => {
          const m = new Map<string, Segment>();
          for (const x of arr) m.set(x.text, x);
          return m;
        };
        const pm = byText(prev);
        const cm = byText(cur);
        const speaker: ScriptDiff["speaker"] = [];
        const direction: ScriptDiff["direction"] = [];
        for (const [t, c] of cm) {
          const p = pm.get(t);
          if (!p) continue;
          if (p.speaker !== c.speaker)
            speaker.push({ id: c.id, text: t, from: p.speaker, to: c.speaker });
          else if ((p.direction || "") !== (c.direction || ""))
            direction.push({ id: c.id, text: t, from: p.direction, to: c.direction });
        }
        const added = cur.filter((c) => !pm.has(c.text));
        const removed = prev.filter((p) => !cm.has(p.text));
        return {
          speaker,
          direction,
          added,
          removed,
          total: speaker.length + direction.length + added.length + removed.length,
          prevCount: prev.length,
          curCount: cur.length,
        };
      },
    // money already rendered for a book (sum of each clip's recorded cost)
    spent:
      (s) =>
      (bookId: string): number => {
        let t = s.scriptUsage
          .filter((x) => x.bookId === bookId)
          .reduce((sum, x) => sum + x.cost, 0);
        for (const [k, segs] of Object.entries(s.segments))
          if (k.startsWith(bookId + ":"))
            for (const x of segs)
              if (x.audio.cost && x.audio.status !== "failed") t += x.audio.cost;
        return t;
      },
    // rough finish time for everything active: per-book chains run in parallel, so take the longest chain
    eta: (s): Eta | null => {
      const hist: Partial<Record<JobKind, number[]>> = {};
      for (const j of s.jobs)
        if (j.status === "done" && j.startedAt && j.finishedAt)
          (hist[j.kind] ??= []).push((j.finishedAt - j.startedAt) / 1000);
      const avg = (k: JobKind): number => {
        const h = hist[k];
        return h?.length ? h.reduce((a, b) => a + b, 0) / h.length : (AVG_JOB[k] ?? 60);
      };
      const perBook: Record<string, number> = {};
      for (const j of s.jobs) {
        if (j.status !== "running" && j.status !== "queued") continue;
        const secs =
          j.status === "queued" ? avg(j.kind) : avg(j.kind) * (1 - (j.progress ?? 0) / 100);
        perBook[j.bookId] = (perBook[j.bookId] ?? 0) + secs;
      }
      const seconds = Math.max(0, ...Object.values(perBook));
      return Object.keys(perBook).length
        ? { seconds, at: Date.now() + seconds * 1000, books: Object.keys(perBook).length }
        : null;
    },
    castStats:
      (s) =>
      (bookId: string): Record<string, CastStat> => {
        const stats: Record<string, CastStat> = {};
        for (const c of s.chapters[bookId] ?? [])
          for (const seg of s.segments[`${bookId}:${c.id}`] ?? []) {
            const st = (stats[seg.speaker] ??= { lines: 0, chapters: new Set(), first: c.id });
            st.lines++;
            st.chapters.add(c.id);
            if (c.id < st.first) st.first = c.id;
          }
        return stats;
      },
    // near-duplicate names worth merging: alias matches, one name contained in another, shared surname-ish token
    mergeSuggestions:
      (s) =>
      (bookId: string): MergeSuggestion[] => {
        const cast = s.characters[bookId] ?? [];
        const out: MergeSuggestion[] = [];
        for (const a of cast)
          for (const b of cast) {
            if (a === b || a.name === "Narrator" || b.name === "Narrator") continue;
            const na = norm(a.name);
            const nb = norm(b.name);
            if (
              a.major &&
              !b.major &&
              b.aliases.length === 0 &&
              a.aliases.some((x) => norm(x) === nb)
            )
              out.push({
                from: b.name,
                into: a.name,
                reason: `“${b.name}” is a known alias of ${a.name}`,
              });
            else if (!b.major && na !== nb && na.split(" ").includes(nb) && nb.length > 2)
              out.push({
                from: b.name,
                into: a.name,
                reason: `“${b.name}” looks like a short form of ${a.name}`,
              });
            else if (!b.major && b.isNew && na !== nb && na.includes(nb) && nb.length > 3)
              out.push({
                from: b.name,
                into: a.name,
                reason: `“${b.name}” is contained in ${a.name}`,
              });
          }
        const seen = new Set<string>();
        return out.filter((x) => {
          const k = x.from;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      },
    // Cost and load are per endpoint: each segment goes to the endpoint that owns its speaker's voice,
    // and a segment longer than that endpoint's limit becomes several requests.
    estimate(): (bookId: string, ids: number[]) => NarrationEstimate {
      return (bookId, ids) => {
        const per: Record<string, EndpointEstimate> = {};
        let chars = 0;
        let segments = 0;
        let unrouted = 0;
        let stale = 0;
        for (const id of ids)
          for (const seg of this.segments[`${bookId}:${id}`] ?? []) {
            chars += seg.text.length;
            segments++;
            if (seg.audio.status === "stale") stale++;
            const ep = this.effectiveVoice(bookId, seg.speaker).endpoint;
            if (!ep) {
              unrouted++;
              continue;
            }
            const e = (per[ep.id] ??= {
              endpoint: ep,
              chars: 0,
              segments: 0,
              requests: 0,
              split: 0,
            });
            const parts = partsFor(seg.text, ep);
            e.chars += seg.text.length;
            e.segments++;
            e.requests += parts;
            if (parts > 1) e.split++;
          }
        const rows = Object.values(per);
        const cost = rows.reduce((a, e) => a + (e.chars / 1e6) * e.endpoint.price, 0);
        return {
          chapters: ids.length,
          chars,
          segments,
          seconds: chars / 15.5,
          cost,
          stale,
          unrouted,
          requests: rows.reduce((a, e) => a + e.requests, 0),
          split: rows.reduce((a, e) => a + e.split, 0),
          endpoints: this.endpoints.filter((e) => e.enabled).length,
          per: rows,
        };
      };
    },
  },

  actions: {
    // ---------- toasts & undo ----------
    // Thin wrapper over Toastflow so the rest of the app never imports it. `undo` makes the toast
    // undoable (↻, Undo button, 10 s, ⌘Z); `action` adds a second button; `timeout: 0` sticks.
    toast(msg: string, opts: ToastOptions = {}): string {
      const { kind = "info", undo = null, action = null, timeout, description = "" } = opts;
      const type = (
        {
          info: "info",
          warn: "warning",
          warning: "warning",
          error: "error",
          success: "success",
          loading: "loading",
        } as const
      )[kind];
      const buttons: ToastButton[] = [];
      const entry: UndoEntry | null = undo ? { label: msg, revert: undo, toastId: null } : null;
      if (entry)
        buttons.push({
          id: "undo",
          label: "Undo",
          ariaLabel: `Undo: ${msg}`,
          dismissAfterClick: true,
          onClick: () => this._revert(entry),
        });
      if (action)
        buttons.push({
          id: "action",
          label: action.label,
          dismissAfterClick: true,
          onClick: () => action.run(),
        });
      const id = tf.show({
        type,
        title: msg,
        description,
        theme: entry ? "undo" : undefined,
        duration: timeout ?? (entry ? 10000 : type === "error" ? 9000 : 6000),
        buttons: buttons.length ? { alignment: "bottom-left", buttons } : undefined,
      });
      if (entry) {
        entry.toastId = id;
        this._undo = [...this._undo.slice(-9), entry];
      }
      return id;
    },
    dismissToast(id: string): void {
      tf.dismiss(id);
    },
    _revert(entry: UndoEntry): void {
      if (!this._undo.includes(entry)) return;
      entry.revert();
      this._undo = this._undo.filter((u) => u !== entry);
      if (entry.toastId != null) tf.dismiss(entry.toastId);
      tf.show({ type: "success", title: "Undone", description: entry.label, duration: 3000 });
    },
    undoLast(): boolean {
      const u = this._undo.at(-1);
      if (!u) return false;
      this._revert(u);
      return true;
    },
    // long-running work: one toast that goes loading → success / error (Toastflow's promise helper)
    toastLoading<T>(
      promise: Promise<T>,
      {
        loading,
        success,
        error,
      }: {
        loading: string;
        success: string | ((r: T) => string);
        error?: string | ((e: unknown) => string);
      },
    ): Promise<T> {
      const result = tf.loading(() => promise, {
        loading: { title: loading, duration: 0, progressBar: false },
        success: (r: T) => ({
          type: "success" as const,
          title: typeof success === "function" ? success(r) : success,
          duration: 5000,
        }),
        error: (e: unknown) => ({
          type: "error" as const,
          title: typeof error === "function" ? error(e) : (error ?? "Failed"),
          description: e instanceof Error ? e.message : "",
          duration: 9000,
        }),
      });
      result.catch(() => {}); // the error toast is the handling; callers decide what else to do with `promise`
      return result;
    },
    // snapshots used by undo: the cast + every segment of a book (speakers live in both)
    _castSnapshot(bookId: string): () => void {
      const chars = clone(this.characters[bookId]);
      const segs: SegmentMap = {};
      for (const [k, v] of Object.entries(this.segments))
        if (k.startsWith(bookId + ":")) segs[k] = clone(v);
      return () => {
        this.characters[bookId] = chars;
        for (const [k, v] of Object.entries(segs)) this.segments[k] = v;
      };
    },
    _bookSnapshot(bookId: string): () => void {
      const i = this.books.findIndex((b) => b.id === bookId);
      const book = clone(this.books[i]);
      const chapters = clone(this.chapters[bookId]);
      const chars = clone(this.characters[bookId]);
      const segs: SegmentMap = {};
      for (const [k, v] of Object.entries(this.segments))
        if (k.startsWith(bookId + ":")) segs[k] = clone(v);
      const exports = clone(this.exports.filter((e) => e.bookId === bookId));
      const jobs = clone(
        this.jobs.filter(
          (j) => j.bookId === bookId && j.status !== "running" && j.status !== "queued",
        ),
      );
      return () => {
        if (!this.books.some((b) => b.id === bookId))
          this.books.splice(Math.min(i, this.books.length), 0, book);
        else
          Object.assign(
            this.books.find((b) => b.id === bookId)!,
            book,
          );
        this.chapters[bookId] = chapters;
        this.characters[bookId] = chars;
        this.segments = {
          ...Object.fromEntries(
            Object.entries(this.segments).filter(([k]) => !k.startsWith(bookId + ":")),
          ),
          ...segs,
        };
        this.exports = [...exports, ...this.exports.filter((e) => e.bookId !== bookId)];
        this.jobs = [...this.jobs.filter((j) => j.bookId !== bookId), ...jobs].sort(
          (a, b) => a.id - b.id,
        );
      };
    },

    // ---------- chapters ----------
    setExcluded(bookId: string, chId: number, v: boolean): void {
      const c = this.chapter(bookId, chId);
      if (c) c.excluded = v;
    },
    // apply one direction to every line of a speaker in a chapter (marks rendered ones stale)
    applyDirection(bookId: string, chId: number, speaker: string, direction: string): number {
      let n = 0;
      for (const s of this.segmentsOf(bookId, chId))
        if (s.speaker === speaker && (s.direction || "") !== direction) {
          s.direction = direction;
          s.edited = true;
          this._markStale(bookId, chId, s);
          n++;
        }
      if (n)
        this.toast(`Direction applied to ${n} ${speaker} line${n === 1 ? "" : "s"}`, {
          kind: "success",
          description: `“${direction}” — rendered lines are now stale`,
          timeout: 4000,
        });
      return n;
    },

    // ---------- budget & pause ----------
    pauseBook(bookId: string): void {
      for (const j of this.jobs)
        if (j.bookId === bookId && (j.status === "running" || j.status === "queued"))
          this.cancelJob(j.id);
      const b = this.bookById(bookId);
      if (b) (b.budget ??= { cap: null, paused: false }).paused = true;
      this.toast(`${b?.title}: everything paused`, {
        kind: "warn",
        description: "Running and queued jobs were cancelled. Resume from the overview.",
        timeout: 5000,
      });
    },
    resumeBook(bookId: string): void {
      const b = this.bookById(bookId);
      if (b?.budget) b.budget.paused = false;
    },
    setBudgetCap(bookId: string, cap: number | null): void {
      const b = this.bookById(bookId);
      if (b) (b.budget ??= { cap: null, paused: false }).cap = cap || null;
    },
    _blocked(bookId: string, kind: string): boolean {
      const b = this.bookById(bookId);
      if (b?.budget?.paused) {
        this.toast(`${b.title} is paused — resume it from the overview to ${kind}`, {
          kind: "warn",
        });
        return true;
      }
      return false;
    },

    // ---------- settings (endpoints & profiles, keys excluded) ----------
    exportSettings(): SettingsFile {
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        endpoints: this.endpoints.map(
          ({
            history: _history,
            failures: _failures,
            rateLimits: _rateLimits,
            backoffUntil: _backoffUntil,
            lastError: _lastError,
            fetching: _fetching,
            ...e
          }) => e,
        ),
        profiles: this.profiles.map((p) => ({ ...p })),
        scriptSettings: { ...this.scriptSettings },
      };
    },
    importSettings(obj: Partial<SettingsFile> | null | undefined): void {
      if (!obj || !Array.isArray(obj.endpoints)) throw new Error("not a settings file");
      if (obj.profiles != null && !Array.isArray(obj.profiles))
        throw new Error("Invalid scripting endpoints");
      const profiles = (obj.profiles ?? []).map((imported) => {
        const existing = this.profiles.find((p) => p.id === imported?.id);
        const profile = newProfile({ ...existing, ...imported });
        if (profileErrors(profile).length)
          throw new Error("Invalid scripting endpoint: " + profile.name);
        return profile;
      });
      let n = 0;
      for (const e of obj.endpoints) {
        const cur = this.endpoints.find((x) => x.id === e.id);
        const fresh = {
          history: [],
          failures: 0,
          rateLimits: 0,
          backoffUntil: 0,
          ...e,
        } as Endpoint;
        if (cur) Object.assign(cur, fresh);
        else this.endpoints.push(fresh);
        n++;
      }
      for (const p of profiles) {
        const cur = this.profiles.find((x) => x.id === p.id);
        if (cur) Object.assign(cur, p);
        else this.profiles.push(p);
      }
      if (obj.scriptSettings) Object.assign(this.scriptSettings, obj.scriptSettings);
      this.toast(`Imported ${n} narration and ${profiles.length} scripting endpoints`, {
        kind: "success",
        description: "API keys are never in the file — add them again on each endpoint.",
        timeout: 7000,
      });
    },

    // ---------- shared ----------
    addJob(kind: JobKind, bookId: string, label: string, chapterId: number | null = null): Job {
      this.jobs.push({
        id: jobSeq++,
        kind,
        bookId,
        chapterId,
        label,
        status: "queued",
        progress: 0,
        queuedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        cancelled: false,
      });
      const job = this.jobs[this.jobs.length - 1]; // mutate the reactive proxy
      logJob(job, "Job queued");
      return job;
    },
    removeJob(id: number): void {
      const j = this.jobs.find((j) => j.id === id);
      if (j && (j.finishedAt || j.status === "queued")) {
        if (j.status === "queued") this.cancelJob(id);
        this.jobs = this.jobs.filter((x) => x.id !== id);
      }
    },
    _sequential(jobs: Job[], start: (job: Job, next: () => void) => void): void {
      const next = () => {
        const j = jobs.shift();
        if (!j) return;
        if (j.status === "cancelled") return next();
        start(j, next);
      };
      next();
    },
    _finish(job: Job, status: JobStatus): void {
      if (job.finishedAt !== null) return;
      job.status = status;
      job.finishedAt = Date.now();
      job.waitingReason = "";
      logJob(job, `Job ${status}`, status === "failed" ? "error" : "info", {
        elapsedMs: job.startedAt === null ? 0 : job.finishedAt - job.startedAt,
      });
    },
    cancelJob(id: number): void {
      const job = this.jobs.find((j) => j.id === id);
      if (!job || job.finishedAt || job.cancelled) return;
      job.cancelled = true;
      logJob(job, "Cancellation requested", "warning", {
        behavior:
          job.kind === "narration"
            ? "In-flight clips finish; queued clips will not start"
            : "Stops on the next scheduler tick",
      });
      const c = job.chapterId ? this.chapter(job.bookId, job.chapterId) : null;
      if (job.status === "queued") {
        this._finish(job, "cancelled");
        if (c && job.kind === "scripting") c.scripting = "none";
        if (c && job.kind === "narration") c.narration = c.duration ? "done" : "none";
      }
      // running jobs notice `cancelled` on their next tick
    },
    retryJob(id: number): void {
      const job = this.jobs.find((j) => j.id === id);
      if (!job) return;
      if (job.chapterId == null) return;
      if (job.kind === "scripting") this.runScripting(job.bookId, [job.chapterId]);
      if (job.kind === "narration") {
        const c = this.chapter(job.bookId, job.chapterId);
        if (!c) return;
        if (
          c.narration === "failed" &&
          this.segmentsOf(job.bookId, c.id).some((x) => x.audio.status === "done")
        )
          this.retryFailed(job.bookId, c.id);
        else this.runNarration(job.bookId, [c.id]);
      }
    },
    clearFinished(): void {
      this.jobs = this.jobs.filter((j) => !j.finishedAt);
    },
    cancelAll(): void {
      for (const j of this.jobs.filter((j) => j.status === "queued")) this.cancelJob(j.id);
      for (const j of this.jobs.filter((j) => j.status === "running")) this.cancelJob(j.id);
    },
    retryAllFailed(): void {
      // one retry per chapter, grouped by book so each book's chapters queue in order
      const seen = new Set<string>();
      for (const j of this.jobs.filter((j) => j.status === "failed" && j.kind !== "export")) {
        const key = `${j.kind}:${j.bookId}:${j.chapterId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const c = j.chapterId == null ? undefined : this.chapter(j.bookId, j.chapterId);
        if (!c) continue;
        if (j.kind === "scripting" && c.scripting === "failed") this.retryJob(j.id);
        if (j.kind === "narration" && c.narration === "failed") this.retryJob(j.id);
      }
    },

    // ---------- library ----------
    _blankChapters(
      count: number,
      volumeId: number,
      startAt: number,
      prefix = "Chapter",
    ): Chapter[] {
      return Array.from({ length: count }, (_, i): Chapter => ({
        id: startAt + i,
        index: startAt + i,
        volumeId,
        volumeIndex: i + 1,
        title: `${prefix} ${i + 1}`,
        words: 3000,
        scripting: "none",
        scriptingProgress: 0,
        narration: "none",
        narrationProgress: 0,
        duration: 0,
      }));
    },
    addNovel(file: string, title?: string): string {
      const id = "new" + Date.now();
      const count = 12 + Math.floor(Math.random() * 10);
      this.books.push({
        id,
        title: title || file.replace(/\.epub$/i, ""),
        author: "Unknown",
        cover: ["#1e293b", "#94a3b8"],
        addedAt: "just now",
        volumes: [{ id: 1, name: title || file.replace(/\.epub$/i, ""), file, from: 1, to: count }],
      });
      this.chapters[id] = this._blankChapters(count, 1, 1);
      this.characters[id] = [
        {
          name: "Narrator",
          aliases: [],
          gender: "n",
          description: "Narration, thoughts, and every speaker without a voice of their own.",
          voice: this.voiceOptions.find((o) => !o.disabled)?.value ?? null,
          style: "",
          color: PALETTE[0],
          major: true,
        },
      ];
      return id;
    },
    // A novel split across several EPUBs: each file becomes a volume, chapters keep numbering continuously
    // so roster / recap continuity can carry across the volume boundary.
    addVolume(bookId: string, file: string, name?: string): void {
      const book = this.bookById(bookId);
      if (!book) return;
      const chs = this.chapters[bookId];
      const count = 8 + Math.floor(Math.random() * 8);
      const from = chs.length + 1;
      const vol: Volume = {
        id: book.volumes.length + 1,
        name: name || `Vol. ${book.volumes.length + 1}`,
        file,
        from,
        to: from + count - 1,
      };
      book.volumes.push(vol);
      chs.push(...this._blankChapters(count, vol.id, from));
    },

    renameVolume(bookId: string, volId: number, name: string): void {
      const v = this.bookById(bookId)?.volumes.find((v) => v.id === volId);
      if (v && name.trim()) v.name = name.trim();
    },
    // Remove a volume (wrong EPUB added): its chapters, segments, jobs and exports go; the remaining
    // chapters are renumbered so numbering stays continuous. Removing the last volume removes the novel.
    removeVolume(bookId: string, volId: number): "book" | "volume" | null {
      const book = this.bookById(bookId);
      if (!book) return null;
      if (book.volumes.length <= 1) {
        this.removeBook(bookId);
        return "book";
      }
      const revert = this._bookSnapshot(bookId);
      const vname = book.volumes.find((v) => v.id === volId)?.name;
      const gone = new Set(
        this.chapters[bookId].filter((c) => c.volumeId === volId).map((c) => c.id),
      );
      for (const j of this.jobs)
        if (
          j.bookId === bookId &&
          j.chapterId != null &&
          gone.has(j.chapterId) &&
          (j.status === "running" || j.status === "queued")
        )
          this.cancelJob(j.id);
      this.jobs = this.jobs.filter(
        (j) => !(j.bookId === bookId && j.chapterId != null && gone.has(j.chapterId)),
      );
      book.volumes = book.volumes.filter((v) => v.id !== volId);
      this._renumber(
        bookId,
        this.chapters[bookId].filter((c) => !gone.has(c.id)),
      );
      this.toast(`Removed ${vname} · ${gone.size} chapters`, { undo: revert });
      return "volume";
    },
    // Volumes are sortable: chapters follow the volume order and are renumbered continuously.
    moveVolume(bookId: string, volId: number, toIndex: number): void {
      const book = this.bookById(bookId);
      if (!book) return;
      const from = book.volumes.findIndex((v) => v.id === volId);
      if (from < 0) return;
      toIndex = Math.max(0, Math.min(book.volumes.length - 1, toIndex));
      if (from === toIndex) return;
      const vols = [...book.volumes];
      const [v] = vols.splice(from, 1);
      vols.splice(toIndex, 0, v);
      book.volumes = vols;
      const chs = this.chapters[bookId];
      this._renumber(
        bookId,
        vols.flatMap((v) =>
          chs.filter((c) => c.volumeId === v.id).sort((a, b) => a.volumeIndex - b.volumeIndex),
        ),
      );
    },
    // give `ordered` chapters ids 1..n in that order; re-key segments, remap jobs/exports, fix volume ranges
    _renumber(bookId: string, ordered: Chapter[]): void {
      const book = this.bookById(bookId);
      if (!book) return;
      const map: Record<number, number> = {};
      ordered.forEach((c, i) => {
        map[c.id] = i + 1;
      });
      const segs: SegmentMap = {};
      for (const [k, v] of Object.entries(this.segments)) {
        if (!k.startsWith(bookId + ":")) {
          segs[k] = v;
          continue;
        }
        const old = Number(k.split(":")[1]);
        if (map[old]) segs[key(bookId, map[old])] = v;
      }
      this.segments = segs;
      ordered.forEach((c) => {
        c.id = map[c.id];
        c.index = c.id;
      });
      this.chapters[bookId] = ordered;
      let from = 1;
      for (const v of book.volumes) {
        const mine = ordered.filter((c) => c.volumeId === v.id);
        v.from = from;
        v.to = from + mine.length - 1;
        from += mine.length;
        mine.forEach((c, i) => (c.volumeIndex = i + 1));
      }
      for (const j of this.jobs)
        if (j.bookId === bookId && j.chapterId != null && map[j.chapterId])
          j.chapterId = map[j.chapterId];
      this.exports = this.exports
        .map((e) =>
          e.bookId !== bookId
            ? e
            : { ...e, chapterIds: e.chapterIds.filter((id) => map[id]).map((id) => map[id]) },
        )
        .filter((e) => e.bookId !== bookId || e.chapterIds.length);
      for (const e of this.exports) if (e.bookId === bookId) e.chapters = e.chapterIds.length;
    },
    removeBook(bookId: string): void {
      const revert = this._bookSnapshot(bookId);
      const title = this.bookById(bookId)?.title;
      for (const j of this.jobs)
        if (j.bookId === bookId && (j.status === "running" || j.status === "queued"))
          this.cancelJob(j.id);
      this.jobs = this.jobs.filter((j) => j.bookId !== bookId);
      this.books = this.books.filter((b) => b.id !== bookId);
      delete this.chapters[bookId];
      delete this.characters[bookId];
      this.segments = Object.fromEntries(
        Object.entries(this.segments).filter(([k]) => !k.startsWith(bookId + ":")),
      );
      this.exports = this.exports.filter((e) => e.bookId !== bookId);
      if (this.currentBookId === bookId) this.currentBookId = null;
      this.toast(`Removed “${title}” from the library`, { undo: revert });
    },

    // ---------- demo ----------
    demoKick(): void {
      if (this._kicked) return;
      this._kicked = true;
      setTimeout(() => {
        this.runScripting("drowned", [3, 4, 5]);
        this.runNarration("cliche", [5, 6]);
      }, 1200);
    },

    // ---------- scripting ----------
    scriptingTelemetry(id: string): ScriptEndpointTelemetry {
      return (this.scriptTelemetry[id] ??= {
        completed: 0,
        failures: 0,
        rateLimits: 0,
        backoffUntil: 0,
        lastSuccess: 0,
        history: [],
      });
    },
    addScriptProfile(): string {
      const p = newProfile();
      this.profiles.push(p);
      return p.id;
    },
    removeScriptProfile(id: string): void {
      if (this.jobs.some((j) => !j.finishedAt && j.scriptRun?.profile.id === id)) {
        this.toast("Cancel this endpoint's jobs before removing it", { kind: "warn" });
        return;
      }
      const i = this.profiles.findIndex((p) => p.id === id);
      if (i < 0) return;
      const [p] = this.profiles.splice(i, 1);
      const secret = keyring.get("profile:" + id);
      keyring.set("profile:" + id, "");
      this.toast(`Removed ${p.name}`, {
        undo: () => {
          this.profiles.splice(i, 0, p);
          keyring.set("profile:" + id, secret);
        },
      });
    },
    runScripting(
      bookId: string,
      ids: number[],
      {
        keepEdits = false,
        retrySegmentId = null,
      }: { keepEdits?: boolean; retrySegmentId?: number | null } = {},
    ): void {
      if (this._blocked(bookId, "script")) return;
      const estimate = this.scriptEstimate(bookId, ids, retrySegmentId);
      if (estimate.blockers.length) {
        this.toast("Scripting needs attention", {
          kind: "warn",
          description: estimate.blockers[0],
        });
        return;
      }
      if (!estimate.chapters) return;
      const profile = clone(estimate.profile!);
      const textOf = (chId: number) =>
        retrySegmentId === null
          ? this.rawText(bookId, chId)
          : (this.segmentsOf(bookId, chId).find((x) => x.id === retrySegmentId)?.text ?? "");
      const chs = this.chapters[bookId].filter(
        (c) =>
          ids.includes(c.id) &&
          !c.excluded &&
          c.scripting !== "running" &&
          c.scripting !== "queued",
      );
      // re-scripting: remember what we had so the reader can show what changed (and optionally re-apply manual edits)
      for (const c of chs)
        if (retrySegmentId === null && this.segments[key(bookId, c.id)]?.length) {
          this._previous[key(bookId, c.id)] = clone(this.segments[key(bookId, c.id)]);
          c.rescript = { keepEdits };
        }
      const jobs = chs.map((c) => {
        c.scripting = "queued";
        c.scriptingProgress = 0;
        const job = this.addJob("scripting", bookId, `Script · ch ${c.id} · ${profile.name}`, c.id);
        job.scriptRun = {
          profile: clone(profile),
          requests: scriptParts(textOf(c.id), profile).length,
          completed: 0,
          active: 0,
          reserved: 0,
          cost: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        logJob(job, "Scripting plan prepared", "info", {
          endpoint: profile.name,
          model: profile.model,
          requests: job.scriptRun.requests,
          characters: textOf(c.id).length,
          concurrency: profile.concurrency,
        });
        jobWaiting(job, "Chapter has not been dispatched yet");
        return job;
      });
      this._sequential(jobs, (job, done) => {
        const c = this.chapter(bookId, job.chapterId!)!;
        const run = job.scriptRun!;
        const requests = scriptParts(textOf(c.id), profile).map((text) =>
          tokenEstimate(text, profile),
        );
        const active: {
          request: number;
          started: number;
          finish: number;
          usage: ReturnType<typeof tokenEstimate>;
        }[] = [];
        let cursor = 0;
        let checkedRateLimit = false;
        let retriedFirstRequest = false;
        const telemetry = this.scriptingTelemetry(profile.id);
        const t = setInterval(() => {
          if (job.cancelled) {
            clearInterval(t);
            run.active = 0;
            run.reserved = 0;
            c.scripting = this.segmentsOf(bookId, c.id).length ? "done" : "none";
            c.scriptingProgress = 0;
            this._finish(job, "cancelled");
            return done();
          }
          // One ordered chapter per book, with concurrent chunk requests sharing the endpoint limit.
          if (
            this.jobs.some(
              (j) =>
                j.id < job.id && j.bookId === bookId && j.kind === "scripting" && !j.finishedAt,
            )
          ) {
            jobWaiting(job, "An earlier chapter in this book is still scripting");
            return;
          }
          for (let i = active.length - 1; i >= 0; i--) {
            if (active[i].finish > Date.now()) continue;
            const { usage, started, request } = active.splice(i, 1)[0];
            logJob(job, `Request ${request} completed`, "info", {
              request,
              responseMs: Date.now() - started,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costUSD: usage.cost,
            });
            telemetry.completed++;
            telemetry.lastSuccess = Date.now();
            telemetry.history = [
              ...telemetry.history.slice(-29),
              { at: Date.now(), ms: Date.now() - started, ok: true },
            ];
            run.active--;
            run.completed++;
            run.reserved = Math.max(0, run.reserved - usage.reserve);
            run.cost += usage.cost;
            run.inputTokens += usage.inputTokens;
            run.outputTokens += usage.outputTokens;
            this.scriptUsage.push({
              bookId,
              profileId: profile.id,
              cost: usage.cost,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            });
          }
          const live = this.profiles.find((p) => p.id === profile.id);
          let slots =
            (live?.concurrency ?? 0) -
            this.jobs.reduce(
              (n, j) => n + (j.scriptRun?.profile.id === profile.id ? j.scriptRun.active : 0),
              0,
            );
          jobWaiting(
            job,
            cursor >= requests.length
              ? ""
              : !live
                ? "Endpoint no longer available"
                : !live.enabled
                  ? "Endpoint is paused"
                  : telemetry.backoffUntil > Date.now()
                    ? "Rate-limit cooldown"
                    : slots <= 0
                      ? "Endpoint concurrency is full"
                      : "",
          );
          while (
            live?.enabled &&
            telemetry.backoffUntil <= Date.now() &&
            slots > 0 &&
            cursor < requests.length
          ) {
            const usage = requests[cursor];
            const remaining =
              (this.bookById(bookId)?.scriptBudget ?? Infinity) -
              this.scriptSpent(bookId) -
              this.scriptReserved(bookId);
            const overall =
              (this.bookById(bookId)?.budget?.cap ?? Infinity) -
              this.spent(bookId) -
              this.scriptReserved(bookId);
            if (usage.reserve > Math.min(remaining, overall)) {
              if (!active.length) {
                this.toast("Scripting stopped at the budget limit", {
                  kind: "warn",
                  description:
                    "Increase the budget and retry this chapter. Completed request costs are retained.",
                });
                clearInterval(t);
                c.scripting = "failed";
                logJob(job, "Remaining budget cannot cover the next request", "error", {
                  requiredUSD: usage.reserve,
                  remainingUSD: Math.min(remaining, overall),
                });
                this._finish(job, "failed");
                for (const pending of jobs) this.cancelJob(pending.id);
                done();
              }
              break;
            }
            // Demo transport occasionally receives a 429 before accepting the first request.
            // A shared retry-after window pauses dispatch across every book on this endpoint.
            if (!checkedRateLimit) {
              checkedRateLimit = true;
              if (Math.random() < 0.08) {
                retriedFirstRequest = true;
                const cooldown = live?.cooldownSec ?? 10;
                telemetry.failures++;
                telemetry.rateLimits++;
                telemetry.backoffUntil = Date.now() + cooldown * 1000;
                telemetry.lastError = {
                  code: 429,
                  message: "Rate limited",
                  body: `{"error":{"message":"Too many requests. Retry after ${cooldown} seconds.","type":"rate_limit_error"}}`,
                  at: Date.now(),
                  bookId,
                  chapterId: c.id,
                  model: profile.model,
                  baseUrl: profile.baseUrl,
                };
                logJob(
                  job,
                  `Request ${cursor + 1} rate limited; retry after ${cooldown}s`,
                  "warning",
                  { request: cursor + 1, attempt: 1, code: 429, endpoint: profile.name },
                );
                telemetry.history = [
                  ...telemetry.history.slice(-29),
                  { at: Date.now(), ms: 0, ok: false },
                ];
                break;
              }
            }
            cursor++;
            slots--;
            run.active++;
            run.reserved += usage.reserve;
            startJob(job);
            logJob(job, `Request ${cursor} started`, "info", {
              request: cursor,
              attempt: cursor === 1 && retriedFirstRequest ? 2 : 1,
              endpoint: profile.name,
              reservedUSD: usage.reserve,
            });
            active.push({
              request: cursor,
              started: Date.now(),
              finish: Date.now() + profile.secPerChunk * 100,
              usage,
            });
            c.scripting = "running";
          }
          c.scriptingProgress = (run.completed / run.requests) * 100;
          job.progress = c.scriptingProgress;
          if (run.completed === run.requests) {
            clearInterval(t);
            const roll = Math.random();
            const outcome = roll < 0.06 ? "failed" : roll < 0.16 ? "fallback" : "done";
            c.scripting = outcome;
            if (outcome !== "done")
              logJob(
                job,
                outcome === "failed"
                  ? "Script verification failed"
                  : "An unverified chunk was kept as narration for review",
                outcome === "failed" ? "error" : "warning",
              );
            this._finish(job, outcome === "failed" ? "failed" : "done");
            if (outcome !== "failed") {
              if (retrySegmentId !== null) {
                const cur = this.segmentsOf(bookId, c.id);
                const index = cur.findIndex((x) => x.id === retrySegmentId);
                if (index >= 0) {
                  const original = cur[index];
                  const fresh = generateSegments(bookId, c.id).slice(
                    0,
                    original.fallbackCount ?? 6,
                  );
                  cur.splice(index, 1, ...fresh);
                  cur.forEach((x, i) => (x.id = i + 1));
                  c.scripting = cur.some((x) => x.fallback) ? "fallback" : "done";
                  c.narration = c.duration ? "stale" : "none";
                  this._absorbCast(bookId, c.id);
                }
                done();
                return;
              }
              let segs = generateSegments(bookId, c.id, { aliasNoise: true });
              if (outcome === "fallback") segs = collapseChunk(segs); // verifier couldn't reconstruct one chunk → kept whole as narration
              const prev = this._previous[key(bookId, c.id)];
              if (prev) {
                // mock a *different* LLM run: a few speakers move, one narration pair merges
                segs = reseg(segs);
                if (c.rescript?.keepEdits)
                  for (const p of prev)
                    if (p.edited) {
                      const t = segs.find((x) => x.text === p.text);
                      if (t) {
                        t.speaker = p.speaker;
                        t.direction = p.direction;
                        t.type = p.type;
                        t.edited = true;
                      }
                    }
              }
              this.segments[key(bookId, c.id)] = segs;
              this._absorbCast(bookId, c.id);
              c.narration = "none";
              c.narrationProgress = 0;
              c.duration = 0;
            }
            done();
          }
        }, 220);
      });
    },
    // Re-run the LLM on just the chunk that fell back. Simulated: replaced by properly split segments.
    retryChunk(bookId: string, chId: number, segId: number): void {
      const seg = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!seg?.fallback) return;
      this.runScripting(bookId, [chId], { keepEdits: true, retrySegmentId: segId });
    },
    _absorbCast(bookId: string, chId: number): void {
      const cast = this.characters[bookId];
      for (const s of this.segmentsOf(bookId, chId)) {
        if (!cast.some((c) => c.name === s.speaker)) {
          cast.push({
            name: s.speaker,
            aliases: [],
            gender: "?",
            description: "",
            voice: null,
            style: "",
            color: PALETTE[cast.length % PALETTE.length],
            major: false,
            isNew: true,
          });
        }
      }
    },
    setSpeaker(bookId: string, chId: number, segId: number, speaker: string): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s && s.speaker !== speaker) {
        s.speaker = speaker;
        s.edited = true;
        this._markStale(bookId, chId, s);
      }
    },
    updateSegment(bookId: string, chId: number, segId: number, patch: Partial<Segment>): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s) return;
      const changed = (Object.keys(patch) as (keyof Segment)[]).some((k) => s[k] !== patch[k]);
      Object.assign(s, patch);
      if (changed) {
        s.edited = true;
        this._markStale(bookId, chId, s);
      }
    },
    // ---------- segment boundaries ----------
    // The LLM sometimes groups two speakers into one segment, or cuts a sentence in half. These two
    // actions fix the split by hand; both are undoable and both invalidate the audio they touch.
    _segSnapshot(bookId: string, chId: number): () => void {
      const before = clone(this.segments[key(bookId, chId)] ?? []);
      const c = this.chapter(bookId, chId);
      const narration = c?.narration;
      const duration = c?.duration;
      return () => {
        this.segments[key(bookId, chId)] = before;
        const ch = this.chapter(bookId, chId);
        if (ch && narration) {
          ch.narration = narration;
          ch.duration = duration ?? ch.duration;
        }
      };
    },
    /** Chapter length is the sum of what is actually rendered, plus the silence stitched between. */
    _retime(bookId: string, chId: number): void {
      const c = this.chapter(bookId, chId);
      if (!c) return;
      const segs = this.segmentsOf(bookId, chId);
      c.duration =
        segs.reduce((a, s) => a + s.audio.duration, 0) + silenceOf(segs, this.pacingOf(bookId));
    },
    /** Cut a segment in two at character offset `at`. Returns the new segment's id. */
    splitSegment(bookId: string, chId: number, segId: number, at: number): number | null {
      const segs = this.segments[key(bookId, chId)];
      const i = segs?.findIndex((x) => x.id === segId) ?? -1;
      if (i < 0) return null;
      const s = segs[i];
      const head = s.text.slice(0, at).trimEnd();
      const tail = s.text.slice(at).trimStart();
      if (!head || !tail) return null;
      // the whitespace the cut falls in is the prose, not padding: a paragraph break has to survive
      // the split so that joining the halves back restores the source exactly
      const sep = s.text.slice(head.length, s.text.length - tail.length);
      const revert = this._segSnapshot(bookId, chId);
      const id = Math.max(0, ...segs.map((x) => x.id)) + 1;
      const second: Segment = {
        ...clone(s),
        id,
        text: tail,
        edited: true,
        audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
      };
      delete second.candidate;
      // a hand-split chunk is no longer the model's unverified guess, and the halves start unflagged
      delete second.fallback;
      delete second.fallbackCount;
      delete second.fallbackMismatch;
      delete second.fallbackRetrying;
      delete second.flag;
      s.text = head;
      s.edited = true;
      delete s.candidate; // a retake of the line as it was says nothing about either half
      if (sep === " ") delete s.sep;
      else s.sep = sep;
      delete s.fallback;
      delete s.fallbackCount;
      delete s.fallbackMismatch;
      delete s.fallbackRetrying;
      this._markStale(bookId, chId, s);
      // the second half has no audio at all, so a narrated chapter is no longer complete
      const c = this.chapter(bookId, chId);
      if (c && c.narration === "done") c.narration = "stale";
      segs.splice(i + 1, 0, second);
      this._retime(bookId, chId);
      this.toast("Segment split in two", {
        description: `#${s.id} keeps “${head.slice(0, 40)}…”, #${id} starts “${tail.slice(0, 40)}…”`,
        undo: revert,
      });
      return id;
    },
    /** Join a segment with the one after it. The first segment's speaker, type and direction win. */
    joinSegments(bookId: string, chId: number, segId: number): boolean {
      const segs = this.segments[key(bookId, chId)];
      const i = segs?.findIndex((x) => x.id === segId) ?? -1;
      if (i < 0 || i + 1 >= segs.length) return false;
      const a = segs[i];
      const b = segs[i + 1];
      const revert = this._segSnapshot(bookId, chId);
      // put back whatever stood between them — a single space unless a split recorded otherwise
      a.text = `${a.text.trimEnd()}${a.sep ?? " "}${b.text.trimStart()}`;
      a.edited = true;
      a.flag ??= b.flag;
      delete a.candidate; // neither half's retake is a take of the joined line
      // the pair now ends where b ended, so b's own separator becomes a's
      if (b.sep == null) delete a.sep;
      else a.sep = b.sep;
      delete a.fallback;
      delete a.fallbackCount;
      delete a.fallbackMismatch;
      delete a.fallbackRetrying;
      this._markStale(bookId, chId, a);
      const c = this.chapter(bookId, chId);
      if (c && c.narration === "done" && b.audio.status !== "none") c.narration = "stale";
      segs.splice(i + 1, 1);
      this._retime(bookId, chId);
      this.toast(`#${b.id} joined into #${a.id}`, {
        description:
          a.speaker === b.speaker
            ? `Read as one ${a.type} line by ${a.speaker}.`
            : `${b.speaker}\u2019s line is now read by ${a.speaker} \u2014 check the speaker.`,
        kind: a.speaker === b.speaker ? "info" : "warn",
        undo: revert,
      });
      return true;
    },
    dismissDiff(bookId: string, chId: number): void {
      delete this._previous[key(bookId, chId)];
    },
    // edited after narration → existing audio no longer matches the script
    _markStale(bookId: string, chId: number, s: Segment): void {
      if (s.audio.status === "done" || s.audio.status === "stale") {
        s.audio.status = "stale";
        const c = this.chapter(bookId, chId);
        if (c?.narration === "done") c.narration = "stale";
      }
    },
    // "changed" is both edited-after-narration lines and halves of a hand-split segment that were
    // never rendered at all — in a chapter that has audio, neither belongs in the finished book.
    renarrateStale(bookId: string, chId: number): void {
      const started = this.chapter(bookId, chId)?.narration !== "none";
      for (const s of this.segmentsOf(bookId, chId))
        if (s.audio.status === "stale" || (started && s.audio.status === "none"))
          s.audio = requeue(s.audio);
      this._resume(bookId, chId);
    },
    // ---------- pronunciation & pacing ----------
    // Two ways to change how a book sounds without editing a word of it. The dictionary rewrites a
    // term on its way to the endpoint, so the clips that were rendered with the old spelling no
    // longer match and are marked stale. A pause is stitched between clips instead of rendered, so
    // changing one re-times the chapter and invalidates nothing.
    _lexSnapshot(bookId: string): () => void {
      const before = clone(this.lexicon[bookId] ?? []);
      const prefix = bookId + ":";
      const keys = Object.keys(this.segments).filter((k) => k.startsWith(prefix));
      const audio = keys.flatMap((k) =>
        this.segments[k].map((s) => [k, s.id, s.audio.status] as const),
      );
      const narration = this.chaptersOf(bookId).map((c) => [c.id, c.narration] as const);
      return () => {
        this.lexicon[bookId] = before;
        for (const [k, id, status] of audio) {
          const s = this.segments[k]?.find((x) => x.id === id);
          if (s) s.audio.status = status;
        }
        for (const [id, was] of narration) {
          const c = this.chapter(bookId, id);
          if (c) c.narration = was;
        }
      };
    },
    /** Clips that would now be sent different words read the old pronunciation — mark them stale. */
    _lexRestale(bookId: string): number {
      let n = 0;
      const prefix = bookId + ":";
      for (const k of Object.keys(this.segments)) {
        if (!k.startsWith(prefix)) continue;
        for (const s of this.segments[k]) {
          const sent = s.audio.said ?? s.audio.text;
          if (s.audio.status !== "done" || sent == null) continue;
          if (this.spoken(bookId, s.text).text === sent) continue;
          s.audio.status = "stale";
          n++;
          const c = this.chapter(bookId, Number(k.slice(prefix.length)));
          if (c?.narration === "done") c.narration = "stale";
        }
      }
      return n;
    },
    _lexChanged(bookId: string, revert: () => void, label: string): void {
      const n = this._lexRestale(bookId);
      this.toast(label, {
        kind: n ? "warn" : "info",
        description: n
          ? `${n} rendered line${n === 1 ? "" : "s"} still read the old pronunciation — re-narrate to apply.`
          : "The book text is unchanged; the endpoint is sent the respelling.",
        undo: revert,
      });
    },
    addTerm(bookId: string, term = "", say = ""): number {
      const revert = this._lexSnapshot(bookId);
      const list = (this.lexicon[bookId] ??= []);
      const id = Math.max(0, ...list.map((e) => e.id)) + 1;
      list.push({ id, term: term.trim(), say: say.trim(), enabled: true });
      if (term.trim() && say.trim())
        this._lexChanged(bookId, revert, `“${term.trim()}” is said “${say.trim()}”`);
      return id;
    },
    updateTerm(bookId: string, id: number, patch: Partial<LexEntry>): void {
      const e = this.lexiconOf(bookId).find((x) => x.id === id);
      if (!e) return;
      if (!(Object.keys(patch) as (keyof LexEntry)[]).some((k) => e[k] !== patch[k])) return;
      const revert = this._lexSnapshot(bookId);
      const was = { ...e };
      Object.assign(e, patch);
      const renamed = e.term !== was.term || e.say !== was.say;
      this._lexChanged(
        bookId,
        revert,
        patch.enabled != null && !renamed
          ? `“${e.term}” ${e.enabled ? "is applied again" : "is no longer applied"}`
          : `“${e.term}” is said “${e.say}”`,
      );
    },
    removeTerm(bookId: string, id: number): void {
      const list = this.lexiconOf(bookId);
      const e = list.find((x) => x.id === id);
      if (!e) return;
      const revert = this._lexSnapshot(bookId);
      list.splice(list.indexOf(e), 1);
      if (e.term && e.say)
        this._lexChanged(bookId, revert, `“${e.term}” removed from the dictionary`);
    },
    /** Silence after one line, in seconds; null goes back to the book's pacing. */
    setPause(bookId: string, chId: number, segId: number, pause: number | null): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s) return;
      if (pause == null) delete s.pause;
      else s.pause = pause;
      this._retime(bookId, chId);
    },
    setPacing(bookId: string, patch: Partial<Pacing>): void {
      const b = this.bookById(bookId);
      if (!b) return;
      b.pacing = { ...this.pacingOf(bookId), ...patch };
      for (const c of this.chaptersOf(bookId)) this._retime(bookId, c.id);
    },
    resetPacing(bookId: string): void {
      const b = this.bookById(bookId);
      if (!b?.pacing) return;
      delete b.pacing;
      for (const c of this.chaptersOf(bookId)) this._retime(bookId, c.id);
    },
    /** Lines in this book that carry a pause of their own. */
    pauseOverrides(bookId: string): { chId: number; seg: Segment }[] {
      const prefix = bookId + ":";
      return Object.keys(this.segments)
        .filter((k) => k.startsWith(prefix))
        .flatMap((k) =>
          this.segments[k]
            .filter((s) => s.pause != null)
            .map((seg) => ({ chId: Number(k.slice(prefix.length)), seg })),
        )
        .sort((a, b) => a.chId - b.chId || a.seg.id - b.seg.id);
    },
    renameCharacter(bookId: string, from: string, to: string): void {
      to = (to ?? "").trim();
      if (!to || from === to) return;
      const cast = this.characters[bookId];
      if (cast.some((c) => c.name === to)) {
        this.mergeCharacter(bookId, from, to);
        return;
      }
      const revert = this._castSnapshot(bookId);
      const c = cast.find((x) => x.name === from);
      if (!c) return;
      c.name = to;
      c.isNew = false;
      this._replaceSpeaker(bookId, from, to);
      this.toast(`Renamed “${from}” to “${to}”`, { undo: revert });
    },
    mergeCharacter(bookId: string, from: string, into: string, { silent = false } = {}): void {
      if (from === into) return;
      const cast = this.characters[bookId];
      const src = cast.find((c) => c.name === from);
      const dst = cast.find((c) => c.name === into);
      if (!src || !dst) return;
      const revert = this._castSnapshot(bookId);
      const n = this.lineCounts(bookId)[from] ?? 0;
      dst.aliases = [...new Set([...dst.aliases, from, ...src.aliases])];
      this.characters[bookId] = cast.filter((c) => c !== src);
      this._replaceSpeaker(bookId, from, into);
      if (!silent)
        this.toast(`Merged “${from}” into ${into} · ${n} line${n === 1 ? "" : "s"} moved`, {
          undo: revert,
        });
    },
    mergeMany(bookId: string, names: string[], into: string): void {
      const revert = this._castSnapshot(bookId);
      let n = 0;
      for (const name of names)
        if (name !== into) {
          this.mergeCharacter(bookId, name, into, { silent: true });
          n++;
        }
      if (n) this.toast(`Merged ${n} speaker${n === 1 ? "" : "s"} into ${into}`, { undo: revert });
    },
    deleteCharacter(bookId: string, name: string): void {
      const revert = this._castSnapshot(bookId);
      const n = this.lineCounts(bookId)[name] ?? 0;
      this.mergeCharacter(bookId, name, "Narrator", { silent: true });
      this.toast(`Removed “${name}” · ${n} line${n === 1 ? "" : "s"} now read by the Narrator`, {
        undo: revert,
      });
    },
    autoAssignByGender(bookId: string): void {
      // pool = voices on enabled endpoints, grouped by the gender tag the endpoint's voice list carries
      const all = this.enabledEndpoints.flatMap((e) =>
        e.voices.map((v) => ({ ref: voiceRef(e.id, v.id), gender: v.gender })),
      );
      if (!all.length) return;
      const byGender: Partial<Record<Gender, typeof all>> = {
        m: all.filter((v) => v.gender === "m"),
        f: all.filter((v) => v.gender === "f"),
        n: all.filter((v) => v.gender === "n"),
      };
      const used: Partial<Record<Gender, number>> = {};
      for (const c of this.characters[bookId]) {
        if (c.voice || c.name === "Narrator") continue;
        const byG = byGender[c.gender];
        const pool = byG?.length ? byG : all;
        const i = (used[c.gender] = (used[c.gender] ?? 0) + 1);
        c.voice = pool[i % pool.length].ref;
      }
    },

    // ---------- endpoints & their voices ----------
    addEndpoint(): Endpoint {
      this.endpoints.push({
        id: "ep" + Date.now(),
        name: "New endpoint",
        baseUrl: "https://",
        model: "gpt-4o-mini-tts",
        concurrency: 1,
        enabled: false,
        latency: 1500,
        failRate: 0.03,
        price: 12,
        needsKey: true,
        maxChars: 0,
        splitAt: "sentence",
        voices: [],
        history: [],
        failures: 0,
        rateLimits: 0,
        backoffUntil: 0,
        fetching: false,
      });
      return this.endpoints[this.endpoints.length - 1];
    },
    removeEndpoint(id: string): void {
      // characters keep a dangling ref → shown as "missing" until undone or re-picked
      const i = this.endpoints.findIndex((e) => e.id === id);
      if (i < 0) return;
      const e = this.endpoints[i];
      this.endpoints.splice(i, 1);
      this.toast(`Removed endpoint ${e.name}`, {
        undo: () => this.endpoints.splice(Math.min(i, this.endpoints.length), 0, e),
      });
    },
    addVoice(ep: Endpoint, { id, label, gender }: Partial<Voice>): boolean {
      id = (id ?? "").trim();
      if (!id || ep.voices.some((v) => v.id === id)) return false;
      ep.voices.push({ id, label: (label ?? "").trim() || id, gender: gender ?? "n" });
      return true;
    },
    removeVoice(ep: Endpoint, id: string): void {
      const i = ep.voices.findIndex((v) => v.id === id);
      if (i < 0) return;
      const v = ep.voices[i];
      ep.voices.splice(i, 1);
      this.toast(`Removed voice ${v.label} from ${ep.name}`, {
        undo: () => ep.voices.splice(Math.min(i, ep.voices.length), 0, v),
      });
    },
    // simulated GET /v1/audio/voices — most OpenAI-compatible servers (Kokoro-FastAPI, Orpheus…) expose one
    fetchVoices(ep: Endpoint): Promise<number> {
      ep.fetching = true;
      const work = new Promise<number>((res, rej) =>
        setTimeout(() => {
          ep.fetching = false;
          if (!/^https?:\/\/.+\..+/.test(ep.baseUrl) && !/127\.0\.0\.1|localhost/.test(ep.baseUrl))
            return rej(new Error(`GET ${ep.baseUrl}/audio/voices — could not connect`));
          const added = DISCOVERABLE_VOICES.filter(
            (v) => !ep.voices.some((x) => x.id === v.id),
          ).map((v) => ({ ...v }));
          ep.voices.push(...added);
          res(added.length);
        }, 1200),
      );
      this.toastLoading(work, {
        loading: `Fetching voices from ${ep.name}…`,
        success: (n) =>
          n ? `${n} voice${n === 1 ? "" : "s"} added to ${ep.name}` : `${ep.name}: no new voices`,
        error: () => `${ep.name}: voice list unavailable`,
      });
      return work.catch(() => 0);
    },
    // how many segments of this book a limit would split, for the endpoint card
    splitCount(bookId: string, ep: Endpoint): number {
      if (!ep.maxChars) return 0;
      let n = 0;
      for (const k of Object.keys(this.segments))
        if (k.startsWith(bookId + ":"))
          for (const s of this.segments[k])
            if (
              this.effectiveVoice(bookId, s.speaker).endpoint?.id === ep.id &&
              s.text.length > ep.maxChars
            )
              n++;
      return n;
    },
    _replaceSpeaker(bookId: string, from: string, to: string): void {
      for (const k of Object.keys(this.segments)) {
        if (!k.startsWith(bookId + ":")) continue;
        const chId = Number(k.split(":")[1]);
        for (const s of this.segments[k])
          if (s.speaker === from) {
            s.speaker = to;
            this._markStale(bookId, chId, s);
          }
      }
    },
    lineCounts(bookId: string, chId: number | null = null): Record<string, number> {
      const counts: Record<string, number> = {};
      const keys = chId
        ? [key(bookId, chId)]
        : Object.keys(this.segments).filter((k) => k.startsWith(bookId + ":"));
      for (const k of keys)
        for (const s of this.segments[k] ?? []) counts[s.speaker] = (counts[s.speaker] ?? 0) + 1;
      return counts;
    },

    // ---------- narration ----------
    runNarration(bookId: string, ids: number[]): void {
      if (this._blocked(bookId, "narrate")) return;
      const chs = this.chapters[bookId].filter(
        (c) =>
          ids.includes(c.id) &&
          !c.excluded &&
          isScripted(c) &&
          !["running", "queued"].includes(c.narration),
      );
      const jobs = chs.map((c) => {
        c.narration = "queued";
        c.narrationProgress = 0;
        const job = this.addJob("narration", bookId, `Narrate · ch ${c.id}`, c.id);
        jobWaiting(job, "Chapter has not been dispatched yet");
        return job;
      });
      this._sequential(jobs, (job, done) => {
        const c = this.chapter(bookId, job.chapterId!)!;
        for (const s of this.segmentsOf(bookId, c.id)) {
          delete s.candidate; // the whole chapter is being rendered again; a pending retake is moot
          s.audio = requeue(s.audio);
        }
        this._dispatch(bookId, c, job, done);
      });
    },
    retrySegment(bookId: string, chId: number, segId: number): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s) s.audio = requeue(s.audio);
      this._resume(bookId, chId);
    },
    retryFailed(bookId: string, chId: number): void {
      for (const s of this.segmentsOf(bookId, chId))
        if (s.audio.status === "failed") s.audio = requeue(s.audio);
      this._resume(bookId, chId);
    },

    // ---------- audio review & retakes ----------
    // A request can succeed and still sound wrong. The listener flags what is wrong, asks for another
    // take, then plays the two against each other and keeps one; the loser stays in the take list.
    // A retake renders into `segment.candidate`, never into `segment.audio`: the clip in the book keeps
    // playing, timing the chapter and going into the export until the listener actually accepts the
    // new one. Nothing about the book changes on the strength of a request that merely succeeded.
    flagSegment(
      bookId: string,
      chId: number,
      segId: number,
      kind: FlagKind,
      note: string = "",
    ): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s) s.flag = { kind, note: note.trim(), at: Date.now() } satisfies SegmentFlag;
    },
    clearFlag(bookId: string, chId: number, segId: number): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s?.flag) delete s.flag;
    },
    /** Queue another render of one segment, keeping the current clip to compare against. */
    retakeSegment(bookId: string, chId: number, segId: number): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s || !this._queueRetake(s)) return;
      this._resume(bookId, chId, "Retake");
    },
    /** Every flagged segment in the chapter gets another take in one run. */
    retakeFlagged(bookId: string, chId: number): number {
      let n = 0;
      for (const s of this.segmentsOf(bookId, chId)) if (s.flag && this._queueRetake(s)) n++;
      if (n) this._resume(bookId, chId, "Retake");
      return n;
    },
    _queueRetake(s: Segment): boolean {
      if (s.candidate || ["queued", "generating"].includes(s.audio.status)) return false;
      // nothing playable to compare against (never rendered, or it failed): this is a plain re-render
      if (s.audio.duration <= 0) {
        s.audio = requeue(s.audio);
        return true;
      }
      s.candidate = {
        status: "queued",
        endpoint: null,
        ms: 0,
        duration: 0,
        n: (s.audio.n ?? 1) + 1,
      };
      return true;
    },
    /** Keep the new take: it becomes the clip in the book, the old one joins the take list. */
    acceptTake(bookId: string, chId: number, segId: number): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      const cand = s?.candidate;
      if (!s || !cand || cand.duration <= 0) return;
      const before = { audio: clone(s.audio), candidate: clone(cand), flag: s.flag };
      const takes = [...(s.audio.takes ?? [])];
      if (s.audio.duration > 0) takes.push(snapshotTake(s.audio));
      s.audio = { ...cand, ...(takes.length ? { takes } : {}) };
      delete s.candidate;
      delete s.flag;
      this._retime(bookId, chId);
      this.toast(`Take ${s.audio.n ?? 1} kept`, {
        kind: "success",
        description: "It is the clip in the book now; the earlier take stays in the take list.",
        undo: () => {
          s.audio = before.audio;
          s.candidate = before.candidate;
          if (before.flag) s.flag = before.flag;
          this._retime(bookId, chId);
        },
      });
    },
    /** Drop the new take. The clip in the book never moved, so only the take list changes. */
    rejectTake(bookId: string, chId: number, segId: number): void {
      const s = this.segmentsOf(bookId, chId).find((x) => x.id === segId);
      const cand = s?.candidate;
      if (!s || !cand) return;
      const before = { audio: clone(s.audio), candidate: clone(cand) };
      if (cand.duration > 0)
        s.audio.takes = [...(s.audio.takes ?? []), { ...snapshotTake(cand), rejected: true }];
      delete s.candidate;
      // the kept clip may have gone out of date while the retake rendered — say so rather than
      // silently calling it current
      const drift = this.clipDrift(bookId, s);
      if (["done", "stale"].includes(s.audio.status))
        s.audio.status = drift.length ? "stale" : "done";
      if (s.audio.status === "stale") this._markStale(bookId, chId, s);
      this.toast(cand.duration > 0 ? `Take ${s.audio.n ?? 1} kept` : "Retake discarded", {
        description: drift.length
          ? `The kept clip is out of date — ${drift[0]}.`
          : cand.duration > 0
            ? `Take ${cand.n} is marked rejected — retake again or edit the line first.`
            : "It never produced a clip.",
        kind: drift.length ? "warn" : "info",
        undo: () => {
          s.audio = before.audio;
          s.candidate = before.candidate;
        },
      });
    },
    _resume(bookId: string, chId: number, label = "Retry"): void {
      const c = this.chapter(bookId, chId);
      if (!c || c.narration === "running") return;
      const job = this.addJob("narration", bookId, `${label} · ch ${c.id}`, c.id);
      this._dispatch(bookId, c, job, () => {});
    },
    _dispatch(bookId: string, c: Chapter, job: Job, done: () => void): void {
      c.narration = "running";
      jobWaiting(job, "");
      startJob(job);
      const segs = this.segmentsOf(bookId, c.id);
      const attempts = new Map<string, number>();
      // A run renders two kinds of clip: a segment's own audio, and the retake standing beside it.
      // `slot` says which one a target writes to, so a retake never lands on the book's clip.
      type Slot = "audio" | "candidate";
      interface Target {
        s: Segment;
        slot: Slot;
      }
      const clipOf = (t: Target): SegmentAudio => (t.slot === "audio" ? t.s.audio : t.s.candidate!);
      const targets = (...status: AudioStatus[]): Target[] =>
        segs.flatMap((s) => [
          ...(status.includes(s.audio.status) ? [{ s, slot: "audio" as Slot }] : []),
          ...(s.candidate && status.includes(s.candidate.status)
            ? [{ s, slot: "candidate" as Slot }]
            : []),
        ]);
      logJob(job, "Narration plan prepared", "info", {
        clips: targets("queued").length,
        segments: segs.length,
      });
      const tick = () => {
        if (job.cancelled) {
          for (const t of targets("queued"))
            if (t.slot === "candidate") delete t.s.candidate;
            else t.s.audio.status = "none";
          if (!targets("generating").length) {
            c.narration = segs.every((s) => s.audio.status === "done") ? "done" : "failed";
            this._finish(job, "cancelled");
            return done();
          }
          return setTimeout(tick, 200);
        }
        // A segment is rendered by the endpoint that owns its speaker's voice (falling back to the
        // Narrator's). Long text is split into `parts` requests against that endpoint's limit.
        const waiting = new Set<string>();
        for (const target of targets("queued")) {
          const next = target.s;
          const slot = target.slot;
          const queued = clipOf(target);
          const route = this.effectiveVoice(bookId, next.speaker);
          const ep = route.endpoint;
          // A paused endpoint *holds* its work — the clip stays queued until it is resumed or the
          // job is cancelled. That is what separates Pause from Cancel. Everything else below is a
          // configuration error the run should report rather than wait on.
          if (ep && !ep.enabled) {
            waiting.add(`${ep.name} is paused`);
            continue;
          }
          if (!ep || (ep.needsKey && !keyring.has(ep.id))) {
            next[slot] = {
              status: "failed",
              endpoint: ep?.id ?? null,
              ms: 0,
              duration: 0,
              ...(queued.n ? { n: queued.n } : {}),
              ...(queued.takes?.length ? { takes: queued.takes } : {}),
              error: {
                code: 0,
                message: !route.ref
                  ? "no voice for speaker"
                  : !ep
                    ? `voice ${route.ref} no longer exists`
                    : `${ep.name} has no API key`,
                body: "",
              },
            };
            logJob(job, `Segment ${next.id}: ${next[slot]!.error!.message}`, "error", {
              segment: next.id,
              target: slot,
            });
            continue;
          }
          if (ep.backoffUntil > Date.now()) {
            waiting.add(`${ep.name}: rate-limit cooldown`);
            continue;
          }
          const active = targets("generating").filter((t) => clipOf(t).endpoint === ep.id).length;
          if (active >= ep.concurrency) {
            waiting.add(`${ep.name}: concurrency full (${ep.concurrency})`);
            continue;
          }
          // the dictionary is applied here, on the way out: the script itself keeps the author's spelling
          const said = this.spoken(bookId, next.text);
          const sent = said.text;
          const cuts = splitText(sent, ep.maxChars, ep.splitAt);
          const parts = cuts.length;
          const attemptKey = `${next.id}:${slot}`;
          const attempt = (attempts.get(attemptKey) ?? 0) + 1;
          attempts.set(attemptKey, attempt);
          const diagnostic = {
            segment: next.id,
            target: slot,
            attempt,
            endpoint: ep.name,
            model: ep.model,
            parts,
            characters: sent.length,
          };
          logJob(
            job,
            `Segment ${next.id}${slot === "candidate" ? " retake" : ""} started`,
            "info",
            diagnostic,
          );
          const who = (this.characters[bookId] ?? []).find((x) => x.name === next.speaker);
          next[slot] = {
            status: "generating",
            endpoint: ep.id,
            ms: 0,
            duration: 0,
            startedAt: Date.now(),
            // the take number and the history of this clip survive the render
            ...(queued.takes?.length ? { takes: queued.takes } : {}),
            ...(queued.n ? { n: queued.n } : {}),
            parts,
            cuts:
              parts > 1
                ? cuts.map((c) => ({ from: c.from, to: c.to, at: c.at, fallback: c.fallback }))
                : undefined,
            splitAt: ep.splitAt,
            // audit trail: exactly what this clip was rendered with, so later edits can be compared against it
            voiceRef: route.ref ?? undefined,
            voice: route.voice ?? undefined,
            model: ep.model,
            direction: next.direction,
            style: who?.style ?? "",
            type: next.type,
            text: next.text,
            ...(said.hits.length ? { said: sent, lex: said.hits.length } : {}),
            at: Date.now(),
            cost: (sent.length / 1e6) * ep.price,
          };
          const dur = ep.latency * rnd(0.5, 1.1) * parts + sent.length * 6;
          setTimeout(() => {
            const clip = next[slot];
            if (!clip) {
              logJob(
                job,
                `Segment ${next.id} result discarded; retake was removed`,
                "warning",
                diagnostic,
              );
              return;
            }
            if (Math.random() < 0.03) {
              // rate limited → back off, put the segment back
              const cooldown = ep.cooldownSec ?? 8;
              ep.backoffUntil = Date.now() + cooldown * 1000;
              ep.rateLimits = (ep.rateLimits ?? 0) + 1;
              ep.lastError = {
                code: 429,
                message: "rate limited",
                body: `{"error":{"message":"Rate limit reached. Please retry after ${cooldown} seconds.","type":"rate_limit_error"}}`,
                retryAfter: cooldown,
                at: Date.now(),
              };
              logJob(job, `Segment ${next.id} rate limited; retry after ${cooldown}s`, "warning", {
                ...diagnostic,
                code: 429,
              });
              next[slot] = requeue(clip);
              return;
            }
            const fail = Math.random() < ep.failRate;
            clip.ms = Math.round(dur);
            clip.duration = fail ? 0 : sent.split(" ").length / 2.6;
            // the script can move while a request is in flight — a clip that no longer matches what
            // the line says now arrives stale, not done
            clip.status = fail
              ? "failed"
              : this.clipDrift(bookId, next, clip).length
                ? "stale"
                : "done";
            if (!fail && clip.status === "stale" && slot === "audio")
              this._markStale(bookId, c.id, next);
            if (fail) {
              const e = ERRORS[Math.floor(Math.random() * ERRORS.length)];
              clip.error = {
                ...e,
                part: parts > 1 ? 1 + Math.floor(Math.random() * parts) : undefined,
                at: Date.now(),
              };
              ep.lastError = { ...clip.error };
            }
            ep.history = [
              ...(ep.history ?? []),
              { t: Date.now(), ms: Math.round(dur), ok: !fail },
            ].slice(-40);
            if (fail) ep.failures = (ep.failures ?? 0) + 1;
            logJob(
              job,
              `Segment ${next.id} ${fail ? "failed" : clip.status === "stale" ? "completed with outdated audio" : "completed"}`,
              fail ? "error" : clip.status === "stale" ? "warning" : "info",
              {
                ...diagnostic,
                responseMs: clip.ms,
                audioSeconds: clip.duration,
                ...(clip.error ? { code: clip.error.code, error: clip.error.message } : {}),
              },
            );
          }, dur);
        }
        jobWaiting(job, [...waiting].sort().join("; "));
        const pending = targets("queued", "generating");
        const finished = segs.length - pending.filter((t) => t.slot === "audio").length;
        c.narrationProgress = Math.round((finished / segs.length) * 100);
        job.progress = c.narrationProgress;
        // Pausing an endpoint holds its queued clips rather than failing them: that is the whole
        // difference between Pause and Cancel. The run stays open, waiting, until the endpoint is
        // resumed or the job is cancelled.
        const held = targets("queued").some((t) => {
          const ep = this.effectiveVoice(bookId, t.s.speaker).endpoint;
          return !!ep && !ep.enabled;
        });
        // stalled: nothing in flight and no queued clip can ever be placed — the voice or its
        // endpoint is gone, not merely paused
        const stalled =
          !held &&
          !targets("generating").length &&
          !targets("queued").some(
            (t) => this.effectiveVoice(bookId, t.s.speaker).endpoint?.enabled,
          );
        if (pending.length === 0 || stalled) {
          for (const t of targets("queued")) {
            t.s[t.slot] = {
              ...clipOf(t),
              status: "failed",
              error: { code: 0, message: "no endpoint available for this voice", body: "" },
            };
            logJob(job, `Segment ${t.s.id} failed: no endpoint available for this voice`, "error", {
              segment: t.s.id,
              target: t.slot,
            });
          }
          // a retake that failed is the listener's to discard: only the book's own clips decide
          // whether this chapter is finished. A clip the script moved under while it rendered came
          // back stale — that is not a failed run, it is one more line to render again.
          const failed = segs.some((s) => !["done", "stale"].includes(s.audio.status));
          const stale = segs.some((s) => s.audio.status === "stale");
          c.narration = failed ? "failed" : stale ? "stale" : "done";
          this._retime(bookId, c.id);
          this._finish(job, failed ? "failed" : "done");
          done();
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    },

    // ---------- export ----------
    // An export is identified by its filename. Building again with the same filename replaces the
    // previous audiobook (version bump, old entry kept as 'replaced'). With splitPerVolume, one
    // file is built per volume, each carrying volume metadata.
    buildExport(bookId: string, ids: number[], meta: ExportMeta): ExportItem[] {
      if (this._blocked(bookId, "build")) return [];
      const book = this.bookById(bookId);
      if (!book) return [];
      const chs = this.chapters[bookId].filter((c) => ids.includes(c.id));
      if (!chs.length) return [];
      const groups: ExportGroup[] = meta.splitPerVolume
        ? book.volumes
            .map((v, i) => ({
              vol: v,
              index: i + 1,
              chapters: chs.filter((c) => c.volumeId === v.id),
            }))
            .filter((g) => g.chapters.length)
        : [{ vol: null, index: 0, chapters: chs }];
      return groups.map((g) => this._buildOne(bookId, g, meta));
    },
    exportFilename(meta: ExportMeta, vol: Volume | null): string {
      const base = (meta.filename || meta.title || "audiobook").replace(/\.m4b$/i, "");
      return vol ? `${base} - ${vol.name.split("·")[0].trim()}.m4b` : `${base}.m4b`;
    },
    _buildOne(bookId: string, g: ExportGroup, meta: ExportMeta): ExportItem {
      const book = this.bookById(bookId)!;
      const filename = this.exportFilename(meta, g.vol);
      const prev = this.exports.find(
        (e) => e.bookId === bookId && e.filename === filename && e.status === "done",
      );
      const job = this.addJob("export", bookId, `Build ${filename}`);
      this.exports.unshift({
        id: Date.now() + Math.random(),
        bookId,
        filename,
        title: g.vol ? `${meta.title} · ${g.vol.name.split("·")[0].trim()}` : meta.title,
        series: meta.series,
        volume: g.vol
          ? ({ number: g.index, name: g.vol.name, of: book.volumes.length } satisfies ExportVolume)
          : null,
        author: meta.author,
        narrator: meta.narrator,
        year: meta.year,
        description: meta.description,
        chapterIds: g.chapters.map((c) => c.id),
        chapters: g.chapters.length,
        markers: meta.markers === false ? 0 : g.chapters.length,
        customCover: !!meta.cover,
        duration: g.chapters.reduce((a, c) => a + c.duration, 0),
        bitrate: meta.bitrate,
        size: 0,
        createdAt: new Date().toISOString().slice(0, 16).replace("T", " "),
        version: prev ? prev.version + 1 : 1,
        replaces: prev?.id ?? null,
        status: "building",
        progress: 0,
      });
      const entry = this.exports[0];
      startJob(job);
      logJob(job, "Export build started", "info", {
        filename,
        chapters: g.chapters.length,
        bitrateKbps: meta.bitrate,
      });
      let milestone = 0;
      const t = setInterval(() => {
        if (job.cancelled) {
          clearInterval(t);
          this.exports = this.exports.filter((e) => e !== entry);
          this._finish(job, "cancelled");
          return;
        }
        entry.progress = Math.min(100, (entry.progress ?? 0) + rnd(3, 9));
        job.progress = entry.progress;
        const reached = Math.floor(entry.progress / 25) * 25;
        if (reached > milestone && reached < 100) {
          milestone = reached;
          logJob(job, `Export ${reached}% complete`);
        }
        if (entry.progress >= 100) {
          clearInterval(t);
          entry.status = "done";
          entry.size = Math.round(((entry.duration * meta.bitrate) / 8 / 1024) * 1.04);
          if (prev) prev.status = "replaced";
          logJob(job, "Export ready", "info", {
            filename,
            sizeMB: entry.size,
            audioSeconds: entry.duration,
          });
          this._finish(job, "done");
        }
      }, 180);
      return entry;
    },
    deleteExport(id: number): void {
      const i = this.exports.findIndex((e) => e.id === id);
      if (i < 0) return;
      const e = this.exports[i];
      this.exports.splice(i, 1);
      this.toast(`Deleted ${e.filename} v${e.version}`, {
        undo: () => this.exports.splice(Math.min(i, this.exports.length), 0, e),
      });
    },
    // narrated chapters that a finished export doesn't contain yet (new volume arrived, more chapters narrated)
    newSince(exp: ExportItem): number[] {
      const narrated = this.chaptersOf(exp.bookId)
        .filter(isNarrated)
        .map((c) => c.id);
      const scope = exp.volume
        ? this.chaptersOf(exp.bookId)
            .filter(
              (c) =>
                isNarrated(c) &&
                this.bookById(exp.bookId)?.volumes[exp.volume!.number - 1]?.id === c.volumeId,
            )
            .map((c) => c.id)
        : narrated;
      return scope.filter((id) => !exp.chapterIds.includes(id));
    },
  },
});
