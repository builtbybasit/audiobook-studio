// Books, chapters and library structure. Cross-feature removal/undo is coordinated here.
//
// This store is the library's side of the seam in `@/services/library`. Every action that changes
// a book has two halves: with a service answering, the change is a request and what comes back is
// what the store holds; without one, the seeded world in the store *is* the library and the same
// change happens in memory. The halves are here rather than in the views, which is the whole point
// of the seam — no page knows which side answered.
//
// One thing the backend half genuinely cannot do, rather than quietly pretends to: **a removal has
// no Undo.** `_bookSnapshot` puts a book back in this store; it cannot put one back in the
// database, and there is no route that would. So in backend mode a removal follows the other half
// of the danger rule in `src/stores/README.md` — it asks first, in the control that starts it — and
// the toast says it cannot be undone rather than offering a button that would lie.
//
// An undo of a skip or a keep, by contrast, is exact on both sides: the store records what the
// chapters were and puts that back — in memory, or through `setDecisions` on the server — rather
// than running the inverse rule and letting an undone skip come back as "looked at".
import { noticeGroups, plural, summarize } from "@/lib/contents";
import { isNarrated, isScripted, key } from "@/lib/scriptReview";
import { clone } from "@/lib/utils";
import { importedBook, importedVolume, PALETTE, sampleForFile } from "@/mock";
import {
  activeLibraryService,
  ApiError,
  type LibraryService,
  type ReviewDecision,
  type TextFormat,
} from "@/services/library";
import type { Book, Chapter, ContentsSummary, NoticeGroup, SegmentMap, Volume } from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useScriptsStore } from "@/stores/scripts";
import { seedState } from "@/stores/seed";
import { useUiStore } from "@/stores/ui";

/** What an EPUB arriving at `importBook` is: a real file, or the demo's name for its contents. */
export interface ImportSpec {
  /** The EPUB itself. Required when a server is answering; there is nothing to send without it. */
  source?: File;
  /** Demo only: what the file turns out to contain, since the seeded world parses nothing. */
  sample?: string;
  /** Demo only: the id to give the book, so a scenario can name the book it opens. */
  id?: string;
  /** The file name, as the volume row shows it. */
  file?: string;
  title?: string;
}

/** A chapter's prose in the two forms the seam serves it in. See `LibraryService.chapterText`. */
interface ChapterText {
  markdown?: string;
  plain?: string;
}

interface LibraryState {
  books: Book[];
  chapters: Record<string, Chapter[]>;
  /**
   * Chapter prose read from the server, keyed `bookId:chapterId`.
   *
   * Backend mode only: in demo the text is generated from the seeded world on demand and there is
   * nothing to cache. Empty here means "not read yet", never "no text" — a reader that finds
   * nothing asks for it rather than falling back to a fixture.
   */
  texts: Record<string, ChapterText>;
  /** Backend mode: whether the shelf has been read from the server yet. */
  loaded: boolean;
}

export const useLibraryStore = defineStore("library", {
  // With a service answering, the library starts empty and is read from the server. The seeded
  // world is not a starting point for a real library — it is the other mode.
  state: (): LibraryState => ({
    ...(activeLibraryService()
      ? { books: [] as Book[], chapters: {} as Record<string, Chapter[]> }
      : seedState("books", "chapters")),
    texts: {},
    loaded: false,
  }),
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
    // ---------- chapter prose ----------
    /**
     * A chapter's prose as the server holds it, or `null` when it has not been read yet.
     *
     * `null` is the honest answer while the request is in flight: the caller waits or shows
     * nothing, and never reaches for a fixture to fill the gap. Demo mode does not come here at
     * all — its text is generated from the seeded world.
     */
    textOf(s): (bookId: string, chId: number, format?: TextFormat) => string | null {
      return (bookId: string, chId: number, format: TextFormat = "markdown"): string | null =>
        s.texts[key(bookId, chId)]?.[format] ?? null;
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
    // ---------- the seam ----------
    /** The service answering for the library, or null when this is the seeded demo. */
    _service(): LibraryService | null {
      return activeLibraryService();
    },
    /**
     * Say a request failed, and change nothing.
     *
     * The alternative — applying the change locally anyway — is the silent fallback the mode rule
     * forbids twice over: the screen would show a library the server does not have.
     */
    _failed(what: string, cause: unknown): void {
      const uiStore = useUiStore();
      const api = cause instanceof ApiError ? cause : null;
      uiStore.toast(api ? api.message : `Could not ${what}`, {
        kind: "error",
        description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
        timeout: 8000,
      });
    },
    /** A book and its chapters as the server just described them, in place of what was here. */
    _put(book: Book, chapters: Chapter[]): void {
      const i = this.books.findIndex((b) => b.id === book.id);
      if (i < 0) this.books.push(book);
      else this.books[i] = book;
      this.chapters[book.id] = chapters;
    },
    /**
     * Read the shelf from the server. Demo mode is already holding one.
     *
     * Called once when the app starts in backend mode; `force` re-reads it.
     */
    async load(force = false): Promise<void> {
      const svc = this._service();
      if (!svc || (this.loaded && !force)) return;
      try {
        this.books = await svc.books();
        this.loaded = true;
      } catch (cause) {
        this._failed("read the library", cause);
      }
    },
    /**
     * Read one book and its chapters. The shelf lists books; only this brings the chapters.
     *
     * Returns whether the book is now here, so a page opened on a link can send the person back to
     * the library rather than render an empty review.
     */
    async loadBook(bookId: string): Promise<boolean> {
      const svc = this._service();
      if (!svc) return !!this.bookById(bookId);
      try {
        const { book, chapters } = await svc.book(bookId);
        this._put(book, chapters);
        return true;
      } catch (cause) {
        this._failed("read this book", cause);
        return false;
      }
    },
    /**
     * Read a chapter's prose into the cache, in the form the caller needs.
     *
     * `plain` is what anything that counts, bills or speaks a chapter must ask for — the stored
     * form would have a link's address and a table's pipes read out and charged for.
     */
    async loadText(bookId: string, chId: number, format: TextFormat = "markdown"): Promise<void> {
      const svc = this._service();
      if (!svc || this.textOf(bookId, chId, format) != null) return;
      try {
        const text = await svc.chapterText(bookId, chId, format);
        this.texts[key(bookId, chId)] = { ...this.texts[key(bookId, chId)], [format]: text };
      } catch (cause) {
        this._failed("read this chapter", cause);
      }
    },
    /** Forget cached prose for a book that is going, or whose chapters have been renumbered. */
    _forgetText(bookId: string): void {
      for (const k of Object.keys(this.texts)) if (k.startsWith(bookId + ":")) delete this.texts[k];
    },
    _bookSnapshot(bookId: string): () => void {
      const castStore = useCastStore();
      const exportsStore = useExportsStore();
      const historyStore = useHistoryStore();
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
      // each chapter's script history belongs to history.ts; it puts its own back
      const history = historyStore._bookSnapshot(bookId);
      return () => {
        history();
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
    setExcluded(bookId: string, chId: number, v: boolean): Promise<number> {
      return this.skipChapters(bookId, [chId], v, { quiet: true });
    },
    /**
     * Skip chapters for the audiobook, or include them again. Nothing is deleted: a skipped chapter
     * keeps its text, its number and its place, leaves every stage, and can be restored from the
     * same review. Including a chapter that carries a note counts as having looked at it, so the
     * suggestion stops asking. A batch toasts with Undo; a single click is its own undo.
     */
    async skipChapters(
      bookId: string,
      ids: number[],
      skip: boolean,
      { quiet = false, scope = "" }: { quiet?: boolean; scope?: string } = {},
    ): Promise<number> {
      const uiStore = useUiStore();
      const svc = this._service();

      // Only chapters the decision would actually change: the count the toast reports, the ids the
      // request carries, and the set an Undo has to put back are all the same list.
      const pending = ids.filter((id) => {
        const c = this.chapter(bookId, id);
        return !!c && !!c.excluded !== skip;
      });
      if (!pending.length) return 0;

      // What the chapters were, so the undo puts back exactly that — on either side of the seam.
      const before = this._decisionsOf(bookId, pending);
      let revert: (() => void) | (() => Promise<void>);
      if (svc) {
        try {
          this.chapters[bookId] = await svc.skipChapters(bookId, pending, skip);
        } catch (cause) {
          this._failed(skip ? "skip those chapters" : "include those chapters", cause);
          return 0;
        }
        revert = () => this._restoreDecisions(bookId, before);
      } else {
        for (const id of pending) {
          const c = this.chapter(bookId, id)!;
          if (skip) c.excluded = true;
          else {
            delete c.excluded;
            if (c.note) c.kept = true;
          }
        }
        revert = () => this._restoreDecisions(bookId, before);
      }

      const n = pending.length;
      if (quiet) return n;
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
    async keepChapters(bookId: string, ids: number[], { quiet = false } = {}): Promise<number> {
      const uiStore = useUiStore();
      const svc = this._service();

      const pending = ids.filter((id) => {
        const c = this.chapter(bookId, id);
        return !!c && !!c.note && !(c.kept && !c.excluded);
      });
      if (!pending.length) return 0;

      const before = this._decisionsOf(bookId, pending);
      if (svc) {
        try {
          this.chapters[bookId] = await svc.keepChapters(bookId, pending);
        } catch (cause) {
          this._failed("keep those chapters", cause);
          return 0;
        }
      } else {
        for (const id of pending) {
          const c = this.chapter(bookId, id)!;
          delete c.excluded;
          c.kept = true;
        }
      }
      const revert = () => this._restoreDecisions(bookId, before);

      const n = pending.length;
      if (quiet) return n;
      uiStore.toast(`Kept ${plural(n, "chapter")}`, {
        kind: "info",
        description: "They go in the audiobook as they are; the note stays visible in the review.",
        undo: revert,
      });
      return n;
    },
    /** What these chapters' review decisions are right now, recorded for an undo to put back. */
    _decisionsOf(bookId: string, ids: readonly number[]): ReviewDecision[] {
      return ids.flatMap((id) => {
        const c = this.chapter(bookId, id);
        return c
          ? [{ id, ...(c.excluded ? { excluded: true } : {}), ...(c.kept ? { kept: true } : {}) }]
          : [];
      });
    },
    /**
     * Put chapters' review decisions back to exactly `decisions`.
     *
     * The one undo for skip, include and keep. Their rules only run forwards — including a noted
     * chapter records that it was looked at — so an undo restores what was recorded rather than
     * asking the inverse rule to guess; with a server answering that is `setDecisions`, and what
     * comes back is what the store holds.
     */
    async _restoreDecisions(bookId: string, decisions: ReviewDecision[]): Promise<void> {
      const svc = this._service();
      if (svc) {
        try {
          this.chapters[bookId] = await svc.setDecisions(bookId, decisions);
        } catch (cause) {
          this._failed("put those chapters back", cause);
        }
        return;
      }
      for (const w of decisions) {
        const c = this.chapter(bookId, w.id);
        if (!c) continue;
        if (w.excluded) c.excluded = true;
        else delete c.excluded;
        if (w.kept && c.note) c.kept = true;
        else delete c.kept;
      }
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
     * Read an EPUB into a new book waiting for its contents review. Returns the book's id.
     *
     * With a server answering, the file itself is sent and what comes back is a parsed book. The
     * seeded world parses nothing, so there `sample` names what the file turns out to contain.
     */
    async importBook(spec: ImportSpec): Promise<string | null> {
      const svc = this._service();
      if (svc) {
        if (!spec.source) {
          this._failed("read that file", new Error("No file was chosen."));
          return null;
        }
        try {
          const { book, chapters } = await svc.importBook(spec.source, { title: spec.title });
          this._put(book, chapters);
          return book.id;
        } catch (cause) {
          this._failed("read that file", cause);
          return null;
        }
      }
      return this._importedLocally(spec.sample ?? sampleForFile(spec.file ?? ""), spec);
    },
    /**
     * The seeded world's half of `importBook`, kept separate because it is synchronous.
     *
     * A demo scenario builds its situation in one pass and reads the book id straight back, so the
     * path the scenarios take must not become a promise.
     */
    _importedLocally(
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
    async importVolume(
      bookId: string,
      spec: ImportSpec & { name?: string },
    ): Promise<number | null> {
      const book = this.bookById(bookId);
      if (!book) return null;
      const svc = this._service();
      if (svc) {
        if (!spec.source) {
          this._failed("read that file", new Error("No file was chosen."));
          return null;
        }
        try {
          const { book: updated, chapters } = await svc.importVolume(
            bookId,
            spec.source,
            spec.name,
          );
          this._put(updated, chapters);
          return updated.volumes.find((v) => v.importing)?.id ?? null;
        } catch (cause) {
          this._failed("read that file", cause);
          return null;
        }
      }
      const chs = this.chapters[bookId];
      const { volume, chapters } = importedVolume(
        spec.sample ?? sampleForFile(spec.file ?? ""),
        Math.max(0, ...book.volumes.map((v) => v.id)) + 1,
        chs.length + 1,
        spec.name?.trim() || `Vol. ${book.volumes.length + 1}`,
        spec.file ?? "volume.epub",
      );
      book.volumes.push(volume);
      chs.push(...chapters);
      return volume.id;
    },
    /** The review is done: the book, or its new volume, is in the library. Nothing starts running. */
    async confirmImport(bookId: string): Promise<boolean> {
      const uiStore = useUiStore();
      const svc = this._service();

      const book = this.bookById(bookId);
      if (!book) return false;
      const wasBook = !!book.importing;
      const vol = book.volumes.find((v) => v.importing);
      if (svc) {
        try {
          // What comes back is the shelved book: the marks are the server's to clear, not ours.
          const shelved = await svc.confirmImport(bookId);
          this._put(shelved, this.chapters[bookId] ?? []);
        } catch (cause) {
          this._failed(wasBook ? "add this book" : "add this volume", cause);
          return false;
        }
      } else {
        delete book.importing;
        for (const v of book.volumes) delete v.importing;
      }
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
      return true;
    },
    /** Cancel an import: a book that was never added goes entirely; a new volume comes off its book. */
    async discardImport(bookId: string): Promise<"book" | "volume" | null> {
      const book = this.bookById(bookId);
      if (!book) return null;
      const svc = this._service();
      if (svc) {
        let discarded: "book" | "volume";
        try {
          discarded = await svc.discardImport(bookId);
        } catch (cause) {
          this._failed("cancel this import", cause);
          return null;
        }
        if (discarded === "book") this._dropBook(bookId);
        else {
          const vol = book.volumes.find((v) => v.importing);
          if (vol) this._dropVolume(bookId, vol.id);
        }
        return discarded;
      }
      if (book.importing) {
        this._dropBook(bookId);
        return "book";
      }
      const vol = book.volumes.find((v) => v.importing);
      if (!vol) return null;
      this._dropVolume(bookId, vol.id);
      return "volume";
    },
    /**
     * The old one-step import, kept for callers that want a book straight on the shelf.
     *
     * Seeded world only: it skips the contents review, which a real import cannot do — the server
     * marks a book `importing` and only `confirmImport` clears it.
     */
    addNovel(file: string, title?: string): string {
      const id = this._importedLocally(sampleForFile(file), {
        id: "new" + Date.now(),
        file,
        title,
      });
      const book = this.bookById(id)!;
      delete book.importing;
      return id;
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
    async removeVolume(bookId: string, volId: number): Promise<"book" | "volume" | null> {
      const uiStore = useUiStore();
      const svc = this._service();

      const book = this.bookById(bookId);
      if (!book) return null;
      if (book.volumes.length <= 1) {
        await this.removeBook(bookId);
        return "book";
      }
      const revert = svc ? null : this._bookSnapshot(bookId);
      const vname = book.volumes.find((v) => v.id === volId)?.name;
      const lost = this._lostNote(
        this._inFlight(
          bookId,
          new Set(this.chapters[bookId].filter((c) => c.volumeId === volId).map((c) => c.id)),
        ),
      );
      if (svc) {
        try {
          const removed = await svc.removeVolume(bookId, volId);
          if (removed === "book") {
            this._dropBook(bookId);
            uiStore.toast(`Removed “${book.title}” from the library`, {
              description:
                "It was the last volume, so the novel went with it. This cannot be undone.",
            });
            return "book";
          }
        } catch (cause) {
          this._failed("remove this volume", cause);
          return null;
        }
      }
      const gone = this._dropVolume(bookId, volId);
      uiStore.toast(`Removed ${vname} · ${gone} chapters`, {
        description:
          `Its scripts, clips and export entries went with it, and the remaining chapters were renumbered.` +
          (svc ? " This cannot be undone." : lost),
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
      const historyStore = useHistoryStore();
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
      // cached prose is keyed by the chapter number as well, and these are about to move. It is a
      // cache of the server's answer, so the cheap correct thing is to drop it and ask again.
      this._forgetText(bookId);
      scriptsStore._forgetLoaded(bookId);
      // a chapter's script history is keyed by its number too, so it moves with the script
      historyStore.remapBook(bookId, map);
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
    async removeBook(bookId: string): Promise<void> {
      const uiStore = useUiStore();
      const svc = this._service();

      // A snapshot puts a book back in this store; nothing puts one back in the database, and no
      // route would. With a server answering, the toast says so rather than offering the button.
      const revert = svc ? null : this._bookSnapshot(bookId);
      const book = this.bookById(bookId);
      const title = book?.title;
      const chapters = (this.chapters[bookId] ?? []).length;
      const lost = this._lostNote(this._inFlight(bookId));
      if (svc) {
        try {
          await svc.removeBook(bookId);
        } catch (cause) {
          this._failed("remove this book", cause);
          return;
        }
      }
      this._dropBook(bookId);
      uiStore.toast(`Removed “${title}” from the library`, {
        description:
          `Its ${chapters} chapter${chapters === 1 ? "" : "s"}, script, cast and audiobooks went with it.` +
          (svc ? " This cannot be undone." : lost),
        undo: revert,
      });
    },
    /** Everything a book owns, gone without a word. */
    _dropBook(bookId: string): void {
      const castStore = useCastStore();
      const exportsStore = useExportsStore();
      const historyStore = useHistoryStore();
      const jobsStore = useJobsStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      for (const j of jobsStore.jobs)
        if (j.bookId === bookId && (j.status === "running" || j.status === "queued"))
          jobsStore.cancelJob(j.id);
      jobsStore.jobs = jobsStore.jobs.filter((j) => j.bookId !== bookId);
      this.books = this.books.filter((b) => b.id !== bookId);
      delete this.chapters[bookId];
      this._forgetText(bookId);
      delete castStore.characters[bookId];
      delete castStore.lexicon[bookId];
      scriptsStore._previous = Object.fromEntries(
        Object.entries(scriptsStore._previous).filter(([k]) => !k.startsWith(bookId + ":")),
      );
      scriptsStore.segments = Object.fromEntries(
        Object.entries(scriptsStore.segments).filter(([k]) => !k.startsWith(bookId + ":")),
      );
      scriptsStore._forgetLoaded(bookId);
      exportsStore.exports = exportsStore.exports.filter((e) => e.bookId !== bookId);
      historyStore.clearBook(bookId);
      if (uiStore.currentBookId === bookId) uiStore.currentBookId = null;
    },
  },
});
