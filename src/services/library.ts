// The seam the library reads and writes through.
//
// `EndpointService` next door already does this for the Endpoints page; this is the same idea for
// the books themselves. Everything above it works in the shapes `@/types` defines and does not
// know what answered — which is what lets a test point the page at a library of its own.
//
// Only the HTTP implementation lives here. It asks the library this tab is on (`API_BASE`): yours,
// or the demo's, which the server holds as a second library with a database of its own.
import type {
  Book,
  BookPrompt,
  CharacterVoice,
  Cast,
  Chapter,
  ChapterHeard,
  ChapterHistory,
  ChapterLines,
  ChapterScript,
  Character,
  EditedScript,
  ExportItem,
  Flagged,
  ImportedBook,
  Judged,
  KeptSample,
  LexEntry,
  LexiconSaved,
  MovedLines,
  Pacing,
  PromptTrialRequest,
  PromptTrialResult,
  ScriptExportSamples,
  ScriptImportPlan,
  ScriptVersion,
  Segment,
  SegmentFlag,
  SpeakerSamples,
  StoredSamples,
  VersionOrigin,
  VolumeStart,
} from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { API_BASE } from "@/services/mode";

export { ApiError, type FetchLike } from "@/services/http";
// The answers are declared in `@/types` with the server that writes them; these are named here too
// for the stores and queries that read them beside the service.
export type {
  Cast,
  ChapterLines,
  ChapterScript,
  ImportedBook,
  MovedLines,
  StoredSamples,
} from "@/types";

/**
 * A book's settings, any of them. A key left out is left alone; `null` clears it — for `pacing`,
 * back to the built-in gaps.
 */
export interface BookSettings {
  budget?: { cap: number | null; paused: boolean } | null;
  scriptBudget?: number | null;
  pacing?: Pacing | null;
  /** the book's notes and its own prompt; `null` clears both */
  prompt?: BookPrompt | null;
  /** read translator's and author's notes aloud (`Book.readNotes`) */
  readNotes?: boolean;
  /** check each chapter by ear once it is narrated (`Book.checkByEar`) */
  checkByEar?: boolean;
  /** thought lines without the thought effect (`Book.plainThoughts`) */
  plainThoughts?: boolean;
  /** the voice for speakers with none of their own (`Book.characterVoice`); `null` = the Narrator's */
  characterVoice?: CharacterVoice | null;
}

/** The two forms a chapter's prose comes in. See `LibraryService.chapterText`. */
export type TextFormat = "markdown" | "plain";

/** One chapter's review decisions, stated outright. Absent means "not". */
export interface ReviewDecision {
  id: number;
  excluded?: boolean;
  kept?: boolean;
}

/** What an edit sends: the script as it now stands, the revision it read, and what produced it. */
export interface ScriptEdit {
  segments: Segment[];
  ifRevision: number;
  /** an ordinary edit when left out */
  origin?: VersionOrigin;
}

export interface LibraryService {
  books(): Promise<Book[]>;
  /** A book and its chapters, as the contents review needs them. */
  book(id: string): Promise<ImportedBook>;
  /**
   * The chapter's prose, as the EPUB contained it.
   *
   * `markdown` is what is stored and what the contents review renders — headings, emphasis, and
   * the tables a chapter was laid out in. `plain` is that with the Markdown resolved away, and is
   * what **anything that counts, bills or sends the text to a model must ask for**: the stored
   * form would have a link's address and a table's pipes read aloud and charged for.
   */
  chapterText(bookId: string, chapterId: number, format?: TextFormat): Promise<string>;
  /** The chapter's script as it stands on the server: empty until a scripting job has written one. */
  chapterScript(bookId: string, chapterId: number): Promise<ChapterScript>;
  /** What was heard of a chapter's current clips, by segment id (`HeardLine`). */
  chapterHeard(bookId: string, chapterId: number): Promise<ChapterHeard>;
  /** Read an EPUB into a new book waiting for its contents review. */
  importBook(file: File, options?: { title?: string }): Promise<ImportedBook>;
  /** Read an EPUB into one more volume of a book already in the library. */
  importVolume(bookId: string, file: File, name?: string): Promise<ImportedBook>;
  /** The review is done: the book, or its new volume, joins the library. */
  confirmImport(bookId: string): Promise<Book>;
  /** Cancel an import: an unconfirmed book goes entirely; a new volume comes off its book. */
  discardImport(bookId: string): Promise<"book" | "volume">;
  /** Skip chapters for the audiobook, or include them again. Nothing is deleted either way. */
  skipChapters(bookId: string, ids: number[], skip: boolean): Promise<Chapter[]>;
  /** Keep a noted chapter as it is, and stop the suggestion asking. */
  keepChapters(bookId: string, ids: number[]): Promise<Chapter[]>;
  /**
   * Put chapters' review decisions to exactly these, whatever they are now.
   *
   * What an Undo sends: skip and keep each apply a rule that only runs forwards — including a
   * noted chapter counts as having looked at it — so an undo records what the chapters were and
   * puts that back rather than asking the inverse rule to guess.
   */
  setDecisions(bookId: string, decisions: ReviewDecision[]): Promise<Chapter[]>;
  removeBook(bookId: string): Promise<void>;
  removeVolume(bookId: string, volumeId: number): Promise<"book" | "volume">;
  /**
   * Change a book's budget, script budget or pacing. Changing the pacing re-times every narrated
   * chapter on the server, so the chapters come back with the book.
   */
  updateBook(bookId: string, settings: BookSettings): Promise<ImportedBook>;
  /** Make this JPEG or PNG the book's own cover, the shelf's and the overview's. */
  changeCover(bookId: string, file: File): Promise<Book>;
  /** Give a volume a new name. */
  renameVolume(bookId: string, volumeId: number, name: string): Promise<Book>;
  /**
   * Cut the book into these volumes: where each begins and its name, in reading order, the first
   * at chapter 1. Chapter numbers stay; which volume each belongs to is rewritten. Refused while
   * an audiobook of the book is being built, or while a volume of a shelved book is in review.
   */
  setVolumes(bookId: string, volumes: VolumeStart[]): Promise<ImportedBook>;
  /**
   * Read the volumes in this order — every volume of the book, once each. The chapters are
   * renumbered to follow, and the server moves everything filed under a chapter number with them.
   * Refused while an audiobook of the book is being built or a volume is still in its review.
   */
  reorderVolumes(bookId: string, order: number[]): Promise<ImportedBook>;

  // ---------- a chapter's script, edited by a person ----------
  /**
   * Replace a chapter's script with what a person made of it. `ifRevision` names the revision the
   * caller read; an edit against a script that has moved since is refused with a conflict, the
   * way a stale job result is, and nothing is written.
   */
  editScript(bookId: string, chapterId: number, edit: ScriptEdit): Promise<EditedScript>;
  /**
   * Send one chunk of a chapter with a prompt that need not be saved, and see what comes back.
   * Nothing is written to the script; the request is priced into the book's ledger and held to its
   * budget. A refused answer comes back as a result with `error`, not as a rejection.
   */
  /**
   * Send one chunk with a prompt that need not be saved, and see what comes back; nothing is
   * written. Aborting `signal` cancels the request on the server too, before or while it is sent.
   */
  tryPrompt(
    bookId: string,
    request: PromptTrialRequest,
    signal?: AbortSignal,
  ): Promise<PromptTrialResult>;
  chapterHistory(bookId: string, chapterId: number): Promise<ChapterHistory>;
  /** Name the script as it stands and keep a copy. The script itself is untouched. */
  saveCheckpoint(
    bookId: string,
    chapterId: number,
    name: string,
  ): Promise<{ version: ScriptVersion; history: ChapterHistory }>;
  /** Forget one version. What an Undo of a checkpoint sends. */
  dropVersion(bookId: string, chapterId: number, versionId: number): Promise<ChapterHistory>;

  // ---------- the cast ----------
  cast(bookId: string): Promise<Cast>;
  /** One speaker, written as stated: new or replaced. Returns the cast as it now stands. */
  putCharacter(bookId: string, character: Character): Promise<Character[]>;
  /** Change a speaker's name; every line that names them moves with it. */
  renameCharacter(bookId: string, from: string, to: string): Promise<MovedLines>;
  /** Fold one speaker into another; the lines move and the name becomes an alias. */
  mergeCharacter(bookId: string, from: string, into: string): Promise<MovedLines>;
  /** Take a speaker off the cast; their lines go to the Narrator. */
  deleteCharacter(bookId: string, name: string): Promise<MovedLines>;
  /** Put a speaker back on exactly these lines, and back in the cast: what an Undo sends. */
  attribute(bookId: string, character: Character, lines: ChapterLines[]): Promise<MovedLines>;
  /**
   * The pronunciation dictionary, replaced whole. Every rendered clip that now reads the old
   * pronunciation is marked stale; `restore` names lines an earlier change staled (what an Undo
   * sends), and those that read this pronunciation again go back to done.
   */
  putLexicon(bookId: string, entries: LexEntry[], restore?: ChapterLines[]): Promise<LexiconSaved>;
  /** Keep a retake as the clip in the book, or discard it; either way it is judged once. */
  judgeTake(
    bookId: string,
    chapterId: number,
    segmentId: number,
    verdict: "accept" | "reject",
  ): Promise<Judged>;
  /**
   * Raise, replace or take down one line's flag, and nothing else about the script — so it names
   * no revision, and a run writing clips beside it cannot make it refuse.
   */
  flagLine(
    bookId: string,
    chapterId: number,
    segmentId: number,
    flag: Pick<SegmentFlag, "kind" | "note"> | null,
  ): Promise<Flagged>;

  // ---------- finished audiobooks ----------
  /**
   * Keep an image to write into this book's audiobooks in place of the EPUB's cover. Answers with
   * the url it is served from, which is what a build's `settings.cover` has to name: the server
   * embeds only an image it holds for this book. The same image twice is the same url.
   */
  uploadCover(bookId: string, file: File): Promise<{ cover: string }>;
  exports(bookId: string): Promise<ExportItem[]>;
  removeExport(bookId: string, exportId: number): Promise<void>;

  // ---------- the script as a file ----------
  /**
   * What importing a script file into this book would do: the chapters it matches, the ones it
   * refuses, and how its cast, dictionary and voices differ from the book's. Nothing is written —
   * applying the plan is the store's, through the same edits a restore makes.
   */
  planScriptImport(bookId: string, file: File): Promise<ScriptImportPlan>;
  /** What ticking "Include voice samples" would add to this book's export: one entry per speaker. */
  scriptExportSamples(bookId: string): Promise<ScriptExportSamples>;

  // ---------- voice samples waiting with a speaker ----------
  /**
   * Keep the recordings `file` carries for these speakers, to wait with them until someone clones
   * them. The server reads them from the file again; answers with what it kept.
   */
  /**
   * Keep what `file` carries for these speakers. `replaced` names the rows those speakers already
   * had, which the server put aside rather than deleting, so the import's Undo can bring them back.
   */
  storeSpeakerSamples(bookId: string, file: File, speakers: string[]): Promise<StoredSamples>;
  speakerSamples(bookId: string): Promise<SpeakerSamples[]>;
  /** One kept recording, as a file the clone form can send on. */
  speakerSampleFile(bookId: string, sampleId: number, sample: KeptSample): Promise<File>;
  /** Put a speaker's recordings aside: hidden at once, gone for good a day later. */
  discardSpeakerSamples(bookId: string, sampleId: number): Promise<void>;
  /** Bring back recordings put aside, while the server still holds them. */
  restoreSpeakerSamples(bookId: string, sampleId: number): Promise<SpeakerSamples>;
}

export class HttpLibraryService implements LibraryService {
  private readonly http: HttpClient;
  constructor(base = API_BASE, fetch?: FetchLike) {
    this.http = new HttpClient(base, fetch);
  }

  async books(): Promise<Book[]> {
    return (await this.http.get<{ books: Book[] }>("/books")).books;
  }

  book(id: string): Promise<ImportedBook> {
    return this.http.get<ImportedBook>(`/books/${seg(id)}`);
  }

  async chapterText(
    bookId: string,
    chapterId: number,
    format: TextFormat = "markdown",
  ): Promise<string> {
    const { text } = await this.http.get<{ text: string }>(
      `/books/${seg(bookId)}/chapters/${chapterId}/text?format=${format}`,
    );
    return text;
  }

  chapterScript(bookId: string, chapterId: number): Promise<ChapterScript> {
    return this.http.get<ChapterScript>(`/books/${seg(bookId)}/chapters/${chapterId}/script`);
  }

  async chapterHeard(bookId: string, chapterId: number): Promise<ChapterHeard> {
    return (
      await this.http.get<{ lines: ChapterHeard }>(
        `/books/${seg(bookId)}/chapters/${chapterId}/heard`,
      )
    ).lines;
  }

  importBook(file: File, { title }: { title?: string } = {}): Promise<ImportedBook> {
    return this.http.postForm<ImportedBook>("/books/import", file, { title });
  }

  importVolume(bookId: string, file: File, name?: string): Promise<ImportedBook> {
    return this.http.postForm<ImportedBook>("/books/import", file, { bookId, name });
  }

  async confirmImport(bookId: string): Promise<Book> {
    return (await this.http.post<{ book: Book }>(`/books/${seg(bookId)}/confirm`)).book;
  }

  async discardImport(bookId: string): Promise<"book" | "volume"> {
    return (await this.http.post<{ discarded: "book" | "volume" }>(`/books/${seg(bookId)}/discard`))
      .discarded;
  }

  async skipChapters(bookId: string, ids: number[], skip: boolean): Promise<Chapter[]> {
    const where = skip ? "skip" : "include";
    return (
      await this.http.post<{ chapters: Chapter[] }>(`/books/${seg(bookId)}/chapters/${where}`, {
        ids,
      })
    ).chapters;
  }

  async keepChapters(bookId: string, ids: number[]): Promise<Chapter[]> {
    return (
      await this.http.post<{ chapters: Chapter[] }>(`/books/${seg(bookId)}/chapters/keep`, { ids })
    ).chapters;
  }

  async setDecisions(bookId: string, decisions: ReviewDecision[]): Promise<Chapter[]> {
    return (
      await this.http.post<{ chapters: Chapter[] }>(`/books/${seg(bookId)}/chapters/decisions`, {
        decisions,
      })
    ).chapters;
  }

  async removeBook(bookId: string): Promise<void> {
    await this.http.delete(`/books/${seg(bookId)}`);
  }

  async removeVolume(bookId: string, volumeId: number): Promise<"book" | "volume"> {
    return (
      await this.http.delete<{ removed: "book" | "volume" }>(
        `/books/${seg(bookId)}/volumes/${volumeId}`,
      )
    ).removed;
  }

  updateBook(bookId: string, settings: BookSettings): Promise<ImportedBook> {
    return this.http.patch<ImportedBook>(`/books/${seg(bookId)}`, settings);
  }

  async changeCover(bookId: string, file: File): Promise<Book> {
    return (await this.http.postForm<{ book: Book }>(`/books/${seg(bookId)}/cover`, file, {})).book;
  }

  async renameVolume(bookId: string, volumeId: number, name: string): Promise<Book> {
    return (
      await this.http.patch<{ book: Book }>(`/books/${seg(bookId)}/volumes/${volumeId}`, { name })
    ).book;
  }

  setVolumes(bookId: string, volumes: VolumeStart[]): Promise<ImportedBook> {
    return this.http.put<ImportedBook>(`/books/${seg(bookId)}/volumes`, { volumes });
  }

  reorderVolumes(bookId: string, order: number[]): Promise<ImportedBook> {
    return this.http.put<ImportedBook>(`/books/${seg(bookId)}/volumes/order`, { order });
  }

  editScript(bookId: string, chapterId: number, edit: ScriptEdit): Promise<EditedScript> {
    return this.http.put<EditedScript>(`/books/${seg(bookId)}/chapters/${chapterId}/script`, edit);
  }

  tryPrompt(
    bookId: string,
    request: PromptTrialRequest,
    signal?: AbortSignal,
  ): Promise<PromptTrialResult> {
    return this.http.send<PromptTrialResult>(`/books/${seg(bookId)}/script-trial`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  }

  async chapterHistory(bookId: string, chapterId: number): Promise<ChapterHistory> {
    return (
      await this.http.get<{ history: ChapterHistory }>(
        `/books/${seg(bookId)}/chapters/${chapterId}/history`,
      )
    ).history;
  }

  saveCheckpoint(
    bookId: string,
    chapterId: number,
    name: string,
  ): Promise<{ version: ScriptVersion; history: ChapterHistory }> {
    return this.http.post(`/books/${seg(bookId)}/chapters/${chapterId}/history/checkpoints`, {
      name,
    });
  }

  async dropVersion(bookId: string, chapterId: number, versionId: number): Promise<ChapterHistory> {
    return (
      await this.http.delete<{ history: ChapterHistory }>(
        `/books/${seg(bookId)}/chapters/${chapterId}/history/versions/${versionId}`,
      )
    ).history;
  }

  cast(bookId: string): Promise<Cast> {
    return this.http.get<Cast>(`/books/${seg(bookId)}/cast`);
  }

  async putCharacter(bookId: string, character: Character): Promise<Character[]> {
    return (
      await this.http.put<{ characters: Character[] }>(
        `/books/${seg(bookId)}/characters/${seg(character.name)}`,
        character,
      )
    ).characters;
  }

  renameCharacter(bookId: string, from: string, to: string): Promise<MovedLines> {
    return this.http.post<MovedLines>(`/books/${seg(bookId)}/characters/${seg(from)}/rename`, {
      to,
    });
  }

  mergeCharacter(bookId: string, from: string, into: string): Promise<MovedLines> {
    return this.http.post<MovedLines>(`/books/${seg(bookId)}/characters/${seg(from)}/merge`, {
      into,
    });
  }

  deleteCharacter(bookId: string, name: string): Promise<MovedLines> {
    return this.http.delete<MovedLines>(`/books/${seg(bookId)}/characters/${seg(name)}`);
  }

  attribute(bookId: string, character: Character, lines: ChapterLines[]): Promise<MovedLines> {
    return this.http.post<MovedLines>(`/books/${seg(bookId)}/characters/attribute`, {
      character,
      lines: lines.map(({ chapterId, ids }) => ({ chapterId, ids })),
    });
  }

  putLexicon(bookId: string, entries: LexEntry[], restore?: ChapterLines[]): Promise<LexiconSaved> {
    return this.http.put<LexiconSaved>(`/books/${seg(bookId)}/lexicon`, {
      entries,
      ...(restore && { restore: restore.map(({ chapterId, ids }) => ({ chapterId, ids })) }),
    });
  }

  judgeTake(
    bookId: string,
    chapterId: number,
    segmentId: number,
    verdict: "accept" | "reject",
  ): Promise<Judged> {
    return this.http.post<Judged>(
      `/books/${seg(bookId)}/chapters/${chapterId}/lines/${segmentId}/verdict`,
      { verdict },
    );
  }

  flagLine(
    bookId: string,
    chapterId: number,
    segmentId: number,
    flag: Pick<SegmentFlag, "kind" | "note"> | null,
  ): Promise<Flagged> {
    const path = `/books/${seg(bookId)}/chapters/${chapterId}/lines/${segmentId}/flag`;
    return flag ? this.http.put<Flagged>(path, flag) : this.http.delete<Flagged>(path);
  }

  uploadCover(bookId: string, file: File): Promise<{ cover: string }> {
    return this.http.postForm<{ cover: string }>(`/books/${seg(bookId)}/covers`, file, {});
  }

  async exports(bookId: string): Promise<ExportItem[]> {
    return (await this.http.get<{ exports: ExportItem[] }>(`/books/${seg(bookId)}/exports`))
      .exports;
  }

  async removeExport(bookId: string, exportId: number): Promise<void> {
    await this.http.delete(`/books/${seg(bookId)}/exports/${exportId}`);
  }

  planScriptImport(bookId: string, file: File): Promise<ScriptImportPlan> {
    return this.http.postForm<ScriptImportPlan>(`/books/${seg(bookId)}/script-import`, file, {});
  }

  scriptExportSamples(bookId: string): Promise<ScriptExportSamples> {
    return this.http.get<ScriptExportSamples>(`/books/${seg(bookId)}/script-export/samples`);
  }

  async storeSpeakerSamples(
    bookId: string,
    file: File,
    speakers: string[],
  ): Promise<StoredSamples> {
    const form = new FormData();
    form.set("file", file);
    form.set("speakers", JSON.stringify(speakers));
    const { stored, replaced } = await this.http.postFormData<{
      stored: SpeakerSamples[];
      replaced?: number[];
    }>(`/books/${seg(bookId)}/speaker-samples`, form);
    return { stored, replaced: replaced ?? [] };
  }

  async speakerSamples(bookId: string): Promise<SpeakerSamples[]> {
    return (
      await this.http.get<{ samples: SpeakerSamples[] }>(`/books/${seg(bookId)}/speaker-samples`)
    ).samples;
  }

  async speakerSampleFile(bookId: string, sampleId: number, sample: KeptSample): Promise<File> {
    const blob = await this.http.getBlob(
      `/books/${seg(bookId)}/speaker-samples/${sampleId}/files/${seg(sample.file)}`,
    );
    return new File([blob], sample.name, { type: blob.type });
  }

  async discardSpeakerSamples(bookId: string, sampleId: number): Promise<void> {
    await this.http.delete<{ id: number }>(`/books/${seg(bookId)}/speaker-samples/${sampleId}`);
  }

  async restoreSpeakerSamples(bookId: string, sampleId: number): Promise<SpeakerSamples> {
    return (
      await this.http.post<{ sample: SpeakerSamples }>(
        `/books/${seg(bookId)}/speaker-samples/${sampleId}/restore`,
      )
    ).sample;
  }
}

/**
 * Where a book's script is downloaded from, as `<book>.script.zip`. A URL rather than a request:
 * the browser follows it and saves what comes back, the way a built audiobook is downloaded.
 */
export function scriptExportUrl(bookId: string, samples = false): string {
  return `${API_BASE}/books/${seg(bookId)}/script-export${samples ? "?samples=1" : ""}`;
}

let service: LibraryService | null = null;

/** The library service: the one a test set, or the HTTP one for this tab's library. */
export function libraryService(): LibraryService {
  return (service ??= new HttpLibraryService());
}

/**
 * Point the app at a different implementation. For tests and for wiring at startup; `null` goes
 * back to the HTTP one, built afresh when it is next asked for.
 */
export function setLibraryService(next: LibraryService | null): void {
  service = next;
}
