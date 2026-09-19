// Chapter script history: the versions a chapter's script has been through, and restoring one.
//
// One rule holds the whole feature together: **the working script is preserved before anything
// replaces it**, labelled by whatever produced it. A re-script, a bulk correction and a restore
// each hand their own label over as they write; ordinary editing hands one over too, but only once
// per session — a run of edits with less than `SESSION_IDLE_MS` between them is one entry, so the
// list reads as "9 manual edits" rather than nine entries nobody can tell apart.
//
// Versions are independent copies of script content (`snapshotScript`), never references into the
// live script and never the audio: a clip finishing in the background cannot change what an older
// version says, and restoring one carries the clips across rather than throwing them away.
//
// With a server answering, the history is the server's. The same rule is applied there
// (`planCapture` in `@/lib/scriptHistory` is shared), in the transaction that writes the script:
// an edit carries what produced it and answers with the history it added to, which `_install`
// puts here, and `useChapterHistory` in `@/queries` reads it on opening a chapter. Nothing in this
// store captures a version itself in that mode — `noteEdit`, `noteBulk` and `_capture` do nothing
// — so the list can never claim something the server did not record.
import { key } from "@/lib/scriptReview";
import {
  compareScripts,
  originLabel,
  planCapture,
  planRestore,
  restoreConsequences,
  SESSION_IDLE_MS,
  snapshotScript,
} from "@/lib/scriptHistory";
import { clone } from "@/lib/utils";
import { activeLibraryService, ApiError } from "@/services/library";
import type {
  ChapterHistory,
  HistoryHead,
  Job,
  Profile,
  RestorePlan,
  ScriptComparison,
  ScriptVersion,
  Segment,
  VersionOrigin,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useDemoStore } from "@/stores/demo";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

export { SESSION_IDLE_MS };

const emptyHead = (): HistoryHead => ({ at: 0, origin: { kind: "scripted" } });
const emptyHistory = (): ChapterHistory => ({ versions: [], head: emptyHead(), nextId: 1 });
/** A chapter's history, copied. The versions themselves are never mutated once they are pushed,
 *  so the list is copied rather than the scripts in it. */
const copyHistory = (h: ChapterHistory): ChapterHistory => ({
  versions: [...h.versions],
  head: { ...h.head, origin: clone(h.head.origin) },
  nextId: h.nextId,
});

interface HistoryState {
  /** keyed `${bookId}:${chapterId}` */
  chapters: Record<string, ChapterHistory>;
  /** the timer that closes each open editing session */
  _idle: Record<string, ReturnType<typeof setTimeout>>;
  /** set while a batch drives the per-line actions, so they do not open an editing session */
  _silent: boolean;
}

export const useHistoryStore = defineStore("history", {
  state: (): HistoryState => ({ chapters: {}, _idle: {}, _silent: false }),
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
      const k = key(bookId, chId);
      this._closeSession(k);
      this.chapters[k] = history;
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
    _ensure(bookId: string, chId: number): ChapterHistory {
      const k = key(bookId, chId);
      if (!this.chapters[k]) this.chapters[k] = emptyHistory();
      return this.chapters[k]; // read back, so what the caller mutates is the reactive proxy
    },
    /**
     * Preserve the working script and say what is about to replace it. Returns the undo for the
     * entry it added, so an operation that offers Undo puts the history back with the script.
     *
     * `next` is what the operation is about to write, when it is known: an operation that leaves
     * the script exactly as it found it — a re-script that came back with the same attribution —
     * adds no entry, and neither does one whose result is already the newest entry.
     */
    _capture(bookId: string, chId: number, origin: VersionOrigin, next?: Segment[]): () => void {
      const scriptsStore = useScriptsStore();

      // the server preserves the script in the transaction that writes it; nothing to do here
      if (activeLibraryService()) return () => {};
      const k = key(bookId, chId);
      const h = this._ensure(bookId, chId);
      const before: HistoryHead = { ...h.head, origin: clone(h.head.origin) };
      this._closeSession(k);
      const current = scriptsStore.segments[k] ?? [];
      const plan = planCapture(h, current, origin, next, Date.now());
      const added = plan.added?.id ?? null;
      if (plan.added) h.versions.push(plan.added);
      h.nextId = plan.nextId;
      h.head = plan.head;
      return () => {
        const live = this.chapters[k];
        if (!live) return;
        if (added !== null) {
          live.versions = live.versions.filter((v) => v.id !== added);
          if (live.nextId === added + 1) live.nextId = added;
        }
        live.head = before;
        this._closeSession(k);
      };
    },
    /**
     * This chapter's history as it stands, put back together with the script by the undo the edit
     * itself offers. An edit and the entry it opens are one thing: undoing a split has to leave the
     * list saying what the script now is, not that a manual edit happened which no longer exists.
     */
    _chapterSnapshot(bookId: string, chId: number): () => void {
      // the server's history follows the script an undo writes back; there is no copy to put back
      if (activeLibraryService()) return () => {};
      const k = key(bookId, chId);
      const h = this.chapters[k];
      const before = h ? copyHistory(h) : null;
      return () => {
        clearTimeout(this._idle[k]);
        delete this._idle[k];
        if (!before) {
          delete this.chapters[k];
          return;
        }
        this.chapters[k] = copyHistory(before);
        // an edit undone mid-session leaves the session open; it still has to close on its own
        if (before.head.open) this._armSession(k);
      };
    },
    // ---------- editing sessions ----------
    /**
     * One line changed by hand. The first edit after a quiet spell preserves the script and opens a
     * session; every edit after it joins that session and is counted into the same entry.
     */
    noteEdit(bookId: string, chId: number): void {
      if (this._silent || activeLibraryService()) return;
      const h = this._ensure(bookId, chId);
      if (h.head.open && h.head.origin.kind === "edited") {
        h.head.origin.edits++;
        h.head.at = Date.now();
      } else this._capture(bookId, chId, { kind: "edited", edits: 1 });
      this._armSession(key(bookId, chId));
    },
    /** Close the session after a quiet spell, so the next edit starts an entry of its own. */
    _armSession(k: string): void {
      const demoStore = useDemoStore();

      const epoch = demoStore._epoch;
      clearTimeout(this._idle[k]);
      this._idle[k] = setTimeout(() => {
        delete this._idle[k];
        // the world this session belonged to has been replaced; its edits are not in this one
        if (demoStore.isStale(epoch)) return;
        const h = this.chapters[k];
        if (h) h.head.open = false;
      }, SESSION_IDLE_MS);
    },
    _closeSession(k: string): void {
      clearTimeout(this._idle[k]);
      delete this._idle[k];
      const h = this.chapters[k];
      if (h) h.head.open = false;
    },
    /** Drop every pending session timer. A replaced world must not close a session in the new one. */
    abandonSessions(): void {
      for (const k of Object.keys(this._idle)) clearTimeout(this._idle[k]);
      this._idle = {};
    },
    /** Run `fn` without its per-line edits opening an editing session — a batch is one entry. */
    silence<T>(fn: () => T): T {
      const was = this._silent;
      this._silent = true;
      try {
        return fn();
      } finally {
        this._silent = was;
      }
    },
    // ---------- the operations that replace a script ----------
    /** A scripting run is about to write `next` over whatever this chapter holds. */
    noteScripted(bookId: string, chId: number, profile: Profile, next: Segment[]): void {
      const scriptsStore = useScriptsStore();

      const again = !!scriptsStore.segments[key(bookId, chId)]?.length;
      this._capture(
        bookId,
        chId,
        { kind: "scripted", profile: profile.name, model: profile.model, again },
        next,
      );
    },
    /** A bulk correction is about to change `lines` lines of this chapter. */
    noteBulk(bookId: string, chId: number, label: string, lines: number): () => void {
      return this._capture(bookId, chId, { kind: "bulk", label, lines });
    },
    // ---------- checkpoints ----------
    /**
     * Name the script as it stands and keep a copy of it. Nothing about the working script changes:
     * a checkpoint is a place to come back to, not an edit.
     */
    saveCheckpoint(
      bookId: string,
      chId: number,
      name: string,
    ): ScriptVersion | null | Promise<ScriptVersion | null> {
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const title = name.trim();
      const current = scriptsStore.segmentsOf(bookId, chId);
      if (!title || !current.length) return null;
      if (activeLibraryService()) return this._remoteCheckpoint(bookId, chId, title);
      const h = this._ensure(bookId, chId);
      const was: HistoryHead = { ...h.head, origin: clone(h.head.origin) };
      // the name goes *on* the state the script is in, so the entry still says how it got there
      const origin: VersionOrigin = {
        kind: "checkpoint",
        name: title,
        ...(h.head.origin.kind === "checkpoint" ? {} : { was: clone(h.head.origin) }),
      };
      const version: ScriptVersion = {
        id: h.nextId++,
        at: Date.now(),
        origin,
        segments: snapshotScript(current),
      };
      h.versions.push(version);
      h.head = { at: Date.now(), origin: clone(origin) };
      this._closeSession(key(bookId, chId));
      uiStore.toast(`Checkpoint saved: “${title}”`, {
        kind: "success",
        description: `v${version.id} · ${current.length} lines of chapter ${chId}. The script itself is untouched.`,
        undo: () => {
          const live = this.chapters[key(bookId, chId)];
          if (!live) return;
          live.versions = live.versions.filter((v) => v.id !== version.id);
          if (live.nextId === version.id + 1) live.nextId = version.id;
          live.head = { at: was.at, origin: clone(was.origin) };
        },
      });
      return version;
    },
    /**
     * A checkpoint on the server: the copy is the server's, and so is the history that comes back.
     * Its undo forgets the version there, which puts the head back too.
     */
    async _remoteCheckpoint(
      bookId: string,
      chId: number,
      title: string,
    ): Promise<ScriptVersion | null> {
      const uiStore = useUiStore();
      const svc = activeLibraryService();
      if (!svc) return null;
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
     * With a server answering, the restored script is written back through the scripts store
     * under a `restored` origin, and the server preserves what it replaced; the undo writes the
     * script that was here back as an edit. The speakers a restore brings back into the cast are
     * written to it as well.
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
      // Undo puts back exactly what the restore changed and nothing else: this chapter's script and
      // its place in the history, the chapter's own status, and any speaker the restore had to add
      // to the cast. Work done elsewhere in the book while the toast was up is not a restore's to
      // take back.
      const beforeScript = clone(scriptsStore.segments[k] ?? []);
      const origin: VersionOrigin = { kind: "restored", from: version.id, fromAt: version.at };
      const historyUndo = this._capture(bookId, chId, origin);
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
          historyUndo();
          if (chapter && was) Object.assign(chapter, was);
          castStore._retime(bookId, chId);
          // only the speakers this restore added, and only while nothing else has started using them
          if (!activeLibraryService()) {
            castStore._dropSpeakers(bookId, absorbed);
            scriptsStore._commit(bookId, chId);
            return;
          }
          // With a server answering the two are requests, and they must not race: a speaker
          // removed while the server's script still names them hands their lines to the Narrator
          // and moves the revision, and the write that was to take their lines away is refused.
          // The script goes first; the removal then moves nothing.
          scriptsStore._commit(bookId, chId);
          return scriptsStore
            ._settled(bookId, chId)
            .then(() => castStore._dropSpeakers(bookId, absorbed));
        },
      });
      return true;
    },
    // ---------- the world this history belongs to ----------
    /** A chapter nothing has been run on has no history either. */
    clearChapter(bookId: string, chId: number): void {
      const k = key(bookId, chId);
      this._closeSession(k);
      delete this.chapters[k];
    },
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
        this._closeSession(k); // the number an open session was collecting under has moved
        const to = map[Number(k.slice(prefix.length))];
        if (to) next[key(bookId, to)] = h;
      }
      this.chapters = next;
    },
    /** A book that is gone takes every chapter's history with it. */
    clearBook(bookId: string): void {
      const prefix = bookId + ":";
      for (const k of Object.keys(this.chapters)) if (k.startsWith(prefix)) this._closeSession(k);
      this.chapters = Object.fromEntries(
        Object.entries(this.chapters).filter(([k]) => !k.startsWith(prefix)),
      );
    },
    /** Every chapter's history in this book, put back by the undo a removal offers. */
    _bookSnapshot(bookId: string): () => void {
      const prefix = bookId + ":";
      const before = Object.entries(this.chapters)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, h]) => [k, copyHistory(h)] as const);
      return () => {
        this.clearBook(bookId);
        for (const [k, h] of before) this.chapters[k] = copyHistory(h);
      };
    },
    /** A seeded history, for the demo scenarios. Ids are assigned in the order they are given. */
    seed(
      bookId: string,
      chId: number,
      seeded: { versions: Omit<ScriptVersion, "id">[]; head: HistoryHead },
    ): void {
      const k = key(bookId, chId);
      this._closeSession(k);
      this.chapters[k] = {
        versions: seeded.versions.map((v, i) => ({
          ...v,
          id: i + 1,
          segments: snapshotScript(v.segments),
        })),
        head: clone(seeded.head),
        nextId: seeded.versions.length + 1,
      };
    },
  },
});
