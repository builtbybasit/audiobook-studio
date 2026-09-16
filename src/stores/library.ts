// Books, chapters and library structure. Cross-feature removal/undo is coordinated here.
import { noticeGroups, plural, summarize } from "@/lib/contents";
import { isNarrated, isScripted, key } from "@/lib/scriptReview";
import { clone } from "@/lib/utils";
import { importedBook, importedVolume, PALETTE, sampleForFile } from "@/mock";
import type { Book, Chapter, ContentsSummary, NoticeGroup, SegmentMap, Volume } from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useScriptsStore } from "@/stores/scripts";
import { seedState } from "@/stores/seed";
import { useUiStore } from "@/stores/ui";
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
    // ---------- contents ----------
    /** The counts the contents review keeps on screen: what goes in, what is skipped, what is undecided. */
    contentsOf(s): (id: string) => ContentsSummary {
      return (id: string): ContentsSummary => summarize(s.chapters[id] ?? []);
    },
    /** Chapters with the same kind of note, so one decision can cover them all. */
    noticeGroupsOf(s): (id: string) => NoticeGroup[] {
      return (id: string): NoticeGroup[] => noticeGroups(s.chapters[id] ?? []);
    },
    /** The volume still waiting in the contents review, when the book itself is already in the library. */
    importingVolume(s): (id: string) => Volume | undefined {
      return (id: string): Volume | undefined =>
        s.books.find((b) => b.id === id)?.volumes.find((v) => v.importing);
    },
    /** Books the library shows: one still in its contents review is not in the library yet. */
    shelved(s): Book[] {
      return s.books.filter((b) => !b.importing);
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
    // ---------- chapters: skip for the audiobook ----------
    setExcluded(bookId: string, chId: number, v: boolean): void {
      this.skipChapters(bookId, [chId], v, { quiet: true });
    },
    /**
     * Skip chapters for the audiobook, or include them again. Nothing is deleted: a skipped chapter
     * keeps its text, its number and its place, leaves every stage, and can be restored from the
     * same review. Including a chapter that carries a note counts as having looked at it, so the
     * suggestion stops asking. A batch toasts with Undo; a single click is its own undo.
     */
    skipChapters(
      bookId: string,
      ids: number[],
      skip: boolean,
      { quiet = false, scope = "" }: { quiet?: boolean; scope?: string } = {},
    ): number {
      const uiStore = useUiStore();

      const before: { id: number; excluded?: boolean; kept?: boolean }[] = [];
      for (const id of ids) {
        const c = this.chapter(bookId, id);
        if (!c || !!c.excluded === skip) continue;
        before.push({ id, excluded: c.excluded, kept: c.kept });
        if (skip) c.excluded = true;
        else {
          delete c.excluded;
          if (c.note) c.kept = true;
        }
      }
      const n = before.length;
      if (!n || quiet) return n;
      const revert = () => {
        for (const w of before) {
          const c = this.chapter(bookId, w.id);
          if (!c) continue;
          if (w.excluded) c.excluded = true;
          else delete c.excluded;
          if (w.kept) c.kept = true;
          else delete c.kept;
        }
      };
      const s = this.contentsOf(bookId);
      uiStore.toast(
        skip
          ? `Skipped ${plural(n, "chapter")}${scope ? ` · ${scope}` : ""}`
          : `Included ${plural(n, "chapter")} again${scope ? ` · ${scope}` : ""}`,
        {
          kind: "info",
          description: `${s.included} of ${s.total} chapters now go in the audiobook. Skipped chapters stay in the book and can be restored here.`,
          undo: revert,
        },
      );
      return n;
    },
    /** The user looked at a note and is keeping the chapter: it stays in, and the suggestion stops asking. */
    keepChapters(bookId: string, ids: number[], { quiet = false } = {}): number {
      const uiStore = useUiStore();

      const before: { id: number; excluded?: boolean; kept?: boolean }[] = [];
      for (const id of ids) {
        const c = this.chapter(bookId, id);
        if (!c || !c.note || (c.kept && !c.excluded)) continue;
        before.push({ id, excluded: c.excluded, kept: c.kept });
        delete c.excluded;
        c.kept = true;
      }
      const n = before.length;
      if (!n || quiet) return n;
      uiStore.toast(`Kept ${plural(n, "chapter")}`, {
        kind: "info",
        description: "They go in the audiobook as they are; the note stays visible in the review.",
        undo: () => {
          for (const w of before) {
            const c = this.chapter(bookId, w.id);
            if (!c) continue;
            if (w.excluded) c.excluded = true;
            else delete c.excluded;
            if (w.kept) c.kept = true;
            else delete c.kept;
          }
        },
      });
      return n;
    },
    // ---------- budget & pause ----------
    pauseBook(bookId: string): void {
      const jobsStore = useJobsStore();
      const uiStore = useUiStore();

      const b = this.bookById(bookId);
      if (b) (b.budget ??= { cap: null, paused: false }).paused = true;
      const held = jobsStore.jobs.filter(
        (j) => j.bookId === bookId && (j.status === "running" || j.status === "queued"),
      ).length;
      uiStore.toast(`${b?.title}: new work paused`, {
        kind: "warn",
        description: held
          ? `${held} ${held === 1 ? "job is" : "jobs are"} held. In-flight steps can finish; queued work resumes from here.`
          : "New scripting, narration and builds are held until you resume this book.",
        timeout: 5000,
      });
    },
    resumeBook(bookId: string): void {
      const uiStore = useUiStore();
      const b = this.bookById(bookId);
      if (b?.budget) b.budget.paused = false;
      if (b) uiStore.toast(`${b.title}: work resumed`, { kind: "success" });
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
    // ---------- library: importing ----------
    // Import → review contents → add. An EPUB is read into a book (or a volume) marked `importing`,
    // the contents review works on it in place — the same review the book keeps afterwards — and
    // confirming clears the mark. Until then the library does not list it and nothing runs on it.
    /**
     * Read an EPUB into a new book waiting for its contents review. Nothing parses a file in this
     * prototype: `sample` names what the file turns out to contain. Returns the book's id.
     */
    importBook(
      sample: string,
      { id, file, title }: { id?: string; file?: string; title?: string } = {},
    ): string {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();

      const base = id ?? `import-${sample}`;
      let bookId = base;
      for (let n = 2; this.books.some((b) => b.id === bookId); n++) bookId = `${base}-${n}`;
      const { book, chapters } = importedBook(sample, bookId);
      if (title?.trim()) book.title = title.trim();
      if (file) book.volumes[0].file = file;
      this.books.push(book);
      this.chapters[bookId] = chapters;
      castStore.characters[bookId] = [
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
      return bookId;
    },
    /**
     * A novel split across several EPUBs: the file becomes one more volume, chapters keep numbering
     * continuously so roster / recap continuity carries across the boundary, and the new volume
     * waits in the contents review like a new book would. Returns the volume's id.
     */
    importVolume(bookId: string, sample: string, file: string, name?: string): number | null {
      const book = this.bookById(bookId);
      if (!book) return null;
      const chs = this.chapters[bookId];
      const { volume, chapters } = importedVolume(
        sample,
        Math.max(0, ...book.volumes.map((v) => v.id)) + 1,
        chs.length + 1,
        name?.trim() || `Vol. ${book.volumes.length + 1}`,
        file,
      );
      book.volumes.push(volume);
      chs.push(...chapters);
      return volume.id;
    },
    /** The review is done: the book, or its new volume, is in the library. Nothing starts running. */
    confirmImport(bookId: string): void {
      const uiStore = useUiStore();

      const book = this.bookById(bookId);
      if (!book) return;
      const wasBook = !!book.importing;
      const vol = book.volumes.find((v) => v.importing);
      delete book.importing;
      for (const v of book.volumes) delete v.importing;
      const s = this.contentsOf(bookId);
      const mine = vol ? this.chapters[bookId].filter((c) => c.volumeId === vol.id) : [];
      const volIn = mine.filter((c) => !c.excluded).length;
      uiStore.toast(
        wasBook
          ? `Added “${book.title}” to the library`
          : `Added ${vol?.name ?? "a volume"} to “${book.title}”`,
        {
          kind: "success",
          description: wasBook
            ? `${s.included} of ${s.total} chapters go in the audiobook` +
              (s.skipped ? `; ${s.skipped} skipped, kept in the book.` : ".")
            : `${volIn} of ${mine.length} chapters go in the audiobook` +
              (mine.length - volIn ? `; ${mine.length - volIn} skipped.` : "."),
          timeout: 6000,
        },
      );
    },
    /** Cancel an import: a book that was never added goes entirely; a new volume comes off its book. */
    discardImport(bookId: string): "book" | "volume" | null {
      const book = this.bookById(bookId);
      if (!book) return null;
      if (book.importing) {
        this._dropBook(bookId);
        return "book";
      }
      const vol = book.volumes.find((v) => v.importing);
      if (!vol) return null;
      this._dropVolume(bookId, vol.id);
      return "volume";
    },
    /** The old one-step import, kept for callers that want a book straight on the shelf. */
    addNovel(file: string, title?: string): string {
      const id = this.importBook(sampleForFile(file), { id: "new" + Date.now(), file, title });
      const book = this.bookById(id)!;
      delete book.importing;
      return id;
    },
    addVolume(bookId: string, file: string, name?: string): void {
      const volId = this.importVolume(bookId, sampleForFile(file), file, name);
      const v = this.bookById(bookId)?.volumes.find((v) => v.id === volId);
      if (v) delete v.importing;
    },
    renameVolume(bookId: string, volId: number, name: string): void {
      const v = this.bookById(bookId)?.volumes.find((v) => v.id === volId);
      if (v && name.trim()) v.name = name.trim();
    },
    /**
     * Runs of this book that a removal would cancel. A snapshot puts back finished work, not work
     * that was still going, so this is the one thing Undo cannot return — and therefore the one
     * thing the toast has to say out loud.
     */
    _inFlight(bookId: string, chapterIds?: Set<number>): number {
      const jobsStore = useJobsStore();
      return jobsStore.jobs.filter(
        (j) =>
          j.bookId === bookId &&
          (j.status === "running" || j.status === "queued") &&
          (!chapterIds || (j.chapterId != null && chapterIds.has(j.chapterId))),
      ).length;
    },
    /** "· 2 runs in flight were cancelled and do not come back." — "" when nothing was running. */
    _lostNote(n: number): string {
      return n
        ? ` ${n} run${n === 1 ? "" : "s"} in flight ${n === 1 ? "was" : "were"} cancelled and ${
            n === 1 ? "does" : "do"
          } not come back with Undo.`
        : "";
    },
    // Remove a volume (wrong EPUB added): its chapters, segments, jobs and exports go; the remaining
    // chapters are renumbered so numbering stays continuous. Removing the last volume removes the novel.
    //
    // It happens at once and offers Undo, like every other removal in the app — see the rule in
    // `src/stores/README.md`. What a confirmation step used to say is said by the control that
    // starts it and by the toast that follows.
    removeVolume(bookId: string, volId: number): "book" | "volume" | null {
      const uiStore = useUiStore();

      const book = this.bookById(bookId);
      if (!book) return null;
      if (book.volumes.length <= 1) {
        this.removeBook(bookId);
        return "book";
      }
      const revert = this._bookSnapshot(bookId);
      const vname = book.volumes.find((v) => v.id === volId)?.name;
      const lost = this._lostNote(
        this._inFlight(
          bookId,
          new Set(this.chapters[bookId].filter((c) => c.volumeId === volId).map((c) => c.id)),
        ),
      );
      const gone = this._dropVolume(bookId, volId);
      uiStore.toast(`Removed ${vname} · ${gone} chapters`, {
        description: `Its scripts, clips and export entries went with it, and the remaining chapters were renumbered.${lost}`,
        undo: revert,
      });
      return "volume";
    },
    /** Take a volume off its book without a word: its chapters, jobs and export entries go, the
     *  rest renumber. Returns how many chapters went. */
    _dropVolume(bookId: string, volId: number): number {
      const jobsStore = useJobsStore();

      const book = this.bookById(bookId);
      if (!book) return 0;
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
      return gone.size;
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
      const uiStore = useUiStore();

      const revert = this._bookSnapshot(bookId);
      const book = this.bookById(bookId);
      const title = book?.title;
      const chapters = (this.chapters[bookId] ?? []).length;
      const lost = this._lostNote(this._inFlight(bookId));
      this._dropBook(bookId);
      uiStore.toast(`Removed “${title}” from the library`, {
        description: `Its ${chapters} chapter${chapters === 1 ? "" : "s"}, script, cast and audiobooks went with it.${lost}`,
        undo: revert,
      });
    },
    /** Everything a book owns, gone without a word. */
    _dropBook(bookId: string): void {
      const castStore = useCastStore();
      const exportsStore = useExportsStore();
      const jobsStore = useJobsStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

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
    },
  },
});
