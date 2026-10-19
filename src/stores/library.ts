// Books, chapters and library structure; cross-feature removal/undo is coordinated here. Every
// change is a request through `@/services/library`, and the answer is what the store holds.
// A removal has no Undo (nothing puts a book back), so its control asks first. Undoing a skip or
// keep restores the recorded decisions via `setDecisions` rather than running the inverse rule.
import { useQueryCache } from "@pinia/colada";
import { chapterNumbers, chapterRef } from "@/lib/chapterNumber";
import { noticeGroups, plural, summarize } from "@/lib/contents";
import { coverRefusal } from "@/lib/exports";
import { bookPromptProblems } from "@/lib/prompt";
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { staleMoved } from "@/queries/effects";
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
  BookUpdated,
  Chapter,
  CharacterVoice,
  ContentsSummary,
  NoticeGroup,
  Pacing,
  PromptTrialRequest,
  PromptTrialResult,
  StartedOver,
  ThoughtChoice,
  Volume,
  VolumeStart,
} from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useExportsStore } from "@/stores/exports";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useScriptsStore } from "@/stores/scripts";
import { useTransferStore } from "@/stores/transfer";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";

/** An EPUB for `importBook`, and the title to use in place of its own. */
export interface ImportSpec {
  source: File;
  title?: string;
}

interface LibraryState {
  books: Book[];
  /**
   * Each book's chapters, once opened; until then the shelf reads `Book.chapters` counts. Prose
   * lives in `useChapterText`.
   */
  chapters: Record<string, Chapter[]>;
  loaded: boolean;
  /** The last shelf read found no API, so an unreachable server never passes for an empty library. */
  unreachable: boolean;
}

/** Null when the prompt has no notes, is off and holds no text. */
export function storedBookPrompt(p: BookPrompt): BookPrompt | null {
  return p.notes.trim() || p.replace || p.system.trim() || p.user.trim() ? p : null;
}

/** Rejects with an `AbortError` as soon as `signal` fires. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new DOMException("Cancelled", "AbortError"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** Settings writes sent per book, so only the latest answer is installed. Not state. */
const settingsWrites = new Map<string, number>();

export const useLibraryStore = defineStore("library", {
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
    /**
     * A shelved book's chapters without the volume still in its review: nothing runs on that until
     * it is added, so only the contents review (`allChaptersOf`) shows it.
     */
    chaptersOf(s): (id: string) => Chapter[] {
      return (id: string): Chapter[] => {
        const all = s.chapters[id] ?? [];
        const book = s.books.find((b) => b.id === id);
        const waiting = book?.importing ? undefined : book?.volumes.find((v) => v.importing);
        return waiting ? all.filter((c) => c.volumeId !== waiting.id) : all;
      };
    },
    /** Every chapter, a volume in review included. */
    allChaptersOf(s): (id: string) => Chapter[] {
      return (id: string): Chapter[] => s.chapters[id] ?? [];
    },
    chapter(s): (bookId: string, chId: number) => Chapter | undefined {
      return (bookId: string, chId: number): Chapter | undefined => {
        const all = s.chapters[bookId] ?? [];
        // ids run 1…n in order, so this is O(1) at 900 chapters; the find covers a gap
        const at = all[chId - 1];
        return at?.id === chId ? at : all.find((c) => c.id === chId);
      };
    },
    /**
     * Each book's reading numbers (`@/lib/chapterNumber`) by chapter id. Reads only ids and
     * `excluded`, so a progress tick does not renumber.
     */
    chapterNumbers(s): Record<string, Map<number, number>> {
      return Object.fromEntries(
        Object.entries(s.chapters).map(([id, chapters]) => [id, chapterNumbers(chapters)]),
      );
    },
    /** Undefined when the chapter is skipped or its book is not read yet. */
    numberOf(): (bookId: string, chId: number) => number | undefined {
      return (bookId: string, chId: number) => this.chapterNumbers[bookId]?.get(chId);
    },
    /**
     * "ch 2" or "skipped". Undefined while the chapters are unread, so a page omits the chapter
     * rather than calling it skipped.
     */
    chapterRef(s): (bookId: string, chId: number) => string | undefined {
      return (bookId: string, chId: number) =>
        s.chapters[bookId]?.some((c) => c.id === chId)
          ? chapterRef(this.chapterNumbers[bookId]?.get(chId))
          : undefined;
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
     * The contents review's counts: in, skipped, undecided. An unopened book answers from its
     * listing counts, so the shelf never says "0 chapters".
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
    /** Where each volume begins, in reading order, with its name: the list `setVolumes` takes. */
    volumeStartsOf(): (id: string) => VolumeStart[] {
      return (id: string): VolumeStart[] =>
        this.volumesOf(id).map((v) => ({ chapter: v.from, name: v.name }));
    },
    /** The volume still in its contents review, when the book is already in the library. */
    importingVolume(s): (id: string) => Volume | undefined {
      return (id: string): Volume | undefined =>
        s.books.find((b) => b.id === id)?.volumes.find((v) => v.importing);
    },
    /** Books the library shows; one still in its contents review is not shown. */
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
        // a book not opened yet: its listing counts, and nothing it cannot know
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
    _service(): LibraryService {
      return libraryService();
    },
    /** Install a book and its chapters as the server described them. */
    _put(book: Book, chapters: Chapter[]): void {
      const i = this.books.findIndex((b) => b.id === book.id);
      if (i < 0) this.books.push(book);
      else this.books[i] = book;
      this.chapters[book.id] = chapters;
    },
    /** Install the shelf as the server lists it; what `useShelf` calls. */
    _shelve(books: Book[]): void {
      this.books = books;
      this.loaded = true;
      this.unreachable = false;
    },
    /** Read the shelf once at start; `force` rereads it. */
    async load(force = false): Promise<void> {
      if (this.loaded && !force) return;
      try {
        await fetchShelf();
      } catch (cause) {
        // the page shows this where the books would be; no toast as well
        this.unreachable = unreachable(cause);
        if (!this.unreachable) toastFailure("read the library", cause);
      }
    },
    /**
     * Read one book and its chapters; only this brings the chapters. Returns whether the book is
     * here, so a page opened on a link can send the person back to the library.
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
     * Everything read about a book is out of date (renumbered or gone). All of it is filed under
     * the book in the query cache, so one invalidation covers it.
     */
    _forgetBook(bookId: string): void {
      void invalidate({ key: keys.book(bookId) }, "all");
    },
    // ---------- chapters: skip for the audiobook ----------
    setExcluded(bookId: string, chId: number, v: boolean): Promise<number> {
      return this.skipChapters(bookId, [chId], v, { quiet: true });
    },
    /**
     * Skip chapters or include them again; nothing is deleted. Including a noted chapter counts as
     * looked at. A batch toasts with Undo; a single click is its own undo.
     */
    async skipChapters(
      bookId: string,
      ids: number[],
      skip: boolean,
      { quiet = false, scope = "" }: { quiet?: boolean; scope?: string } = {},
    ): Promise<number> {
      const uiStore = useUiStore();

      // Only chapters this would change: the toast count, request ids and Undo set are one list.
      const pending = ids.filter((id) => {
        const c = this.chapter(bookId, id);
        return !!c && !!c.excluded !== skip;
      });
      if (!pending.length) return 0;

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
    /** Keep a noted chapter in, so the suggestion stops asking. */
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
    /** These chapters' review decisions now, for an undo to put back. */
    _decisionsOf(bookId: string, ids: readonly number[]): ReviewDecision[] {
      return ids.flatMap((id) => {
        const c = this.chapter(bookId, id);
        return c
          ? [{ id, ...(c.excluded ? { excluded: true } : {}), ...(c.kept ? { kept: true } : {}) }]
          : [];
      });
    },
    /**
     * Put review decisions back exactly, via `setDecisions`: the one undo for skip, include and
     * keep. Their rules only run forwards, so the recorded state is restored, not inferred.
     */
    async _restoreDecisions(bookId: string, decisions: ReviewDecision[]): Promise<void> {
      try {
        this.chapters[bookId] = await this._service().setDecisions(bookId, decisions);
      } catch (cause) {
        toastFailure("put those chapters back", cause);
      }
    },
    // ---------- budget, pause & settings ----------
    // These are page inputs, so they change here at once and the write follows; a refused write
    // reads the book back.
    /**
     * Write some of a book's settings and hold the answer. Last-one-wins: only the latest write's
     * answer is installed, or a late one would undo typing. Null when refused or overtaken. Clips
     * each answer says it staled are marked whichever answer it is.
     */
    async _writeSettings(
      bookId: string,
      settings: BookSettings,
      what: string,
    ): Promise<BookUpdated | null> {
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      const n = (settingsWrites.get(bookId) ?? 0) + 1;
      settingsWrites.set(bookId, n);
      try {
        const answer = await this._service().updateBook(bookId, settings);
        for (const { chapterId, ids, revision } of answer.stale)
          scriptsStore._applyLines(bookId, chapterId, ids, {}, revision);
        const staled = answer.stale.reduce((a, r) => a + r.ids.length, 0);
        if (staled)
          uiStore.toast("Pause length changed", {
            kind: "warn",
            description: `${staled} rendered line${staled === 1 ? "" : "s"} still have the old pause — re-narrate to apply.`,
          });
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
     * Move a chapter's progress ahead of the server (an edit staled a clip, a restore replaced the
     * script, pacing re-timed clips). The next book read is what it then says.
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
    /** A narrated chapter with a clip that no longer matches now reads as stale. */
    _staleChapter(bookId: string, chId: number): void {
      const c = this.chapter(bookId, chId);
      if (c?.narration === "done") c.narration = "stale";
    },
    /** Set the pacing here ahead of its write; null is the default. */
    _setPacing(bookId: string, pacing: Pacing | null): void {
      const b = this.bookById(bookId);
      if (!b) return;
      if (pacing) b.pacing = pacing;
      else delete b.pacing;
    },
    /** Install the book as the server described it, keeping the chapters here. */
    _putBook(book: Book): void {
      const i = this.books.findIndex((b) => b.id === book.id);
      if (i < 0) this.books.push(book);
      else this.books[i] = book;
    },
    /** Write the budget whole: the server takes the cap and the pause together. */
    async _pushBudget(bookId: string, what: string): Promise<unknown> {
      const b = this.bookById(bookId);
      const answer = await this._writeSettings(bookId, { budget: b?.budget ?? null }, what);
      if (answer) await this._budgetMoved(bookId);
      return answer;
    },
    /**
     * Reread the book's spending with the budget. `keys.spend` is named here, not via
     * `@/queries/spend`, which reads this store.
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
     * Whether notes are read aloud. Changes no line but which lines are spoken (`isSpoken`), so
     * each chapter's length, need and counts come from the server's answer.
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
    /** Whether chapters are checked by ear after narration; only changes what the server queues. */
    async setCheckByEar(bookId: string, on: boolean): Promise<void> {
      const b = this.bookById(bookId);
      if (!b || !!b.checkByEar === on) return;
      if (on) b.checkByEar = true;
      else delete b.checkByEar;
      await this._writeSettings(
        bookId,
        { checkByEar: on },
        on ? "check this book by ear" : "stop checking this book by ear",
      );
    },
    /** Whether the scripting model suggests dictionary terms for this book. */
    async setPronounce(bookId: string, on: boolean): Promise<void> {
      const b = this.bookById(bookId);
      if (!b || !b.pronounceOff === on) return;
      if (on) delete b.pronounceOff;
      else b.pronounceOff = true;
      await this._writeSettings(
        bookId,
        { pronounceOff: on ? null : true },
        on ? "suggest pronunciations" : "stop suggesting pronunciations",
      );
    },
    /**
     * The book's thought effect: an effect id, "none", or null to follow the library. Existing
     * clips show in the reread old-sound count until Re-apply or a retake.
     */
    async setBookThoughts(bookId: string, choice: ThoughtChoice | null): Promise<void> {
      const b = this.bookById(bookId);
      if (!b || (b.thoughts ?? null) === choice) return;
      if (choice === null) delete b.thoughts;
      else b.thoughts = choice;
      await this._writeSettings(bookId, { thoughts: choice }, "save this book's thought effect");
      void staleMoved(bookId);
    },
    /** A removed effect sends the books that chose it back to the library's. Returns those books. */
    _dropEffect(id: string): string[] {
      const chose = this.books.filter((b) => b.thoughts === id);
      for (const b of chose) delete b.thoughts;
      return chose.map((b) => b.id);
    },
    /**
     * The voice for speakers with none of their own, or null for the Narrator's. Changes no clip;
     * once saved, the lines it moved to another voice are asked about, as a speaker's voice is.
     */
    async setCharacterVoice(bookId: string, cv: CharacterVoice | null): Promise<void> {
      const b = this.bookById(bookId);
      if (!b) return;
      const was = b.characterVoice && { ...b.characterVoice };
      if (cv) b.characterVoice = cv;
      else delete b.characterVoice;
      if (await this._writeSettings(bookId, { characterVoice: cv }, "save the Character voice"))
        await useCastStore()._characterVoiceChanged(bookId, was);
    },
    /**
     * Write the book's scripter notes and prompt whole. Refused here with the reason when it cannot
     * be sent. Returns whether it was written.
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
     * Send one chunk with an unsaved prompt and return the answer. Writes no script, but is a real
     * request priced and held to the budget, so spend and activity are reread. Refusals throw; a
     * bad model answer is a result. `signal` stops waiting; later answers are not shown.
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
    // An EPUB becomes a book (or volume) marked `importing`; the contents review works on it in
    // place and confirming clears the mark. Until then it is unlisted and nothing runs on it.
    /** Read an EPUB into a new book awaiting its contents review. Returns the book's id. */
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
     * Add an EPUB as one more volume. Chapter numbering continues so roster and recap continuity
     * carry across; the volume waits in the contents review. Returns the volume's id.
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
    /** Finish the review: the book or new volume joins the library. Nothing starts running. */
    async confirmImport(bookId: string): Promise<boolean> {
      const uiStore = useUiStore();

      const book = this.bookById(bookId);
      if (!book) return false;
      const wasBook = !!book.importing;
      const vol = book.volumes.find((v) => v.importing);
      try {
        // the server clears the marks
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
    /** Cancel an import: a new book goes entirely; a new volume comes off its book. */
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
    /** A refusal says why and leaves the cover as it was. */
    async changeCover(bookId: string, file: File): Promise<void> {
      const refused = coverRefusal(file);
      if (refused) {
        useUiStore().toast(refused, {
          kind: "warn",
          description: `${file.name} was not used; the cover is as it was.`,
        });
        return;
      }
      try {
        this._putBook(await this._service().changeCover(bookId, file));
      } catch (cause) {
        toastFailure("change the cover", cause);
      }
    },
    /** An input like the settings: renamed here at once; a refused rename reads the book back. */
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
    /**
     * Cut the book into these volumes, in reading order. The whole list is one write and one undo
     * (the toast's Undo writes the old list). Chapter numbers do not move.
     */
    async setVolumes(
      bookId: string,
      starts: VolumeStart[],
      { quiet = false, scope = "" } = {},
    ): Promise<boolean> {
      const uiStore = useUiStore();
      const before = this.volumeStartsOf(bookId);
      if (
        !before.length ||
        (before.length === starts.length &&
          before.every((b, i) => b.chapter === starts[i].chapter && b.name === starts[i].name))
      )
        return false;
      let answer: ImportedBook;
      try {
        answer = await this._service().setVolumes(bookId, starts);
      } catch (cause) {
        toastFailure("cut the volumes", cause);
        return false;
      }
      this._put(answer.book, answer.chapters);
      if (!quiet)
        uiStore.toast(scope || `${starts.length} volumes`, {
          undo: () => void this.setVolumes(bookId, before, { quiet: true }),
        });
      return true;
    },
    // Remove a volume (wrong EPUB added): its chapters and their data go and the rest renumber.
    // Removing the last volume removes the book. Cannot be undone; the control asks first.
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
    /** Drop a volume silently; the rest renumber (`_renumber`). The server already cancelled its
     *  jobs and dropped its exports. Returns how many chapters went. */
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
    // Asks the server first rather than moving at once: renumbering moves everything filed under a
    // chapter number, and undoing that after a refusal (an export building, a volume in review)
    // would be a second renumbering. Then `_renumber` follows locally. Returns whether it moved.
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
      // the book may have been reread while the request was out
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
    // give `ordered` chapters ids 1..n; re-key every store by chapter number, fix volume ranges,
    // and reread whatever was read by those numbers
    _renumber(bookId: string, ordered: Chapter[]): void {
      const historyStore = useHistoryStore();
      const jobsStore = useJobsStore();
      const scriptsStore = useScriptsStore();
      const transferStore = useTransferStore();

      const book = this.bookById(bookId);
      if (!book) return;
      const map: Record<number, number> = {};
      ordered.forEach((c, i) => {
        map[c.id] = i + 1;
      });
      scriptsStore._remapBook(bookId, map);
      // script history and a read script file's plan are keyed by chapter number too
      historyStore.remapBook(bookId, map);
      transferStore._remapBook(bookId, map);
      // every cached answer for this book is keyed by numbers that moved (job queue included)
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

      // nothing puts a book back, so no Undo
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
     * Clear a book's scripts and clips to script afresh; with `cast`, every speaker but the
     * Narrator too. Scripts stay in history but clip files are gone, so no Undo. Returns whether
     * the server did it.
     */
    async startOver(bookId: string, { cast = false }: { cast?: boolean } = {}): Promise<boolean> {
      const castStore = useCastStore();
      const historyStore = useHistoryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      let answer: StartedOver;
      try {
        answer = await this._service().startOver(bookId, { cast });
      } catch (cause) {
        toastFailure("start this book over", cause);
        return false;
      }
      scriptsStore._dropBook(bookId);
      historyStore.clearBook(bookId);
      if (cast) castStore._dropBook(bookId);
      this._put(answer.book, answer.chapters);
      this._forgetBook(bookId);
      const { scripts, clips, speakers } = answer.cleared;
      uiStore.toast(`Started “${answer.book.title}” over`, {
        description: `${plural(scripts, "script")}${clips ? ` and ${plural(clips, "clip")}` : ""} cleared${speakers ? `, and ${plural(speakers, "speaker")} taken off the cast` : ""}. A chapter scripted again keeps its old script in History.`,
      });
      return true;
    },
    /** Drop everything a removed book owned, silently; the server already cancelled its jobs. */
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
      // removed, not invalidated: a read of a book the server no longer has would only fail
      const queryCache = useQueryCache();
      for (const entry of queryCache.getEntries({ key: keys.book(bookId) }))
        queryCache.remove(entry);
      void jobsStore._changed();
      void invalidate({ key: keys.librarySpend });
      if (uiStore.currentBookId === bookId) uiStore.currentBookId = null;
    },
  },
});
