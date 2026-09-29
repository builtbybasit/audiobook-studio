// Chapter script history: the versions a chapter's script has been through, and restoring one.
//
// One rule holds the whole feature together: **the working script is preserved before anything
// replaces it**, labelled by whatever produced it. A re-script, a bulk correction and a restore
// each hand their own label over as they write; ordinary editing hands one over too, but only once
// per session — a run of edits with less than `SESSION_IDLE_MS` between them is one entry, so the
// list reads as "9 manual edits" rather than nine entries nobody can tell apart.
//
// The history is the server's. It applies that rule (`planCapture` in `@/lib/scriptHistory`) in
// the transaction that writes the script: an edit carries what produced it and answers with the
// history it added to, which `_install` puts here, and `useChapterHistory` in `@/queries` reads it
// on opening a chapter. Nothing in this store captures a version itself, so the list can never
// claim something the server did not record.
//
// Versions are independent copies of script content, never the audio: restoring one carries the
// clips across rather than throwing them away.
import { key } from "@/lib/scriptReview";
import { compareScripts, originLabel, planRestore, restoreConsequences } from "@/lib/scriptHistory";
import { clone } from "@/lib/utils";
import { ApiError, libraryService } from "@/services/library";
import type {
  ChapterHistory,
  HistoryHead,
  Job,
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
import { useUiStore } from "@/stores/ui";

const emptyHead = (): HistoryHead => ({ at: 0, origin: { kind: "scripted" } });
const emptyHistory = (): ChapterHistory => ({ versions: [], head: emptyHead(), nextId: 1 });

interface HistoryState {
  /** keyed `${bookId}:${chapterId}` */
  chapters: Record<string, ChapterHistory>;
}

export const useHistoryStore = defineStore("history", {
  state: (): HistoryState => ({ chapters: {} }),
  getters: {
    /** This chapter's history, or an empty one for a chapter nothing has happened to yet. */
    historyOf(s): (bookId: string, chId: number) => ChapterHistory {
      return (bookId, chId) => s.chapters[key(bookId, chId)] ?? emptyHistory();
    },
    /** The saved versions, newest first — the order the list reads in. */
    versionsOf(): (bookId: string, chId: number) => ScriptVersion[] {
      return (bookId, chId) => [...this.historyOf(bookId, chId).versions].reverse();
    },
    /** How the working script came to be. */
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
    /** What restoring one would do, worked out without touching anything. */
    restorePlanOf(): (bookId: string, chId: number, versionId: number) => RestorePlan | null {
      const castStore = useCastStore();
      const narrationStore = useNarrationStore();
      const scriptsStore = useScriptsStore();

      return (bookId, chId, versionId) => {
        const v = this.historyOf(bookId, chId).versions.find((x) => x.id === versionId);
        if (!v) return null;
        return planRestore(scriptsStore.segmentsOf(bookId, chId), v.segments, {
          drift: (segment, audio) => narrationStore.clipDrift(bookId, segment, audio),
          cast: new Set(castStore.charactersOf(bookId).map((c) => c.name)),
        });
      };
    },
    /**
     * Runs that would land on this chapter. A request sent before a restore would write a script,
     * a clip or a chapter status that belongs to the version you have just left behind, so
     * restoring waits for them rather than racing them.
     */
    busyJobs(): (bookId: string, chId: number) => Job[] {
      const jobsStore = useJobsStore();

      return (bookId, chId) =>
        jobsStore.jobs.filter(
          (j) =>
            j.bookId === bookId &&
            j.chapterId === chId &&
            !j.finishedAt &&
            (j.kind === "scripting" || j.kind === "narration"),
        );
    },
  },
  actions: {
    // ---------- the seam ----------
    /** A chapter's history as the server holds it, in place of what was here. */
    _install(bookId: string, chId: number, history: ChapterHistory): void {
      this.chapters[key(bookId, chId)] = history;
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
    // ---------- checkpoints ----------
    /**
     * Name the script as it stands and keep a copy of it. Nothing about the working script changes:
     * a checkpoint is a place to come back to, not an edit. The copy is the server's, and so is the
     * history that comes back; the Undo forgets the version there, which puts the head back too.
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
        this._failed("save this checkpoint", cause);
        return null;
      }
      uiStore.toast(`Checkpoint saved: “${title}”`, {
        kind: "success",
        description: `v${version.id} · ${version.segments.length} lines of chapter ${chId}. The script itself is untouched.`,
        undo: async () => {
          try {
            this._install(bookId, chId, await svc.dropVersion(bookId, chId, version.id));
          } catch (cause) {
            this._failed("forget this checkpoint", cause);
          }
        },
      });
      return version;
    },
    // ---------- restoring ----------
    /**
     * Put this chapter's script back to one of its versions. The versions after it are kept — a
     * restore is one more entry, never a rewriting of what came before it — and the audio is
     * carried across clip by clip rather than thrown away.
     *
     * The restored script is written back through the scripts store under a `restored` origin, and
     * the server preserves what it replaced; the undo writes the script that was here back as an
     * edit. The speakers a restore brings back into the cast are written to it as well.
     */
    restore(bookId: string, chId: number, versionId: number): boolean {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const h = this.chapters[key(bookId, chId)];
      const version = h?.versions.find((v) => v.id === versionId);
      if (!version) return false;
      const busy = this.busyJobs(bookId, chId);
      if (busy.length) {
        uiStore.toast(`Chapter ${chId} has a run in flight`, {
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
      const k = key(bookId, chId);
      const chapter = libraryStore.chapter(bookId, chId);
      const was = chapter
        ? {
            narration: chapter.narration,
            narrationProgress: chapter.narrationProgress,
            duration: chapter.duration,
            scripting: chapter.scripting,
          }
        : null;
      // Undo puts back exactly what the restore changed and nothing else: this chapter's script,
      // the chapter's own status, and any speaker the restore had to add to the cast. Work done elsewhere in the book while the toast was up is not a restore's to
      // take back.
      const beforeScript = clone(scriptsStore.segments[k] ?? []);
      const origin: VersionOrigin = { kind: "restored", from: version.id, fromAt: version.at };
      scriptsStore.segments[k] = plan.segments;
      if (chapter) {
        if (chapter.scripting === "done" || chapter.scripting === "fallback")
          chapter.scripting = plan.scripting ?? chapter.scripting;
        chapter.narration = plan.narration;
        if (plan.narration === "none") chapter.narrationProgress = 0;
      }
      // a speaker the book's cast lost comes back unreviewed, where the Cast page can merge it
      const absorbed = castStore._absorbCast(bookId, chId);
      for (const name of absorbed) void castStore._push(bookId, name);
      castStore._retime(bookId, chId);
      scriptsStore._commit(bookId, chId, origin);
      const facts = restoreConsequences(plan);
      uiStore.toast(`Chapter ${chId} restored to v${version.id}`, {
        kind: "success",
        description: `${originLabel(version.origin)} · ${facts.join(" · ")}. Everything after it is still in the history.`,
        timeout: 12000,
        undo: () => {
          scriptsStore.segments[k] = beforeScript;
          if (chapter && was) Object.assign(chapter, was);
          castStore._retime(bookId, chId);
          // Only the speakers this restore added, and only while nothing else has started using
          // them. The two writes must not race: a speaker removed while the server's script still
          // names them hands their lines to the Narrator and moves the revision, and the write that
          // was to take their lines away is refused. The script goes first; the removal then moves
          // nothing.
          scriptsStore._commit(bookId, chId);
          return scriptsStore
            ._settled(bookId, chId)
            .then(() => castStore._dropSpeakers(bookId, absorbed));
        },
      });
      return true;
    },
    // ---------- the book this history belongs to ----------
    /**
     * The book's chapters have been renumbered — a volume was removed or moved — so each history
     * follows the chapter it belongs to, and a chapter that is gone takes its own with it. Without
     * this a chapter would inherit the versions of whichever chapter used to carry its number.
     */
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
