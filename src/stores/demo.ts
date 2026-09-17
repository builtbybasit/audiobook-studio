// Seeded scenario coordination and restoration. Never owns a second copy of live book data.
//
// A scenario is applied to the pristine seeded world, never on top of whatever the last one left:
// `applyScenario` restores every store from the same fixture world first, then seeds the situation
// on top of it. That is what makes the rows repeatable — the same row gives the same situation
// however many others ran before it — and what makes Reset a single, obvious thing.
//
// Simulated work in flight is abandoned rather than left to land: `_epoch` is the generation of the
// world the running simulators were started against, and every simulator checks it before writing.
// A run from the world you just left cannot finish a chapter, fail a build or spend a budget in the
// one you are looking at now.
import { DEFAULT_EXPORT_SETTINGS, exportKey } from "@/lib/exports";
import { keyring } from "@/lib/keyring";
import { clearPageState } from "@/lib/pageState";
import { isScripted, key } from "@/lib/scriptReview";
import {
  applySearchDemo,
  applySituation,
  BOOK_SEEDS,
  clock,
  demoScenario,
  demoScenarios,
  exportScenarios,
  searchDemoTarget,
  searchScenarios,
  SEEDED_KEYS,
  STARTUP_DELAY_MS,
  startupRuns,
  type HistoryRow,
  type ScenarioContext,
} from "@/mock";
import type { DemoScenario, ExportScenario, ExportSettings, SearchScenario } from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
interface DemoState {
  _kicked: boolean;
  /** the scenario the world currently holds, or null for the world as it is seeded */
  _scenario: string | null;
  /** what applying it did, in counts — kept on screen in the drawer rather than only toasted */
  _note: string;
  /** bumped every time the world is replaced; simulated runs from an older one stop */
  _epoch: number;
  _searchDemo: { bookId: string; restore: () => void } | null;
  _exportDemo: { bookId: string } | null;
  _exportFails: boolean;
  /** how fast simulated work runs; mirrors `clock.speed`, which the simulators read */
  _speed: number;
}
export const useDemoStore = defineStore("demo", {
  state: (): DemoState => ({
    _kicked: false,
    _scenario: null,
    _note: "",
    _epoch: 0,
    _searchDemo: null,
    _exportDemo: null,
    _exportFails: false,
    _speed: clock.speed,
  }),
  getters: {
    /** Every scenario the Demo tools offer, newly built each time they are rendered. */
    scenarios(): DemoScenario[] {
      return demoScenarios();
    },
    /** The row the world is currently in, for the panel's "you are here" line. */
    activeScenario(s): DemoScenario | null {
      return s._scenario ? (demoScenario(s._scenario) ?? null) : null;
    },
    /**
     * True for a book a reset keeps. The seeded world is the only thing a reset restores, so a book
     * imported during the session goes with it — and a page open on that book has to leave first.
     */
    survivesReset(): (bookId: string) => boolean {
      return (bookId) => BOOK_SEEDS.some((b) => b.id === bookId);
    },
    // ---------- search demo ----------
    /** The character the demo scatters an alias of, or null when the book has nothing scripted. */
    searchDemo(): (bookId: string) => {
      main: string;
      alias: string;
    } | null {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();

      return (bookId) =>
        libraryStore.chaptersOf(bookId).some(isScripted)
          ? searchDemoTarget(castStore.charactersOf(bookId))
          : null;
    },
    searchScenarios(): (bookId: string) => SearchScenario[] {
      return (bookId) => {
        const d = this.searchDemo(bookId);
        return d ? searchScenarios(d) : [];
      };
    },
  },
  actions: {
    // ---------- the world these scenarios are seeded on ----------
    /**
     * Put every store back to the one pristine fixture world and abandon whatever was running.
     * `seedState` hands each store an independent copy of the same world, so resetting them all is
     * a coherent library rather than eight stores agreeing by luck.
     */
    _restoreWorld(): void {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();
      const exportsStore = useExportsStore();
      const historyStore = useHistoryStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const narrationStore = useNarrationStore();
      const scriptingStore = useScriptingStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      this.abandonRuns();
      // an editing session groups the edits of a world that is about to be replaced; its timer must
      // not close a session in the next one, so it is dropped rather than left to fire
      historyStore.abandonSessions();
      for (const store of [
        castStore,
        endpointsStore,
        exportsStore,
        historyStore,
        jobsStore,
        libraryStore,
        narrationStore,
        scriptingStore,
        scriptsStore,
      ])
        store.$reset();
      // the undo stack points at objects from the world that has just been replaced
      uiStore._undo = [];
      // a book imported during the session is not in the seeded world, so nothing may still be
      // pointed at it — the sidebar would offer stage links into a book that no longer exists
      if (uiStore.currentBookId && !libraryStore.bookById(uiStore.currentBookId))
        uiStore.currentBookId = null;
      // page state that lives outside the store — half-typed endpoint forms, filters, open tabs
      clearPageState();
      // a scenario is free to take a demo credential away; the world it belongs to puts it back
      for (const [id, value] of SEEDED_KEYS) keyring.set(id, value);
      this._scenario = null;
      this._note = "";
      this._searchDemo = null;
      this._exportDemo = null;
      this._exportFails = false;
    },
    /**
     * Stop caring about every run in flight. The simulators notice on their next tick — and, for a
     * request already dispatched, when its result comes back — and stop without writing anything.
     * Queued and running rows are settled as cancelled so the queue never shows work that nothing
     * is driving any more.
     */
    abandonRuns(): void {
      const jobsStore = useJobsStore();

      this._epoch++;
      for (const j of jobsStore.jobs)
        if (!j.finishedAt) {
          j.cancelled = true;
          jobsStore._finish(j, "cancelled");
        }
    },
    /**
     * Speed up every simulated wait. A run already going picks it up at its next request; what a
     * request records — latency, cost — stays nominal. A tester's setting, so a reset leaves it.
     */
    setSpeed(speed: number): void {
      clock.speed = Math.max(0.1, speed);
      this._speed = clock.speed;
    },
    /** True for a run started against a world that has since been replaced. */
    isStale(epoch: number): boolean {
      return this._epoch !== epoch;
    },
    // ---------- scenarios ----------
    /**
     * Seed one situation and say where it wants to be looked at. Always from the seeded world, so
     * two runs of the same row give the same situation and nothing of the last one survives.
     */
    applyScenario(id: string): string | null {
      const libraryStore = useLibraryStore();
      const narrationStore = useNarrationStore();
      const scriptingStore = useScriptingStore();
      const uiStore = useUiStore();

      const scenario = demoScenario(id);
      if (!scenario) return null;
      this._restoreWorld();
      const result = applySituation(this._scenarioContext(), id, scenario.bookId);
      this._scenario = id;
      this._note = result.note;
      if (scenario.group === "export") this._exportDemo = { bookId: scenario.bookId };
      uiStore.toast(`Demo scenario: ${scenario.name}`, {
        kind: "info",
        description: `${result.note} Reset returns the demo to its seeded state.`,
        timeout: 8000,
      });
      // the runs the scenario wants in flight, started once the world is the way it describes
      for (const run of scenario.runs ?? [])
        if (run.kind === "scripting") scriptingStore.runScripting(scenario.bookId, run.chapterIds);
        else narrationStore.runNarration(scenario.bookId, run.chapterIds);
      return libraryStore.bookById(scenario.bookId) ? (result.open ?? scenario.path) : null;
    },
    /** Back to the seeded world, with nothing applied and nothing running. */
    resetDemo(): void {
      const uiStore = useUiStore();

      this._restoreWorld();
      uiStore.toast("Demo data reset", {
        kind: "info",
        description:
          "Every book, script, voice, job and export is back to its seeded state, and simulated work that was running was abandoned.",
        timeout: 5000,
      });
    },
    /** What a situation is allowed to reach for. See `ScenarioContext` for why it is spelled out. */
    _scenarioContext(): ScenarioContext {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();
      const exportsStore = useExportsStore();
      const historyStore = useHistoryStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return {
        now: () => Date.now(),
        world: {
          characters: castStore.characters,
          lexicon: castStore.lexicon,
          endpoints: endpointsStore.endpoints,
        },
        book: (bookId) => libraryStore.bookById(bookId),
        chapters: (bookId) => libraryStore.chaptersOf(bookId),
        cast: (bookId) => castStore.characters[bookId] ?? [],
        segmentsOf: (bookId, chId) => scriptsStore.segmentsOf(bookId, chId),
        clearScript: (bookId, chId) => {
          delete scriptsStore.segments[key(bookId, chId)];
          delete scriptsStore._previous[key(bookId, chId)];
          historyStore.clearChapter(bookId, chId);
        },
        seedHistory: (bookId, chId, history) => historyStore.seed(bookId, chId, history),
        profiles: () => endpointsStore.profiles,
        telemetry: (profileId) => jobsStore.scriptingTelemetry(profileId),
        addHistory: (row) => this._addHistory(row),
        clearJobs: (bookId) => {
          jobsStore.jobs = jobsStore.jobs.filter((j) => j.bookId !== bookId);
        },
        clearExports: (bookId) => {
          exportsStore.exports = exportsStore.exports.filter((e) => e.bookId !== bookId);
        },
        seedBuilds: (bookId) =>
          this._seedBuildHistory(
            bookId,
            libraryStore
              .chaptersOf(bookId)
              .filter((c) => c.narration === "done")
              .map((c) => c.id),
          ),
        spent: (bookId) => jobsStore.spent(bookId),
        addScriptUsage: (bookId, profileId, cost) => {
          jobsStore.scriptUsage.push({ bookId, profileId, cost, inputTokens: 0, outputTokens: 0 });
        },
        retime: (bookId, chId) => castStore._retime(bookId, chId),
        importSample: (sampleId, bookId) => libraryStore.importBook(sampleId, { id: bookId }),
        shelveBook: (spec) => {
          const id = libraryStore.importBook(spec.sample, { id: spec.id, title: spec.title });
          const book = libraryStore.bookById(id)!;
          book.author = spec.author;
          book.cover = spec.cover;
          book.addedAt = spec.addedAt;
          delete book.importing;
          return id;
        },
        addFinishedExport: (bookId, ids) => this._addFinishedExport(bookId, ids),
      };
    },
    /** An audiobook built earlier from exactly these chapters, fingerprinted as they stand now. */
    _addFinishedExport(bookId: string, ids: number[]): void {
      const exportsStore = useExportsStore();
      const libraryStore = useLibraryStore();

      const book = libraryStore.bookById(bookId);
      if (!book) return;
      const chapters = libraryStore.chaptersOf(bookId).filter((c) => ids.includes(c.id));
      const duration =
        chapters.reduce((a, c) => a + c.duration, 0) + Math.max(0, ids.length - 1) * 2;
      const settings: ExportSettings = {
        ...DEFAULT_EXPORT_SETTINGS,
        title: book.title,
        series: book.title,
        author: book.author,
        filename: book.title,
      };
      const size = Math.max(1, Math.round(((duration * settings.bitrate) / 8 / 1024) * 1.04));
      const file = {
        name: `${book.title}.m4b`,
        chapterIds: ids,
        duration,
        size,
        markers: ids.length,
        volume: null,
      };
      exportsStore.exports.push({
        id: Date.now() + Math.random(),
        bookId,
        key: exportKey(settings),
        filename: file.name,
        title: book.title,
        series: book.title,
        author: book.author,
        narrator: "OpenAI TTS · multi-voice",
        year: settings.year,
        description: "",
        format: settings.format,
        grouping: settings.grouping,
        files: [file],
        chapterIds: ids,
        chapters: ids.length,
        duration,
        bitrate: settings.bitrate,
        chapterGap: settings.chapterGap,
        normalize: settings.normalize,
        loudness: settings.loudness,
        size,
        markers: ids.length,
        createdAt: `${book.addedAt} 20:10`,
        version: 1,
        replaces: null,
        status: "done",
        settings,
        state: exportsStore.exportStateFor(bookId, ids),
      });
    },
    /**
     * A finished row in the queue, as an earlier session would have left it — including the activity
     * that explains it. A failed row whose log says only "Job queued" is not a failure anyone can
     * diagnose, so the run's own account is seeded with it and dated between the row's start and its
     * finish, in order.
     */
    _addHistory(row: HistoryRow): void {
      const jobsStore = useJobsStore();

      const job = jobsStore.addJob(row.kind, row.bookId, row.label, row.chapterId);
      const started = Date.now() - row.minutesAgo * 60000;
      const finished = started + row.seconds * 1000;
      job.status = row.status;
      job.progress = row.status === "done" || row.status === "failed" ? 100 : 40;
      job.queuedAt = started - 1500;
      job.startedAt = started;
      job.finishedAt = finished;
      job.cancelled = row.status === "cancelled";
      job.waitingReason = "";
      if (row.bulk) {
        job.bulk = { ...row.bulk };
        // a seeded run holds its id: the next run started by hand must not be filed under it
        jobsStore._nextRun = Math.max(jobsStore._nextRun, row.bulk.id + 1);
      }
      const middle = row.activity ?? [];
      // the run's account, spread over the time it actually took
      job.activity = [
        { at: job.queuedAt, level: "info" as const, message: "Job queued" },
        {
          at: started,
          level: "info" as const,
          message: "Job started",
          detail: { queueMs: 1500 },
        },
        ...middle.map((e, i) => ({
          at: started + ((i + 1) * (finished - started)) / (middle.length + 1),
          level: e.level ?? ("info" as const),
          message: e.message,
          ...(e.detail ? { detail: e.detail } : {}),
        })),
        {
          at: finished,
          level: row.status === "failed" ? ("error" as const) : ("info" as const),
          message: `Job ${row.status}`,
          detail: { elapsedMs: finished - started },
        },
      ].map((e, i) => ({ ...e, id: i + 1, at: Math.round(e.at) }));
    },
    /** Set the seeded runs going once, so the queue is not empty the first time you look at it. */
    demoKick(): void {
      const narrationStore = useNarrationStore();
      const scriptingStore = useScriptingStore();

      if (this._kicked) return;
      this._kicked = true;
      const epoch = this._epoch;
      setTimeout(() => {
        // a scenario applied in the first second owns the world now; the startup runs are not its
        if (this.isStale(epoch)) return;
        for (const run of startupRuns())
          if (run.kind === "scripting") scriptingStore.runScripting(run.bookId, run.chapterIds);
          else narrationStore.runNarration(run.bookId, run.chapterIds);
      }, STARTUP_DELAY_MS);
    },
    // ---------- the page-level demos ----------
    // The Search and Export pages have their own Demo chips, older than the panel and pointed at the
    // page they sit on. They go through the same scenarios: seeding one is applying a row.
    /** A seeded situation for the Search page's bulk corrections, on the book the page is open on. */
    seedSearchDemo(bookId: string): void {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const open = this._searchDemo;
      if (open?.bookId === bookId) return;
      // seeding a second book would otherwise drop the snapshot that puts the first one back, and
      // one Reset cannot undo two books
      if (open) {
        open.restore();
        this._searchDemo = null;
      }
      const target = this.searchDemo(bookId);
      if (!target) {
        uiStore.toast("This book has no scripted chapters to seed", { kind: "warn" });
        return;
      }
      const restore = libraryStore._bookSnapshot(bookId);
      const { moved, flagged, staled } = applySearchDemo(
        target,
        castStore.characters[bookId],
        libraryStore.chaptersOf(bookId).filter(isScripted),
        (chId) => scriptsStore.segmentsOf(bookId, chId),
      );
      this._searchDemo = { bookId, restore };
      uiStore.toast("Search demo seeded", {
        kind: "info",
        description: `${moved} lines re-attributed to “${target.alias}”, ${flagged} flagged, ${staled} clips made stale. Reset puts “${libraryStore.bookById(bookId)?.title}” back.`,
        timeout: 7000,
      });
    },
    /** Put the book back the way it was before the demo. In-memory only, like everything else. */
    resetSearchDemo(): void {
      const uiStore = useUiStore();

      const demo = this._searchDemo;
      if (!demo) return;
      demo.restore();
      this._searchDemo = null;
      uiStore.toast("Search demo reset", {
        kind: "info",
        description: "The book is back to its seeded state.",
        timeout: 4000,
      });
    },
    exportScenarios(): ExportScenario[] {
      return exportScenarios();
    },
    /** Apply one of the Export rows and say which book to open. */
    seedExportDemo(id: string): string | null {
      const scenario = demoScenario(id);
      return scenario && this.applyScenario(id) ? scenario.bookId : null;
    },
    resetExportDemo(): void {
      if (!this._exportDemo) return;
      this._restoreWorld();
    },
    /** One build running, one that failed and is waiting for a retry, and one that finished. */
    _seedBuildHistory(bookId: string, ids: number[]): void {
      const exportsStore = useExportsStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();

      const base: ExportSettings = {
        ...DEFAULT_EXPORT_SETTINGS,
        title: libraryStore.bookById(bookId)?.title ?? "Audiobook",
        series: libraryStore.bookById(bookId)?.title ?? "",
        author: libraryStore.bookById(bookId)?.author ?? "",
        filename: (libraryStore.bookById(bookId)?.title ?? "Audiobook") + " (sample)",
      };
      // one that failed and is waiting for a retry
      const failed = exportsStore.buildExport(bookId, ids.slice(0, Math.max(1, ids.length - 2)), {
        ...base,
        filename: base.filename + " - earlier attempt",
      });
      if (failed) {
        const job = jobsStore.jobs.find((j) => j.id === failed.jobId);
        if (job) {
          this._exportFails = false;
          exportsStore._failBuild(failed, job, failed.files[0]?.name ?? failed.filename, "");
        }
      }
      // and one that is running now
      exportsStore.buildExport(bookId, ids, {
        ...base,
        filename: base.filename + " - in progress",
      });
    },
  },
});
