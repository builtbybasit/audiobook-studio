// The seam the library reads and writes through, as `EndpointService` is for endpoints, so a test
// can point the page at a library of its own. The HTTP implementation asks this tab's library
// (`API_BASE`): yours, or the demo's.
import type {
  Book,
  BookUpdated,
  BookPrompt,
  CharacterVoice,
  Cast,
  CastStat,
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
  StartedOver,
  Judged,
  KeptSample,
  LexEntry,
  LexiconSaved,
  MovedLines,
  MovedSpeakers,
  NarrationQueued,
  OldVoice,
  Pacing,
  PromptTrialRequest,
  PromptTrialResult,
  ScriptExportSamples,
  ScriptImportPlan,
  ScriptVersion,
  Segment,
  SegmentFlag,
  SpeakerSamples,
  SpeakerWikiFill,
  StoredSamples,
  ThoughtChoice,
  VersionOrigin,
  VoiceSuggestions,
  VolumeStart,
} from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { API_BASE } from "@/services/mode";

export { ApiError, type FetchLike } from "@/services/http";
export type {
  Cast,
  CastStat,
  ChapterLines,
  ChapterScript,
  ImportedBook,
  StartedOver,
  MovedLines,
  MovedSpeakers,
  StoredSamples,
} from "@/types";

/** A speaker as they were, and the lines (and voice-sample rows) to put them back on. */
export interface SpeakerLines {
  character: Character;
  lines: ChapterLines[];
  samples?: number[];
}

/**
 * A book's settings. A key left out is left alone; `null` clears it (`pacing`: the built-in gaps).
 */
export interface BookSettings {
  budget?: { cap: number | null; paused: boolean } | null;
  scriptBudget?: number | null;
  pacing?: Pacing | null;
  /** the book's notes and its own prompt; `null` clears both */
  prompt?: BookPrompt | null;
  /** `Book.readNotes` */
  readNotes?: boolean;
  /** `Book.autoTranscribe` */
  autoTranscribe?: boolean;
  /** `Book.pronounceOff`; `null` = suggestions on */
  pronounceOff?: true | null;
  /** `Book.exactCounts`; `null` = rough counts */
  exactCounts?: true | null;
  /** `Book.wiki`; `null` forgets it */
  wiki?: string | null;
  /** `Book.thoughts`: an id or "none"; `null` = the library's */
  thoughts?: ThoughtChoice | null;
  /** `Book.characterVoice`; `null` = the Narrator's */
  characterVoice?: CharacterVoice | null;
}

/** See `LibraryService.chapterText`. */
export type TextFormat = "markdown" | "plain";

/** One chapter's review decisions, stated outright. Absent means "not". */
export interface ReviewDecision {
  id: number;
  excluded?: boolean;
  kept?: boolean;
}

export interface ScriptEdit {
  segments: Segment[];
  /** the revision the edit was made from */
  ifRevision: number;
  /** an ordinary edit when left out */
  origin?: VersionOrigin;
  /** the chapter's recap, written with its script; left out, the stored one stands */
  recap?: string;
}

export interface LibraryService {
  books(): Promise<Book[]>;
  book(id: string): Promise<ImportedBook>;
  /**
   * `markdown` is what is stored and rendered. Anything that counts, bills or sends text to a model
   * must ask for `plain`, or a link's address and a table's pipes get read aloud and charged for.
   */
  chapterText(bookId: string, chapterId: number, format?: TextFormat): Promise<string>;
  /** For each name, the chapters whose text has it as a whole word, same case, in book order. */
  mentions(bookId: string, names: readonly string[]): Promise<Record<string, number[]>>;
  /** Empty until a scripting job has written one. */
  chapterScript(bookId: string, chapterId: number): Promise<ChapterScript>;
  /** A chapter the book does not have is left out. */
  chapterTexts(
    bookId: string,
    chapterIds: readonly number[],
    format: TextFormat,
  ): Promise<Record<number, string>>;
  /** A chapter the book does not have is left out. */
  chapterScripts(
    bookId: string,
    chapterIds: readonly number[],
  ): Promise<Record<number, ChapterScript>>;
  /** What was heard of a chapter's current clips, by segment id (`HeardLine`). */
  chapterHeard(bookId: string, chapterId: number): Promise<ChapterHeard>;
  /** Read an EPUB into a new book waiting for its contents review. */
  importBook(file: File, options?: { title?: string }): Promise<ImportedBook>;
  /** Read an EPUB into one more volume of a book already in the library. */
  importVolume(bookId: string, file: File, name?: string): Promise<ImportedBook>;
  /** The review is done: the book, or its new volume, joins the library. */
  confirmImport(bookId: string): Promise<Book>;
  /** An unconfirmed book goes entirely; a new volume comes off its book. */
  discardImport(bookId: string): Promise<"book" | "volume">;
  /** Nothing is deleted either way. */
  skipChapters(bookId: string, ids: number[], skip: boolean): Promise<Chapter[]>;
  /** Keep a noted chapter as it is, and stop the suggestion asking. */
  keepChapters(bookId: string, ids: number[]): Promise<Chapter[]>;
  /**
   * Set review decisions outright; what an Undo sends. Skip and keep only run forwards (including a
   * noted chapter counts as looking at it), so an undo restores state instead of inverting.
   */
  setDecisions(bookId: string, decisions: ReviewDecision[]): Promise<Chapter[]>;
  removeBook(bookId: string): Promise<void>;
  removeVolume(bookId: string, volumeId: number): Promise<"book" | "volume">;
  /**
   * Take every script and clip off the book (scripts stay in history); `cast` also drops every
   * speaker but the Narrator. Refused while any job of the book is queued or running.
   */
  startOver(bookId: string, options: { cast: boolean }): Promise<StartedOver>;
  /**
   * A pacing change re-times every narrated chapter, so the chapters come back with the book; a
   * new in-line pause length stales the clips of lines holding one.
   */
  updateBook(bookId: string, settings: BookSettings): Promise<BookUpdated>;
  /** JPEG or PNG; the shelf's and overview's cover. */
  changeCover(bookId: string, file: File): Promise<Book>;
  renameVolume(bookId: string, volumeId: number, name: string): Promise<Book>;
  /**
   * Volume starts in reading order, the first at chapter 1. Chapter numbers stay. Refused while an
   * audiobook is building or a shelved book's volume is in review.
   */
  setVolumes(bookId: string, volumes: VolumeStart[]): Promise<ImportedBook>;
  /**
   * Every volume, once each. Chapters are renumbered and the server moves everything filed under a
   * chapter number with them. Refused while an audiobook is building or a volume is in review.
   */
  reorderVolumes(bookId: string, order: number[]): Promise<ImportedBook>;

  // ---------- a chapter's script, edited by a person ----------
  /** Refused with a conflict, writing nothing, when the script has moved past `ifRevision`. */
  editScript(bookId: string, chapterId: number, edit: ScriptEdit): Promise<EditedScript>;
  /**
   * Send one chunk with an unsaved prompt; nothing is written to the script, but the request is
   * priced and held to the budget. A refusal comes back as `error`, not a rejection. Aborting
   * `signal` cancels it on the server too.
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
  /** What an Undo of a checkpoint sends. */
  dropVersion(bookId: string, chapterId: number, versionId: number): Promise<ChapterHistory>;

  // ---------- the cast ----------
  cast(bookId: string): Promise<Cast>;
  /** The scripting model's voice picks for up to 30 speakers, asked of `profile`. */
  voiceSuggestions(bookId: string, profile: string, speakers: string[]): Promise<VoiceSuggestions>;
  /** What one speaker's wiki page says (tags only), asked of `profile`; `url` or the book's wiki. */
  speakerWiki(
    bookId: string,
    ask: { name: string; profile: string; url?: string },
    signal?: AbortSignal,
  ): Promise<SpeakerWikiFill>;
  /** Each speaker's spoken lines across the book; a speaker with none is absent. */
  speakerCounts(bookId: string): Promise<Record<string, CastStat>>;
  /** New or replaced. Returns the cast as it now stands. */
  putCharacter(bookId: string, character: Character): Promise<Character[]>;
  /** Every line that names them moves with it. */
  renameCharacter(bookId: string, from: string, to: string): Promise<MovedLines>;
  /** In order, all or nothing: each `from`'s lines move to its `into` and the name becomes an alias. */
  mergeCharacters(bookId: string, merges: { from: string; into: string }[]): Promise<MovedSpeakers>;
  /** All or nothing; their lines go to the Narrator. */
  removeCharacters(bookId: string, names: string[]): Promise<MovedSpeakers>;
  /** Several speakers at once, all or nothing. Returns the cast as it now stands. */
  putCharacters(bookId: string, characters: Character[]): Promise<Character[]>;
  /** These speakers' finished lines made with another voice than they get now, by chapter. */
  oldVoice(bookId: string, names: string[]): Promise<OldVoice>;
  /** Re-narrate those lines in these chapters, as `oldVoice` priced them. */
  revoice(bookId: string, names: string[], chapters: number[]): Promise<NarrationQueued>;
  /** Put speakers back on exactly these lines, and back in the cast: what an Undo sends. */
  attribute(bookId: string, speakers: SpeakerLines[]): Promise<MovedSpeakers>;
  /**
   * Replaced whole; clips reading an old pronunciation go stale. `restore` (an Undo) names lines an
   * earlier change staled; those that read this pronunciation again go back to done.
   */
  putLexicon(bookId: string, entries: LexEntry[], restore?: ChapterLines[]): Promise<LexiconSaved>;
  /** Keep a retake as the clip in the book, or discard it; either way it is judged once. */
  judgeTake(
    bookId: string,
    chapterId: number,
    segmentId: number,
    verdict: "accept" | "reject",
  ): Promise<Judged>;
  /** Names no revision, so a run writing clips beside it cannot make it refuse. */
  flagLine(
    bookId: string,
    chapterId: number,
    segmentId: number,
    flag: Pick<SegmentFlag, "kind" | "note"> | null,
  ): Promise<Flagged>;

  // ---------- finished audiobooks ----------
  /**
   * Answers with the url a build's `settings.cover` must name: the server embeds only an image it
   * holds for this book. The same image twice is the same url.
   */
  uploadCover(bookId: string, file: File): Promise<{ cover: string }>;
  exports(bookId: string): Promise<ExportItem[]>;
  removeExport(bookId: string, exportId: number): Promise<void>;

  // ---------- the script as a file ----------
  /** What importing a script file would do. Nothing is written; the store applies the plan. */
  planScriptImport(bookId: string, file: File): Promise<ScriptImportPlan>;
  /** What ticking "Include voice samples" would add to this book's export: one entry per speaker. */
  scriptExportSamples(bookId: string): Promise<ScriptExportSamples>;

  // ---------- voice samples waiting with a speaker ----------
  /**
   * Keep what `file` carries for these speakers until someone clones them. `replaced` names rows
   * put aside (not deleted) so the import's Undo can bring them back.
   */
  storeSpeakerSamples(bookId: string, file: File, speakers: string[]): Promise<StoredSamples>;
  speakerSamples(bookId: string): Promise<SpeakerSamples[]>;
  /** One kept recording, as a file the clone form can send on. */
  speakerSampleFile(bookId: string, sampleId: number, sample: KeptSample): Promise<File>;
  /** Hidden at once, gone for good a day later. */
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

  async mentions(bookId: string, names: readonly string[]): Promise<Record<string, number[]>> {
    const q = names.map((n) => `name=${encodeURIComponent(n)}`).join("&");
    return (
      await this.http.get<{ byName: Record<string, number[]> }>(
        `/books/${seg(bookId)}/mentions?${q}`,
      )
    ).byName;
  }

  chapterScript(bookId: string, chapterId: number): Promise<ChapterScript> {
    return this.http.get<ChapterScript>(`/books/${seg(bookId)}/chapters/${chapterId}/script`);
  }

  async chapterTexts(
    bookId: string,
    chapterIds: readonly number[],
    format: TextFormat,
  ): Promise<Record<number, string>> {
    const ids = chapterIds.map((id) => `id=${id}`).join("&");
    return (
      await this.http.get<{ texts: Record<number, string> }>(
        `/books/${seg(bookId)}/texts?format=${format}&${ids}`,
      )
    ).texts;
  }

  async chapterScripts(
    bookId: string,
    chapterIds: readonly number[],
  ): Promise<Record<number, ChapterScript>> {
    const ids = chapterIds.map((id) => `id=${id}`).join("&");
    return (
      await this.http.get<{ scripts: Record<number, ChapterScript> }>(
        `/books/${seg(bookId)}/scripts?${ids}`,
      )
    ).scripts;
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

  startOver(bookId: string, options: { cast: boolean }): Promise<StartedOver> {
    return this.http.post<StartedOver>(`/books/${seg(bookId)}/start-over`, options);
  }

  updateBook(bookId: string, settings: BookSettings): Promise<BookUpdated> {
    return this.http.patch<BookUpdated>(`/books/${seg(bookId)}`, settings);
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

  voiceSuggestions(bookId: string, profile: string, speakers: string[]): Promise<VoiceSuggestions> {
    return this.http.post<VoiceSuggestions>(`/books/${seg(bookId)}/voice-suggestions`, {
      profile,
      speakers,
    });
  }

  speakerWiki(
    bookId: string,
    ask: { name: string; profile: string; url?: string },
    signal?: AbortSignal,
  ): Promise<SpeakerWikiFill> {
    return this.http.send<SpeakerWikiFill>(`/books/${seg(bookId)}/characters/wiki`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ask),
      signal,
    });
  }

  async speakerCounts(bookId: string): Promise<Record<string, CastStat>> {
    return (
      await this.http.get<{ counts: Record<string, CastStat> }>(
        `/books/${seg(bookId)}/speaker-counts`,
      )
    ).counts;
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

  mergeCharacters(
    bookId: string,
    merges: { from: string; into: string }[],
  ): Promise<MovedSpeakers> {
    return this.http.post<MovedSpeakers>(`/books/${seg(bookId)}/characters/merge`, { merges });
  }

  removeCharacters(bookId: string, names: string[]): Promise<MovedSpeakers> {
    return this.http.post<MovedSpeakers>(`/books/${seg(bookId)}/characters/remove`, { names });
  }

  async putCharacters(bookId: string, characters: Character[]): Promise<Character[]> {
    return (
      await this.http.put<{ characters: Character[] }>(`/books/${seg(bookId)}/characters`, {
        characters,
      })
    ).characters;
  }

  oldVoice(bookId: string, names: string[]): Promise<OldVoice> {
    return this.http.post<OldVoice>(`/books/${seg(bookId)}/characters/old-voice`, { names });
  }

  revoice(bookId: string, names: string[], chapters: number[]): Promise<NarrationQueued> {
    return this.http.post<NarrationQueued>(`/books/${seg(bookId)}/characters/revoice`, {
      names,
      chapters,
    });
  }

  attribute(bookId: string, speakers: SpeakerLines[]): Promise<MovedSpeakers> {
    return this.http.post<MovedSpeakers>(`/books/${seg(bookId)}/characters/attribute`, {
      speakers: speakers.map(({ character, lines, samples }) => ({
        character,
        lines: lines.map(({ chapterId, ids }) => ({ chapterId, ids })),
        ...(samples?.length ? { samples } : {}),
      })),
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

/** `<book>.script.zip`, as a URL the browser follows and saves, like a built audiobook. */
export function scriptExportUrl(bookId: string, samples = false): string {
  return `${API_BASE}/books/${seg(bookId)}/script-export${samples ? "?samples=1" : ""}`;
}

let service: LibraryService | null = null;

/** The library service: the one a test set, or the HTTP one for this tab's library. */
export function libraryService(): LibraryService {
  return (service ??= new HttpLibraryService());
}

/** For tests and startup wiring; `null` goes back to a fresh HTTP one. */
export function setLibraryService(next: LibraryService | null): void {
  service = next;
}
