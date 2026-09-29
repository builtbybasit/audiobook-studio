import type { ExpressionPlan } from "@/lib/expressions";
// Narration, expression preflight and retakes. Accepted audio stays on the script segments.
import {
  annotationFrom,
  expressionParts,
  expressionPlan,
  expressionSupport,
} from "@/lib/expressions";
import { narrationPlan, narrationTargets, SCOPE_LABEL, segmentFailed } from "@/lib/runPlan";
import { partsFor } from "@/lib/split";
import type {
  Endpoint,
  EndpointEstimate,
  ExpressionAnnotation,
  ExpressionTag,
  FlagKind,
  NarrationEstimate,
  NarrationScope,
  RunPlan,
  Segment,
  SegmentAudio,
  SegmentFlag,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { billingOf, speechPricing } from "@/lib/endpoints";
import { plannedSpeechUnits } from "@/lib/narrationCost";
import {
  addUnits,
  estimateSpeech,
  money,
  noUnits,
  speechComponents,
  speechRates,
} from "@/lib/pricing";
import { effectiveRates } from "@/lib/pricing";
import { sampleRateLabel, speechInstructions } from "@/lib/speech";
import { plural } from "@/lib/contents";
import { key } from "@/lib/scriptReview";
import { ApiError } from "@/services/http";
import { jobsService } from "@/services/jobs";
import { libraryService } from "@/services/library";
import type { BillableUnits, SpeechEstimate } from "@/types";
import { useUiStore } from "@/stores/ui";
export const useNarrationStore = defineStore("narration", {
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
        // An endpoint left on the model's own rate asks for nothing, so no clip it made is at the
        // wrong one; only a rate the endpoint now names can be one a clip was not rendered at.
        const rate = now.endpoint?.sampleRate;
        if (a.sampleRate && rate && a.sampleRate !== rate)
          out.push(`sample rate: ${sampleRateLabel(a.sampleRate)} → ${sampleRateLabel(rate)}`);
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
     * One definition, so "Re-narrate changed (N)" in the ledger, the reader's banner and the lexicon
     * panel's re-narrate button all count the lines `renarrateStale` asks the server for. A panel
     * with its own copy is one that promises N and renders something else.
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
     * Why this run cannot start, in the sentences the run strip shows — or empty when it can.
     *
     * In the store rather than in whichever panel has an estimate, and built on the estimate's
     * `worstCase` — the figure the server reserves against the cap, from the same
     * `@/lib/narrationCost` — because a budget figure worked out a second way is how a strip
     * green-lights a run the server then refuses. Note the cap is compared against a per-endpoint
     * sum of undiscounted prices, never a single max over the aggregate: two endpoints on different
     * discounts do not add up the same way.
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
     * The same measurement the server takes when the request actually goes out, so an estimate
     * and the charge that follows it count the same thing: the line **after** the pronunciation
     * dictionary and the expression tags, plus the voice instructions sent beside it — never the
     * source text, and never the endpoint's split limit, which is about payload size rather than
     * price. The audio side is this app's own reading-speed estimate, because nothing has been
     * rendered yet; stitched silence is not generated audio and is not in it.
     */
    _plannedUnits(): (bookId: string, seg: Segment, ep: Endpoint) => BillableUnits {
      const castStore = useCastStore();

      return (bookId, seg, ep) => {
        const who = castStore.charactersOf(bookId).find((x) => x.name === seg.speaker);
        return plannedSpeechUnits(
          this.expressionRender(bookId, seg),
          ep,
          speechInstructions({ style: who?.style, direction: seg.direction }),
        );
      };
    },
    /**
     * What running this selection at this scope would do, chapter by chapter, with the reasons a
     * selected chapter is left out. The picker's summary, the button's label and the estimate are
     * all this one calculation, and the server queues a run by the same `narrationTargets`.
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
     * One grouping and one call into the pricing engine per endpoint, which the estimate reads every
     * column of — the undiscounted figure the cap is checked against included, so the panel cannot
     * quote a figure the cap does not honour.
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
          // the cap's own figure, taken here so the panel and the strip's blockers cannot disagree
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
      const undo = scriptsStore._editSnapshot(bookId, chId);
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
      if (patch) Object.assign(a, patch, { annotationId });
      else s.expressions = s.expressions!.filter((a) => a.annotationId !== annotationId);
      s.edited = true;
      scriptsStore._markStale(bookId, chId, s);
      scriptsStore._commit(bookId, chId);
      uiStore.toast(patch ? "Expression updated" : "Expression removed", { undo });
    },
    // ---------- narration ----------
    //
    // Every run is the server's: it decides which lines a scope covers from the clips it holds,
    // renders them and writes each as it lands, and the queue's poll (`useBookJobs`) reads the
    // chapter's script again as they do. The budget is the server's to enforce too: it refuses a
    // run that does not fit the book's cap, or any run on a paused book, with a 409 whose sentence
    // the toast shows as it is, and stops a running job before a request the cap no longer allows.
    // Nothing about a chapter changes here before the server answers — see `docs/backend.md`.
    /**
     * Narrate (or re-narrate) the given chapters, as one run.
     *
     * `scope` is what the run was asked to do — fill the gaps and refresh what the script has moved
     * past, retry only what failed, or render everything again. A line that already has a playable
     * clip renders its replacement beside it, and the clip in the book keeps playing until the
     * replacement lands. The server marks the chapters it queued and the response carries them as
     * they now stand; a chapter it left out — skipped for the audiobook, not scripted, already being
     * narrated, or with nothing in the scope — is said so in the toast.
     */
    async runNarration(
      bookId: string,
      ids: number[],
      { scope = "all", quiet = false }: { scope?: NarrationScope; quiet?: boolean } = {},
    ): Promise<void> {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      if (libraryStore._blocked(bookId, "narrate")) return;
      try {
        const { jobs, skipped, chapters } = await jobsService().narrateChapters(bookId, ids, scope);
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
        this._failed("queue narration", cause);
      }
    },
    /**
     * The lines the script has moved past, as the server counts them from the clips it holds: the
     * "missing & changed" scope over one chapter.
     */
    renarrateStale(bookId: string, chId: number): void {
      void this.runNarration(bookId, [chId], { scope: "fill" });
    },
    /**
     * One line, asked for by hand. The server's smallest unit of work is a chapter at a scope: a
     * failed line is re-rendered with the chapter's other failed lines, and a line that did not
     * fail has nothing to retry.
     */
    retrySegment(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s && segmentFailed(s)) void this.runNarration(bookId, [chId], { scope: "failed" });
      else this._unavailable("Re-renders of one line");
    },
    /** Every request in this chapter that failed, and only those — a replacement that failed too. */
    retryFailed(bookId: string, chId: number): void {
      void this.runNarration(bookId, [chId], { scope: "failed" });
    },
    /** Say what the server cannot do yet, and change nothing. */
    _unavailable(what: string): void {
      const uiStore = useUiStore();
      uiStore.toast(`${what} are not available yet`, {
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
      void this._retake(bookId, chId, [segId]);
    },
    /** Every flagged segment in the chapter gets another take in one run. */
    retakeFlagged(bookId: string, chId: number): void {
      const scriptsStore = useScriptsStore();

      const flagged = scriptsStore.segmentsOf(bookId, chId).filter((s) => s.flag);
      void this._retake(
        bookId,
        chId,
        flagged.map((s) => s.id),
      );
    },
    /**
     * The lines are queued on the server as one job, each to render beside the clip it may
     * replace, and the queue's poll brings each candidate here when it lands. A line already
     * waiting on a verdict is left out and said so. Resolves to how many lines were queued.
     */
    async _retake(bookId: string, chId: number, ids: number[]): Promise<number> {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();
      if (!ids.length) return 0;
      try {
        const { job, queued, skipped, chapters } = await jobsService().retakeLines(
          bookId,
          chId,
          ids,
        );
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
    /** Keep the new take: it becomes the clip in the book, the old one joins the take list. */
    acceptTake(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      const cand = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId)?.candidate;
      if (!cand || cand.duration <= 0) return;
      void this._verdict(bookId, chId, segId, "accept");
    },
    /** Drop the new take. The clip in the book never moved, so only the take list changes. */
    rejectTake(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      if (!scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId)?.candidate) return;
      void this._verdict(bookId, chId, segId, "reject");
    },
    /**
     * The server swaps or discards the retake and answers with the line and the chapter as they now
     * stand, which replace what is here. There is no Undo: the displaced clip is in the take list,
     * where the comparison can be made again.
     */
    async _verdict(
      bookId: string,
      chId: number,
      segId: number,
      verdict: "accept" | "reject",
    ): Promise<void> {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();
      const k = key(bookId, chId);
      try {
        const { segment, revision, chapter } = await libraryService().judgeTake(
          bookId,
          chId,
          segId,
          verdict,
        );
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
  },
});
