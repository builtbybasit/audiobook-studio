// The seam the library reads and writes through.
//
// `EndpointService` next door already does this for the Endpoints page; this is the same idea for
// the books themselves. Everything above it works in the shapes `@/types` defines and does not
// know which side answered — that is what lets the seeded demo and a real backend put the same
// contents review on screen.
//
// Only the HTTP implementation lives here. In demo mode the library's state *is* the mock world
// the store holds, so asking for this service is a mistake worth failing on rather than answering
// with seeded books that would look like a working backend.
import type {
  Book,
  Chapter,
  ChapterHistory,
  Character,
  ExportItem,
  LexEntry,
  ScriptVersion,
  Segment,
  VersionOrigin,
} from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { isBackend, mode } from "@/services/mode";

export { ApiError, type FetchLike } from "@/services/http";

export interface ImportedBook {
  book: Book;
  chapters: Chapter[];
}

/** The two forms a chapter's prose comes in. See `LibraryService.chapterText`. */
export type TextFormat = "markdown" | "plain";

/** One chapter's review decisions, stated outright. Absent means "not". */
export interface ReviewDecision {
  id: number;
  excluded?: boolean;
  kept?: boolean;
}

/** A chapter's script as the server holds it, and the revision a later write has to name. */
export interface ChapterScript {
  segments: Segment[];
  revision: number;
}

/** What an edit sends: the script as it now stands, the revision it read, and what produced it. */
export interface ScriptEdit {
  segments: Segment[];
  ifRevision: number;
  /** an ordinary edit when left out */
  origin?: VersionOrigin;
}

/** What an edit comes back with: the script, its new revision, and the history it added to. */
export interface EditedScript extends ChapterScript {
  history: ChapterHistory;
}

/** A book's cast and its pronunciation dictionary. */
export interface Cast {
  characters: Character[];
  lexicon: LexEntry[];
}

/** Lines of one chapter, named by number. */
export interface ChapterLines {
  chapterId: number;
  ids: number[];
}

/**
 * Lines that changed hands when a speaker was renamed, merged or removed, with the revision each
 * chapter's script is at now that they have, and the cast after it.
 */
export interface MovedLines {
  characters: Character[];
  moved: (ChapterLines & { revision: number })[];
}

export interface LibraryService {
  /** false only when these books come from somewhere real */
  readonly simulated: boolean;
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

  // ---------- a chapter's script, edited by a person ----------
  /**
   * Replace a chapter's script with what a person made of it. `ifRevision` names the revision the
   * caller read; an edit against a script that has moved since is refused with a conflict, the
   * way a stale job result is, and nothing is written.
   */
  editScript(bookId: string, chapterId: number, edit: ScriptEdit): Promise<EditedScript>;
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
  /** The pronunciation dictionary, replaced whole. */
  putLexicon(bookId: string, entries: LexEntry[]): Promise<LexEntry[]>;

  // ---------- finished audiobooks ----------
  exports(bookId: string): Promise<ExportItem[]>;
  removeExport(bookId: string, exportId: number): Promise<void>;
}

export class HttpLibraryService implements LibraryService {
  readonly simulated = false;
  private readonly http: HttpClient;
  constructor(base = "/api", fetch?: FetchLike) {
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

  editScript(bookId: string, chapterId: number, edit: ScriptEdit): Promise<EditedScript> {
    return this.http.put<EditedScript>(`/books/${seg(bookId)}/chapters/${chapterId}/script`, edit);
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

  async putLexicon(bookId: string, entries: LexEntry[]): Promise<LexEntry[]> {
    return (
      await this.http.put<{ entries: LexEntry[] }>(`/books/${seg(bookId)}/lexicon`, { entries })
    ).entries;
  }

  async exports(bookId: string): Promise<ExportItem[]> {
    return (await this.http.get<{ exports: ExportItem[] }>(`/books/${seg(bookId)}/exports`))
      .exports;
  }

  async removeExport(bookId: string, exportId: number): Promise<void> {
    await this.http.delete(`/books/${seg(bookId)}/exports/${exportId}`);
  }
}

let service: LibraryService | null = null;

/**
 * The library service, or `null` when there is nobody to ask.
 *
 * This is the question the store asks, and the answer decides which half of every library action
 * runs: with a service the library is the server's and every change is a request; without one it
 * is the seeded world the store holds. `null` is a mode, not a failure — what the demo rules
 * forbid is a *service* that quietly answers with fixtures, not a store that knows it has none.
 */
export function activeLibraryService(): LibraryService | null {
  if (service) return service;
  return isBackend ? (service = new HttpLibraryService()) : null;
}

/**
 * The library service for the mode the app started in.
 *
 * In demo mode there isn't one, and this throws rather than inventing an answer: the library's
 * demo state is the seeded world the store holds, and handing back something that merely looked
 * like a backend is exactly the silent fallback the demo rules forbid.
 */
export function libraryService(): LibraryService {
  const found = activeLibraryService();
  if (!found)
    throw new Error(
      `The library service is not available in ${mode} mode. ` +
        `The seeded library lives in the store; start the app with VITE_MODE=backend to talk to a server.`,
    );
  return found;
}

/**
 * Point the app at a different implementation. For tests and for wiring at startup.
 *
 * A store reads the service when its state is first built, so a test that wants the backend half
 * of the library must set this *before* it creates the store.
 */
export function setLibraryService(next: LibraryService | null): void {
  service = next;
}
