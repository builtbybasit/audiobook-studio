// Export drafts, results and update decisions.
//
// The finished audiobooks are the server's: `useBookExports` in `@/queries` reads a book's in,
// forgetting one is a request, and building one is a job the server runs — `buildExport` sends the
// selection and the settings and installs the entry that comes back, rather than encoding anything
// here.
import {
  chapterStates,
  coverRefusal,
  DEFAULT_EXPORT_SETTINGS,
  loudnessReport,
  OUTPUT_KEYS,
  planOf,
  reusedChapters,
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
  LoudnessReport,
  VoiceRef,
} from "@/types";
import { defineStore } from "pinia";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { jobsService } from "@/services/jobs";
import { libraryService, ApiError } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
interface ExportsState {
  exports: ExportItem[];
  _exportDraft: {
    bookId: string;
    ids: number[];
    settings: ExportSettings;
    /** the finished export this build would be the next version of */
    updates: number | null;
  } | null;
}
export const useExportsStore = defineStore("exports", {
  // no export is here until it has been read from the server
  state: (): ExportsState => ({ exports: [], _exportDraft: null }),
  actions: {
    // ---------- the seam ----------
    /** A book's exports as the server holds them, in place of what was here for that book. */
    _install(bookId: string, list: ExportItem[]): void {
      this.exports = [...this.exports.filter((e) => e.bookId !== bookId), ...list];
    },
    _failed(what: string, cause: unknown): void {
      const uiStore = useUiStore();
      const api = cause instanceof ApiError ? cause : null;
      uiStore.toast(api ? api.message : `Could not ${what}`, {
        kind: "error",
        description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
        timeout: 8000,
      });
    },
    // ---------- export ----------
    // A build makes one *export*, which is one or more files: grouping decides how many and nothing
    // else changes. An export is identified by `key` (name + format + grouping), so building the
    // same audiobook again is a new version of it rather than a second entry, and the chapters whose
    // audio has not moved since the last version are carried over instead of encoded again. The
    // encoding is the server's, and so is the file.
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
    /** The voices heard in a selection, by how much of it they read. */
    exportVoicesFor(
      bookId: string,
      ids: number[],
    ): {
      ref: VoiceRef;
      label: string;
      endpoint: string;
      segments: number;
    }[] {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();
      const scriptsStore = useScriptsStore();

      const by = new Map<
        VoiceRef,
        {
          segments: number;
        }
      >();
      for (const id of ids)
        for (const s of scriptsStore.segmentsOf(bookId, id)) {
          if (s.audio.duration <= 0) continue;
          // what the clip was actually rendered with, falling back to where the line routes now
          const ref = s.audio.voiceRef ?? castStore.effectiveVoice(bookId, s.speaker).ref;
          if (!ref) continue;
          (by.get(ref) ?? (by.set(ref, { segments: 0 }), by.get(ref)!)).segments++;
        }
      return [...by.entries()]
        .map(([ref, v]) => {
          const r = endpointsStore.resolveVoice(ref);
          return {
            ref,
            label: r ? r.voice.label : `${ref.split("/")[1]} (missing)`,
            endpoint: r?.endpoint.name ?? ref.split("/")[0],
            segments: v.segments,
          };
        })
        .sort((a, b) => b.segments - a.segments);
    },
    exportLoudnessFor(bookId: string, ids: number[], settings: ExportSettings): LoudnessReport {
      return loudnessReport(this.exportVoicesFor(bookId, ids), settings);
    },
    /** One fingerprint per chapter, so a later build knows what it can carry over. */
    exportStateFor(bookId: string, ids: number[]): Record<number, string> {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return chapterStates(
        libraryStore.chaptersOf(bookId),
        ids,
        (id) => scriptsStore.segmentsOf(bookId, id),
        castStore.pacingOf(bookId),
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

      // entries from before the scope was recorded keep the reading they were built under
      const scope = e.scope ?? (e.grouping === "volume" ? "volumes" : "book");
      if (scope === "chosen") return new Set(e.chapterIds);
      const all = libraryStore.chaptersOf(e.bookId);
      if (scope === "book") return new Set(all.map((c) => c.id));
      const vols = new Set(e.chapterIds.map((id) => libraryStore.chapter(e.bookId, id)?.volumeId));
      return new Set(all.filter((c) => vols.has(c.volumeId)).map((c) => c.id));
    },
    /**
     * The chapters a build would carry over from `prev` untouched rather than encode again. The
     * plan's estimate and the build itself both come here, so the promise and the build agree.
     */
    exportReuse(
      prev: ExportItem | null | undefined,
      ids: number[],
      settings: ExportSettings,
      state?: Record<number, string>,
    ): number[] {
      if (!prev) return [];
      return reusedChapters(prev, ids, settings, state ?? this.exportStateFor(prev.bookId, ids));
    },
    /**
     * Why a finished export no longer matches the book. `settings` is the form as it stands now,
     * so the page can also say "you have changed the bitrate since".
     *
     * `added` is only what the export claimed and has not got; chapters narrated *outside* its scope
     * are `outside` and are offered as their own decision. A deliberately partial export is not an
     * unfinished whole-book one.
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
        reusable: e.chapterIds.length - changed.length - missing.length,
        needed: !!(added.length || changed.length || missing.length || diff.length),
      };
    },
    /** Narrated chapters a finished export does not contain yet. Kept for the book overview. */
    newSince(exp: ExportItem): number[] {
      return this.exportUpdateFor(exp).added;
    },
    /**
     * Queue a build. `ids` is exactly what goes in — the page has already resolved anything that
     * could not, so nothing is dropped here silently.
     *
     * The server decides whether this build can run and starts the job, and what comes back is the
     * audiobook it is already writing. Nothing is marked here before it answers — a refusal that
     * never reached the server must not look like one that did — and the refusals themselves are
     * the server's, stated in the same words as the readiness review's blockers.
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
        // added rather than installed: the book's other audiobooks are still as last read, and this
        // one belongs at the top
        this.exports = [entry, ...this.exports.filter((e) => e.id !== entry.id)];
        // the Queue page picks the job up from its own poll, and the audiobooks are read again
        // because the server has just marked the version this build replaces
        await Promise.all([jobsStore._changed(), invalidate({ key: keys.exports(bookId) })]);
        return this.exports.find((e) => e.id === entry.id) ?? entry;
      } catch (cause) {
        this._failed("build this audiobook", cause);
        return null;
      }
    },
    /**
     * Use this image as the audiobook's cover: `settings.cover` names it once it can be built with,
     * and not before. Anything but a JPEG or a PNG is turned away here, without a request. The
     * image is uploaded first and the url it answers with is the cover, because a build names only
     * an image the server holds for this book. A refusal says why and leaves the cover that was
     * chosen before. Returns whether the cover changed.
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
        this._failed("upload that cover", cause);
        return false;
      }
    },
    /**
     * The settings an existing export was built with, in the shape the form uses. A build records
     * everything it ran with, cover and marker pattern included, so an update starts from the
     * audiobook you made rather than from the defaults. Consent to stale clips is the one thing
     * never inherited: it is given for one build, in front of the review.
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
     * Hand a build back to the Build tab rather than starting it: tick these chapters, fill the form
     * with these settings, and let the readiness review ask its questions. Update and Retry come
     * here whenever going ahead would mean shrinking the selection or answering for you.
     */
    stageExport(
      bookId: string,
      ids: number[],
      settings: ExportSettings,
      updates: number | null = null,
    ): void {
      this._exportDraft = { bookId, ids: [...ids], settings: { ...settings }, updates };
    },
    /**
     * Chapters an export wants back that no build can contain: gone from the book, or skipped by it
     * now. They cannot even be ticked in the list, so they are named rather than staged.
     */
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
     * Build the failed attempt again, with the settings it was started with. If anything has moved
     * since it fell over — a chapter re-scripted, one narrating now — that is a new decision, so the
     * retry goes to the Build tab for the same review a first build gets. Resolves to the build it
     * started, or null when it started none.
     */
    async retryExport(exportId: number): Promise<ExportItem | null> {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      const failed = this.exports.find((e) => e.id === exportId);
      if (!failed || failed.status !== "failed") return null;
      const run = jobsStore.jobs.find((j) => j.id === failed.jobId)?.exportRun;
      // the settings it was started with, stale consent included: retrying *this* build is not a
      // new choice. What it must never do is give consent that was never given.
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
      // the failed attempt's row is the server's, and the read after the build says what it kept;
      // the build says for itself whether it started: a retry has nothing left to decide here
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
     * Bring a finished export up to date: the chapters that have changed are encoded again, the rest
     * are carried over, and the version that is current now stays current until the new one lands.
     * `extra` adds chapters — the ones narrated since, or the ones outside its scope you chose to
     * fold in.
     *
     * An update is the same audiobook again, so it keeps everything it contained. A chapter whose
     * audio has gone is not dropped to make the update go through, and stale clips are not accepted
     * on your behalf: either sends the build to the Build tab, where the readiness review that
     * guards a first build asks the same questions about this one.
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
        this._failed("delete this audiobook", cause);
        return;
      }
      this.exports = this.exports.filter((x) => x.id !== id);
      uiStore.toast(`Deleted ${e.filename} v${e.version}`, {
        description: "This cannot be undone.",
      });
    },
  },
});
