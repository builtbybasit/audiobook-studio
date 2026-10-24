// Chapter script history: a chapter's versions, and restoring one. The working script is kept
// before anything replaces it, labelled by what produced it; edits less than `SESSION_IDLE_MS`
// apart are one entry. The server applies this (`planCapture` in `@/lib/scriptHistory`) as it
// writes, so nothing here captures a version. Versions hold script content only; a restore
// carries clips across.
import { chapterName } from "@/lib/chapterNumber";
import { key } from "@/lib/scriptReview";
import { compareScripts, originLabel, planRestore, restoreConsequences } from "@/lib/scriptHistory";
import { clone } from "@/lib/utils";
import { libraryService } from "@/services/library";
import type {
  ChapterHistory,
  HistoryHead,
  Job,
  JobKind,
  RestorePlan,
  ScriptComparison,
  ScriptVersion,
  VersionOrigin,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";

/** Runs that write into a chapter's script (lines, clips, flags, re-applied files). */
const LANDS_ON_SCRIPT: Record<JobKind, boolean> = {
  scripting: true,
  narration: true,
  transcribe: true,
  export: false,
  effects: true,
};

const nameOf = (bookId: string, chId: number) =>
  chapterName(useLibraryStore().numberOf(bookId, chId));

const emptyHead = (): HistoryHead => ({ at: 0, origin: { kind: "scripted" } });
const emptyHistory = (): ChapterHistory => ({ versions: [], head: emptyHead(), nextId: 1 });

/** A chapter's script written over by a restore or an import: what came of it, and its undo. */
export interface Rewrite {
  /** speakers a line names that the cast lacked, added to it unreviewed */
  absorbed: string[];
  /**
   * each of `absorbed` written to the cast after the chapter's write: false when refused, or when
   * that write was refused and no line names them, so they were taken off unwritten
   */
  pushed: Promise<boolean>[];
  /** whether the write landed; a refused one has already been read back over and said */
  landed: Promise<boolean>;
  /**
   * Put back the script and chapter status as an edit; resolves with whether that landed. A
   * rewrite that never landed resolves false without touching the chapter.
   */
  undo: () => Promise<boolean>;
}

interface HistoryState {
  /** keyed `${bookId}:${chapterId}` */
  chapters: Record<string, ChapterHistory>;
}

export const useHistoryStore = defineStore("history", {
  state: (): HistoryState => ({ chapters: {} }),
  getters: {
    /** Empty for a chapter nothing has happened to yet. */
    historyOf(s): (bookId: string, chId: number) => ChapterHistory {
      return (bookId, chId) => s.chapters[key(bookId, chId)] ?? emptyHistory();
    },
    /** The saved versions, newest first. */
    versionsOf(): (bookId: string, chId: number) => ScriptVersion[] {
      return (bookId, chId) => [...this.historyOf(bookId, chId).versions].reverse();
    },
    headOf(): (bookId: string, chId: number) => HistoryHead {
      return (bookId, chId) => this.historyOf(bookId, chId).head;
    },
    /** What changed between one version and the script as it stands. */
    comparisonOf(): (bookId: string, chId: number, versionId: number) => ScriptComparison | null {
      const scriptsStore = useScriptsStore();

      return (bookId, chId, versionId) => {
        const v = this.historyOf(bookId, chId).versions.find((x) => x.id === versionId);
        return v ? compareScripts(v.segments, scriptsStore.segmentsOf(bookId, chId)) : null;
      };
    },
    /** What restoring one would do, touching nothing. */
    restorePlanOf(): (bookId: string, chId: number, versionId: number) => RestorePlan | null {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const narrationStore = useNarrationStore();
      const scriptsStore = useScriptsStore();

      return (bookId, chId, versionId) => {
        const v = this.historyOf(bookId, chId).versions.find((x) => x.id === versionId);
        if (!v) return null;
        return planRestore(scriptsStore.segmentsOf(bookId, chId), v.segments, {
          drift: (segment, audio) => narrationStore.clipDrift(bookId, segment, audio),
          cast: new Set(castStore.charactersOf(bookId).map((c) => c.name)),
          book: libraryStore.bookById(bookId),
        });
      };
    },
    /** Runs that would land on this chapter; restoring waits for them rather than racing them. */
    busyJobs(): (bookId: string, chId: number) => Job[] {
      const jobsStore = useJobsStore();

      return (bookId, chId) =>
        jobsStore.jobs.filter(
          (j) =>
            j.bookId === bookId && j.chapterId === chId && !j.finishedAt && LANDS_ON_SCRIPT[j.kind],
        );
    },
  },
  actions: {
    // ---------- the seam ----------
    _install(bookId: string, chId: number, history: ChapterHistory): void {
      this.chapters[key(bookId, chId)] = history;
    },
    // ---------- checkpoints ----------
    /**
     * Name the script and keep a copy on the server; the working script is unchanged. Undo forgets
     * the version, which puts the head back too.
     */
    async saveCheckpoint(
      bookId: string,
      chId: number,
      name: string,
    ): Promise<ScriptVersion | null> {
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const title = name.trim();
      if (!title || !scriptsStore.segmentsOf(bookId, chId).length) return null;
      const svc = libraryService();
      let version: ScriptVersion;
      try {
        const saved = await svc.saveCheckpoint(bookId, chId, title);
        version = saved.version;
        this._install(bookId, chId, saved.history);
      } catch (cause) {
        toastFailure("save this checkpoint", cause);
        return null;
      }
      uiStore.toast(`Checkpoint saved: “${title}”`, {
        kind: "success",
        description: `v${version.id} · ${version.segments.length} lines of ${nameOf(bookId, chId)}. The script itself is untouched.`,
        undo: async () => {
          try {
            this._install(bookId, chId, await svc.dropVersion(bookId, chId, version.id));
          } catch (cause) {
            toastFailure("forget this checkpoint", cause);
          }
        },
      });
      return version;
    },
    // ---------- restoring ----------
    /**
     * Restore one version as a new entry (later versions kept), carrying clips across, written
     * under a `restored` origin. Undo writes the old script back as an edit.
     */
    restore(bookId: string, chId: number, versionId: number): boolean {
      const castStore = useCastStore();
      const uiStore = useUiStore();

      const h = this.chapters[key(bookId, chId)];
      const version = h?.versions.find((v) => v.id === versionId);
      if (!version) return false;
      const busy = this.busyJobs(bookId, chId);
      if (busy.length) {
        // the job's label names the work alone ("Narrate"); the chapter is the one in the title
        uiStore.toast(`A run is in flight on ${nameOf(bookId, chId)}`, {
          kind: "warn",
          description: `${busy[0].label} would write over anything restored now. Cancel it first — the run's own results are not undoable.`,
        });
        return false;
      }
      const plan = this.restorePlanOf(bookId, chId, versionId);
      if (!plan) return false;
      if (plan.comparison.identical) {
        uiStore.toast(`v${version.id} is already the current script`, {
          kind: "info",
          description: "Nothing to restore, so nothing was added to the history.",
        });
        return false;
      }
      const origin: VersionOrigin = { kind: "restored", from: version.id, fromAt: version.at };
      const write = this._rewrite(bookId, chId, plan, origin);
      const facts = restoreConsequences(plan);
      uiStore.toast(`Restored ${nameOf(bookId, chId)} to v${version.id}`, {
        kind: "success",
        description: `${originLabel(version.origin)} · ${facts.join(" · ")}. Everything after it is still in the history.`,
        timeout: 12000,
        // Only speakers this restore added and nothing else uses, and only after the script is
        // back: removing a speaker the server's script still names hands their lines to the
        // Narrator and refuses the restore's write. Nor may it overtake their own write.
        undo: () =>
          Promise.all([write.undo(), ...write.pushed]).then(() =>
            castStore._dropSpeakers(bookId, write.absorbed),
          ),
      });
      return true;
    },
    /**
     * Write `plan` over the script under `origin` (restore and import): status as the plan says,
     * unknown speakers added unreviewed and written after the chapter, re-timed, saved. Undo puts
     * back this chapter's script, status and `recap.back`; the caller drops absorbed speakers.
     */
    _rewrite(
      bookId: string,
      chId: number,
      plan: RestorePlan,
      origin: VersionOrigin,
      recap?: { to: string; back: string },
    ): Rewrite {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      const chapter = libraryStore.chapter(bookId, chId);
      const was = chapter
        ? {
            narration: chapter.narration,
            narrationProgress: chapter.narrationProgress,
            duration: chapter.duration,
            scripting: chapter.scripting,
          }
        : null;
      const beforeScript = clone(scriptsStore.segmentsOf(bookId, chId));
      scriptsStore._replace(bookId, chId, plan.segments);
      // An imported script is the chapter's script whatever its status; a restore only moves a
      // scripted chapter between done and fallback, and leaves a failed one failed.
      const scripted =
        origin.kind === "imported" || was?.scripting === "done" || was?.scripting === "fallback";
      if (was)
        libraryStore._patchChapter(bookId, chId, {
          ...(scripted && plan.scripting ? { scripting: plan.scripting } : {}),
          narration: plan.narration,
          ...(plan.narration === "none" ? { narrationProgress: 0 } : {}),
        });
      const absorbed = castStore._absorbCast(bookId, chId);
      castStore._retime(bookId, chId);
      const landed = scriptsStore._save(bookId, chId, origin, recap?.to);
      return {
        absorbed,
        pushed: absorbed.map((name) => castStore._push(bookId, name, landed)),
        landed,
        undo: async () => {
          if (!(await landed)) return false;
          scriptsStore._replace(bookId, chId, beforeScript);
          if (was) libraryStore._patchChapter(bookId, chId, was);
          castStore._retime(bookId, chId);
          const back = await scriptsStore._save(bookId, chId, undefined, recap?.back);
          await scriptsStore._settled(bookId, chId);
          return back;
        },
      };
    },
    // ---------- the book this history belongs to ----------
    /** Histories follow renumbered chapters; a removed chapter's history goes with it. */
    remapBook(bookId: string, map: Record<number, number>): void {
      const prefix = bookId + ":";
      const next: Record<string, ChapterHistory> = {};
      for (const [k, h] of Object.entries(this.chapters)) {
        if (!k.startsWith(prefix)) {
          next[k] = h;
          continue;
        }
        const to = map[Number(k.slice(prefix.length))];
        if (to) next[key(bookId, to)] = h;
      }
      this.chapters = next;
    },
    /** A book that is gone takes every chapter's history with it. */
    clearBook(bookId: string): void {
      const prefix = bookId + ":";
      this.chapters = Object.fromEntries(
        Object.entries(this.chapters).filter(([k]) => !k.startsWith(prefix)),
      );
    },
  },
});
