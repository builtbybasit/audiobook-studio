// Export drafts, results and update decisions. The mock build receives a focused context.
import {
  chapterSignature,
  DEFAULT_EXPORT_SETTINGS,
  exportKey,
  loudnessReport,
  OUTPUT_KEYS,
  planOf,
  reviewOf,
  sameOutput,
  SETTING_LABEL,
  settingsOf,
  usable,
} from "@/lib/exports";
import { logJob, startJob } from "@/lib/jobActivity";
import type { BuildSimContext } from "@/mock";
import { failBuild, runBuild } from "@/mock";
import type {
  ExportItem,
  ExportPlan,
  ExportReview,
  ExportScope,
  ExportSettings,
  ExportUpdate,
  Job,
  LoudnessReport,
  VoiceRef,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useDemoStore } from "@/stores/demo";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { seedState } from "@/stores/seed";
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
  state: (): ExportsState => ({ ...seedState("exports"), _exportDraft: null }),
  getters: {},
  actions: {
    _buildSim(): BuildSimContext {
      const demoStore = useDemoStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      // the generation of the demo world this build belongs to, taken as it is queued
      const epoch = demoStore._epoch;
      return {
        stale: () => demoStore.isStale(epoch),
        paused: (id) => !!libraryStore.bookById(id)?.budget?.paused,
        chapterTitle: (bookId, chId) => libraryStore.chapter(bookId, chId)?.title ?? "",
        exportById: (id) => this.exports.find((e) => e.id === id),
        dropExport: (id) => {
          this.exports = this.exports.filter((e) => e.id !== id);
        },
        retryJob: (id) => jobsStore.retryJob(id),
        retryExport: (id) => this.retryExport(id),
        consumeFailure: () => {
          demoStore._exportFails = false;
        },
        finishJob: (job, status) => jobsStore._finish(job, status),
        toast: (msg, opts) => uiStore.toast(msg, opts),
      };
    },
    // ---------- export ----------
    // A build makes one *export*, which is one or more files: grouping decides how many and nothing
    // else changes. An export is identified by `key` (name + format + grouping), so building the
    // same audiobook again is a new version of it rather than a second entry, and the chapters whose
    // audio has not moved since the last version are carried over instead of encoded again.
    //
    // Nothing here writes a file. Progress, timings, reuse and failure are simulated in the same
    // shape the narration and scripting runs already use, so the Queue treats a build like any
    // other job.
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

      const pacing = castStore.pacingOf(bookId);
      const out: Record<number, string> = {};
      for (const id of ids) {
        const c = libraryStore.chapter(bookId, id);
        if (c) out[id] = chapterSignature(c, scriptsStore.segmentsOf(bookId, id), pacing);
      }
      return out;
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
    /**
     * What a selection *claims*. Exporting everything the book can give is a standing intention —
     * narrate another chapter and the audiobook is behind. Exporting three chapters you picked is a
     * finished decision, and the rest of the book is not missing from it.
     */
    exportScopeFor(bookId: string, ids: number[], settings: ExportSettings): ExportScope {
      const libraryStore = useLibraryStore();

      const chosen = new Set(ids);
      const all = libraryStore.chaptersOf(bookId).filter((c) => !c.excluded && usable(c));
      if (settings.grouping === "volume") {
        const vols = new Set(ids.map((id) => libraryStore.chapter(bookId, id)?.volumeId));
        // a per-volume build claims the volumes it covers — whole, or it is a chosen handful
        return all.every((c) => !vols.has(c.volumeId) || chosen.has(c.id)) ? "volumes" : "chosen";
      }
      return all.every((c) => chosen.has(c.id)) ? "book" : "chosen";
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
      if (!prev || !sameOutput(prev, settings)) return [];
      const now = state ?? this.exportStateFor(prev.bookId, ids);
      return ids.filter((id) => prev.state?.[id] && prev.state[id] === now[id]);
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
     * could not, so nothing is dropped here silently. Returns the export entry, which is live:
     * its progress and status are what the page and the queue both read.
     */
    buildExport(
      bookId: string,
      ids: number[],
      settings: ExportSettings,
      opts: {
        updates?: number;
      } = {},
    ): ExportItem | null {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      if (libraryStore._blocked(bookId, "build")) return null;
      const book = libraryStore.bookById(bookId);
      if (!book) return null;
      const key = exportKey(settings);
      // One audiobook, one build at a time. Two runs against the same finished export would both
      // call themselves the next version, and the second to land would quietly win.
      const running = this.exports.find(
        (e) => e.bookId === bookId && e.key === key && e.status === "building",
      );
      if (running) {
        uiStore.toast(`${running.filename} is already building`, {
          kind: "warn",
          description:
            "Wait for it to finish, or cancel it from the Audiobooks tab — two builds would both claim v" +
            running.version +
            ".",
        });
        return null;
      }
      const chapters = libraryStore.chaptersOf(bookId).filter((c) => ids.includes(c.id));
      if (!chapters.length) return null;
      const unusable = chapters.filter((c) => !usable(c));
      if (unusable.length) {
        uiStore.toast(
          `${unusable.length} selected chapter${unusable.length === 1 ? " has" : "s have"} no usable audio`,
          {
            kind: "warn",
            description: "Nothing was built. Narrate them or take them out of the selection first.",
          },
        );
        return null;
      }
      const stale = chapters.filter((c) => c.narration === "stale");
      if (stale.length && !settings.useStale) {
        uiStore.toast(
          `${stale.length} selected chapter${stale.length === 1 ? " has" : "s have"} stale audio`,
          {
            kind: "warn",
            description: "Choose “use it as it is” or leave those chapters out before building.",
          },
        );
        return null;
      }
      // An update only updates an export this build would actually replace: rename it, or change
      // the format or the layout, and it is a different audiobook being built for the first time.
      const asked =
        opts.updates != null ? this.exports.find((e) => e.id === opts.updates) : undefined;
      const prev =
        (asked?.key === key ? asked : undefined) ??
        this.exports.find((e) => e.bookId === bookId && e.key === key && e.status === "done");
      const state = this.exportStateFor(bookId, ids);
      // carried over: same chapter, same audio, and the previous version was built the same way
      const reuse = this.exportReuse(prev, ids, settings, state);
      const encode = ids.filter((id) => !reuse.includes(id));
      const plan = planOf({ chapters, volumes: libraryStore.volumesOf(bookId), settings });
      const job = jobsStore.addJob("export", bookId, `Build ${plan.label}`);
      const draft: ExportItem = {
        id: Date.now() + Math.random(),
        bookId,
        key,
        filename: plan.label,
        title: settings.title,
        series: settings.series,
        author: settings.author,
        narrator: settings.narrator,
        year: settings.year,
        description: settings.description,
        format: settings.format,
        grouping: settings.grouping,
        files: plan.files.map((f) => ({
          name: f.name,
          chapterIds: f.chapterIds,
          duration: f.duration,
          size: f.size,
          markers: f.markers,
          volume: f.volume,
        })),
        chapterIds: [...ids],
        chapters: chapters.length,
        duration: plan.duration,
        bitrate: settings.bitrate,
        chapterGap: settings.chapterGap,
        normalize: settings.normalize,
        loudness: settings.loudness,
        size: 0,
        markers: plan.markers,
        customCover: !!settings.cover,
        createdAt: new Date().toISOString().slice(0, 16).replace("T", " "),
        scope: this.exportScopeFor(bookId, ids, settings),
        settings: { ...settings },
        // what it sounded like, so it can be heard as built rather than as the book stands now
        timeline: chapters.map((c) => ({ id: c.id, title: c.title, duration: c.duration })),
        version: prev ? prev.version + 1 : 1,
        replaces: prev?.id ?? null,
        status: "building",
        progress: 0,
        state,
        rebuilt: encode.length,
        reused: reuse.length,
        stale: stale.length,
        jobId: job.id,
      };
      this.exports.unshift(draft);
      // mutate the reactive proxy, not the object that was handed to `unshift` — progress, status
      // and the failure all have to reach the page
      const entry = this.exports[0];
      job.exportRun = {
        exportId: entry.id,
        settings: { ...settings },
        chapterIds: [...ids],
        updates: prev?.id ?? null,
        files: plan.files.length,
        file: 0,
        fileName: plan.files[0]?.name ?? plan.label,
        stage: "Preparing",
        encode: encode.length,
        reuse: reuse.length,
        done: 0,
      };
      startJob(job);
      logJob(
        job,
        prev ? `Updating ${plan.label} to v${entry.version}` : `Building ${plan.label}`,
        "info",
        {
          files: plan.files.length,
          chapters: chapters.length,
          format: settings.format,
          layout: settings.grouping,
          bitrateKbps: settings.bitrate,
        },
      );
      if (reuse.length)
        logJob(job, `Reusing ${reuse.length} chapters that have not changed`, "info", {
          reused: reuse.length,
          reEncoding: encode.length,
          basedOn: `v${prev!.version}`,
        });
      if (stale.length)
        logJob(job, `${stale.length} chapters use clips the script has moved under`, "warning", {
          accepted: "the build was started with “use stale audio”",
        });
      if (settings.normalize)
        logJob(job, `Loudness normalisation to ${settings.loudness} LUFS (simulated)`, "info", {
          simulated: "no audio is analysed or processed in this prototype",
        });
      this._runBuild(entry, job, encode, reuse);
      return entry;
    },
    /** The simulated encoder: walks the plan file by file, chapter by chapter. */
    _runBuild(entry: ExportItem, job: Job, encode: number[], reuse: number[]): void {
      const demoStore = useDemoStore();

      runBuild(this._buildSim(), entry, job, encode, reuse, demoStore._exportFails);
    },
    /** A build that fell over. The version that was already good stays the current one. */
    _failBuild(entry: ExportItem, job: Job, file: string, chapter: string): void {
      failBuild(this._buildSim(), entry, job, file, chapter);
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
     * retry goes to the Build tab for the same review a first build gets.
     */
    retryExport(exportId: number): void {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      const failed = this.exports.find((e) => e.id === exportId);
      if (!failed || failed.status !== "failed") return;
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
        return;
      }
      this.exports = this.exports.filter((e) => e.id !== exportId);
      this.buildExport(failed.bookId, ids, settings, { updates: failed.replaces ?? undefined });
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
    updateExport(exportId: number, extra: number[] = []): ExportItem | null {
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
      return this.buildExport(e.bookId, ids, settings, { updates: e.id });
    },
    deleteExport(id: number): void {
      const uiStore = useUiStore();

      const i = this.exports.findIndex((e) => e.id === id);
      if (i < 0) return;
      const e = this.exports[i];
      this.exports.splice(i, 1);
      uiStore.toast(`Deleted ${e.filename} v${e.version}`, {
        undo: () => this.exports.splice(Math.min(i, this.exports.length), 0, e),
      });
    },
  },
});
