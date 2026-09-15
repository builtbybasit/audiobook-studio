// Seeded scenario coordination and restoration. Never owns a second copy of live book data.
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { isScripted } from "@/lib/scriptReview";
import {
  applySearchDemo,
  exportDemoPrep,
  exportScenarios,
  freshenChapters,
  searchDemoTarget,
  searchScenarios,
  STARTUP_DELAY_MS,
  startupRuns,
} from "@/mock";
import type { ExportScenario, ExportSettings, SearchScenario } from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "./cast";
import { useExportsStore } from "./exports";
import { useJobsStore } from "./jobs";
import { useLibraryStore } from "./library";
import { useNarrationStore } from "./narration";
import { useScriptingStore } from "./scripting";
import { useScriptsStore } from "./scripts";
import { useUiStore } from "./ui";
interface DemoState {
  _kicked: boolean;
  _searchDemo: { bookId: string; restore: () => void } | null;
  _exportDemo: { bookId: string; restore: () => void } | null;
  _exportFails: boolean;
}
export const useDemoStore = defineStore("demo", {
  state: (): DemoState => ({
    _kicked: false,
    _searchDemo: null,
    _exportDemo: null,
    _exportFails: false,
  }),
  getters: {
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
    // ---------- demo ----------
    // A seeded situation for the Search page's bulk corrections: one character's alias scattered
    // through the book as if the model had mis-attributed it, a few flagged lines, and clips in all
    // three states. Nothing persists \u2014 `resetSearchDemo` puts the book back exactly as it was.
    seedSearchDemo(bookId: string): void {
      const castStore = useCastStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      if (this._searchDemo) return;
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
        description: `${moved} lines re-attributed to \u201c${target.alias}\u201d, ${flagged} flagged, ${staled} clips made stale. Reset puts \u201c${libraryStore.bookById(bookId)?.title}\u201d back.`,
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
    /** Set the seeded runs going once, so the queue is not empty the first time you look at it. */
    demoKick(): void {
      const narrationStore = useNarrationStore();
      const scriptingStore = useScriptingStore();

      if (this._kicked) return;
      this._kicked = true;
      setTimeout(() => {
        for (const run of startupRuns())
          if (run.kind === "scripting") scriptingStore.runScripting(run.bookId, run.chapterIds);
          else narrationStore.runNarration(run.bookId, run.chapterIds);
      }, STARTUP_DELAY_MS);
    },
    // ---------- export demo ----------
    // Seeded situations for trying a build. Like the Search demo, seeding mutates the open book in
    // memory and keeps the snapshot that puts it back.
    exportScenarios(): ExportScenario[] {
      return exportScenarios();
    },
    seedExportDemo(id: string): string | null {
      const exportsStore = useExportsStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const scenario = this.exportScenarios().find((s) => s.id === id);
      if (!scenario) return null;
      const bookId = scenario.bookId;
      this.resetExportDemo();
      const restore = libraryStore._bookSnapshot(bookId);
      const prep = exportDemoPrep(id);
      if (prep.freshen)
        freshenChapters(libraryStore.chaptersOf(bookId), (chId) =>
          scriptsStore.segmentsOf(bookId, chId),
        );
      if (prep.clearExports)
        exportsStore.exports = exportsStore.exports.filter((e) => e.bookId !== bookId);
      if (prep.buildHistory)
        this._seedBuildHistory(
          bookId,
          libraryStore
            .chaptersOf(bookId)
            .filter((c) => c.narration === "done")
            .map((c) => c.id),
        );
      this._exportDemo = { bookId, restore };
      uiStore.toast(`Seeded: ${scenario.label}`, {
        kind: "info",
        description: `${prep.note} Reset puts the book back.`,
        timeout: 7000,
      });
      return bookId;
    },
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
    resetExportDemo(): void {
      const jobsStore = useJobsStore();

      const demo = this._exportDemo;
      if (!demo) return;
      for (const j of jobsStore.jobs)
        if (j.bookId === demo.bookId && j.kind === "export" && !j.finishedAt)
          jobsStore.cancelJob(j.id);
      demo.restore();
      this._exportDemo = null;
    },
  },
});
