// Requests in flight and waiting, shaped like ledger rows so Activity shows both in one list.
// Speech counts and cooldowns are the server gate's (`endpointsStore.serverLoad`), across every job.
// Transcriber requests aren't reported in flight; they appear in the ledger once answered.
import type { Job, RequestRecord, WaitReason } from "@/types";
import { speechReadiness, type UnifiedEndpoint } from "@/lib/endpoints";
import { jobLabel } from "@/lib/queue";

import { useScriptsStore } from "@/stores/scripts";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";

export interface LiveActivity {
  active: number;
  queued: number;
  /** why the queued work isn't moving; null when nothing is waiting */
  waiting: WaitReason | null;
  /** the ceiling actually in force now */
  effectiveLimit: number;
}

const bookOf = (k: string): string => k.slice(0, k.lastIndexOf(":"));

type LiveRow = Omit<RequestRecord, "kind" | "endpointId" | "simulated">;
const liveRow = (u: UnifiedEndpoint, r: LiveRow): RequestRecord => ({
  ...r,
  kind: u.kind,
  endpointId: u.id,
  simulated: false,
});

export function useEndpointActivity() {
  const scriptsStore = useScriptsStore();
  const castStore = useCastStore();
  const jobsStore = useJobsStore();
  const libraryStore = useLibraryStore();
  const endpointsStore = useEndpointsStore();
  /** As the server's gate counts them. */
  function ttsCounts(u: UnifiedEndpoint): { active: number; queued: number } {
    const { active, waiting } = endpointsStore.serverLoad(u.id);
    return { active, queued: waiting };
  }

  function scriptingCounts(u: UnifiedEndpoint): { active: number; queued: number } {
    const runs = jobsStore.jobs.filter((j) => j.scriptRun?.profile.id === u.id && !j.finishedAt);
    return {
      active: runs.reduce((n, j) => n + j.scriptRun!.active, 0),
      queued: runs.reduce(
        (n, j) =>
          n + Math.max(0, j.scriptRun!.requests - j.scriptRun!.completed - j.scriptRun!.active),
        0,
      ),
    };
  }

  /** What holds work before any slot or budget does. */
  const readiness = (u: UnifiedEndpoint) => speechReadiness(u.entry, Date.now());

  function counts(u: UnifiedEndpoint): { active: number; queued: number } {
    switch (u.kind) {
      case "scripting":
        return scriptingCounts(u);
      case "tts":
        return ttsCounts(u);
      case "transcription":
        return { active: 0, queued: 0 };
    }
  }

  function waitReasonFor(u: UnifiedEndpoint, active: number, bookId: string | null): WaitReason {
    const { state } = readiness(u);
    if (state === "paused" || state === "nokey" || state === "cooldown") return state;
    if (active >= u.concurrency) return "concurrency";
    if (bookId) {
      const book = libraryStore.bookById(bookId);
      const cap = book?.budget?.cap;
      // spent plus reserved: a request waits on the budget once the cap is committed. A book whose
      // spending is unread is not said to be waiting on it.
      const spent = jobsStore.spent(bookId);
      const reserved = jobsStore.reserved(bookId);
      if (cap != null && spent != null && reserved != null && spent + reserved >= cap)
        return "budget";
      const scriptSpent = jobsStore.scriptSpent(bookId);
      const scriptReserved = jobsStore.scriptReserved(bookId);
      if (
        u.kind === "scripting" &&
        book?.scriptBudget != null &&
        scriptSpent != null &&
        scriptReserved != null &&
        scriptSpent + scriptReserved >= book.scriptBudget
      )
        return "budget";
    }
    return "ordered";
  }

  function liveActivity(u: UnifiedEndpoint): LiveActivity {
    const { active, queued } = counts(u);
    const waiting = queued ? waitReasonFor(u, active, null) : null;
    // paused, keyless or cooling down: the ceiling in force is zero
    const { state } = readiness(u);
    const effectiveLimit =
      state === "paused" || state === "nokey" || state === "cooldown" ? 0 : u.concurrency;
    return { active, queued, waiting, effectiveLimit };
  }

  /** Unfinished jobs using this endpoint: what a Cancel would hit. */
  function jobsUsing(u: UnifiedEndpoint): Job[] {
    switch (u.kind) {
      case "scripting":
        return jobsStore.jobs.filter((j) => j.scriptRun?.profile.id === u.id && !j.finishedAt);
      case "tts":
        return jobsStore.jobs.filter((j) => {
          if (j.kind !== "narration" || j.finishedAt || j.chapterId == null) return false;
          return scriptsStore
            .segmentsOf(j.bookId, j.chapterId)
            .some(
              (s) =>
                s.audio.endpoint === u.id ||
                castStore.effectiveVoice(j.bookId, s.speaker).endpoint?.id === u.id,
            );
        });
      // no job sends to a transcriber; the clone form does
      case "transcription":
        return [];
    }
  }

  function liveRequests(u: UnifiedEndpoint, now: number): RequestRecord[] {
    switch (u.kind) {
      case "scripting":
        return scriptingRequests(u, now);
      case "tts":
        return speechRequests(u, now);
      case "transcription":
        return [];
    }
  }

  function scriptingRequests(u: UnifiedEndpoint, now: number): RequestRecord[] {
    const rows: RequestRecord[] = [];
    const push = (r: LiveRow) => rows.push(liveRow(u, r));

    for (const j of jobsStore.jobs.filter(
      (x) => x.scriptRun?.profile.id === u.id && !x.finishedAt,
    )) {
      const run = j.scriptRun!;
      const started = j.startedAt ?? j.queuedAt;
      const label = jobLabel(
        "Script chunk",
        j.chapterId == null ? undefined : libraryStore.chapterRef(j.bookId, j.chapterId),
      );
      for (let i = 0; i < run.active; i++)
        push({
          id: `job-${j.id}-run-${i}`,
          bookId: j.bookId,
          chapterId: j.chapterId,
          label,
          status: "running",
          attempts: 1,
          queuedAt: j.queuedAt,
          startedAt: started,
          finishedAt: null,
          queueMs: Math.max(0, started - j.queuedAt),
          responseMs: Math.max(0, now - started),
          usage: {},
          cost: null,
          costBasis: "estimated",
        });
      const waiting = Math.max(0, run.requests - run.completed - run.active);
      for (let i = 0; i < waiting; i++)
        push({
          id: `job-${j.id}-wait-${i}`,
          bookId: j.bookId,
          chapterId: j.chapterId,
          label,
          status: "queued",
          attempts: 0,
          queuedAt: j.queuedAt,
          startedAt: null,
          finishedAt: null,
          queueMs: Math.max(0, now - j.queuedAt),
          responseMs: 0,
          waiting: waitReasonFor(u, run.active, j.bookId),
          usage: {},
          cost: null,
          costBasis: "estimated",
        });
    }
    return rows;
  }

  function speechRequests(u: UnifiedEndpoint, now: number): RequestRecord[] {
    const rows: RequestRecord[] = [];
    const push = (r: LiveRow) => rows.push(liveRow(u, r));

    const { active } = ttsCounts(u);
    for (const [k, segs] of Object.entries(scriptsStore.segments)) {
      const bookId = bookOf(k);
      const chapterId = Number(k.slice(k.lastIndexOf(":") + 1));
      for (const s of segs)
        for (const [slot, clip] of [
          ["audio", s.audio],
          ["candidate", s.candidate],
        ] as const) {
          if (!clip) continue;
          const label = `${slot === "candidate" ? "Retake" : "Line"} ${s.id} · ${s.speaker}`;
          if (clip.status === "generating" && clip.endpoint === u.id) {
            const started = clip.startedAt ?? now;
            push({
              id: `seg-${bookId}-${chapterId}-${s.id}-${slot}`,
              bookId,
              chapterId,
              label,
              status: "running",
              attempts: 1,
              queuedAt: started,
              startedAt: started,
              finishedAt: null,
              queueMs: 0,
              responseMs: Math.max(0, now - started),
              usage: { chars: (clip.said ?? clip.text ?? s.text).length },
              cost: null,
              costBasis: "estimated",
            });
          } else if (
            clip.status === "queued" &&
            castStore.effectiveVoice(bookId, s.speaker).endpoint?.id === u.id
          ) {
            push({
              id: `seg-${bookId}-${chapterId}-${s.id}-${slot}-q`,
              bookId,
              chapterId,
              label,
              status: "queued",
              attempts: 0,
              queuedAt: now,
              startedAt: null,
              finishedAt: null,
              queueMs: 0,
              responseMs: 0,
              waiting: waitReasonFor(u, active, bookId),
              usage: { chars: s.text.length },
              cost: null,
              costBasis: "estimated",
            });
          }
        }
    }
    return rows;
  }

  return { liveActivity, liveRequests, jobsUsing, waitReasonFor };
}
