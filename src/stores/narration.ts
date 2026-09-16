import type { ExpressionPlan } from "@/lib/expressions";
// Narration, expression preflight and retakes. Accepted audio stays on the script segments.
import {
  annotationFrom,
  expressionParts,
  expressionPlan,
  expressionSupport,
} from "@/lib/expressions";
import { jobWaiting } from "@/lib/jobActivity";
import { isScripted } from "@/lib/scriptReview";
import { partsFor } from "@/lib/split";
import { requeue, snapshotTake } from "@/lib/takes";
import { clone } from "@/lib/utils";
import type { NarrationSimContext } from "@/mock";
import { dispatchNarration } from "@/mock";
import type {
  Chapter,
  EndpointEstimate,
  ExpressionAnnotation,
  ExpressionTag,
  FlagKind,
  Job,
  NarrationEstimate,
  Segment,
  SegmentAudio,
  SegmentFlag,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "./cast";
import { useDemoStore } from "./demo";
import { useEndpointsStore } from "./endpoints";
import { useJobsStore } from "./jobs";
import { useLibraryStore } from "./library";
import { useScriptsStore } from "./scripts";
import { useUiStore } from "./ui";
interface NarrationState {
  expressionReview: {
    bookId: string;
    targets: { chId: number; segId: number }[];
    resume: () => void;
  } | null;
}
export const useNarrationStore = defineStore("narration", {
  state: (): NarrationState => ({ expressionReview: null }),
  getters: {
    expressionRender(): (bookId: string, segment: Segment) => ExpressionPlan {
      const castStore = useCastStore();

      return (bookId: string, segment: Segment) =>
        expressionPlan(
          segment,
          castStore.effectiveVoice(bookId, segment.speaker).endpoint,
          castStore.lexiconOf(bookId),
        );
    },
    expressionIssues(): (
      bookId: string,
      ids: number[],
    ) => {
      chId: number;
      segId: number;
      speaker: string;
      annotationId: number;
      label: string;
      reason: string;
    }[] {
      const scriptsStore = useScriptsStore();

      return (bookId: string, ids: number[]) =>
        ids.flatMap((chId) =>
          scriptsStore.segmentsOf(bookId, chId).flatMap((s) =>
            this.expressionRender(bookId, s).issues.map((issue) => ({
              ...issue,
              chId,
              segId: s.id,
              speaker: s.speaker,
            })),
          ),
        );
    },
    // speakers whose voice can't be rendered right now: voice/endpoint gone, endpoint paused, key missing
    /** Everything a clip was rendered with that the script no longer says — empty means "still current".
     *  One definition, so the ledger's amber line, a rejected retake and a finished render agree. */
    clipDrift(): (bookId: string, s: Segment, a?: SegmentAudio) => string[] {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();

      return (bookId, s, a = s.audio) => {
        if (!a.at) return [];
        const out: string[] = [];
        if (a.text != null && a.text !== s.text)
          out.push(
            a.text.length === s.text.length
              ? "text: edited"
              : `text: ${a.text.length} → ${s.text.length} chars`,
          );
        const sent = a.pronounced ?? a.said ?? a.text;
        // the words themselves are unchanged but the dictionary now sends different ones
        if (a.text === s.text && sent != null && castStore.spoken(bookId, s.text).text !== sent)
          out.push("pronunciation: the dictionary changed after this clip");
        if ((a.expressionSignature ?? "") !== this.expressionRender(bookId, s).signature)
          out.push("expressions: tags, position, or model support changed after this clip");
        if ((a.direction || "") !== (s.direction || ""))
          out.push(`direction: “${a.direction || "—"}” → “${s.direction || "—"}”`);
        if (a.type && a.type !== s.type) out.push(`type: ${a.type} → ${s.type}`);
        const now = castStore.effectiveVoice(bookId, s.speaker);
        if (a.voiceRef && now.ref !== a.voiceRef)
          out.push(
            `voice: ${endpointsStore.voiceLabel(a.voiceRef)} → ${endpointsStore.voiceLabel(now.ref) || "unset"}`,
          );
        const who = castStore.charactersOf(bookId).find((c) => c.name === s.speaker);
        if ((a.style ?? "") !== (who?.style ?? ""))
          out.push(`style: “${a.style || "—"}” → “${who?.style || "—"}”`);
        return out;
      };
    },
    // Cost and load are per endpoint: each segment goes to the endpoint that owns its speaker's voice,
    // and a segment longer than that endpoint's limit becomes several requests.
    estimate(): (bookId: string, ids: number[]) => NarrationEstimate {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();
      const scriptsStore = useScriptsStore();

      return (bookId, ids) => {
        const per: Record<string, EndpointEstimate> = {};
        let chars = 0;
        let segments = 0;
        let unrouted = 0;
        let stale = 0;
        for (const id of ids)
          for (const seg of scriptsStore.segments[`${bookId}:${id}`] ?? []) {
            chars += seg.text.length;
            segments++;
            if (seg.audio.status === "stale") stale++;
            const ep = castStore.effectiveVoice(bookId, seg.speaker).endpoint;
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
            const render = this.expressionRender(bookId, seg);
            const parts = render.issues.length
              ? partsFor(render.text, ep)
              : expressionParts(render, ep).length;
            e.chars += render.text.length;
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
          endpoints: endpointsStore.endpoints.filter((e) => e.enabled).length,
          per: rows,
        };
      };
    },
  },
  actions: {
    // ---------- model-specific narration expressions ----------
    refreshExpressionAudio(): void {
      const scriptsStore = useScriptsStore();

      for (const [k, segs] of Object.entries(scriptsStore.segments)) {
        const [bookId, ch] = k.split(":");
        for (const s of segs)
          if (s.expressions?.length && this.clipDrift(bookId, s).length)
            scriptsStore._markStale(bookId, Number(ch), s);
      }
    },
    addExpression(
      bookId: string,
      chId: number,
      segId: number,
      tag: ExpressionTag,
      at: number,
    ): void {
      const castStore = useCastStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((s) => s.id === segId);
      if (!s) return;
      const ep = castStore.effectiveVoice(bookId, s.speaker).endpoint;
      const definition = ep?.expressions?.tags.find((t) => t.id === tag.id);
      if (
        expressionSupport(ep) !== "supported" ||
        !definition ||
        !Number.isInteger(at) ||
        at < 0 ||
        at > s.text.length
      )
        return;
      const undo = scriptsStore._segSnapshot(bookId, chId);
      (s.expressions ??= []).push(
        annotationFrom(
          definition,
          at,
          Math.max(0, ...s.expressions!.map((a) => a.annotationId)) + 1,
        ),
      );
      s.edited = true;
      scriptsStore._markStale(bookId, chId, s);
      uiStore.toast(`${definition.label} added`, {
        description: "The source text is unchanged. Re-render this line to hear the expression.",
        undo,
      });
    },
    updateExpression(
      bookId: string,
      chId: number,
      segId: number,
      annotationId: number,
      patch: Partial<ExpressionAnnotation> | null,
    ): void {
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((s) => s.id === segId);
      const a = s?.expressions?.find((a) => a.annotationId === annotationId);
      if (!s || !a) return;
      const undo = scriptsStore._segSnapshot(bookId, chId);
      if (patch) Object.assign(a, patch, { annotationId });
      else s.expressions = s.expressions!.filter((a) => a.annotationId !== annotationId);
      s.edited = true;
      scriptsStore._markStale(bookId, chId, s);
      uiStore.toast(patch ? "Expression updated" : "Expression removed", { undo });
    },
    _expressionGuard(
      bookId: string,
      targets: {
        chId: number;
        segId: number;
      }[],
      resume: () => void,
    ): boolean {
      const scriptsStore = useScriptsStore();

      const blocked = targets.some((t) => {
        const s = scriptsStore.segmentsOf(bookId, t.chId).find((s) => s.id === t.segId);
        return s && this.expressionRender(bookId, s).issues.length;
      });
      if (blocked) this.expressionReview = { bookId, targets, resume };
      return blocked;
    },
    continueExpressionReview(): void {
      const pending = this.expressionReview;
      if (!pending) return;
      this.expressionReview = null;
      pending.resume(); // rechecks current annotations, routing and launch prerequisites
    },
    omitReviewExpressions(): void {
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const pending = this.expressionReview;
      if (!pending) return;
      const undos = [...new Set(pending.targets.map((t) => t.chId))].map((chId) =>
        scriptsStore._segSnapshot(pending.bookId, chId),
      );
      let count = 0;
      for (const t of pending.targets) {
        const s = scriptsStore.segmentsOf(pending.bookId, t.chId).find((s) => s.id === t.segId);
        if (!s) continue;
        const issues = this.expressionRender(pending.bookId, s).issues;
        for (const issue of issues) {
          s.expressions!.find((a) => a.annotationId === issue.annotationId)!.omitted = true;
          count++;
        }
        if (issues.length) {
          s.edited = true;
          scriptsStore._markStale(pending.bookId, t.chId, s);
        }
      }
      uiStore.toast(`${count} expressions omitted from narration`, {
        description: "Annotations stay in the script until you enable them again.",
        undo: () => undos.forEach((undo) => undo()),
      });
    },
    // "changed" is both edited-after-narration lines and halves of a hand-split segment that were
    // never rendered at all — in a chapter that has audio, neither belongs in the finished book.
    renarrateStale(bookId: string, chId: number): void {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      const started = libraryStore.chapter(bookId, chId)?.narration !== "none";
      if (
        this._expressionGuard(
          bookId,
          scriptsStore
            .segmentsOf(bookId, chId)
            .filter((s) => s.audio.status === "stale" || (started && s.audio.status === "none"))
            .map((s) => ({ chId, segId: s.id })),
          () => this.renarrateStale(bookId, chId),
        )
      )
        return;
      for (const s of scriptsStore.segmentsOf(bookId, chId))
        if (s.audio.status === "stale" || (started && s.audio.status === "none"))
          s.audio = requeue(s.audio);
      this._resume(bookId, chId);
    },
    // ---------- narration ----------
    runNarration(bookId: string, ids: number[]): void {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      if (libraryStore._blocked(bookId, "narrate")) return;
      const chs = libraryStore.chapters[bookId].filter(
        (c) =>
          ids.includes(c.id) &&
          !c.excluded &&
          isScripted(c) &&
          !["running", "queued"].includes(c.narration),
      );
      if (
        this._expressionGuard(
          bookId,
          chs.flatMap((c) =>
            scriptsStore.segmentsOf(bookId, c.id).map((s) => ({ chId: c.id, segId: s.id })),
          ),
          () => this.runNarration(bookId, ids),
        )
      )
        return;
      const jobs = chs.map((c) => {
        c.narration = "queued";
        c.narrationProgress = 0;
        const job = jobsStore.addJob("narration", bookId, `Narrate · ch ${c.id}`, c.id);
        jobWaiting(job, "Chapter has not been dispatched yet");
        return job;
      });
      jobsStore._sequential(jobs, (job, done) => {
        const c = libraryStore.chapter(bookId, job.chapterId!)!;
        for (const s of scriptsStore.segmentsOf(bookId, c.id)) {
          delete s.candidate; // the whole chapter is being rendered again; a pending retake is moot
          s.audio = requeue(s.audio);
        }
        this._dispatch(bookId, c, job, done);
      });
    },
    retrySegment(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      if (
        this._expressionGuard(bookId, [{ chId, segId }], () =>
          this.retrySegment(bookId, chId, segId),
        )
      )
        return;
      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s) s.audio = requeue(s.audio);
      this._resume(bookId, chId);
    },
    retryFailed(bookId: string, chId: number): void {
      const scriptsStore = useScriptsStore();

      if (
        this._expressionGuard(
          bookId,
          scriptsStore
            .segmentsOf(bookId, chId)
            .filter((s) => s.audio.status === "failed")
            .map((s) => ({ chId, segId: s.id })),
          () => this.retryFailed(bookId, chId),
        )
      )
        return;
      for (const s of scriptsStore.segmentsOf(bookId, chId))
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
      const scriptsStore = useScriptsStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s) s.flag = { kind, note: note.trim(), at: Date.now() } satisfies SegmentFlag;
    },
    clearFlag(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s?.flag) delete s.flag;
    },
    /** Queue another render of one segment, keeping the current clip to compare against. */
    retakeSegment(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      if (
        this._expressionGuard(bookId, [{ chId, segId }], () =>
          this.retakeSegment(bookId, chId, segId),
        )
      )
        return;
      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s || !this._queueRetake(s)) return;
      this._resume(bookId, chId, "Retake");
    },
    /** Every flagged segment in the chapter gets another take in one run. */
    retakeFlagged(bookId: string, chId: number): number {
      const scriptsStore = useScriptsStore();

      if (
        this._expressionGuard(
          bookId,
          scriptsStore
            .segmentsOf(bookId, chId)
            .filter((s) => s.flag)
            .map((s) => ({ chId, segId: s.id })),
          () => this.retakeFlagged(bookId, chId),
        )
      )
        return 0;
      let n = 0;
      for (const s of scriptsStore.segmentsOf(bookId, chId))
        if (s.flag && this._queueRetake(s)) n++;
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
      const castStore = useCastStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      const cand = s?.candidate;
      if (!s || !cand || cand.duration <= 0) return;
      const before = { audio: clone(s.audio), candidate: clone(cand), flag: s.flag };
      const takes = [...(s.audio.takes ?? [])];
      if (s.audio.duration > 0) takes.push(snapshotTake(s.audio));
      s.audio = { ...cand, ...(takes.length ? { takes } : {}) };
      delete s.candidate;
      delete s.flag;
      castStore._retime(bookId, chId);
      uiStore.toast(`Take ${s.audio.n ?? 1} kept`, {
        kind: "success",
        description: "It is the clip in the book now; the earlier take stays in the take list.",
        undo: () => {
          s.audio = before.audio;
          s.candidate = before.candidate;
          if (before.flag) s.flag = before.flag;
          castStore._retime(bookId, chId);
        },
      });
    },
    /** Drop the new take. The clip in the book never moved, so only the take list changes. */
    rejectTake(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
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
      if (s.audio.status === "stale") scriptsStore._markStale(bookId, chId, s);
      uiStore.toast(cand.duration > 0 ? `Take ${s.audio.n ?? 1} kept` : "Retake discarded", {
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
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();

      const c = libraryStore.chapter(bookId, chId);
      if (!c || c.narration === "running") return;
      const job = jobsStore.addJob("narration", bookId, `${label} · ch ${c.id}`, c.id);
      this._dispatch(bookId, c, job, () => {});
    },
    _dispatch(bookId: string, c: Chapter, job: Job, done: () => void): void {
      dispatchNarration(this._narrationSim(), bookId, c, job, done);
    },
    // ---------- what the simulators are allowed to reach ----------
    // The mock runs in `src/mock/simulators` fake an endpoint, not the application. Each one is
    // handed exactly the slice of the store it needs, so a timer loop can never quietly acquire a
    // dependency on the rest of it — and the store stays the only place reactive state is defined.
    _narrationSim(): NarrationSimContext {
      const castStore = useCastStore();
      const demoStore = useDemoStore();
      const jobsStore = useJobsStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      // the generation of the demo world this run belongs to, taken as it is dispatched
      const epoch = demoStore._epoch;
      return {
        stale: () => demoStore.isStale(epoch),
        segmentsOf: (bookId, chId) => scriptsStore.segmentsOf(bookId, chId),
        charactersOf: (bookId) => castStore.charactersOf(bookId),
        effectiveVoice: (bookId, speaker) => castStore.effectiveVoice(bookId, speaker),
        expressionRender: (bookId, segment) => this.expressionRender(bookId, segment),
        clipDrift: (bookId, segment, audio) => this.clipDrift(bookId, segment, audio),
        markStale: (bookId, chId, segment) => scriptsStore._markStale(bookId, chId, segment),
        retime: (bookId, chId) => castStore._retime(bookId, chId),
        finishJob: (job, status) => jobsStore._finish(job, status),
        toast: (msg, opts) => uiStore.toast(msg, opts),
      };
    },
  },
});
