import type { ExpressionPlan } from "@/lib/expressions";
// Narration, expression preflight and retakes. Accepted audio stays on the script segments.
import {
  annotationFrom,
  expressionParts,
  expressionPlan,
  expressionSupport,
} from "@/lib/expressions";
import { jobWaiting, logJob } from "@/lib/jobActivity";
import {
  chapterNarration,
  narrationPlan,
  narrationTargets,
  runActionLabel,
  SCOPE_LABEL,
  skipSummary,
} from "@/lib/runPlan";
import { isScripted } from "@/lib/scriptReview";
import { partsFor } from "@/lib/split";
import { nextTakeNumber, requeue, snapshotTake } from "@/lib/takes";
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
  NarrationScope,
  RunPlan,
  Segment,
  SegmentAudio,
  SegmentFlag,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useDemoStore } from "@/stores/demo";
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
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
    /** How many endpoint requests one line becomes, after expressions and the endpoint's limit. */
    requestsFor(): (bookId: string, seg: Segment) => number {
      const castStore = useCastStore();

      return (bookId, seg) => {
        const ep = castStore.effectiveVoice(bookId, seg.speaker).endpoint;
        if (!ep) return 0;
        const render = this.expressionRender(bookId, seg);
        return render.issues.length
          ? partsFor(render.text, ep)
          : expressionParts(render, ep).length;
      };
    },
    /**
     * What running this selection at this scope would do, chapter by chapter, with the reasons a
     * selected chapter is left out. The picker's summary, the button's label, the estimate and the
     * work `runNarration` queues are all this one calculation.
     */
    narrationRunPlan(): (
      bookId: string,
      ids: number[],
      scope?: NarrationScope,
      keepPending?: boolean,
    ) => RunPlan {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return (bookId, ids, scope = "all", keepPending = true) =>
        narrationPlan(
          libraryStore.chaptersOf(bookId).filter((c) => ids.includes(c.id)),
          scope,
          {
            segmentsOf: (chId) => scriptsStore.segmentsOf(bookId, chId),
            requestsOf: (s) => this.requestsFor(bookId, s),
            keepPending,
          },
        );
    },
    // Cost and load are per endpoint: each segment goes to the endpoint that owns its speaker's voice,
    // and a segment longer than that endpoint's limit becomes several requests.
    //
    // The estimate counts the lines the *chosen scope* would send, not every line in the chapter:
    // "retry failed clips" over a finished book is a handful of requests, and saying otherwise is
    // the difference between an estimate and a number.
    estimate(): (
      bookId: string,
      ids: number[],
      scope?: NarrationScope,
      keepPending?: boolean,
    ) => NarrationEstimate {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return (bookId, ids, scope = "all", keepPending = true) => {
        const per: Record<string, EndpointEstimate> = {};
        let chars = 0;
        let segments = 0;
        let unrouted = 0;
        let stale = 0;
        let replacing = 0;
        let pending = 0;
        let chapters = 0;
        for (const id of ids) {
          const c = libraryStore.chapter(bookId, id);
          if (!c || c.excluded || !isScripted(c) || ["running", "queued"].includes(c.narration))
            continue;
          const targets = narrationTargets(
            scriptsStore.segments[`${bookId}:${id}`] ?? [],
            scope,
            keepPending,
          );
          pending += targets.pending.length;
          if (!targets.run.length) continue;
          chapters++;
          for (const seg of targets.run) {
            chars += seg.text.length;
            segments++;
            if (seg.audio.status === "stale") stale++;
            if (seg.audio.duration > 0) replacing++;
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
        }
        const rows = Object.values(per);
        const cost = rows.reduce((a, e) => a + (e.chars / 1e6) * e.endpoint.price, 0);
        return {
          chapters,
          chars,
          segments,
          seconds: chars / 15.5,
          cost,
          stale,
          replacing,
          pending,
          scope,
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
      const historyStore = useHistoryStore();
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
      const undo = scriptsStore._editSnapshot(bookId, chId);
      historyStore.noteEdit(bookId, chId); // an annotation is script, not audio
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
      const historyStore = useHistoryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((s) => s.id === segId);
      const a = s?.expressions?.find((a) => a.annotationId === annotationId);
      if (!s || !a) return;
      // dragging a tag back where it already was is not an edit: it must not open a history entry,
      // and it must not make a clip that still matches the script look stale
      if (
        patch &&
        (Object.keys(patch) as (keyof ExpressionAnnotation)[]).every((k) => a[k] === patch[k])
      )
        return;
      const undo = scriptsStore._editSnapshot(bookId, chId);
      historyStore.noteEdit(bookId, chId);
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
      const historyStore = useHistoryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const pending = this.expressionReview;
      if (!pending) return;
      // what would actually be omitted, worked out before anything is touched: a chapter whose
      // annotations all render cleanly is not edited, so it neither goes stale nor gains an entry
      const work = pending.targets.flatMap((t) => {
        const s = scriptsStore.segmentsOf(pending.bookId, t.chId).find((s) => s.id === t.segId);
        const issues = s ? this.expressionRender(pending.bookId, s).issues : [];
        return issues.length ? [{ chId: t.chId, segment: s!, issues }] : [];
      });
      const chapters = [...new Set(work.map((w) => w.chId))];
      const undos = chapters.map((chId) => scriptsStore._editSnapshot(pending.bookId, chId));
      for (const chId of chapters) historyStore.noteEdit(pending.bookId, chId);
      let count = 0;
      for (const w of work) {
        for (const issue of w.issues) {
          w.segment.expressions!.find((a) => a.annotationId === issue.annotationId)!.omitted = true;
          count++;
        }
        w.segment.edited = true;
        scriptsStore._markStale(pending.bookId, w.chId, w.segment);
      }
      uiStore.toast(`${count} expressions omitted from narration`, {
        description: "Annotations stay in the script until you enable them again.",
        undo: count ? () => undos.forEach((undo) => undo()) : undefined,
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
          // a stale clip is still playable; its replacement renders beside it and takes over only
          // when it lands, so the chapter never loses audio it had
          this._queueRender(s);
      this._resume(bookId, chId);
    },
    // ---------- narration ----------
    /**
     * Narrate (or re-narrate) the given chapters.
     *
     * `scope` is what the run was asked to do — fill the gaps and refresh what the script has moved
     * past, retry only what failed, or render everything again — and it decides which lines are
     * queued, what the estimate counted and what the queue reports. Nothing usable is thrown away
     * to make room: a line that already has a playable clip renders its replacement *beside* it,
     * exactly as a retake does, and the clip in the book keeps playing, timing the chapter and
     * going into the export until the replacement actually lands. A bulk run accepts its own
     * replacements rather than asking for a verdict on each one; the clip it displaces joins the
     * take list, and a replacement that fails changes nothing at all.
     *
     * A retake somebody asked for and has not judged is left alone unless `keepPending` is turned
     * off — it is a comparison in progress, not spare capacity.
     */
    runNarration(
      bookId: string,
      ids: number[],
      {
        scope = "all",
        keepPending = true,
        quiet = false,
      }: { scope?: NarrationScope; keepPending?: boolean; quiet?: boolean } = {},
    ): void {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      if (libraryStore._blocked(bookId, "narrate")) return;
      const plan = this.narrationRunPlan(bookId, ids, scope, keepPending);
      const chs = plan.chapters
        .map((p) => libraryStore.chapter(bookId, p.id))
        .filter((c): c is Chapter => !!c);
      // only the lines this run would actually send have to render cleanly; a scope that leaves a
      // chapter's expressions alone should not stop the run to ask about them
      if (
        this._expressionGuard(
          bookId,
          chs.flatMap((c) =>
            narrationTargets(scriptsStore.segmentsOf(bookId, c.id), scope, keepPending).run.map(
              (s) => ({ chId: c.id, segId: s.id }),
            ),
          ),
          () => this.runNarration(bookId, ids, { scope, keepPending, quiet }),
        )
      )
        return;
      if (!chs.length) {
        if (!quiet && ids.length)
          uiStore.toast("Nothing to narrate in this selection", {
            kind: "info",
            description: skipSummary(plan) || `No line is ${SCOPE_LABEL[scope].toLowerCase()}.`,
          });
        return;
      }
      const runId = jobsStore._nextRunId();
      const op = runActionLabel(plan);
      const jobs = chs.map((c, i) => {
        const row = plan.chapters[i];
        c.narration = "queued";
        c.narrationProgress = 0;
        const job = jobsStore.addJob(
          "narration",
          bookId,
          `${row.replacing ? "Re-narrate" : "Narrate"} · ch ${c.id}`,
          c.id,
        );
        job.bulk = { id: runId, op, index: i + 1, total: chs.length, scope: SCOPE_LABEL[scope] };
        logJob(job, "Narration scope chosen", "info", {
          scope: SCOPE_LABEL[scope],
          clips: row.clips,
          requests: row.requests,
          replacing: row.replacing,
          ...(row.pending
            ? { [keepPending ? "retakesLeftAlone" : "retakesReplaced"]: row.pending }
            : {}),
        });
        jobWaiting(job, "Chapter has not been dispatched yet");
        return job;
      });
      if (!quiet)
        uiStore.toast(`${op} · ${SCOPE_LABEL[scope]}`, {
          kind: "info",
          description:
            `${plan.clips} clip${plan.clips === 1 ? "" : "s"} in ${chs.length} chapter${chs.length === 1 ? "" : "s"} · ` +
            `${plan.requests} request${plan.requests === 1 ? "" : "s"} · ~$${this.estimate(bookId, ids, scope, keepPending).cost.toFixed(2)}. ` +
            (plan.replacing
              ? `${plan.replacing} clip${plan.replacing === 1 ? " keeps" : "s keep"} playing until the replacement lands. `
              : "") +
            (plan.pending
              ? keepPending
                ? `${plan.pending} line${plan.pending === 1 ? "" : "s"} with a retake waiting ${plan.pending === 1 ? "was" : "were"} left alone. `
                : `${plan.pending} retake${plan.pending === 1 ? "" : "s"} waiting for a verdict ${plan.pending === 1 ? "joins" : "join"} the take list and ${plan.pending === 1 ? "is" : "are"} rendered again. `
              : "") +
            skipSummary(plan),
          timeout: 10000,
        });
      jobsStore._sequential(jobs, (job, done) => {
        const c = libraryStore.chapter(bookId, job.chapterId!)!;
        // worked out again here rather than reused from the plan: a chapter waiting behind five
        // others may have been edited, retaken or narrated by hand while it waited
        const { run, pending } = narrationTargets(
          scriptsStore.segmentsOf(bookId, c.id),
          scope,
          keepPending,
        );
        let replacing = 0;
        for (const s of run) if (this._queueRender(s) === "replace") replacing++;
        const queued = run.length;
        logJob(job, "Narration plan prepared", "info", {
          scope: SCOPE_LABEL[scope],
          clips: queued,
          replacing,
          segments: scriptsStore.segmentsOf(bookId, c.id).length,
          ...(pending.length
            ? { [keepPending ? "retakesLeftAlone" : "retakesReplaced"]: pending.length }
            : {}),
        });
        if (!queued) {
          logJob(job, "Nothing to render for this scope; the chapter is unchanged", "info");
          c.narration = chapterNarration(scriptsStore.segmentsOf(bookId, c.id));
          jobsStore._finish(job, "done");
          return done();
        }
        this._dispatch(bookId, c, job, done);
      });
    },
    /**
     * Put one line in the queue. A line with a playable clip renders its replacement beside it, so
     * nothing usable is lost before the new request succeeds; a line with nothing worth keeping —
     * never rendered, or its last attempt failed — renders in place.
     *
     * A retake still waiting for a verdict is only reached here when the run was told to replace
     * it, and even then it is not thrown away: it joins the take list marked rejected, exactly as
     * `rejectTake` leaves it, so the comparison the listener was in the middle of is still playable
     * afterwards. It is never deleted while it is the only render of this line that worked.
     */
    _queueRender(s: Segment): "render" | "replace" {
      const cand = s.candidate;
      if (cand) {
        delete s.candidate;
        // a failed retake is not a comparison; it is in the way of the one about to be made
        if (cand.duration > 0)
          s.audio = {
            ...s.audio,
            takes: [...(s.audio.takes ?? []), { ...snapshotTake(cand), rejected: true }],
          };
      }
      if (s.audio.duration > 0) {
        s.candidate = {
          status: "queued",
          endpoint: null,
          ms: 0,
          duration: 0,
          n: nextTakeNumber(s.audio),
          auto: true,
        };
        return "replace";
      }
      s.audio = requeue(s.audio);
      return "render";
    },
    /**
     * A bulk replacement that succeeded takes over: it becomes the clip in the book and the one it
     * displaces joins the take list, so the history is kept and nobody is asked for 300 verdicts.
     * The listener's flag is left where it is — it is their note, not this run's to clear.
     */
    _acceptReplacement(bookId: string, chId: number, segId: number): void {
      const castStore = useCastStore();
      const scriptsStore = useScriptsStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      const cand = s?.candidate;
      if (!s || !cand || !cand.auto || cand.duration <= 0) return;
      const takes = [...(s.audio.takes ?? [])];
      if (s.audio.duration > 0) takes.push(snapshotTake(s.audio));
      const { auto: _auto, ...clip } = cand;
      s.audio = { ...clip, ...(takes.length ? { takes } : {}) };
      delete s.candidate;
      castStore._retime(bookId, chId);
    },
    retrySegment(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      if (
        this._expressionGuard(bookId, [{ chId, segId }], () =>
          this.retrySegment(bookId, chId, segId),
        )
      )
        return;
      // One line, asked for by hand: a plain re-render in place, not a comparison. `retakeSegment`
      // is the one that keeps the old clip to judge against.
      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s) s.audio = requeue(s.audio);
      this._resume(bookId, chId);
    },
    /** Every request in this chapter that failed, and only those — a replacement that failed too. */
    retryFailed(bookId: string, chId: number): void {
      const scriptsStore = useScriptsStore();

      const failed = (s: Segment): boolean =>
        s.audio.status === "failed" || s.candidate?.status === "failed";
      if (
        this._expressionGuard(
          bookId,
          scriptsStore
            .segmentsOf(bookId, chId)
            .filter(failed)
            .map((s) => ({ chId, segId: s.id })),
          () => this.retryFailed(bookId, chId),
        )
      )
        return;
      for (const s of scriptsStore.segmentsOf(bookId, chId)) if (failed(s)) this._queueRender(s);
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
        n: nextTakeNumber(s.audio),
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
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      // the generation of the demo world this run belongs to, taken as it is dispatched
      const epoch = demoStore._epoch;
      return {
        stale: () => demoStore.isStale(epoch),
        paused: (id) => !!libraryStore.bookById(id)?.budget?.paused,
        segmentsOf: (bookId, chId) => scriptsStore.segmentsOf(bookId, chId),
        charactersOf: (bookId) => castStore.charactersOf(bookId),
        effectiveVoice: (bookId, speaker) => castStore.effectiveVoice(bookId, speaker),
        expressionRender: (bookId, segment) => this.expressionRender(bookId, segment),
        clipDrift: (bookId, segment, audio) => this.clipDrift(bookId, segment, audio),
        markStale: (bookId, chId, segment) => scriptsStore._markStale(bookId, chId, segment),
        acceptReplacement: (bookId, chId, segId) => this._acceptReplacement(bookId, chId, segId),
        chapterNarration: (bookId, chId) => chapterNarration(scriptsStore.segmentsOf(bookId, chId)),
        retime: (bookId, chId) => castStore._retime(bookId, chId),
        finishJob: (job, status) => jobsStore._finish(job, status),
        toast: (msg, opts) => uiStore.toast(msg, opts),
      };
    },
  },
});
