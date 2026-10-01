// Books, chapters and library structure. Cross-feature removal/undo is coordinated here.
//
// This store is the library's side of the seam in `@/services/library`: every action that changes
// a book is a request, and what comes back is what the store holds. The requests are made here
// rather than in the views, so no page has to know how a change reaches the server.
//
// One thing the library genuinely cannot do, rather than quietly pretends to: **a removal has no
// Undo.** Nothing puts a book back in the database, and there is no route that would. So a removal
// follows the other half of the danger rule in `src/stores/README.md` — it asks first, in the
// control that starts it — and the toast says it cannot be undone rather than offering a button
// that would lie.
//
// An undo of a skip or a keep, by contrast, is exact: the store records what the chapters were and
// puts that back through `setDecisions`, rather than running the inverse rule and letting an undone
// skip come back as "looked at".
import { useQueryCache } from "@pinia/colada";
import { noticeGroups, plural, summarize } from "@/lib/contents";
import { bookPromptProblems } from "@/lib/prompt";
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { invalidate } from "@/queries/invalidate";
import { fetchBook, fetchShelf } from "@/queries/library";
import { keys } from "@/queries/keys";
import {
  type BookSettings,
  type ImportedBook,
  type LibraryService,
  libraryService,
  type ReviewDecision,
} from "@/services/library";
import { unreachable } from "@/services/http";
import type {
  Book,
  BookPrompt,
  Chapter,
  CharacterVoice,
  ContentsSummary,
  NoticeGroup,
  Pacing,
  PromptTrialRequest,
  PromptTrialResult,
  Volume,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useExportsStore } from "@/stores/exports";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useScriptsStore } from "@/stores/scripts";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";

/** An EPUB arriving at `importBook`, and the title to give the book in place of its own. */
export interface ImportSpec {
  source: File;
  title?: string;
}

interface LibraryState {
  books: Book[];
  /**
   * Each book's chapters, once read. A book's chapters arrive when it is opened; until then the
   * book carries counts of them (`Book.chapters`), which is what the shelf reads. Prose is not here
   * at all: `useChapterText` in `@/queries` holds it.
   */
  chapters: Record<string, Chapter[]>;
  /** Whether the shelf has been read from the server yet. */
  loaded: boolean;
  /**
   * The last read of the shelf found nothing answering for the API. The Library says so where the
   * books would be, so an unreachable server never passes for an empty library.
   */
  unreachable: boolean;
}

/** A book's prompt as it is stored: null when it has no notes, is not switched on and holds no text. */
export function storedBookPrompt(p: BookPrompt): BookPrompt | null {
  return p.notes.trim() || p.replace || p.system.trim() || p.user.trim() ? p : null;
}

/** A promise that rejects with an `AbortError` as soon as `signal` fires, whatever it was waiting on. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new DOMException("Cancelled", "AbortError"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/**
 * How many settings writes each book has sent, so only the latest one's answer is installed. Not
 * state: nothing renders it, and a reload starting it again from nothing is correct.
 */
const settingsWrites = new Map<string, number>();

export const useLibraryStore = defineStore("library", {
  // The library starts empty and is read from the server.
  state: (): LibraryState => ({
    books: [],
    chapters: {},
    loaded: false,
    unreachable: false,
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
    /**
     * The counts the contents review keeps on screen: what goes in, what is skipped, what is
     * undecided. A book whose chapters have not been read yet answers from the counts it was
     * listed with, so the shelf never says "0 chapters" about a book it has not opened.
     */
    contentsOf(s): (id: string) => ContentsSummary {
      return (id: string): ContentsSummary => {
        const chapters = s.chapters[id];
        if (chapters) return summarize(chapters);
        const counts = s.books.find((b) => b.id === id)?.chapters;
        if (!counts) return summarize([]);
        return {
          total: counts.total,
          included: counts.included,
          skipped: counts.total - counts.included,
          suggested: 0,
          review: 0,
          kept: 0,
          noted: 0,
        };
      };
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
        const exported = exportsStore.exports.filter(
          (e) => e.bookId === id && e.status === "done",
        ).length;
        const all = s.chapters[id];
        // a book not opened yet: the counts it was listed with, and nothing it cannot know
        const counts = all ? null : s.books.find((b) => b.id === id)?.chapters;
        if (counts)
          return {
            total: counts.included,
            excluded: counts.total - counts.included,
            scripted: counts.scripted,
            fallback: 0,
            narrated: counts.narrated,
            stale: 0,
            exported,
            running: false,
          };
        const ch = (all ?? []).filter((c) => !c.excluded);
        return {
          total: ch.length,
          excluded: (all ?? []).length - ch.length,
          scripted: ch.filter(isScripted).length,
          fallback: ch.filter((c) => c.scripting === "fallback").length,
          narrated: ch.filter(isNarrated).length,
          stale: ch.filter((c) => c.narration === "stale").length,
          exported,
          running: ch.some((c) => c.scripting === "running" || c.narration === "running"),
        };
      };
    },
  },
  actions: {
    // ---------- the seam ----------
    /** The service answering for the library. */
    _service(): LibraryService {
      return libraryService();
    },
    /** A book and its chapters as the server just described them, in place of what was here. */
    _put(book: Book, chapters: Chapter[]): void {
      const i = this.books.findIndex((b) => b.id === book.id);
      if (i < 0) this.books.push(book);
      else this.books[i] = book;
      this.chapters[book.id] = chapters;
    },
    /** The shelf as the server lists it, in place of what was here. What `useShelf` installs. */
    _shelve(books: Book[]): void {
      this.books = books;
      this.loaded = true;
      this.unreachable = false;
    },
    /**
     * Read the shelf from the server (`fetchShelf`). Called once when the app starts; `force`
     * re-reads it.
     */
    async load(force = false): Promise<void> {
      if (this.loaded && !force) return;
      try {
        await fetchShelf();
      } catch (cause) {
        // the page says this one where the books would be; a toast on top would say it twice
        this.unreachable = unreachable(cause);
        if (!this.unreachable) toastFailure("read the library", cause);
      }
    },
    /**
     * Read one book and its chapters (`fetchBook`). The shelf lists books; only this brings the
     * chapters.
     *
     * Returns whether the book is now here, so a page opened on a link can send the person back to
     * the library rather than render an empty review.
     */
    async loadBook(bookId: string): Promise<boolean> {
      try {
        await fetchBook(bookId);
        return true;
      } catch (cause) {
        toastFailure("read this book", cause);
        return false;
      }
    },
    /**
     * Everything read about a book is out of date: its chapters were renumbered, or it is gone.
     *
     * Prose, scripts, histories, the cast and the exports are all filed under the book in the
     * query cache, so one invalidation covers them; what is still on screen is read again and what
     * is not is read when it next is.
     */
    _forgetBook(bookId: string): void {
      void invalidate({ key: keys.book(bookId) }, "all");
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

      // Only chapters the decision would actually change: the count the toast reports, the ids the
      // request carries, and the set an Undo has to put back are all the same list.
      const pending = ids.filter((id) => {
        const c = this.chapter(bookId, id);
        return !!c && !!c.excluded !== skip;
      });
      if (!pending.length) return 0;

      // What the chapters were, so the undo puts back exactly that.
      const before = this._decisionsOf(bookId, pending);
      try {
        this.chapters[bookId] = await this._service().skipChapters(bookId, pending, skip);
      } catch (cause) {
        toastFailure(skip ? "skip those chapters" : "include those chapters", cause);
        return 0;
      }
      const revert = () => this._restoreDecisions(bookId, before);

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

      const pending = ids.filter((id) => {
        const c = this.chapter(bookId, id);
        return !!c && !!c.note && !(c.kept && !c.excluded);
      });
      if (!pending.length) return 0;

      const before = this._decisionsOf(bookId, pending);
      try {
        this.chapters[bookId] = await this._service().keepChapters(bookId, pending);
      } catch (cause) {
        toastFailure("keep those chapters", cause);
        return 0;
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
     * asking the inverse rule to guess, through `setDecisions`; what comes back is what the store
     * holds.
     */
    async _restoreDecisions(bookId: string, decisions: ReviewDecision[]): Promise<void> {
      try {
        this.chapters[bookId] = await this._service().setDecisions(bookId, decisions);
      } catch (cause) {
        toastFailure("put those chapters back", cause);
      }
    },
    // ---------- budget, pause & settings ----------
    // These are inputs on a page — a number box, a toggle — so they change here at once and the
    // write follows; waiting on the server would make a field lag behind the typing. What the
    // server answers is then what the store holds, and a refused write reads the book back so the
    // screen shows what the server has rather than what was typed.
    /**
     * Write some of a book's settings to the server, and hold the book it answers with.
     *
     * Settings writes are last-one-wins: a number box sends one per keystroke, so only the answer
     * to the latest write for a book is installed — an earlier answer arriving late would put back
     * a value the person has already typed past. Returns the answer, or null when it was refused
     * or has been overtaken.
     */
    async _writeSettings(
      bookId: string,
      settings: BookSettings,
      what: string,
    ): Promise<ImportedBook | null> {
      const n = (settingsWrites.get(bookId) ?? 0) + 1;
      settingsWrites.set(bookId, n);
      try {
        const answer = await this._service().updateBook(bookId, settings);
        if (settingsWrites.get(bookId) !== n) return null;
        this._putBook(answer.book);
        return answer;
      } catch (cause) {
        if (settingsWrites.get(bookId) !== n) return null;
        toastFailure(what, cause);
        await this.loadBook(bookId);
        return null;
      }
    },
    /**
     * What this side holds of a chapter's progress, moved ahead of the server's answer: an edit
     * that staled a clip, a restore or an import that replaced the script, a pacing that re-timed
     * the clips here. The server's next read of the book is what the chapter then says.
     */
    _patchChapter(
      bookId: string,
      chId: number,
      patch: Partial<
        Pick<Chapter, "scripting" | "narration" | "narrationProgress" | "duration" | "lines">
      >,
    ): void {
      const c = this.chapter(bookId, chId);
      if (c) Object.assign(c, patch);
    },
    /** A narrated chapter one of whose clips no longer matches its script now reads as stale. */
    _staleChapter(bookId: string, chId: number): void {
      const c = this.chapter(bookId, chId);
      if (c?.narration === "done") c.narration = "stale";
    },
    /** The book's pacing as it now stands here, ahead of the write that sends it; null is the default. */
    _setPacing(bookId: string, pacing: Pacing | null): void {
      const b = this.bookById(bookId);
      if (!b) return;
      if (pacing) b.pacing = pacing;
      else delete b.pacing;
    },
    /** The book as the server just described it, leaving its chapters as they are here. */
    _putBook(book: Book): void {
      const i = this.books.findIndex((b) => b.id === book.id);
      if (i < 0) this.books.push(book);
      else this.books[i] = book;
    },
    /** The budget as it now stands here, written whole: the server takes the cap and the pause together. */
    async _pushBudget(bookId: string, what: string): Promise<unknown> {
      const b = this.bookById(bookId);
      const answer = await this._writeSettings(bookId, { budget: b?.budget ?? null }, what);
      if (answer) await this._budgetMoved(bookId);
      return answer;
    },
    /**
     * A budget was written: the book's spending is read again alongside it, so every panel that
     * sets the one against the other shows both as the server now has them. `keys.spend` is
     * named here rather than through `@/queries/spend`, which reads this store.
     */
    _budgetMoved(bookId: string): Promise<unknown> {
      return Promise.all([
        invalidate({ key: keys.spend(bookId) }),
        invalidate({ key: keys.librarySpend }),
      ]);
    },
    async pauseBook(bookId: string): Promise<void> {
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
      if (b) await this._pushBudget(bookId, "pause this book");
    },
    async resumeBook(bookId: string): Promise<void> {
      const uiStore = useUiStore();
      const b = this.bookById(bookId);
      if (b?.budget) b.budget.paused = false;
      if (b) uiStore.toast(`${b.title}: work resumed`, { kind: "success" });
      if (b) await this._pushBudget(bookId, "resume this book");
    },
    async setBudgetCap(bookId: string, cap: number | null): Promise<void> {
      const b = this.bookById(bookId);
      if (!b) return;
      (b.budget ??= { cap: null, paused: false }).cap = cap || null;
      await this._pushBudget(bookId, "save the budget");
    },
    /** The most the book's scripting may spend; null is no cap of its own. */
    async setScriptBudget(bookId: string, v: number | null): Promise<void> {
      const b = this.bookById(bookId);
      if (!b) return;
      b.scriptBudget = v;
      if (await this._writeSettings(bookId, { scriptBudget: v }, "save the scripting budget"))
        await this._budgetMoved(bookId);
    },
    /**
     * Whether the book reads its translator's and author's notes aloud. It changes no line, but it
     * changes which lines are read (`isSpoken`): on, every note is a line to narrate, and a chapter
     * whose notes have no clip is no longer finished; off, their clips stay where they are, unheard.
     * So what each chapter lasts, still needs and counts is taken from the server's answer.
     */
    async setReadNotes(bookId: string, on: boolean): Promise<void> {
      const b = this.bookById(bookId);
      if (!b || !!b.readNotes === on) return;
      if (on) b.readNotes = true;
      else delete b.readNotes;
      const answer = await this._writeSettings(
        bookId,
        { readNotes: on },
        on ? "read this book's notes aloud" : "stop reading this book's notes",
      );
      if (!answer) return;
      for (const { id, narration, duration, lines } of answer.chapters)
        this._patchChapter(bookId, id, { narration, duration, ...(lines ? { lines } : {}) });
    },
    /**
     * The book's Character voice — what a speaker with no voice of their own is read in — or null
     * to go back to the Narrator's. It changes no line and no clip: a clip made in the voice it
     * replaced shows as made in another voice, as one does when a speaker's own voice changes.
     */
    async setCharacterVoice(bookId: string, cv: CharacterVoice | null): Promise<void> {
      const b = this.bookById(bookId);
      if (!b) return;
      if (cv) b.characterVoice = cv;
      else delete b.characterVoice;
      await this._writeSettings(bookId, { characterVoice: cv }, "save the Character voice");
    },
    /**
     * The book's notes for the scripter and its own prompt, written whole. One that cannot be sent
     * is refused here, with the reason, and nothing is written; the panel shows the same reasons as
     * they are typed and only saves once there are none. Returns whether it was written.
     */
    async setBookPrompt(bookId: string, prompt: BookPrompt): Promise<boolean> {
      const uiStore = useUiStore();

      const b = this.bookById(bookId);
      if (!b) return false;
      const problems = bookPromptProblems(prompt);
      if (problems.length) {
        uiStore.toast("This book's prompt was not saved", {
          kind: "error",
          description: problems.join(" "),
          timeout: 8000,
        });
        return false;
      }
      const stored = storedBookPrompt(prompt);
      b.prompt = stored ? { ...stored } : undefined;
      return !!(await this._writeSettings(bookId, { prompt: stored }, "save this book's prompt"));
    },
    /**
     * Send one chunk of a chapter with a prompt that need not be saved yet, and hand back what came
     * back. Nothing is written to the script, but the request is real: the server prices it into
     * the book's ledger and holds it to the book's budget, so once it settles the book's spend and
     * the endpoint's activity are read again. A refusal (a budget that has no room, an endpoint
     * that cannot be reached) is thrown for the caller to show; a model's bad answer is a result.
     *
     * `signal` stops waiting for it: the trial's panel is cancelled at once, and nothing that
     * comes back afterwards is shown.
     */
    tryPrompt(
      bookId: string,
      request: PromptTrialRequest,
      signal?: AbortSignal,
    ): Promise<PromptTrialResult> {
      const sent = this._service().tryPrompt(bookId, request, signal);
      void sent
        .catch(() => undefined)
        .finally(() =>
          Promise.all([this._budgetMoved(bookId), invalidate({ key: keys.endpointRequests })]),
        );
      return abortable(sent, signal);
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
    /** Read an EPUB into a new book waiting for its contents review. Returns the book's id. */
    async importBook({ source, title }: ImportSpec): Promise<string | null> {
      try {
        const { book, chapters } = await this._service().importBook(source, { title });
        this._put(book, chapters);
        return book.id;
      } catch (cause) {
        toastFailure("read that file", cause);
        return null;
      }
    },
    /**
     * A novel split across several EPUBs: the file becomes one more volume, chapters keep numbering
     * continuously so roster / recap continuity carries across the boundary, and the new volume
     * waits in the contents review like a new book would. Returns the volume's id.
     */
    async importVolume(
      bookId: string,
      { source, name }: { source: File; name?: string },
    ): Promise<number | null> {
      if (!this.bookById(bookId)) return null;
      try {
        const { book, chapters } = await this._service().importVolume(bookId, source, name);
        this._put(book, chapters);
        return book.volumes.find((v) => v.importing)?.id ?? null;
      } catch (cause) {
        toastFailure("read that file", cause);
        return null;
      }
    },
    /** The review is done: the book, or its new volume, is in the library. Nothing starts running. */
    async confirmImport(bookId: string): Promise<boolean> {
      const uiStore = useUiStore();

      const book = this.bookById(bookId);
      if (!book) return false;
      const wasBook = !!book.importing;
      const vol = book.volumes.find((v) => v.importing);
      try {
        // What comes back is the shelved book: the marks are the server's to clear, not ours.
        const shelved = await this._service().confirmImport(bookId);
        this._put(shelved, this.chapters[bookId] ?? []);
      } catch (cause) {
        toastFailure(wasBook ? "add this book" : "add this volume", cause);
        return false;
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
      let discarded: "book" | "volume";
      try {
        discarded = await this._service().discardImport(bookId);
      } catch (cause) {
        toastFailure("cancel this import", cause);
        return null;
      }
      if (discarded === "book") this._dropBook(bookId);
      else {
        const vol = book.volumes.find((v) => v.importing);
        if (vol) this._dropVolume(bookId, vol.id);
      }
      return discarded;
    },
    /**
     * A new name for a volume. Like the settings above it is an input, so the name changes here at
     * once and the server's answer follows; a refused rename reads the book back.
     */
    async renameVolume(bookId: string, volId: number, name: string): Promise<void> {
      const v = this.bookById(bookId)?.volumes.find((v) => v.id === volId);
      name = name.trim();
      if (!v || !name || v.name === name) return;
      v.name = name;
      try {
        this._putBook(await this._service().renameVolume(bookId, volId, name));
      } catch (cause) {
        toastFailure("rename this volume", cause);
        await this.loadBook(bookId);
      }
    },
    // Remove a volume (wrong EPUB added): its chapters, segments, jobs and exports go; the remaining
    // chapters are renumbered so numbering stays continuous. Removing the last volume removes the novel.
    //
    // Nothing puts a volume back in the database, so this cannot be undone — see the rule in
    // `src/stores/README.md`. The control that starts it asks first, and the toast says so.
    async removeVolume(bookId: string, volId: number): Promise<"book" | "volume" | null> {
      const uiStore = useUiStore();

      const book = this.bookById(bookId);
      if (!book) return null;
      if (book.volumes.length <= 1) {
        await this.removeBook(bookId);
        return "book";
      }
      const vname = book.volumes.find((v) => v.id === volId)?.name;
      try {
        const removed = await this._service().removeVolume(bookId, volId);
        if (removed === "book") {
          this._dropBook(bookId);
          uiStore.toast(`Removed “${book.title}” from the library`, {
            description:
              "It was the last volume, so the novel went with it. This cannot be undone.",
          });
          return "book";
        }
      } catch (cause) {
        toastFailure("remove this volume", cause);
        return null;
      }
      const gone = this._dropVolume(bookId, volId);
      uiStore.toast(`Removed ${vname} · ${gone} chapters`, {
        description:
          "Its scripts, clips and export entries went with it, and the remaining chapters were renumbered. This cannot be undone.",
      });
      return "volume";
    },
    /** Take a volume off its book without a word: its chapters go and the rest renumber. The
     *  server cancelled its jobs and dropped its export entries; the reads of both follow from
     *  `_renumber`. Returns how many chapters went. */
    _dropVolume(bookId: string, volId: number): number {
      const book = this.bookById(bookId);
      if (!book) return 0;
      const gone = new Set(
        this.chapters[bookId].filter((c) => c.volumeId === volId).map((c) => c.id),
      );
      book.volumes = book.volumes.filter((v) => v.id !== volId);
      this._renumber(
        bookId,
        this.chapters[bookId].filter((c) => !gone.has(c.id)),
      );
      return gone.size;
    },
    // Volumes are sortable: chapters follow the volume order and are renumbered continuously.
    //
    // This asks the server first rather than moving at once: a renumbering moves every script, history, job and export filed under a chapter number,
    // and putting all of that back after a refusal (the server refuses while an audiobook is being
    // built, or while a volume is still in its review) would be a second renumbering. Once the
    // server has moved its side, `_renumber` moves this side by the same rule — each chapter keeps
    // its place within its volume — and the book and chapters the server answered with are installed
    // over the result. Returns whether the volume moved.
    async moveVolume(bookId: string, volId: number, toIndex: number): Promise<boolean> {
      const book = this.bookById(bookId);
      if (!book) return false;
      const from = book.volumes.findIndex((v) => v.id === volId);
      if (from < 0) return false;
      toIndex = Math.max(0, Math.min(book.volumes.length - 1, toIndex));
      if (from === toIndex) return false;
      const vols = [...book.volumes];
      const [v] = vols.splice(from, 1);
      vols.splice(toIndex, 0, v);
      let answer: ImportedBook;
      try {
        answer = await this._service().reorderVolumes(
          bookId,
          vols.map((v) => v.id),
        );
      } catch (cause) {
        toastFailure("move this volume", cause);
        return false;
      }
      // the book may have been re-read while the request was out; renumber what is here now
      const here = this.bookById(bookId);
      const chs = this.chapters[bookId];
      if (here && chs) {
        here.volumes = vols.map((v) => here.volumes.find((x) => x.id === v.id) ?? v);
        this._renumber(
          bookId,
          here.volumes.flatMap((v) =>
            chs.filter((c) => c.volumeId === v.id).sort((a, b) => a.volumeIndex - b.volumeIndex),
          ),
        );
      } else this._forgetBook(bookId);
      this._put(answer.book, answer.chapters);
      return true;
    },
    // give `ordered` chapters ids 1..n in that order; re-key what each store holds by chapter
    // number, fix volume ranges, and read again everything read from the server by those numbers
    _renumber(bookId: string, ordered: Chapter[]): void {
      const historyStore = useHistoryStore();
      const jobsStore = useJobsStore();
      const scriptsStore = useScriptsStore();

      const book = this.bookById(bookId);
      if (!book) return;
      const map: Record<number, number> = {};
      ordered.forEach((c, i) => {
        map[c.id] = i + 1;
      });
      scriptsStore._remapBook(bookId, map);
      // a chapter's script history is keyed by its number too, so it moves with the script
      historyStore.remapBook(bookId, map);
      // everything read from the server about this book was keyed by numbers that have moved: it
      // is a cache of the server's answers, so the cheap correct thing is to ask again — the
      // queue included, whose jobs name their chapters by number
      this._forgetBook(bookId);
      void jobsStore._changed();
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
    },
    async removeBook(bookId: string): Promise<void> {
      const uiStore = useUiStore();

      // Nothing puts a book back in the database, and no route would: the toast says so rather
      // than offering an Undo.
      const title = this.bookById(bookId)?.title;
      const chapters = (this.chapters[bookId] ?? []).length;
      try {
        await this._service().removeBook(bookId);
      } catch (cause) {
        toastFailure("remove this book", cause);
        return;
      }
      this._dropBook(bookId);
      uiStore.toast(`Removed “${title}” from the library`, {
        description: `Its ${chapters} chapter${chapters === 1 ? "" : "s"}, script, cast and audiobooks went with it. This cannot be undone.`,
      });
    },
    /**
     * Everything a book owns, gone without a word. The server cancelled its jobs and took its
     * audiobooks and its spending with it; each store that held some of the book lets it go, and
     * the queue and the library's spending are read again.
     */
    _dropBook(bookId: string): void {
      const castStore = useCastStore();
      const historyStore = useHistoryStore();
      const jobsStore = useJobsStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      this.books = this.books.filter((b) => b.id !== bookId);
      delete this.chapters[bookId];
      castStore._dropBook(bookId);
      scriptsStore._dropBook(bookId);
      historyStore.clearBook(bookId);
      // nothing filed under the book is there to read again, so its reads are let go rather than
      // invalidated: a read of a book the server no longer has would only fail
      const queryCache = useQueryCache();
      for (const entry of queryCache.getEntries({ key: keys.book(bookId) }))
        queryCache.remove(entry);
      void jobsStore._changed();
      void invalidate({ key: keys.librarySpend });
      if (uiStore.currentBookId === bookId) uiStore.currentBookId = null;
    },
  },
});
