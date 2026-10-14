// Export drafts, results and update decisions. Audiobooks are the server's (`useBookExports`); a
// build is a server job, and `buildExport` puts the entry it answers with at the top of the list.
import { useQueryCache } from "@pinia/colada";
import {
  chapterStates,
  coverRefusal,
  DEFAULT_EXPORT_SETTINGS,
  OUTPUT_KEYS,
  planOf,
  reviewOf,
  scopeOf,
  SETTING_LABEL,
  settingsOf,
  usable,
} from "@/lib/exports";
import type {
  ExportItem,
  ExportPlan,
  ExportReview,
  ExportScope,
  ExportSettings,
  ExportUpdate,
} from "@/types";
import { defineStore } from "pinia";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { jobsService } from "@/services/jobs";
import { libraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";
interface ExportsState {
  _exportDraft: {
    bookId: string;
    ids: number[];
    settings: ExportSettings;
    /** the finished export this build would be the next version of */
    updates: number | null;
  } | null;
}
/** Whether a query key is one book's exports: `["books", id, "exports"]`. */
const isExportsKey = (key: readonly unknown[]): boolean =>
  key.length === 3 && key[0] === "books" && key[2] === "exports";

export const useExportsStore = defineStore("exports", {
  state: (): ExportsState => ({ _exportDraft: null }),
  getters: {
    /** Every book's audiobooks listed so far; an unread book has none here. */
    exports(): ExportItem[] {
      return useQueryCache()
        .getEntries({ key: ["books"], predicate: (e) => isExportsKey(e.key) })
        .flatMap((e) => (e.state.value.data as ExportItem[] | undefined) ?? []);
    },
  },
  actions: {
    // ---------- the seam ----------
    /** Change one book's audiobooks locally until the server's list is read again. */
    _edit(bookId: string, change: (list: ExportItem[]) => ExportItem[]): void {
      useQueryCache().setQueryData<ExportItem[]>(keys.exports(bookId), (list) =>
        change(list ?? []),
      );
    },
    // ---------- export ----------
    // One build makes one export (one or more files, by grouping). `key` (name + format + grouping)
    // identifies it, so rebuilding is a new version, not a second entry.
    /** Everything the page needs to describe a build, with no side effects. */
    exportPlanFor(bookId: string, ids: number[], settings: ExportSettings): ExportPlan {
      const libraryStore = useLibraryStore();

      const chapters = libraryStore.chaptersOf(bookId).filter((c) => ids.includes(c.id));
      return planOf({ chapters, volumes: libraryStore.volumesOf(bookId), settings });
    },
    exportReviewFor(bookId: string, ids: number[], settings: ExportSettings): ExportReview {
      const libraryStore = useLibraryStore();

      const chapters = libraryStore.chaptersOf(bookId).filter((c) => ids.includes(c.id));
      return reviewOf(chapters, settings);
    },
    /** One fingerprint per chapter, so a finished export can tell which of its chapters moved. */
    exportStateFor(bookId: string, ids: number[]): Record<number, string> {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return chapterStates(
        libraryStore.chaptersOf(bookId),
        ids,
        (id) => scriptsStore.segmentsOf(bookId, id),
        castStore.pacingOf(bookId),
        libraryStore.bookById(bookId),
      );
    },
    exportsOf(bookId: string): ExportItem[] {
      return this.exports.filter((e) => e.bookId === bookId && e.status !== "replaced");
    },
    /** Earlier versions of one export, newest first. */
    exportVersionsOf(e: ExportItem): ExportItem[] {
      return this.exports
        .filter((x) => x.bookId === e.bookId && x.key === e.key && x.id !== e.id)
        .sort((a, b) => b.version - a.version);
    },
    /** What a selection *claims*: see `scopeOf`. */
    exportScopeFor(bookId: string, ids: number[], settings: ExportSettings): ExportScope {
      const libraryStore = useLibraryStore();

      return scopeOf(libraryStore.chaptersOf(bookId), ids, settings.grouping);
    },
    /** The chapters a finished export is responsible for keeping up with. */
    exportScopeOf(e: ExportItem): Set<number> {
      const libraryStore = useLibraryStore();

      // entries without a recorded scope keep the reading they were built under
      const scope = e.scope ?? (e.grouping === "volume" ? "volumes" : "book");
      if (scope === "chosen") return new Set(e.chapterIds);
      const all = libraryStore.chaptersOf(e.bookId);
      if (scope === "book") return new Set(all.map((c) => c.id));
      const vols = new Set(e.chapterIds.map((id) => libraryStore.chapter(e.bookId, id)?.volumeId));
      return new Set(all.filter((c) => vols.has(c.volumeId)).map((c) => c.id));
    },
    /**
     * Why a finished export no longer matches the book; `settings` is the form now, for "you
     * changed the bitrate since". `added` is only what it claimed; chapters outside its scope are
     * `outside`, a separate decision.
     */
    exportUpdateFor(e: ExportItem, settings?: ExportSettings): ExportUpdate {
      const libraryStore = useLibraryStore();

      const now = this.exportStateFor(e.bookId, e.chapterIds);
      const changed: number[] = [];
      const stale: number[] = [];
      const missing: number[] = [];
      for (const id of e.chapterIds) {
        const c = libraryStore.chapter(e.bookId, id);
        if (!c || !usable(c)) {
          missing.push(id);
          continue;
        }
        if (now[id] !== e.state?.[id]) changed.push(id);
        if (c.narration === "stale") stale.push(id);
      }
      const scope = this.exportScopeOf(e);
      const narrated = libraryStore
        .chaptersOf(e.bookId)
        .filter((c) => !c.excluded && usable(c) && !e.chapterIds.includes(c.id));
      const added = narrated.filter((c) => scope.has(c.id)).map((c) => c.id);
      const outside = narrated.filter((c) => !scope.has(c.id)).map((c) => c.id);
      const diff: string[] = [];
      if (settings) {
        const was = settingsOf(e);
        for (const k of OUTPUT_KEYS)
          if (was[k] !== undefined && was[k] !== settings[k]) diff.push(SETTING_LABEL[k] ?? k);
      }
      return {
        added,
        outside,
        changed,
        stale,
        missing,
        settings: diff,
        needed: !!(added.length || changed.length || missing.length || diff.length),
      };
    },
    /** Narrated chapters a finished export does not contain yet. */
    newSince(exp: ExportItem): number[] {
      return this.exportUpdateFor(exp).added;
    },
    /**
     * Queue a build of exactly `ids`; the page already resolved anything that could not go in.
     * The server decides and refuses, in the readiness review's words; nothing is marked here
     * before it answers.
     */
    async buildExport(
      bookId: string,
      ids: number[],
      settings: ExportSettings,
      opts: {
        updates?: number;
      } = {},
    ): Promise<ExportItem | null> {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();

      if (libraryStore._blocked(bookId, "build")) return null;
      if (!libraryStore.bookById(bookId)) return null;
      try {
        const { export: entry } = await jobsService().buildExport(
          bookId,
          ids,
          settings,
          opts.updates ?? null,
        );
        // added rather than reread: the other audiobooks are unchanged, and this one goes on top
        this._edit(bookId, (list) => [entry, ...list.filter((e) => e.id !== entry.id)]);
        // reread: the server has just marked the version this build replaces
        await Promise.all([jobsStore._changed(), invalidate({ key: keys.exports(bookId) })]);
        return this.exports.find((e) => e.id === entry.id) ?? entry;
      } catch (cause) {
        toastFailure("build this audiobook", cause);
        return null;
      }
    },
    /**
     * Upload an image (JPEG or PNG only, checked here) and make its url the cover: a build only
     * names images the server holds. A refusal says why and keeps the old cover. Returns whether
     * the cover changed.
     */
    async chooseCover(bookId: string, settings: ExportSettings, file: File): Promise<boolean> {
      const uiStore = useUiStore();

      const refused = coverRefusal(file);
      if (refused) {
        uiStore.toast(refused, {
          kind: "warn",
          description: `${file.name} was not used; the cover is as it was.`,
        });
        return false;
      }
      try {
        settings.cover = (await libraryService().uploadCover(bookId, file)).cover;
        return true;
      } catch (cause) {
        toastFailure("upload that cover", cause);
        return false;
      }
    },
    /**
     * The settings an export was built with, as form values, so an update starts from it. Consent
     * to stale clips is never inherited: it is given per build, in front of the review.
     */
    settingsFromExport(e: ExportItem): ExportSettings {
      if (e.settings) return { ...DEFAULT_EXPORT_SETTINGS, ...e.settings, useStale: false };
      return {
        ...DEFAULT_EXPORT_SETTINGS,
        ...settingsOf(e),
        filename: e.filename
          .replace(/\/$/, "")
          .replace(/ - [^-]*\.(m4b|mp3)$/i, "")
          .replace(/\.(m4b|mp3)$/i, ""),
        cover: null,
        useStale: false,
      } as ExportSettings;
    },
    /**
     * Hand a build to the Build tab instead of starting it, for the readiness review to ask its
     * questions. Update and Retry do this whenever going ahead would shrink the selection or
     * answer for you.
     */
    stageExport(
      bookId: string,
      ids: number[],
      settings: ExportSettings,
      updates: number | null = null,
    ): void {
      this._exportDraft = { bookId, ids: [...ids], settings: { ...settings }, updates };
    },
    /** Chapters an export wants that no build can contain (gone or skipped); named, not staged. */
    _buildable(
      bookId: string,
      ids: number[],
    ): {
      ids: number[];
      dropped: number[];
    } {
      const libraryStore = useLibraryStore();

      const ok: number[] = [];
      const dropped: number[] = [];
      for (const id of ids) {
        const c = libraryStore.chapter(bookId, id);
        if (c && !c.excluded) ok.push(id);
        else dropped.push(id);
      }
      return { ids: ok, dropped };
    },
    /**
     * Rebuild a failed attempt with its settings. If anything moved since, it goes to the Build tab
     * for review instead. Resolves to the build started, or null.
     */
    async retryExport(exportId: number): Promise<ExportItem | null> {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      const failed = this.exports.find((e) => e.id === exportId);
      if (!failed || failed.status !== "failed") return null;
      const run = jobsStore.jobs.find((j) => j.id === failed.jobId)?.exportRun;
      // its own settings, stale consent included: retrying *this* build is not a new choice
      const settings = run?.settings ?? this.settingsFromExport(failed);
      const { ids, dropped } = this._buildable(failed.bookId, run?.chapterIds ?? failed.chapterIds);
      const review = reviewOf(
        libraryStore.chaptersOf(failed.bookId).filter((c) => ids.includes(c.id)),
        settings,
      );
      if (review.blockers.length || dropped.length) {
        this.stageExport(failed.bookId, ids, settings, failed.replaces);
        uiStore.toast(`${failed.filename} has changed since it failed`, {
          kind: "warn",
          description: this._draftNote(review.blockers.length, dropped.length, "retried"),
          timeout: 8000,
        });
        return null;
      }
      // the build says for itself whether it started
      return await this.buildExport(failed.bookId, ids, settings, {
        updates: failed.replaces ?? undefined,
      });
    },
    /** Why a build was handed back instead of started. */
    _draftNote(blockers: number, dropped: number, verb: string): string {
      const parts = [];
      if (blockers)
        parts.push(
          `${blockers === 1 ? "One chapter needs" : `${blockers} kinds of chapter need`} a decision`,
        );
      if (dropped)
        parts.push(
          `${dropped} ${dropped === 1 ? "chapter is" : "chapters are"} gone from the book or skipped by it`,
        );
      return `${parts.join(", ")}. It is waiting on the Build tab with everything it was ${verb} with — nothing was built.`;
    },
    /**
     * Rebuild a finished export as a new version; the current one stays until it lands. `extra`
     * adds chapters. It keeps everything it contained: missing audio or stale clips send it to the
     * Build tab rather than being dropped or accepted for you.
     */
    async updateExport(exportId: number, extra: number[] = []): Promise<ExportItem | null> {
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      const e = this.exports.find((x) => x.id === exportId);
      if (!e) return null;
      const settings = this.settingsFromExport(e);
      const { ids, dropped } = this._buildable(
        e.bookId,
        [...new Set([...e.chapterIds, ...extra])].sort((a, b) => a - b),
      );
      const review = reviewOf(
        libraryStore.chaptersOf(e.bookId).filter((c) => ids.includes(c.id)),
        settings,
      );
      if (review.blockers.length || dropped.length) {
        this.stageExport(e.bookId, ids, settings, e.id);
        uiStore.toast(`${e.filename} needs a decision before it can be updated`, {
          kind: "warn",
          description: this._draftNote(review.blockers.length, dropped.length, "built"),
          timeout: 8000,
        });
        return null;
      }
      return await this.buildExport(e.bookId, ids, settings, { updates: e.id });
    },
    async deleteExport(id: number): Promise<void> {
      const uiStore = useUiStore();

      const e = this.exports.find((x) => x.id === id);
      if (!e) return;
      // nothing puts one back on the server, so the control asked first and the toast says so
      try {
        await libraryService().removeExport(e.bookId, e.id);
      } catch (cause) {
        toastFailure("delete this audiobook", cause);
        return;
      }
      this._edit(e.bookId, (list) => list.filter((x) => x.id !== id));
      uiStore.toast(`Deleted ${e.filename} v${e.version}`, {
        description: "This cannot be undone.",
      });
    },
  },
});
