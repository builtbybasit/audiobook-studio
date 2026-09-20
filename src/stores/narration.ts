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
  segmentFailed,
  skipSummary,
} from "@/lib/runPlan";
import { partsFor } from "@/lib/split";
import { nextTakeNumber, requeue, snapshotTake } from "@/lib/takes";
import { clone } from "@/lib/utils";
import type { NarrationSimContext } from "@/mock";
import { dispatchNarration } from "@/mock";
import type {
  Chapter,
  Endpoint,
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
import { billingOf, speechPricing } from "@/lib/endpoints";
import {
  addUnits,
  AUDIO_CHARS_PER_SECOND,
  estimateSpeech,
  measureSpeech,
  money,
  noUnits,
  speechComponents,
  speechRates,
} from "@/lib/pricing";
import { effectiveRates } from "@/lib/pricing";
import { speechInstructions } from "@/lib/speech";
import { plural } from "@/lib/contents";
import { key } from "@/lib/scriptReview";
import { ApiError } from "@/services/http";
import { activeJobsService } from "@/services/jobs";
import { activeLibraryService } from "@/services/library";
import type { BillableUnits, SpeechEstimate } from "@/types";
import { useUiStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
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
    /**
     * The lines of one chapter the script has moved past: stale clips, plus — once the chapter has
     * been narrated at all — the lines that were never rendered, because in a started chapter a gap
     * is work left to do rather than a chapter nobody has begun.
     *
     * One definition, so "Re-narrate changed (N)" in the ledger, the reader's banner, the lexicon
     * panel's re-narrate button and `renarrateStale` itself all count and queue the same lines. A
     * panel with its own copy is one that promises N and renders something else.
     */
    changedSegments(): (bookId: string, chId: number) => Segment[] {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return (bookId, chId) => {
        const started = libraryStore.chapter(bookId, chId)?.narration !== "none";
        return scriptsStore
          .segmentsOf(bookId, chId)
          .filter((s) => s.audio.status === "stale" || (started && s.audio.status === "none"));
      };
    },
    /**
     * What rendering these lines would cost at the **undiscounted** price, per endpoint.
     *
     * The budget figure, never the headline one: a run over a book takes long enough for an
     * off-peak window to close or a promotion to expire inside it, so a cap that only holds while a
     * discount lasts is not a cap. Requests to an endpoint whose rate is not known are counted in
     * `unpriced` and add nothing, which makes the figure a floor — the same reading the estimate
     * panel gives them.
     */
    _worstCase(): (
      bookId: string,
      segs: Segment[],
      at?: number,
    ) => { cost: number; unpriced: number } {
      return (bookId, segs, at = Date.now()) => {
        let cost = 0;
        let unpriced = 0;
        for (const { row, priced } of this._pricedByEndpoint(bookId, segs, at).rows) {
          // both halves unknown is a rate nobody can reserve against; a known undiscounted figure is
          // still a cap to check, even when the discounted one is missing
          if (priced.cost == null && priced.withoutPromotions == null) unpriced += row.requests;
          cost += Math.max(priced.cost ?? 0, priced.withoutPromotions ?? 0);
        }
        return { cost, unpriced };
      };
    },
    /**
     * Why this run cannot start, in the sentences the run strip shows — or empty when it can.
     *
     * In the store rather than in whichever panel has an estimate, and built on the same
     * `_worstCase` the cap is actually enforced against (`_budgetBlocked`), because a budget figure
     * worked out a second way is how a strip green-lights a run the store then refuses. Note the
     * cap is compared against a per-endpoint sum of undiscounted prices, never a single max over
     * the aggregate: two endpoints on different discounts do not add up the same way.
     */
    blockers(): (
      bookId: string,
      ids: number[],
      scope?: NarrationScope,
      keepPending?: boolean,
    ) => string[] {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();

      return (bookId, ids, scope = "all", keepPending = true) => {
        // one estimate pass: it already grouped and priced this run's lines per endpoint, and
        // carries the cap's own figure on `worstCase`. This strip re-renders on every progress tick
        // while a run is in flight, so a second grouping here would cost two `expressionRender`
        // calls per line, several times a second, for a number already in hand.
        const est = this.estimate(bookId, ids, scope, keepPending);
        const out: string[] = [];
        if (!est.segments) return out;
        if (est.unrouted)
          out.push(
            `${est.unrouted} line${est.unrouted === 1 ? "" : "s"} have no voice to render with. Assign one on Cast first.`,
          );
        const cap = libraryStore.bookById(bookId)?.budget?.cap;
        if (cap != null) {
          const cost = est.worstCase;
          const spent = jobsStore.spent(bookId);
          const held = jobsStore.reserved(bookId);
          if (spent + held + cost > cap)
            out.push(
              `Over the book's $${cap.toFixed(2)} cap: $${spent.toFixed(2)} spent` +
                (held > 0 ? `, $${held.toFixed(2)} held by work already running` : "") +
                `, ${money(cost)} for this — priced without today's discounts, because they can end mid-run.`,
            );
        }
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
     * What one line would submit to one endpoint, counted every way a provider can bill it.
     *
     * The same measurement the simulator takes when the request actually goes out, so an estimate
     * and the charge that follows it count the same thing: the line **after** the pronunciation
     * dictionary and the expression tags, plus the voice instructions sent beside it — never the
     * source text, and never the endpoint's split limit, which is about payload size rather than
     * price. The audio side is this app's own reading-speed estimate, because nothing has been
     * rendered yet; stitched silence is not generated audio and is not in it.
     */
    _plannedUnits(): (bookId: string, seg: Segment, ep: Endpoint) => BillableUnits {
      const castStore = useCastStore();

      return (bookId, seg, ep) => {
        const render = this.expressionRender(bookId, seg);
        const parts = render.issues.length
          ? partsFor(render.text, ep)
          : expressionParts(render, ep).length;
        const who = castStore.charactersOf(bookId).find((x) => x.name === seg.speaker);
        return measureSpeech(
          {
            text: render.text,
            instructions: speechInstructions({ style: who?.style, direction: seg.direction }),
            requests: parts,
            audioSeconds: render.text.length / AUDIO_CHARS_PER_SECOND,
          },
          billingOf(ep),
        );
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
    /**
     * What these lines would submit to each endpoint, and what that would cost at `at`.
     *
     * Every line goes to the endpoint that owns its speaker's voice, and a line past that endpoint's
     * limit becomes several requests — so cost and load are per endpoint, and each card is priced in
     * whatever unit it bills in. Lines with no route are counted in `unrouted` and priced by nobody.
     *
     * One grouping and one call into the pricing engine, reduced three different ways: the estimate
     * panel keeps every column, `_worstCase` keeps the undiscounted figure the cap is checked
     * against, and `_plannedCost` keeps the two halves recorded on the job. They used to be three
     * copies of this loop, which is how a panel starts quoting a figure the cap does not honour.
     */
    _pricedByEndpoint(): (
      bookId: string,
      segs: Segment[],
      at: number,
    ) => { rows: { row: EndpointEstimate; priced: SpeechEstimate }[]; unrouted: number } {
      const castStore = useCastStore();

      return (bookId, segs, at) => {
        const per: Record<string, EndpointEstimate> = {};
        let unrouted = 0;
        for (const seg of segs) {
          const ep = castStore.effectiveVoice(bookId, seg.speaker).endpoint;
          if (!ep) {
            unrouted++;
            continue;
          }
          const e = (per[ep.id] ??= {
            endpoint: ep,
            units: noUnits(),
            chars: 0,
            segments: 0,
            requests: 0,
            split: 0,
            cost: 0,
            inputCost: 0,
            audioCost: null,
            withoutPromotions: 0,
            why: [],
          });
          e.units = addUnits(e.units, this._plannedUnits(bookId, seg, ep));
          e.segments++;
          const parts = this.requestsFor(bookId, seg);
          e.requests += parts;
          e.chars = e.units.chars;
          if (parts > 1) e.split++;
        }
        const rows = Object.values(per).map((row) => {
          const billing = billingOf(row.endpoint);
          const priced = estimateSpeech(billing, speechPricing(row.endpoint).config, row.units, at);
          row.cost = priced.cost;
          row.inputCost = priced.inputCost;
          row.audioCost = priced.audioCost;
          row.withoutPromotions = priced.withoutPromotions;
          return { row, priced };
        });
        return { rows, unrouted };
      };
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
      const endpointsStore = useEndpointsStore();
      const scriptsStore = useScriptsStore();

      return (bookId, ids, scope = "all", keepPending = true) => {
        // The plan decides which chapters are in the run and which are left out; the estimate prices
        // what it chose. Re-deriving the eligibility cascade here is how the panel and the button
        // start disagreeing about the same press.
        const plan = this.narrationRunPlan(bookId, ids, scope, keepPending);
        const lines: Segment[] = [];
        let chars = 0;
        let stale = 0;
        for (const row of plan.chapters) {
          const { run } = narrationTargets(
            scriptsStore.segmentsOf(bookId, row.id),
            scope,
            keepPending,
          );
          for (const seg of run) {
            chars += seg.text.length;
            if (seg.audio.status === "stale") stale++;
            lines.push(seg);
          }
        }
        // Each endpoint is priced on its own card, at the rates in force right now, in whatever
        // unit it bills in — a per-request endpoint is charged per request, a per-minute one on the
        // audio this run would produce. One instant for the whole estimate, so the rows agree with
        // each other and with the total.
        const at = Date.now();
        const { rows: priceRows, unrouted } = this._pricedByEndpoint(bookId, lines, at);
        const rows = priceRows.map(({ row }) => row);
        const cautions = new Set<string>();
        let cost = 0;
        let withoutPromotions = 0;
        let unpriced = 0;
        let inputCost = 0;
        let worstCase = 0;
        let audioCost: number | null = null;
        for (const { row: e, priced } of priceRows) {
          const billing = billingOf(e.endpoint);
          // every step that moved any of this endpoint's rates off its card, in order — resolved
          // once for the endpoint rather than once per component
          const resolved = effectiveRates(
            speechRates(billing),
            speechPricing(e.endpoint).config,
            at,
            billing.unit,
          );
          e.why = [
            ...new Set(speechComponents(billing.unit).flatMap((c) => resolved.components[c].why)),
          ];
          if (priced.cost == null) unpriced += e.requests;
          else cost += priced.cost;
          inputCost += priced.inputCost ?? 0;
          if (priced.audioCost != null) audioCost = (audioCost ?? 0) + priced.audioCost;
          withoutPromotions += priced.withoutPromotions ?? 0;
          // the cap's own figure, taken here so the panel and `_budgetBlocked` cannot disagree
          worstCase += Math.max(priced.cost ?? 0, priced.withoutPromotions ?? 0);
          for (const why of priced.cautions) cautions.add(why);
        }
        if (unpriced)
          cautions.add(
            `${unpriced} request${unpriced === 1 ? "" : "s"} go to an endpoint with no rate set. They are counted but never priced, so this total is a floor rather than the bill.`,
          );
        return {
          chapters: plan.chapters.length,
          chars,
          segments: lines.length,
          seconds: chars / 15.5,
          units: rows.reduce((a, e) => addUnits(a, e.units), noUnits()),
          cost,
          inputCost,
          audioCost,
          unpriced,
          withoutPromotions,
          worstCase,
          cautions: [...cautions],
          stale,
          replacing: plan.replacing,
          pending: plan.pending,
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
    // ---------- the book's budget cap ----------
    //
    // The cap is enforced here rather than in the page that happens to have an estimate panel.
    // Narration has half a dozen entry points — a bulk run, "re-narrate stale", a retry, a retake,
    // "retake everything flagged" — and a check that lives in one of them is not a cap, it is a
    // warning on one screen. Nothing queues a clip without coming through `_budgetBlocked` first,
    // and nothing dispatches one without `_reserveQueued` holding its price against the cap.
    /**
     * Would rendering these lines take the book past its cap?
     *
     * Checked against what has been spent **and** what unfinished work has already reserved, so two
     * runs that each fit on their own cannot both start and land past the cap between them.
     */
    _budgetBlocked(bookId: string, segs: Segment[], quiet = false): boolean {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      const cap = libraryStore.bookById(bookId)?.budget?.cap;
      if (cap == null || !segs.length) return false;
      const { cost } = this._worstCase(bookId, segs);
      const spent = jobsStore.spent(bookId);
      const held = jobsStore.reserved(bookId);
      if (spent + held + cost <= cap) return false;
      if (!quiet)
        uiStore.toast("Over the book's budget cap", {
          kind: "warn",
          description:
            `$${cap.toFixed(2)} cap · $${spent.toFixed(2)} spent` +
            (held > 0 ? ` · $${held.toFixed(2)} held by work already running` : "") +
            ` · $${cost.toFixed(2)} for this, priced without today's discounts because they can end mid-run. ` +
            "Raise the cap on the book overview, or wait for the work in flight to land.",
          timeout: 9000,
        });
      return true;
    },
    /** The lines of one chapter with a render waiting to go out, of either kind. */
    _queuedSegments(bookId: string, chId: number): Segment[] {
      const scriptsStore = useScriptsStore();

      return scriptsStore
        .segmentsOf(bookId, chId)
        .filter((s) => s.audio.status === "queued" || s.candidate?.status === "queued");
    },
    /**
     * Hold the undiscounted price of everything this job has queued against the book's cap.
     *
     * Released whole when the job finishes rather than clip by clip — `reserved` only counts
     * unfinished jobs — so the reservation errs towards holding too much back, which is the only
     * direction a cap can afford to be wrong in.
     */
    _reserveQueued(job: Job, bookId: string, chId: number): void {
      const queued = this._queuedSegments(bookId, chId);
      // The estimate is taken from the same lines, at the same instant, so the reconciliation
      // afterwards compares like with like: this chapter's own clips against this chapter's own
      // estimate, never the run's average spread over it.
      const at = Date.now();
      const planned = this._plannedCost(bookId, queued, at);
      job.narrationRun = {
        reserved: this._worstCase(bookId, queued, at).cost,
        clips: queued.length,
        estimated: planned.cost,
        estimatedInput: planned.inputCost,
        estimatedAudio: planned.audioCost,
      };
    },
    /**
     * What these lines would cost at the rates in force at `at`, split into its two halves.
     *
     * The same measurement and the same engine the estimate panel uses — one calculation, so a
     * chapter cannot be dispatched against a figure the panel never showed.
     */
    _plannedCost(
      bookId: string,
      segs: Segment[],
      at: number = Date.now(),
    ): { cost: number; inputCost: number; audioCost: number | null } {
      let cost = 0;
      let inputCost = 0;
      let audioCost: number | null = null;
      for (const { priced } of this._pricedByEndpoint(bookId, segs, at).rows) {
        cost += priced.cost ?? 0;
        inputCost += priced.inputCost ?? 0;
        if (priced.audioCost != null) audioCost = (audioCost ?? 0) + priced.audioCost;
      }
      return { cost, inputCost, audioCost };
    },
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
      scriptsStore._commit(bookId, chId);
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
      scriptsStore._commit(bookId, chId);
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
      if (!blocked) return false;
      // There is one review slot, and a caller that loops chapter by chapter reaches this once per
      // chapter. Replacing the pending review would drop every chapter but the last on the floor —
      // silently, because each blocked call also returns early without queueing. So a second block
      // while one is still open *joins* it: the targets are merged and both resumes run, which is
      // what makes "re-narrate every stale chapter" safe to write as a loop.
      const open = this.expressionReview;
      if (open && open.bookId === bookId) {
        const seen = new Set(open.targets.map((t) => `${t.chId}:${t.segId}`));
        open.targets.push(...targets.filter((t) => !seen.has(`${t.chId}:${t.segId}`)));
        const first = open.resume;
        open.resume = () => {
          first();
          resume();
        };
      } else {
        this.expressionReview = { bookId, targets: [...targets], resume };
      }
      return true;
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
      for (const chId of chapters) scriptsStore._commit(pending.bookId, chId);
      uiStore.toast(`${count} expressions omitted from narration`, {
        description: "Annotations stay in the script until you enable them again.",
        undo: count ? () => undos.forEach((undo) => undo()) : undefined,
      });
    },
    // "changed" is both edited-after-narration lines and halves of a hand-split segment that were
    // never rendered at all — in a chapter that has audio, neither belongs in the finished book.
    /**
     * The backend half of `runNarration`: queue the chapters on the server, as one run.
     *
     * Nothing about a chapter changes here. The server marks the chapters it queued, the response
     * carries them as they now stand, and the queue's poll (`useBookJobs`) reads the chapter's
     * script again as clips land. A chapter the server left out — skipped for the audiobook, not
     * scripted, already being narrated, or with nothing in the scope — is said so in the toast.
     */
    async _runRemote(
      bookId: string,
      ids: number[],
      { scope = "all", quiet = false }: { scope?: NarrationScope; quiet?: boolean } = {},
    ): Promise<void> {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();
      const svc = activeJobsService();
      if (!svc) return;
      try {
        const { jobs, skipped, chapters } = await svc.narrateChapters(bookId, ids, scope);
        libraryStore.chapters[bookId] = chapters;
        await jobsStore._changed();
        if (quiet) return;
        const count = (why: (typeof skipped)[number]["why"]) =>
          skipped.filter((s) => s.why === why).length;
        const notes = [
          count("busy") ? `${plural(count("busy"), "chapter")} already being narrated` : "",
          count("excluded")
            ? `${plural(count("excluded"), "chapter")} skipped for the audiobook`
            : "",
          count("unscripted") ? `${plural(count("unscripted"), "chapter")} not scripted yet` : "",
          count("nothing")
            ? `${plural(count("nothing"), "chapter")} with no line ${SCOPE_LABEL[scope].toLowerCase()}`
            : "",
        ].filter(Boolean);
        if (!jobs.length) {
          uiStore.toast("Nothing to narrate in this selection", {
            kind: "warn",
            description:
              notes.join("; ") || "The selection had no chapters the server could narrate.",
          });
          return;
        }
        const replacing = jobs.filter((j) => j.bulk?.op === "Re-narrate").length;
        uiStore.toast(
          `${replacing === jobs.length ? "Re-narrate" : "Narrate"} · ${plural(jobs.length, "chapter")}`,
          {
            kind: "info",
            description:
              "Queued on the server. Progress is in the Queue, and each clip appears here when it lands." +
              (replacing ? ` ${plural(replacing, "narrated chapter")} will be replaced.` : "") +
              (notes.length ? ` Left out: ${notes.join("; ")}.` : ""),
            timeout: 8000,
          },
        );
      } catch (cause) {
        const api = cause instanceof ApiError ? cause : null;
        uiStore.toast(api ? api.message : "Could not queue narration", {
          kind: "error",
          description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
          timeout: 8000,
        });
      }
    },
    /** Say what the server cannot do yet, and change nothing. */
    _notRemote(what: string): void {
      const uiStore = useUiStore();
      uiStore.toast(`${what} are not available with a server yet`, {
        kind: "warn",
        description:
          "Re-narrate the chapter instead: “missing & changed” re-renders the lines whose clip no longer matches, and “failed only” the ones that failed.",
        timeout: 8000,
      });
    },
    /** Say a request failed, and change nothing. */
    _failed(what: string, cause: unknown): void {
      const uiStore = useUiStore();
      const api = cause instanceof ApiError ? cause : null;
      uiStore.toast(api ? api.message : `Could not ${what}`, {
        kind: "error",
        description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
        timeout: 8000,
      });
    },
    /**
     * The backend half of a retake: the lines are queued on the server as one job, each to render
     * beside the clip it may replace, and the queue's poll brings each candidate here when it
     * lands. A line already waiting on a verdict is left out and said so. Resolves to how many
     * lines were queued.
     */
    async _remoteRetake(bookId: string, chId: number, ids: number[]): Promise<number> {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();
      const svc = activeJobsService();
      if (!svc || !ids.length) return 0;
      try {
        const { job, queued, skipped, chapters } = await svc.retakeLines(bookId, chId, ids);
        libraryStore.chapters[bookId] = chapters;
        if (job) await jobsStore._changed();
        const pending = skipped.filter((s) => s.why === "pending").length;
        if (!queued.length)
          uiStore.toast("Nothing to retake", {
            kind: "info",
            description: pending
              ? `${plural(pending, "line")} already ${pending === 1 ? "has" : "have"} a retake waiting for a verdict.`
              : "The lines asked for are not in this chapter's script.",
          });
        else
          uiStore.toast(`Retake · ${plural(queued.length, "line")}`, {
            kind: "info",
            description:
              "Queued on the server. Each take appears beside its line when it lands, ready to compare." +
              (pending
                ? ` ${plural(pending, "line")} left alone: a retake is already waiting.`
                : ""),
            timeout: 8000,
          });
        return queued.length;
      } catch (cause) {
        this._failed("queue the retake", cause);
        return 0;
      }
    },
    /**
     * The backend half of a verdict. The server swaps or discards the retake and answers with the
     * line and the chapter as they now stand, which replace what is here. There is no Undo: the
     * displaced clip is in the take list, where the comparison can be made again.
     */
    async _remoteVerdict(
      bookId: string,
      chId: number,
      segId: number,
      verdict: "accept" | "reject",
    ): Promise<void> {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();
      const svc = activeLibraryService();
      if (!svc) return;
      const k = key(bookId, chId);
      try {
        const { segment, revision, chapter } = await svc.judgeTake(bookId, chId, segId, verdict);
        const segs = scriptsStore.segments[k];
        const i = segs?.findIndex((x) => x.id === segId) ?? -1;
        if (i >= 0) segs.splice(i, 1, segment);
        scriptsStore._revision[k] = Math.max(scriptsStore._revision[k] ?? 0, revision);
        const c = libraryStore.chapter(bookId, chId);
        if (c) Object.assign(c, chapter);
        if (verdict === "accept") {
          uiStore.toast(`Take ${segment.audio.n ?? 1} kept`, {
            kind: "success",
            description: "It is the clip in the book now; the earlier take stays in the take list.",
          });
          return;
        }
        // the kept clip may have gone out of date while the retake rendered — say so rather than
        // silently calling it current, and let the script carry the mark
        const drift = i >= 0 ? this.clipDrift(bookId, segment) : [];
        if (drift.length && ["done", "stale"].includes(segment.audio.status)) {
          scriptsStore._markStale(bookId, chId, segment);
          scriptsStore._commit(bookId, chId);
        }
        const rejected = segment.audio.takes?.at(-1);
        uiStore.toast(
          rejected?.rejected ? `Take ${segment.audio.n ?? 1} kept` : "Retake discarded",
          {
            kind: drift.length ? "warn" : "info",
            description: drift.length
              ? `The kept clip is out of date — ${drift[0]}.`
              : rejected?.rejected
                ? `Take ${rejected.n} is marked rejected — retake again or edit the line first.`
                : "It never produced a clip.",
          },
        );
      } catch (cause) {
        this._failed(verdict === "accept" ? "keep this take" : "discard this take", cause);
      }
    },
    renarrateStale(bookId: string, chId: number): void {
      // the server works out which lines the script has moved past from the clips it holds
      if (activeJobsService()) {
        this.runNarration(bookId, [chId], { scope: "fill" });
        return;
      }
      // one list, used for the guard, the budget check and the work: a guard that asked about a
      // different set from the one queued would check expressions on lines the run never touches, or
      // render lines whose expressions were never checked
      const stale = this.changedSegments(bookId, chId);
      if (
        this._expressionGuard(
          bookId,
          stale.map((s) => ({ chId, segId: s.id })),
          () => this.renarrateStale(bookId, chId),
        )
      )
        return;
      if (this._budgetBlocked(bookId, stale)) return;
      // a stale clip is still playable; its replacement renders beside it and takes over only when
      // it lands, so the chapter never loses audio it had
      for (const s of stale) this._queueRender(s);
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
      // With a server answering, the run is the server's: it decides which lines the scope
      // covers from the clips it holds, renders them and writes each as it lands. The expression
      // guard, the estimate and the budget gates are the seeded endpoints' and do not apply —
      // see `docs/backend.md`.
      if (activeJobsService()) {
        void this._runRemote(bookId, ids, { scope, quiet });
        return;
      }
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
      // The whole run is checked against the cap before a single chapter is queued, at the
      // undiscounted price and against what other runs have already reserved.
      if (
        this._budgetBlocked(
          bookId,
          chs.flatMap(
            (c) => narrationTargets(scriptsStore.segmentsOf(bookId, c.id), scope, keepPending).run,
          ),
          quiet,
        )
      )
        return;
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
        // Reserved now, for every chapter of the run, not only for the one being dispatched: a
        // second run started while this one is half-way through has to see the whole of what this
        // one is still going to spend. It is worked out again at dispatch from what is actually
        // queued by then, because a chapter waiting behind five others can change while it waits.
        const planned = narrationTargets(
          scriptsStore.segmentsOf(bookId, c.id),
          scope,
          keepPending,
        ).run;
        job.narrationRun = {
          reserved: this._worstCase(bookId, planned).cost,
          clips: planned.length,
        };
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
            `${plan.requests} request${plan.requests === 1 ? "" : "s"} · ~${money(this.estimate(bookId, ids, scope, keepPending).cost)}. ` +
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
        this._reserveQueued(job, bookId, c.id);
        logJob(job, "Budget reserved for this chapter", "info", {
          reservedUSD: job.narrationRun?.reserved ?? 0,
          basis: "undiscounted — a promotion or an off-peak window can end mid-run",
        });
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

      // The server's smallest unit of work is a chapter at a scope: a failed line is re-rendered
      // with the chapter's other failed lines, and a line that did not fail has nothing to retry.
      if (activeJobsService()) {
        const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
        if (s && segmentFailed(s)) this.runNarration(bookId, [chId], { scope: "failed" });
        else this._notRemote("Re-renders of one line");
        return;
      }
      if (
        this._expressionGuard(bookId, [{ chId, segId }], () =>
          this.retrySegment(bookId, chId, segId),
        )
      )
        return;
      // One line, asked for by hand: a plain re-render in place, not a comparison. `retakeSegment`
      // is the one that keeps the old clip to judge against.
      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s || this._budgetBlocked(bookId, [s])) return;
      s.audio = requeue(s.audio);
      this._resume(bookId, chId);
    },
    /** Every request in this chapter that failed, and only those — a replacement that failed too. */
    retryFailed(bookId: string, chId: number): void {
      const scriptsStore = useScriptsStore();

      if (activeJobsService()) {
        this.runNarration(bookId, [chId], { scope: "failed" });
        return;
      }
      // one list, used for the guard and for the work: a guard that checked a different set from
      // the one queued would clear expressions on lines the run never touches, or render lines whose
      // expressions were never checked
      const broken = scriptsStore.segmentsOf(bookId, chId).filter(segmentFailed);
      if (
        this._expressionGuard(
          bookId,
          broken.map((s) => ({ chId, segId: s.id })),
          () => this.retryFailed(bookId, chId),
        )
      )
        return;
      if (this._budgetBlocked(bookId, broken)) return;
      for (const s of broken) this._queueRender(s);
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
      if (!s) return;
      s.flag = { kind, note: note.trim(), at: Date.now() } satisfies SegmentFlag;
      // a flag is written with the script it is on; it changes nothing a version keeps
      scriptsStore._commit(bookId, chId);
    },
    clearFlag(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s?.flag) return;
      delete s.flag;
      scriptsStore._commit(bookId, chId);
    },
    /** Queue another render of one segment, keeping the current clip to compare against. */
    retakeSegment(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      if (activeJobsService()) {
        void this._remoteRetake(bookId, chId, [segId]);
        return;
      }
      if (
        this._expressionGuard(bookId, [{ chId, segId }], () =>
          this.retakeSegment(bookId, chId, segId),
        )
      )
        return;
      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s || this._budgetBlocked(bookId, [s]) || !this._queueRetake(s)) return;
      this._resume(bookId, chId, "Retake");
    },
    /** Every flagged segment in the chapter gets another take in one run. */
    retakeFlagged(bookId: string, chId: number): number {
      const scriptsStore = useScriptsStore();

      // one list for the guard, the budget check and the work — see `renarrateStale`
      const flagged = scriptsStore.segmentsOf(bookId, chId).filter((s) => s.flag);
      if (activeJobsService()) {
        void this._remoteRetake(
          bookId,
          chId,
          flagged.map((s) => s.id),
        );
        return flagged.length;
      }
      if (
        this._expressionGuard(
          bookId,
          flagged.map((s) => ({ chId, segId: s.id })),
          () => this.retakeFlagged(bookId, chId),
        )
      )
        return 0;
      if (this._budgetBlocked(bookId, flagged)) return 0;
      let n = 0;
      for (const s of flagged) if (this._queueRetake(s)) n++;
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
      if (activeLibraryService()) {
        void this._remoteVerdict(bookId, chId, segId, "accept");
        return;
      }
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
      if (activeLibraryService()) {
        void this._remoteVerdict(bookId, chId, segId, "reject");
        return;
      }
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
    /**
     * Dispatch whatever the caller has just put in this chapter's queue.
     *
     * Every direct action — a retry, a retake, "retake everything flagged" — arrives here, so this
     * is where their work is reserved against the cap. They check the cap before they queue;
     * reserving happens after, because only then is it settled what is actually going out.
     */
    _resume(bookId: string, chId: number, label = "Retry"): void {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();

      const c = libraryStore.chapter(bookId, chId);
      if (!c || c.narration === "running") return;
      const job = jobsStore.addJob("narration", bookId, `${label} · ch ${c.id}`, c.id);
      this._reserveQueued(job, bookId, chId);
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
      const usageStore = useUsageStore();

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
        // append-only: what a request cost is written once, when it settles, and nothing that later
        // happens to the clip it produced can move it
        recordSpeech: (r) => usageStore.recordSpeech(r),
        recordRefused: (r) => usageStore.recordRefused({ ...r, kind: "tts" }),
        finishJob: (job, status) => jobsStore._finish(job, status),
        toast: (msg, opts) => uiStore.toast(msg, opts),
      };
    },
  },
});
