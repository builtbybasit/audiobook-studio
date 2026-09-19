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
import type { Book, Chapter } from "@/types";
import { isBackend, mode } from "@/services/mode";

export interface ImportedBook {
  book: Book;
  chapters: Chapter[];
}

/** The two forms a chapter's prose comes in. See `LibraryService.chapterText`. */
export type TextFormat = "markdown" | "plain";

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
  removeBook(bookId: string): Promise<void>;
  removeVolume(bookId: string, volumeId: number): Promise<"book" | "volume">;
}

/** A failure the API described. `detail` is the longer explanation a panel can expand to. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/**
 * Just the part of `fetch` this client calls.
 *
 * Narrower than `typeof fetch` on purpose: the global carries extras that differ between runtimes,
 * and requiring them would mean a test could not hand over a plain function.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What the API returns when something goes wrong; see `server/lib/http.ts`. */
interface ErrorBody {
  error?: { message?: string; detail?: string };
}

/** Enough of an unexpected response to recognise it by, without pasting a page into a toast. */
function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max) + "…";
}

export class HttpLibraryService implements LibraryService {
  readonly simulated = false;
  constructor(
    private readonly base = "/api",
    private readonly fetch: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  private async send<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, init);
    } catch (cause) {
      // The server is not answering. Saying so is the whole point: the alternative is a UI that
      // looks like an empty library rather than one that cannot be reached.
      throw new ApiError(
        "Could not reach the server",
        0,
        cause instanceof Error ? cause.message : undefined,
      );
    }
    const text = await res.text();
    // Not everything that answers this URL is the API. A proxy, a dev server or a gateway in front
    // of it answers with HTML, and parsing that would throw a `SyntaxError` out of a method whose
    // whole contract is that it throws `ApiError` — so the page would report a JavaScript fault
    // where it should be saying the server is unreachable.
    let body: unknown = null;
    let parsed = true;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      parsed = false;
    }

    if (!res.ok) {
      const { error } = (parsed ? (body ?? {}) : {}) as ErrorBody;
      throw new ApiError(
        error?.message ?? `Request failed (${res.status})`,
        res.status,
        error?.detail ?? (parsed ? undefined : excerpt(text)),
      );
    }
    if (!parsed)
      throw new ApiError(
        "The server did not answer with JSON",
        res.status,
        excerpt(text) || "The response was empty.",
      );
    return body as T;
  }

  private form(file: File, fields: Record<string, string | undefined>): RequestInit {
    const form = new FormData();
    form.set("file", file);
    for (const [k, v] of Object.entries(fields)) if (v?.trim()) form.set(k, v.trim());
    return { method: "POST", body: form };
  }

  private post(body?: unknown): RequestInit {
    return {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    };
  }

  async books(): Promise<Book[]> {
    return (await this.send<{ books: Book[] }>("/books")).books;
  }

  book(id: string): Promise<ImportedBook> {
    return this.send<ImportedBook>(`/books/${encodeURIComponent(id)}`);
  }

  async chapterText(
    bookId: string,
    chapterId: number,
    format: TextFormat = "markdown",
  ): Promise<string> {
    const { text } = await this.send<{ text: string }>(
      `/books/${encodeURIComponent(bookId)}/chapters/${chapterId}/text?format=${format}`,
    );
    return text;
  }

  importBook(file: File, { title }: { title?: string } = {}): Promise<ImportedBook> {
    return this.send<ImportedBook>("/books/import", this.form(file, { title }));
  }

  importVolume(bookId: string, file: File, name?: string): Promise<ImportedBook> {
    return this.send<ImportedBook>("/books/import", this.form(file, { bookId, name }));
  }

  async confirmImport(bookId: string): Promise<Book> {
    return (
      await this.send<{ book: Book }>(`/books/${encodeURIComponent(bookId)}/confirm`, this.post())
    ).book;
  }

  async discardImport(bookId: string): Promise<"book" | "volume"> {
    return (
      await this.send<{ discarded: "book" | "volume" }>(
        `/books/${encodeURIComponent(bookId)}/discard`,
        this.post(),
      )
    ).discarded;
  }

  async skipChapters(bookId: string, ids: number[], skip: boolean): Promise<Chapter[]> {
    const where = skip ? "skip" : "include";
    return (
      await this.send<{ chapters: Chapter[] }>(
        `/books/${encodeURIComponent(bookId)}/chapters/${where}`,
        this.post({ ids }),
      )
    ).chapters;
  }

  async keepChapters(bookId: string, ids: number[]): Promise<Chapter[]> {
    return (
      await this.send<{ chapters: Chapter[] }>(
        `/books/${encodeURIComponent(bookId)}/chapters/keep`,
        this.post({ ids }),
      )
    ).chapters;
  }

  async removeBook(bookId: string): Promise<void> {
    await this.send(`/books/${encodeURIComponent(bookId)}`, { method: "DELETE" });
  }

  async removeVolume(bookId: string, volumeId: number): Promise<"book" | "volume"> {
    return (
      await this.send<{ removed: "book" | "volume" }>(
        `/books/${encodeURIComponent(bookId)}/volumes/${volumeId}`,
        { method: "DELETE" },
      )
    ).removed;
  }
}

let service: LibraryService | null = null;

/**
 * The library service for the mode the app started in.
 *
 * In demo mode there isn't one, and this throws rather than inventing an answer: the library's
 * demo state is the seeded world the store holds, and handing back something that merely looked
 * like a backend is exactly the silent fallback the demo rules forbid.
 */
export function libraryService(): LibraryService {
  if (!isBackend)
    throw new Error(
      `The library service is not available in ${mode} mode. ` +
        `The seeded library lives in the store; start the app with VITE_MODE=backend to talk to a server.`,
    );
  return (service ??= new HttpLibraryService());
}

/** Point the app at a different implementation. For tests and for wiring at startup. */
export function setLibraryService(next: LibraryService | null): void {
  service = next;
}
