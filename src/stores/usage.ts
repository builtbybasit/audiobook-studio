// Every request this session actually settled, in the order it settled. Append-only.
//
// Two things used to be worked out by looking at what the app is holding *right now*, and both of
// them lost requests that had really been made and really been paid for:
//
//   spending — totalled from the clip currently on each line, so accepting a retake made the money
//              already spent on the clip it displaced disappear, and reopened budget capacity that
//              had genuinely been used. Failed requests, rejected takes and superseded recordings
//              were all invisible for the same reason.
//   activity — read out of the live job simulator, so a request vanished from the Endpoint Activity
//              list the moment it finished and the page fell back to unrelated fixture history.
//
// A settled request is a fact about the past. Once one is written here it is never moved, never
// re-priced and never removed, whatever later happens to the clip or the script it produced — the
// same promise `PricedRequest` and `SpeechCharge` make about their own rates, kept at the level of
// the list rather than the individual receipt.
//
// Rows are `RequestRecord`s, the shape the Endpoints page already renders, so this session's work
// and the fixture service's invented week meet in one list rather than two. `simulated: false`
// marks them apart: these are requests this session put through the simulator, not backstory.
import { defineStore } from "pinia";
import type {
  EndpointKind,
  PricedRequest,
  ReqError,
  RequestRecord,
  RequestStatus,
  ScriptUsageRecord,
  SegmentMap,
  SpeechCharge,
  TokenUsage,
} from "@/types";
import { seedRead } from "@/stores/seed";

interface UsageState {
  /** append-only; the order is the order they settled in */
  requests: RequestRecord[];
  /**
   * What the seeded world had already spent on each book's narration before the session began.
   *
   * Taken from the **pristine** world, once, rather than from the clips the session is free to
   * move: a retry that puts a seeded clip back in the queue, a run that replaces one, a retake that
   * displaces one — none of them may change what was spent before any of it happened. Recomputed
   * on `$reset()`, because that restores the world this figure describes.
   */
  opening: Record<string, number>;
  _n: number;
}

/** What the clips of one seeded world cost, per book. */
function openingSpend(segments: SegmentMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, segs] of Object.entries(segments)) {
    const bookId = k.slice(0, k.lastIndexOf(":"));
    let total = out[bookId] ?? 0;
    for (const s of segs) total += s.audio.cost ?? 0;
    out[bookId] = total;
  }
  return out;
}

export const useUsageStore = defineStore("usage", {
  state: (): UsageState => ({
    requests: [],
    opening: seedRead((world) => openingSpend(world.segments)),
    _n: 0,
  }),
  getters: {
    /**
     * Settled rows from this session against one endpoint, newest first.
     *
     * Both halves of the identity are needed: a speech endpoint and a scripting profile are allowed
     * to share an id — the seeded world has an `openai` of each — and it is the pair that names one
     * endpoint, exactly as the page's own `scripting:openai` / `tts:openai` keys do.
     */
    ofEndpoint(s): (endpointId: string, kind: EndpointKind) => RequestRecord[] {
      return (endpointId: string, kind: EndpointKind) =>
        s.requests.filter((r) => r.endpointId === endpointId && r.kind === kind).reverse();
    },
    /**
     * The scripting half, in the shape the run panels and the budget have always read. Derived
     * rather than kept twice: one list of settled requests, two ways of looking at it.
     */
    scriptUsage(s): ScriptUsageRecord[] {
      return s.requests
        .filter((r) => r.kind === "scripting")
        .map((r) => ({
          bookId: r.bookId ?? "",
          profileId: r.endpointId,
          cost: r.cost ?? 0,
          inputTokens: r.usage.inputTokens ?? 0,
          outputTokens: r.usage.outputTokens ?? 0,
          ...(r.priced ? { priced: r.priced } : {}),
        }));
    },
    scriptSpent(s): (bookId: string) => number {
      return (bookId: string) =>
        s.requests
          .filter((r) => r.kind === "scripting" && r.bookId === bookId)
          .reduce((sum, r) => sum + (r.cost ?? 0), 0);
    },
    /** What this session's speech requests cost. Not what the clips currently in the book cost. */
    speechSpent(s): (bookId: string) => number {
      return (bookId: string) =>
        s.requests
          .filter((r) => r.kind === "tts" && r.bookId === bookId)
          .reduce((sum, r) => sum + (r.cost ?? 0), 0);
    },
    /**
     * What the seeded world had already spent on this book's narration before the session began.
     *
     * Those clips predate the ledger and have no receipt, so they are an opening balance rather
     * than a list of requests. Every clip rendered in this session has a row of its own instead, so
     * the two halves cannot overlap.
     */
    openingNarrationSpend(s): (bookId: string) => number {
      return (bookId: string) => s.opening[bookId] ?? 0;
    },
    /**
     * How much of the input recent requests on one endpoint actually had cached.
     *
     * Only requests whose provider *reported* cache detail count. A provider that says nothing is
     * left out rather than counted as a run of misses, so an endpoint that never reports returns
     * null and the estimate simply does not offer a cache-adjusted figure.
     */
    observedCache(s): (profileId: string) => { hitRate: number; samples: number } | null {
      return (profileId: string) => {
        const usages: TokenUsage[] = s.requests
          .filter((r) => r.kind === "scripting" && r.endpointId === profileId && r.priced)
          .slice(-40)
          .map((r) => r.priced!.usage);
        const reported = usages.filter((u) => u.cachedInput != null && u.inputTokens > 0);
        if (!reported.length) return null;
        const input = reported.reduce((n, u) => n + u.inputTokens, 0);
        const cached = reported.reduce((n, u) => n + (u.cachedInput ?? 0), 0);
        return input > 0 ? { hitRate: cached / input, samples: reported.length } : null;
      };
    },
  },
  actions: {
    /** The one way a row gets in. Nothing else writes `requests`, and nothing edits a row after. */
    _append(r: Omit<RequestRecord, "id" | "simulated">): RequestRecord {
      const row: RequestRecord = { ...r, id: `session-${this._n++}`, simulated: false };
      this.requests.push(row);
      return row;
    },
    /** One completed scripting request, with the receipt it was priced from. */
    recordScript(r: {
      bookId: string;
      chapterId: number | null;
      profileId: string;
      /** 1-based index within its chapter's run, for the row's label */
      request: number;
      attempts: number;
      queuedAt: number;
      startedAt: number;
      finishedAt: number;
      priced: PricedRequest;
    }): void {
      const u = r.priced.usage;
      this._append({
        endpointId: r.profileId,
        kind: "scripting",
        bookId: r.bookId,
        chapterId: r.chapterId,
        label: `Script chunk ${r.request}${r.chapterId == null ? "" : ` · ch ${r.chapterId}`}`,
        status: "done",
        attempts: r.attempts,
        queuedAt: r.queuedAt,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        queueMs: Math.max(0, r.startedAt - r.queuedAt),
        responseMs: Math.max(0, r.finishedAt - r.startedAt),
        usage: {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          ...(u.cachedInput != null ? { cachedInput: u.cachedInput } : {}),
          ...(u.cacheWrite ? { cacheWrite: u.cacheWrite } : {}),
        },
        cost: r.priced.total,
        costBasis: r.priced.basis,
        priced: r.priced,
      });
    },
    /**
     * One settled speech request, with the receipt it was charged at.
     *
     * A request that failed is still recorded and still charged for what it sent: that is what the
     * provider does, and leaving it out is how recorded spending drifts below what was actually
     * billed. `charge` already has the right answer for each billing unit — a per-minute endpoint
     * charges a failure nothing because no audio came back.
     */
    recordSpeech(r: {
      bookId: string;
      chapterId: number;
      endpointId: string;
      label: string;
      status: RequestStatus;
      queuedAt: number;
      startedAt: number;
      finishedAt: number;
      charge: SpeechCharge;
      error?: ReqError;
    }): void {
      this._append({
        endpointId: r.endpointId,
        kind: "tts",
        bookId: r.bookId,
        chapterId: r.chapterId,
        label: r.label,
        status: r.status,
        attempts: 1,
        queuedAt: r.queuedAt,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        queueMs: Math.max(0, r.startedAt - r.queuedAt),
        responseMs: Math.max(0, r.finishedAt - r.startedAt),
        // every quantity that was counted, not only the one this endpoint bills on: an endpoint
        // that changes billing model later still has history worth comparing
        usage: {
          chars: r.charge.units.chars,
          bytes: r.charge.units.bytes,
          ...(r.charge.units.textTokens != null ? { textTokens: r.charge.units.textTokens } : {}),
          audioSeconds: r.charge.units.audioSeconds,
          ...(r.charge.units.audioTokens != null
            ? { audioTokens: r.charge.units.audioTokens }
            : {}),
        },
        cost: r.charge.amount,
        costBasis: r.charge.basis,
        speech: r.charge,
        ...(r.error ? { error: r.error } : {}),
      });
    },
    /**
     * A request the provider refused before it did any work. No provider bills a 429, so it costs
     * nothing — but it happened, it is why the queue stalled, and the Activity list is the place
     * that explains a stall.
     */
    recordRefused(r: {
      bookId: string;
      chapterId: number;
      endpointId: string;
      kind: "scripting" | "tts";
      label: string;
      at: number;
      startedAt: number;
      error: ReqError;
    }): void {
      this._append({
        endpointId: r.endpointId,
        kind: r.kind,
        bookId: r.bookId,
        chapterId: r.chapterId,
        label: r.label,
        status: "failed",
        attempts: 1,
        queuedAt: r.startedAt,
        startedAt: r.startedAt,
        finishedAt: r.at,
        queueMs: 0,
        responseMs: Math.max(0, r.at - r.startedAt),
        usage: {},
        cost: 0,
        costBasis: "calculated",
        rateLimited: true,
        error: r.error,
      });
    },
    /**
     * Spending a demo scenario declares rather than a request anybody made — "this book has already
     * used its scripting budget". It is an opening balance, so it carries no receipt and is marked
     * as invented, which keeps it out of the Activity list while still counting against the cap.
     */
    recordOpeningScriptSpend(bookId: string, profileId: string, cost: number, at: number): void {
      this.requests.push({
        id: `opening-${this._n++}`,
        endpointId: profileId,
        kind: "scripting",
        bookId,
        chapterId: null,
        label: "Earlier scripting on this book",
        status: "done",
        attempts: 1,
        queuedAt: at,
        startedAt: at,
        finishedAt: at,
        queueMs: 0,
        responseMs: 0,
        usage: {},
        cost,
        costBasis: "calculated",
        simulated: true,
      });
    },
  },
});
