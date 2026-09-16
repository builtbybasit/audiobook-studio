// Books, chapters and library structure. Cross-feature removal/undo is coordinated here.
import { isNarrated, isScripted, key } from "@/lib/scriptReview";
import { clone } from "@/lib/utils";
import { importedChapterCount, PALETTE } from "@/mock";
import type { Book, Chapter, SegmentMap, Volume } from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "./cast";
import { useEndpointsStore } from "./endpoints";
import { useExportsStore } from "./exports";
import { useJobsStore } from "./jobs";
import { useScriptsStore } from "./scripts";
import { seedState } from "./seed";
import { useUiStore } from "./ui";
interface LibraryState {
  books: Book[];
  chapters: Record<string, Chapter[]>;
}
export const useLibraryStore = defineStore("library", {
  state: (): LibraryState => ({ ...seedState("books", "chapters") }),
  getters: {
    book(s): Book | undefined {
      const uiStore = useUiStore();
      return s.books.find((b) => b.id === uiStore.currentBookId);
    },
    bookById(s): (id: string) => Book | undefined {
      return (id: string): Book | undefined => s.books.find((b) => b.id === id);
    },
    chaptersOf(s): (id: string) => Chapter[] {
      return (id: string): Chapter[] => s.chapters[id] ?? [];
    },
    chapter(s): (bookId: string, chId: number) => Chapter | undefined {
      return (bookId: string, chId: number): Chapter | undefined =>
        (s.chapters[bookId] ?? []).find((c) => c.id === chId);
    },
    volumesOf(s): (id: string) => Volume[] {
      return (id: string): Volume[] => s.books.find((b) => b.id === id)?.volumes ?? [];
    },
    volumeOf(s): (bookId: string, chId: number) => Volume | undefined {
      return (bookId: string, chId: number): Volume | undefined => {
        const c = (s.chapters[bookId] ?? []).find((c) => c.id === chId);
        return s.books.find((b) => b.id === bookId)?.volumes.find((v) => v.id === c?.volumeId);
      };
    },
    progress(s): (id: string) => {
      total: number;
      excluded: number;
      scripted: number;
      fallback: number;
      narrated: number;
      stale: number;
      exported: number;
      running: boolean;
    } {
      const exportsStore = useExportsStore();
      return (id: string) => {
        const all = s.chapters[id] ?? [];
        const ch = all.filter((c) => !c.excluded);
        return {
          total: ch.length,
          excluded: all.length - ch.length,
          scripted: ch.filter(isScripted).length,
          fallback: ch.filter((c) => c.scripting === "fallback").length,
          narrated: ch.filter(isNarrated).length,
          stale: ch.filter((c) => c.narration === "stale").length,
          exported: exportsStore.exports.filter((e) => e.bookId === id && e.status === "done")
            .length,
          running: ch.some((c) => c.scripting === "running" || c.narration === "running"),
        };
      };
    },
  },
  actions: {
    _bookSnapshot(bookId: string): () => void {
      const castStore = useCastStore();
      const exportsStore = useExportsStore();
      const jobsStore = useJobsStore();
      const scriptsStore = useScriptsStore();

      const i = this.books.findIndex((b) => b.id === bookId);
      const book = clone(this.books[i]);
      const chapters = clone(this.chapters[bookId]);
      const chars = clone(castStore.characters[bookId]);
      const dictionary = castStore.lexicon[bookId] && clone(castStore.lexicon[bookId]);
      const previous: SegmentMap = {};
      for (const [k, v] of Object.entries(scriptsStore._previous))
        if (k.startsWith(bookId + ":")) previous[k] = clone(v);
      const segs: SegmentMap = {};
      for (const [k, v] of Object.entries(scriptsStore.segments))
        if (k.startsWith(bookId + ":")) segs[k] = clone(v);
      const exports = clone(exportsStore.exports.filter((e) => e.bookId === bookId));
      // the list's order is part of what is being put back: the Audiobooks shelf is read in it
      const order = exportsStore.exports.map((e) => e.id);
      const jobs = clone(
        jobsStore.jobs.filter(
          (j) => j.bookId === bookId && j.status !== "running" && j.status !== "queued",
        ),
      );
      return () => {
        if (!this.books.some((b) => b.id === bookId))
          this.books.splice(Math.min(i, this.books.length), 0, book);
        else
          Object.assign(
            this.books.find((b) => b.id === bookId)!,
            book,
          );
        this.chapters[bookId] = chapters;
        castStore.characters[bookId] = chars;
        if (dictionary) castStore.lexicon[bookId] = dictionary;
        else delete castStore.lexicon[bookId];
        scriptsStore._previous = {
          ...Object.fromEntries(
            Object.entries(scriptsStore._previous).filter(([k]) => !k.startsWith(bookId + ":")),
          ),
          ...previous,
        };
        scriptsStore.segments = {
          ...Object.fromEntries(
            Object.entries(scriptsStore.segments).filter(([k]) => !k.startsWith(bookId + ":")),
          ),
          ...segs,
        };
        const mine = new Map(exports.map((e) => [e.id, e]));
        const others = exportsStore.exports.filter((e) => e.bookId !== bookId);
        const byId = new Map(others.map((e) => [e.id, e]));
        exportsStore.exports = [
          // anything built since the snapshot was taken keeps the front, where a new build lands
          ...others.filter((e) => !order.includes(e.id)),
          ...order.flatMap((id) => {
            const e = mine.get(id) ?? byId.get(id);
            return e ? [e] : [];
          }),
        ];
        jobsStore.jobs = [...jobsStore.jobs.filter((j) => j.bookId !== bookId), ...jobs].sort(
          (a, b) => a.id - b.id,
        );
      };
    },
    // ---------- chapters ----------
    setExcluded(bookId: string, chId: number, v: boolean): void {
      const c = this.chapter(bookId, chId);
      if (c) c.excluded = v;
    },
    // ---------- budget & pause ----------
    pauseBook(bookId: string): void {
      const jobsStore = useJobsStore();
      const uiStore = useUiStore();

      for (const j of jobsStore.jobs)
        if (j.bookId === bookId && (j.status === "running" || j.status === "queued"))
          jobsStore.cancelJob(j.id);
      const b = this.bookById(bookId);
      if (b) (b.budget ??= { cap: null, paused: false }).paused = true;
      uiStore.toast(`${b?.title}: everything paused`, {
        kind: "warn",
        description: "Running and queued jobs were cancelled. Resume from the overview.",
        timeout: 5000,
      });
    },
    resumeBook(bookId: string): void {
      const b = this.bookById(bookId);
      if (b?.budget) b.budget.paused = false;
    },
    setBudgetCap(bookId: string, cap: number | null): void {
      const b = this.bookById(bookId);
      if (b) (b.budget ??= { cap: null, paused: false }).cap = cap || null;
    },
    _blocked(bookId: string, kind: string): boolean {
      const uiStore = useUiStore();

      const b = this.bookById(bookId);
      if (b?.budget?.paused) {
        uiStore.toast(`${b.title} is paused — resume it from the overview to ${kind}`, {
          kind: "warn",
        });
        return true;
      }
      return false;
    },
    // ---------- library ----------
    _blankChapters(
      count: number,
      volumeId: number,
      startAt: number,
      prefix = "Chapter",
    ): Chapter[] {
      return Array.from({ length: count }, (_, i): Chapter => ({
        id: startAt + i,
        index: startAt + i,
        volumeId,
        volumeIndex: i + 1,
        title: `${prefix} ${i + 1}`,
        words: 3000,
        scripting: "none",
        scriptingProgress: 0,
        narration: "none",
        narrationProgress: 0,
        duration: 0,
      }));
    },
    addNovel(file: string, title?: string): string {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();

      const id = "new" + Date.now();
      const count = importedChapterCount("novel");
      this.books.push({
        id,
        title: title || file.replace(/\.epub$/i, ""),
        author: "Unknown",
        cover: ["#1e293b", "#94a3b8"],
        addedAt: "just now",
        volumes: [{ id: 1, name: title || file.replace(/\.epub$/i, ""), file, from: 1, to: count }],
      });
      this.chapters[id] = this._blankChapters(count, 1, 1);
      castStore.characters[id] = [
        {
          name: "Narrator",
          aliases: [],
          gender: "n",
          description: "Narration, thoughts, and every speaker without a voice of their own.",
          voice: endpointsStore.voiceOptions.find((o) => !o.disabled)?.value ?? null,
          style: "",
          color: PALETTE[0],
          major: true,
        },
      ];
      return id;
    },
    // A novel split across several EPUBs: each file becomes a volume, chapters keep numbering continuously
    // so roster / recap continuity can carry across the volume boundary.
    addVolume(bookId: string, file: string, name?: string): void {
      const book = this.bookById(bookId);
      if (!book) return;
      const chs = this.chapters[bookId];
      const count = importedChapterCount("volume");
      const from = chs.length + 1;
      const vol: Volume = {
        id: book.volumes.length + 1,
        name: name || `Vol. ${book.volumes.length + 1}`,
        file,
        from,
        to: from + count - 1,
      };
      book.volumes.push(vol);
      chs.push(...this._blankChapters(count, vol.id, from));
    },
    renameVolume(bookId: string, volId: number, name: string): void {
      const v = this.bookById(bookId)?.volumes.find((v) => v.id === volId);
      if (v && name.trim()) v.name = name.trim();
    },
    // Remove a volume (wrong EPUB added): its chapters, segments, jobs and exports go; the remaining
    // chapters are renumbered so numbering stays continuous. Removing the last volume removes the novel.
    removeVolume(bookId: string, volId: number): "book" | "volume" | null {
      const jobsStore = useJobsStore();
      const uiStore = useUiStore();

      const book = this.bookById(bookId);
      if (!book) return null;
      if (book.volumes.length <= 1) {
        this.removeBook(bookId);
        return "book";
      }
      const revert = this._bookSnapshot(bookId);
      const vname = book.volumes.find((v) => v.id === volId)?.name;
      const gone = new Set(
        this.chapters[bookId].filter((c) => c.volumeId === volId).map((c) => c.id),
      );
      for (const j of jobsStore.jobs)
        if (
          j.bookId === bookId &&
          j.chapterId != null &&
          gone.has(j.chapterId) &&
          (j.status === "running" || j.status === "queued")
        )
          jobsStore.cancelJob(j.id);
      jobsStore.jobs = jobsStore.jobs.filter(
        (j) => !(j.bookId === bookId && j.chapterId != null && gone.has(j.chapterId)),
      );
      book.volumes = book.volumes.filter((v) => v.id !== volId);
      this._renumber(
        bookId,
        this.chapters[bookId].filter((c) => !gone.has(c.id)),
      );
      uiStore.toast(`Removed ${vname} · ${gone.size} chapters`, { undo: revert });
      return "volume";
    },
    // Volumes are sortable: chapters follow the volume order and are renumbered continuously.
    moveVolume(bookId: string, volId: number, toIndex: number): void {
      const book = this.bookById(bookId);
      if (!book) return;
      const from = book.volumes.findIndex((v) => v.id === volId);
      if (from < 0) return;
      toIndex = Math.max(0, Math.min(book.volumes.length - 1, toIndex));
      if (from === toIndex) return;
      const vols = [...book.volumes];
      const [v] = vols.splice(from, 1);
      vols.splice(toIndex, 0, v);
      book.volumes = vols;
      const chs = this.chapters[bookId];
      this._renumber(
        bookId,
        vols.flatMap((v) =>
          chs.filter((c) => c.volumeId === v.id).sort((a, b) => a.volumeIndex - b.volumeIndex),
        ),
      );
    },
    // give `ordered` chapters ids 1..n in that order; re-key segments, remap jobs/exports, fix volume ranges
    _renumber(bookId: string, ordered: Chapter[]): void {
      const exportsStore = useExportsStore();
      const jobsStore = useJobsStore();
      const scriptsStore = useScriptsStore();

      const book = this.bookById(bookId);
      if (!book) return;
      const map: Record<number, number> = {};
      ordered.forEach((c, i) => {
        map[c.id] = i + 1;
      });
      const segs: SegmentMap = {};
      for (const [k, v] of Object.entries(scriptsStore.segments)) {
        if (!k.startsWith(bookId + ":")) {
          segs[k] = v;
          continue;
        }
        const old = Number(k.split(":")[1]);
        if (map[old]) segs[key(bookId, map[old])] = v;
      }
      scriptsStore.segments = segs;
      ordered.forEach((c) => {
        c.id = map[c.id];
        c.index = c.id;
      });
      this.chapters[bookId] = ordered;
      let from = 1;
      for (const v of book.volumes) {
        const mine = ordered.filter((c) => c.volumeId === v.id);
        v.from = from;
        v.to = from + mine.length - 1;
        from += mine.length;
        mine.forEach((c, i) => (c.volumeIndex = i + 1));
      }
      for (const j of jobsStore.jobs)
        if (j.bookId === bookId && j.chapterId != null && map[j.chapterId])
          j.chapterId = map[j.chapterId];
      const remap = (ids: number[]) => ids.filter((id) => map[id]).map((id) => map[id]);
      exportsStore.exports = exportsStore.exports
        .map((e) =>
          e.bookId !== bookId
            ? e
            : {
                ...e,
                chapterIds: remap(e.chapterIds),
                files: e.files.map((f) => ({ ...f, chapterIds: remap(f.chapterIds) })),
                state: Object.fromEntries(
                  Object.entries(e.state ?? {})
                    .filter(([id]) => map[Number(id)])
                    .map(([id, sig]) => [map[Number(id)], sig]),
                ),
              },
        )
        .filter((e) => e.bookId !== bookId || e.chapterIds.length);
      for (const e of exportsStore.exports)
        if (e.bookId === bookId) e.chapters = e.chapterIds.length;
    },
    removeBook(bookId: string): void {
      const castStore = useCastStore();
      const exportsStore = useExportsStore();
      const jobsStore = useJobsStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const revert = this._bookSnapshot(bookId);
      const title = this.bookById(bookId)?.title;
      for (const j of jobsStore.jobs)
        if (j.bookId === bookId && (j.status === "running" || j.status === "queued"))
          jobsStore.cancelJob(j.id);
      jobsStore.jobs = jobsStore.jobs.filter((j) => j.bookId !== bookId);
      this.books = this.books.filter((b) => b.id !== bookId);
      delete this.chapters[bookId];
      delete castStore.characters[bookId];
      delete castStore.lexicon[bookId];
      scriptsStore._previous = Object.fromEntries(
        Object.entries(scriptsStore._previous).filter(([k]) => !k.startsWith(bookId + ":")),
      );
      scriptsStore.segments = Object.fromEntries(
        Object.entries(scriptsStore.segments).filter(([k]) => !k.startsWith(bookId + ":")),
      );
      exportsStore.exports = exportsStore.exports.filter((e) => e.bookId !== bookId);
      if (uiStore.currentBookId === bookId) uiStore.currentBookId = null;
      uiStore.toast(`Removed “${title}” from the library`, { undo: revert });
    },
  },
});
