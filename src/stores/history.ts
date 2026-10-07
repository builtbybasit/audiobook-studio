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

/**
 * The runs that write into a chapter's script: a scripting run writes its lines, a narration its
 * clips, and a check by ear its flags. An export only reads the clips.
 */
const LANDS_ON_SCRIPT: Record<JobKind, boolean> = {
  scripting: true,
  narration: true,
  check: true,
  export: false,
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
   * each of `absorbed` written to the cast once the chapter's write is answered: true once the
   * server has them, false when it refused them or the chapter's write was refused and no line
   * here names them any more, so they were taken off again unwritten
   */
  pushed: Promise<boolean>[];
  /** whether the write landed; a refused one has already been read back over and said */
  landed: Promise<boolean>;
  /**
   * Put back the script and the chapter's status as they were, written as an edit, and resolve
   * once nothing more is being written for the chapter with whether that landed. A rewrite that
   * did not land changed nothing on the server, so there is nothing to put back and it resolves
   * false without touching the chapter.
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
            j.bookId === bookId && j.chapterId === chId && !j.finishedAt && LANDS_ON_SCRIPT[j.kind],
        );
    },
  },
  actions: {
    // ---------- the seam ----------
    /** A chapter's history as the server holds it, in place of what was here. */
    _install(bookId: string, chId: number, history: ChapterHistory): void {
      this.chapters[key(bookId, chId)] = history;
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
        // Only the speakers this restore added, and only while nothing else has started using
        // them. The two writes must not race: a speaker removed while the server's script still
        // names them hands their lines to the Narrator and moves the revision, and the write that
        // was to take their lines away is refused. The script goes first; the removal then moves
        // nothing. Nor may it overtake their own write, which would leave nobody to remove.
        undo: () =>
          Promise.all([write.undo(), ...write.pushed]).then(() =>
            castStore._dropSpeakers(bookId, write.absorbed),
          ),
      });
      return true;
    },
    /**
     * Write `plan` over this chapter's script under `origin`, the way a restore and an import both
     * do: the script replaced, the chapter's narration (and scripting) status set as the plan
     * says, any speaker a line names that the cast lacks added unreviewed, the chapter re-timed,
     * and the script saved. The server preserves what it replaced in the history. The speakers it
     * added are written to the cast in the same step, each waiting for the chapter's write: one
     * only this chapter named, whose write was refused, is never the server's (`cast._push`).
     *
     * The undo puts back exactly what this changed and nothing else — the chapter's script and its
     * own status. Work done elsewhere in the book while the toast was up is not a rewrite's to take
     * back, and nor are the speakers it absorbed, which the caller drops once the script is back.
     */
    _rewrite(bookId: string, chId: number, plan: RestorePlan, origin: VersionOrigin): Rewrite {
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
      // An imported script is the chapter's script whatever its scripting status was; a restore
      // only moves a scripted chapter between done and fallback, and leaves a failed one failed.
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
      const landed = scriptsStore._save(bookId, chId, origin);
      return {
        absorbed,
        pushed: absorbed.map((name) => castStore._push(bookId, name, landed)),
        landed,
        undo: async () => {
          if (!(await landed)) return false;
          scriptsStore._replace(bookId, chId, beforeScript);
          if (was) libraryStore._patchChapter(bookId, chId, was);
          castStore._retime(bookId, chId);
          const back = await scriptsStore._save(bookId, chId);
          await scriptsStore._settled(bookId, chId);
          return back;
        },
      };
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
