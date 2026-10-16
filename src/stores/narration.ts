import type { ExpressionPlan } from "@/lib/expressions";
// Narration, expression preflight and retakes. Accepted audio stays on the script segments.
import { annotationFrom, expressionSupport, pauseAnnotation, validToken } from "@/lib/expressions";
import { compareReading, prepareReading, type Reading } from "@/lib/reading";
import { narrationPlan, narrationTargets, SCOPE_LABEL, segmentFailed } from "@/lib/runPlan";
import { isSpoken } from "@/lib/siteText";
import type {
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
import { plural } from "@/lib/contents";
import { key } from "@/lib/scriptReview";
import { jobsService } from "@/services/jobs";
import { libraryService } from "@/services/library";
import { fetchCast } from "@/queries/cast";
import { fetchScript } from "@/queries/chapterScript";
import { fetchSpend } from "@/queries/spend";
import type { SpeechEstimate } from "@/types";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";

/**
 * Adopt the revision a one-line write moved to, only when it is the very next one. Further on,
 * another write (a clip landed) came in between that this copy has not read; naming it would let
 * the next edit overwrite that.
 */
function stepRevision(bookId: string, chId: number, revision: number): void {
  const scriptsStore = useScriptsStore();
  if (scriptsStore._revision[key(bookId, chId)] === revision - 1)
    scriptsStore._adoptRevision(bookId, chId, revision);
}

export const useNarrationStore = defineStore("narration", {
  getters: {
    /**
     * Exactly what a line is sent as now (`@/lib/reading`), as the server reads it too: on the
     * endpoint its voice names even when that endpoint no longer lists it (`endpoints.endpointOf`).
     */
    reading(): (bookId: string, s: Segment) => Reading {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();

      return (bookId, s) => {
        const voice = castStore.effectiveVoice(bookId, s.speaker);
        return prepareReading(
          s,
          {
            endpoint: endpointsStore.endpointOf(voice.ref),
            voiceRef: voice.ref,
            style: castStore.byName[bookId]?.get(s.speaker)?.style,
          },
          castStore.lexiconOf(bookId),
          castStore.pacingOf(bookId),
        );
      };
    },
    /** The words of a line's reading: what the editor previews and the issues it shows. */
    expressionRender(): (bookId: string, segment: Segment) => ExpressionPlan {
      return (bookId, segment) => this.reading(bookId, segment).plan;
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
            // issues are only about a line's own expressions; skipping lines with none saves
            // most of a long book's cost here
            s.expressions?.length
              ? this.expressionRender(bookId, s).issues.map((issue) => ({
                  ...issue,
                  chId,
                  segId: s.id,
                  speaker: s.speaker,
                }))
              : [],
          ),
        );
    },
    /** What a clip was rendered with that the script no longer says; empty means current. Must
     *  agree with the server's `compareReading`. */
    clipDrift(): (bookId: string, s: Segment, a?: SegmentAudio) => string[] {
      const endpointsStore = useEndpointsStore();

      return (bookId, s, a = s.audio) =>
        a.at ? compareReading(a, s, this.reading(bookId, s), endpointsStore.voiceLabel) : [];
    },
    /**
     * Lines the script has moved past: stale clips, plus unrendered lines once the chapter has
     * been narrated at all. Every "re-narrate changed (N)" count reads this, matching what
     * `renarrateStale` asks the server for.
     */
    changedSegments(): (bookId: string, chId: number) => Segment[] {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return (bookId, chId) => {
        const started = libraryStore.chapter(bookId, chId)?.narration !== "none";
        const book = libraryStore.bookById(bookId);
        // a line the book does not read has no clip to be out of date (`narrationTargets`)
        return scriptsStore
          .segmentsOf(bookId, chId)
          .filter(
            (s) =>
              isSpoken(s, book) &&
              (s.audio.status === "stale" || (started && s.audio.status === "none")),
          );
      };
    },
    /**
     * Why this run cannot start, in fix-it order; empty when it can. `startRun` refuses on the same
     * list. Built on the estimate's `worstCase`, the figure the server reserves against the cap
     * (`@/lib/narrationCost`): a per-endpoint sum of undiscounted prices, never one max over the
     * total. Takes the estimate rather than recomputing it on every progress tick.
     */
    blockers(): (bookId: string, est: NarrationEstimate) => string[] {
      const castStore = useCastStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();

      return (bookId, est) => {
        const out: string[] = [];
        if (!castStore.charactersOf(bookId).find((c) => c.name === "Narrator")?.voice)
          out.push("Assign the Narrator’s voice to start.");
        const book = libraryStore.bookById(bookId);
        if (book?.budget?.paused) out.push("This book is paused (overview → resume).");
        if (est.unrouted)
          out.push(
            `${est.unrouted} line${est.unrouted === 1 ? "" : "s"} have no voice to render with. Assign one on Cast first.`,
          );
        const cap = book?.budget?.cap;
        if (est.segments && cap != null) {
          const cost = est.worstCase;
          // the ledger's sums, or nothing while unread: never a zero for uncounted spending
          const spent: number | undefined = jobsStore.spent(bookId);
          const held: number | undefined = jobsStore.reserved(bookId);
          if (spent == null || held == null)
            out.push("Reading what this book has spent, to check this run against its cap…");
          else if (spent + held + cost > cap)
            out.push(
              `Over the book's $${cap.toFixed(2)} cap: $${spent.toFixed(2)} spent` +
                (held > 0 ? `, $${held.toFixed(2)} held by work already running` : "") +
                `, ${money(cost)} for this — priced without today's discounts, because they can end mid-run.`,
            );
        }
        const byReason: Record<string, string[]> = {};
        for (const i of castStore.routingIssues(bookId)) (byReason[i.reason] ??= []).push(i.name);
        for (const [reason, names] of Object.entries(byReason))
          out.push(
            `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}: ${reason}.`,
          );
        return out;
      };
    },
    /** How many endpoint requests one line becomes, after expressions and the endpoint's limit. */
    requestsFor(): (bookId: string, seg: Segment) => number {
      return (bookId, seg) => this.reading(bookId, seg).requests;
    },
    /**
     * Names the kinds behind `plan.skippedLines` ("3 lines of site text and 2 notes are not
     * read"), reading the plan's chapters by the same `isSpoken`. Empty when nothing is skipped.
     */
    unreadNote(): (bookId: string, plan: RunPlan) => string {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return (bookId, plan) => {
        if (!plan.skippedLines) return "";
        const book = libraryStore.bookById(bookId);
        const looked = [
          ...plan.chapters.map((c) => c.id),
          ...plan.skipped
            .filter((c) => c.reason === "nothing" || c.reason === "pending")
            .map((c) => c.id),
        ];
        let site = 0;
        let notes = 0;
        for (const id of looked)
          for (const s of scriptsStore.segmentsOf(bookId, id))
            if (!isSpoken(s, book)) {
              if (s.type === "note") notes++;
              else site++;
            }
        const parts = [
          site ? `${plural(site, "line")} of site text` : "",
          notes ? plural(notes, "note") : "",
        ].filter(Boolean);
        return `${parts.join(" and ")} ${site + notes === 1 ? "is" : "are"} not read`;
      };
    },
    /**
     * What running this selection at this scope would do per chapter, with reasons for skipped
     * chapters. The server queues by the same `narrationTargets`.
     */
    narrationRunPlan(): (
      bookId: string,
      ids: number[],
      scope?: NarrationScope,
      keepPending?: boolean,
    ) => RunPlan {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return (bookId, ids, scope = "all", keepPending = true) => {
        const picked = new Set(ids);
        return narrationPlan(
          libraryStore.chaptersOf(bookId).filter((c) => picked.has(c.id)),
          scope,
          {
            segmentsOf: (chId) => scriptsStore.segmentsOf(bookId, chId),
            requestsOf: (s) => this.requestsFor(bookId, s),
            keepPending,
            book: libraryStore.bookById(bookId),
          },
        );
      };
    },
    /**
     * What these lines would submit to each endpoint and cost at `at`, in each endpoint's billing
     * unit; unroutable lines go in `unrouted`. Each line is measured on its reading
     * (`plannedSpeechUnits`), as the server measures the real request. Includes the undiscounted
     * figure the cap is checked against.
     */
    _pricedByEndpoint(): (
      bookId: string,
      segs: Segment[],
      at: number,
    ) => { rows: { row: EndpointEstimate; priced: SpeechEstimate }[]; unrouted: number } {
      return (bookId, segs, at) => {
        const per: Record<string, EndpointEstimate> = {};
        let unrouted = 0;
        for (const seg of segs) {
          const reading = this.reading(bookId, seg);
          const ep = reading.reader.endpoint;
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
          e.units = addUnits(e.units, plannedSpeechUnits(reading, ep));
          e.segments++;
          const parts = reading.requests;
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
    // Counts only the lines the chosen scope would send: "retry failed" over a finished book is a
    // handful of requests.
    estimate(): (
      bookId: string,
      ids: number[],
      scope?: NarrationScope,
      keepPending?: boolean,
    ) => NarrationEstimate {
      return (bookId, ids, scope = "all", keepPending = true) =>
        this.estimateOf(
          bookId,
          this.narrationRunPlan(bookId, ids, scope, keepPending),
          keepPending,
        );
    },
    /** `estimate` from a plan already in hand, so every panel reads one plan and one estimate. */
    estimateOf(): (bookId: string, plan: RunPlan, keepPending?: boolean) => NarrationEstimate {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return (bookId, plan, keepPending = true) => {
        const scope = plan.scope ?? "all";
        const book = libraryStore.bookById(bookId);
        // The plan decides the chapters; re-deriving eligibility here would let panel and button
        // disagree about the same press.
        const lines: Segment[] = [];
        let chars = 0;
        let stale = 0;
        for (const row of plan.chapters) {
          const { run } = narrationTargets(
            scriptsStore.segmentsOf(bookId, row.id),
            scope,
            keepPending,
            book,
          );
          for (const seg of run) {
            chars += seg.text.length;
            if (seg.audio.status === "stale") stale++;
            lines.push(seg);
          }
        }
        // One instant for the whole estimate, so the rows agree with each other and the total.
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
          // every step that moved this endpoint's rates off its card, in order, resolved once
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
          // the cap's own figure, so the panel and the strip's blockers cannot disagree
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
      const config = ep?.expressions;
      // a listed tag, or on a model that takes any words in its brackets, the one typed
      const definition =
        config?.tags.find((t) => t.id === tag.id) ??
        (config?.open && validToken(tag.token, config.brackets) ? tag : undefined);
      if (
        expressionSupport(ep) !== "supported" ||
        !definition ||
        !Number.isInteger(at) ||
        at < 0 ||
        at > s.text.length
      )
        return;
      const { undo } = this._annotate(bookId, chId, s, (id) => annotationFrom(definition, at, id));
      uiStore.toast(`${definition.label} added`, {
        description: "The source text is unchanged. Re-render this line to hear the expression.",
        undo,
      });
    },
    /**
     * A pause at `at`, as long as the book's short pause. Needs no tag: a voice without a pause tag
     * hears silence. Returns the new pause's id, for the editor to open it.
     */
    addPause(bookId: string, chId: number, segId: number, at: number): number | null {
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((s) => s.id === segId);
      if (!s || !Number.isInteger(at) || at < 0 || at > s.text.length) return null;
      const { id, undo } = this._annotate(bookId, chId, s, (id) =>
        pauseAnnotation("pause", at, id),
      );
      uiStore.toast("Pause added", { description: "Re-render this line to hear it.", undo });
      return id;
    },
    /** Put the annotation `make` makes on line `s` as one edit: its id, and the edit's Undo. */
    _annotate(
      bookId: string,
      chId: number,
      s: Segment,
      make: (annotationId: number) => ExpressionAnnotation,
    ): { id: number; undo: () => void } {
      const scriptsStore = useScriptsStore();

      const undo = scriptsStore._editSnapshot(bookId, chId);
      const id = Math.max(0, ...(s.expressions ?? []).map((a) => a.annotationId)) + 1;
      (s.expressions ??= []).push(make(id));
      s.edited = true;
      scriptsStore._markStale(bookId, chId, s);
      scriptsStore._commit(bookId, chId);
      return { id, undo };
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
      // dragging a tag back where it was is not an edit: no history entry, no stale clip
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
    // Every run is the server's: it picks lines, renders, lands clips, and enforces the budget
    // (409 with a sentence the toast shows). Nothing changes here before the server answers.
    /**
     * Narrate the given chapters as one run at `scope`. A line with a playable clip renders its
     * replacement beside it. Chapters the server left out are named in the toast. True when
     * anything was queued. Checks no blockers; use `startRun` for that.
     */
    async runNarration(
      bookId: string,
      ids: number[],
      { scope = "all", quiet = false }: { scope?: NarrationScope; quiet?: boolean } = {},
    ): Promise<boolean> {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      if (libraryStore._blocked(bookId, "narrate")) return false;
      try {
        const { jobs, skipped, chapters } = await jobsService().narrateChapters(bookId, ids, scope);
        libraryStore.chapters[bookId] = chapters;
        await jobsStore._changed();
        if (quiet) return jobs.length > 0;
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
          return false;
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
        return true;
      } catch (cause) {
        toastFailure("queue narration", cause);
        return false;
      }
    },
    /**
     * Start a run as the run strip would, refusing with the reason while `blockers` has any. A
     * Queue retry may be for a book no page has open, so its scripts, cast and spending are read
     * first. True when anything was queued.
     */
    async startRun(
      bookId: string,
      ids: number[],
      opts: { scope?: NarrationScope; quiet?: boolean } = {},
    ): Promise<boolean> {
      const castStore = useCastStore();
      const jobsStore = useJobsStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      // a failed read leaves its part unread, and the blockers then say so
      const quietly = (read: Promise<unknown>) => read.catch(() => {});
      await Promise.all([
        ...ids
          .filter((chId) => !scriptsStore.held(bookId, chId))
          .map((chId) => quietly(fetchScript(bookId, chId))),
        castStore.held(bookId) ? undefined : quietly(fetchCast(bookId)),
        jobsStore.spendOf(bookId) ? undefined : quietly(fetchSpend(bookId)),
      ]);
      const blockers = this.blockers(bookId, this.estimate(bookId, ids, opts.scope));
      if (blockers.length) {
        uiStore.toast("Narration can’t start yet", {
          kind: "warn",
          description: blockers.join(" "),
          timeout: 8000,
        });
        return false;
      }
      return this.runNarration(bookId, ids, opts);
    },
    /** The "missing & changed" scope over one chapter, as the server counts it. */
    renarrateStale(bookId: string, chId: number): void {
      void this.startRun(bookId, [chId], { scope: "fill" });
    },
    /**
     * The server's smallest unit is a chapter at a scope: a failed line reruns with the chapter's
     * other failed lines; a line that did not fail has nothing to retry.
     */
    retrySegment(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (s && segmentFailed(s)) void this.startRun(bookId, [chId], { scope: "failed" });
      else this._unavailable("Re-renders of one line");
    },
    /** Every failed request in this chapter, including failed replacements. */
    retryFailed(bookId: string, chId: number): void {
      void this.startRun(bookId, [chId], { scope: "failed" });
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
    // ---------- audio review & retakes ----------
    // A retake renders into `segment.candidate`, never `segment.audio`: the book's clip keeps
    // playing, timing and exporting until the listener accepts the new one; the loser stays in the
    // take list.
    /**
     * Raise or replace a line's flag. Shows at once; the server writes it to that line alone
     * (`_writeFlag`), a bulk flag one line at a time. Resolves once answered.
     */
    flagSegment(
      bookId: string,
      chId: number,
      segId: number,
      kind: FlagKind,
      note: string = "",
    ): Promise<void> {
      const scriptsStore = useScriptsStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s) return Promise.resolve();
      const was = s.flag;
      s.flag = { kind, note: note.trim(), at: Date.now() } satisfies SegmentFlag;
      return this._writeFlag(bookId, chId, segId, { kind, note: s.flag.note }, was);
    },
    clearFlag(bookId: string, chId: number, segId: number): Promise<void> {
      const scriptsStore = useScriptsStore();

      const s = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!s?.flag) return Promise.resolve();
      const was = s.flag;
      delete s.flag;
      return this._writeFlag(bookId, chId, segId, null, was);
    },
    /**
     * Write one line's flag only. It names no revision, so a run landing clips cannot refuse it;
     * the answer replaces the flag shown, and a refusal restores the old one. It still moves the
     * revision on, so it takes its turn among the chapter's writes (`scripts._writeLine`).
     */
    async _writeFlag(
      bookId: string,
      chId: number,
      segId: number,
      flag: Pick<SegmentFlag, "kind" | "note"> | null,
      was: SegmentFlag | undefined,
    ): Promise<void> {
      const scriptsStore = useScriptsStore();
      const line = () => scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      try {
        await scriptsStore._writeLine(bookId, chId, async () => {
          const answer = await libraryService().flagLine(bookId, chId, segId, flag);
          // taken before the chapter's next write, so that one sends it and names its revision
          const s = line();
          if (s) {
            if (answer.flag) s.flag = answer.flag;
            else delete s.flag;
          }
          stepRevision(bookId, chId, answer.revision);
        });
      } catch (cause) {
        const s = line();
        if (s) {
          if (was) s.flag = was;
          else delete s.flag;
        }
        toastFailure(flag ? "flag this line" : "clear this flag", cause);
      }
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
     * Queue the lines as one server job, each rendering beside the clip it may replace. A line
     * already awaiting a verdict is skipped and said so. Resolves to how many were queued.
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
        toastFailure("queue the retake", cause);
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
     * The server swaps or discards the retake and answers with the line and chapter. No Undo: the
     * displaced clip stays in the take list.
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
        stepRevision(bookId, chId, revision);
        const c = libraryStore.chapter(bookId, chId);
        if (c) Object.assign(c, chapter);
        // the server checks whichever clip stays against the line as it reads now
        const stale = segment.audio.status === "stale";
        const why = stale ? this.clipDrift(bookId, segment)[0] : undefined;
        const outOfDate = `The kept clip is out of date${why ? ` — ${why}` : ""}.`;
        if (verdict === "accept") {
          uiStore.toast(`Take ${segment.audio.n ?? 1} kept`, {
            kind: stale ? "warn" : "success",
            description: stale
              ? outOfDate
              : "It is the clip in the book now; the earlier take stays in the take list.",
          });
          return;
        }
        const rejected = segment.audio.takes?.at(-1);
        uiStore.toast(
          rejected?.rejected ? `Take ${segment.audio.n ?? 1} kept` : "Retake discarded",
          {
            kind: stale ? "warn" : "info",
            description: stale
              ? outOfDate
              : rejected?.rejected
                ? `Take ${rejected.n} is marked rejected — retake again or edit the line first.`
                : "It never produced a clip.",
          },
        );
      } catch (cause) {
        toastFailure(verdict === "accept" ? "keep this take" : "discard this take", cause);
      }
    },
  },
});
