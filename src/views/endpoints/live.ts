// What this endpoint is doing *right now*, read out of the running job simulator rather than the
// fixture service. Two different things end up in the same Activity list:
//
//   `simulated: true`  — sample history invented by the fixture service (the backstory)
//   `simulated: false` — work this session actually put through the job simulator
//
// Both are make-believe in the sense that no provider is called; the flag separates "made up
// before you got here" from "you started this a minute ago", and the list labels each.
import { keyring } from "@/lib/keyring";
import type { Job, RequestRecord, WaitReason } from "@/types";
import type { UnifiedEndpoint } from "@/lib/endpoints";

import { useScriptsStore } from "@/stores/scripts";
import { useCastStore } from "@/stores/cast";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";

export interface LiveActivity {
  active: number;
  queued: number;
  /** why the queued work isn't moving; null when nothing is waiting */
  waiting: WaitReason | null;
  /** the configured ceiling, and the smaller ceiling actually in force right now */
  effectiveLimit: number;
}

const bookOf = (k: string): string => k.slice(0, k.lastIndexOf(":"));

export function useEndpointActivity() {
  const scriptsStore = useScriptsStore();
  const castStore = useCastStore();
  const jobsStore = useJobsStore();
  const libraryStore = useLibraryStore();
  /** Segments routed to this TTS endpoint, by the voice their speaker resolves to. */
  function ttsCounts(u: UnifiedEndpoint): { active: number; queued: number } {
    let active = 0;
    let queued = 0;
    for (const [k, segs] of Object.entries(scriptsStore.segments)) {
      const bookId = bookOf(k);
      for (const s of segs)
        for (const clip of [s.audio, s.candidate]) {
          if (!clip) continue;
          if (clip.status === "generating") {
            if (clip.endpoint === u.id) active++;
          } else if (clip.status === "queued") {
            if (castStore.effectiveVoice(bookId, s.speaker).endpoint?.id === u.id) queued++;
          }
        }
    }
    return { active, queued };
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

  function waitReasonFor(u: UnifiedEndpoint, active: number, bookId: string | null): WaitReason {
    if (!u.enabled) return "paused";
    if (u.needsKey && !keyring.has(u.slot)) return "nokey";
    if (u.backoffUntil > Date.now()) return "cooldown";
    if (active >= u.concurrency) return "concurrency";
    if (bookId) {
      const book = libraryStore.bookById(bookId);
      const cap = book?.budget?.cap;
      if (cap != null && jobsStore.spent(bookId) >= cap) return "budget";
      if (
        u.kind === "scripting" &&
        book?.scriptBudget != null &&
        jobsStore.scriptSpent(bookId) >= book.scriptBudget
      )
        return "budget";
    }
    return "ordered";
  }

  function liveActivity(u: UnifiedEndpoint): LiveActivity {
    const { active, queued } = u.kind === "scripting" ? scriptingCounts(u) : ttsCounts(u);
    const waiting = queued ? waitReasonFor(u, active, null) : null;
    // pausing or a cooldown drops the ceiling that is actually in force to zero
    const effectiveLimit =
      !u.enabled || u.backoffUntil > Date.now() || (u.needsKey && !keyring.has(u.slot))
        ? 0
        : u.concurrency;
    return { active, queued, waiting, effectiveLimit };
  }

  /** Unfinished jobs that would put requests through this endpoint — what a Cancel would hit. */
  function jobsUsing(u: UnifiedEndpoint): Job[] {
    if (u.kind === "scripting")
      return jobsStore.jobs.filter((j) => j.scriptRun?.profile.id === u.id && !j.finishedAt);
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
  }

  /** In-flight and waiting requests, shaped like history rows so one list can show both. */
  function liveRequests(u: UnifiedEndpoint, now: number): RequestRecord[] {
    const rows: RequestRecord[] = [];
    const push = (r: Omit<RequestRecord, "kind" | "endpointId" | "simulated">) =>
      rows.push({ ...r, kind: u.kind, endpointId: u.id, simulated: false });

    if (u.kind === "scripting") {
      for (const j of jobsStore.jobs.filter(
        (x) => x.scriptRun?.profile.id === u.id && !x.finishedAt,
      )) {
        const run = j.scriptRun!;
        const started = j.startedAt ?? j.queuedAt;
        for (let i = 0; i < run.active; i++)
          push({
            id: `job-${j.id}-run-${i}`,
            bookId: j.bookId,
            chapterId: j.chapterId,
            label: `Script chunk · ch ${j.chapterId}`,
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
            label: `Script chunk · ch ${j.chapterId}`,
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
