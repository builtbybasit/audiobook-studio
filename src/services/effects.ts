// The seam the library's voice effects go through, as `@/services/library` is for books.
import type {
  Effect,
  EffectUses,
  ExistingScope,
  Job,
  StaleSound,
  Step,
  ThoughtChoice,
} from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { API_BASE } from "@/services/mode";

export interface EffectsService {
  /** In library order. */
  list(): Promise<Effect[]>;
  /** Right after `after`, or at the end; the server gives it its id. */
  create(effect: Omit<Effect, "id">, after?: string): Promise<Effect>;
  /** Every book and speaker that chooses it, and whether the library's thought effect is it. */
  uses(id: string): Promise<EffectUses>;
  /** A field left out is cleared; the id stays. */
  update(effect: Effect): Promise<Effect>;
  /** The server clears every book's and speaker's choice of it too. */
  remove(id: string): Promise<void>;
  /** The library's thought effect: an effect's id, or "none". */
  libraryThoughts(): Promise<ThoughtChoice>;
  setLibraryThoughts(choice: ThoughtChoice): Promise<ThoughtChoice>;
  /** The clip at `url` run through `chains` in order, as a WAV; nothing is kept. */
  preview(url: string, chains: Step[][]): Promise<Blob>;
  /** The chain a piece of Pedalboard code builds; a 400 says why it builds none. */
  parse(code: string): Promise<Step[]>;
  /** A book's (or one speaker's) clips with an old sound, how many cannot be redone, and where. */
  stale(bookId: string, speaker?: string): Promise<StaleSound>;
  /** Redo the old-sound clips in scope (all of them by default). Refused (409) while one is queued or running. */
  reapply(bookId: string, scope?: ExistingScope): Promise<Job>;
  /** Mark the old-sound clips in scope as kept, until their lines' sound changes again; how many. */
  keep(bookId: string, scope: ExistingScope): Promise<number>;
}

export class HttpEffectsService implements EffectsService {
  private readonly http: HttpClient;
  constructor(base = API_BASE, fetch?: FetchLike) {
    this.http = new HttpClient(base, fetch);
  }

  async list(): Promise<Effect[]> {
    return (await this.http.get<{ effects: Effect[] }>("/effects")).effects;
  }

  async create(effect: Omit<Effect, "id">, after?: string): Promise<Effect> {
    const body = after ? { ...effect, after } : effect;
    return (await this.http.post<{ effect: Effect }>("/effects", body)).effect;
  }

  async uses(id: string): Promise<EffectUses> {
    return await this.http.get<EffectUses>(`/effects/${seg(id)}/uses`);
  }

  async update({ id, ...body }: Effect): Promise<Effect> {
    return (await this.http.put<{ effect: Effect }>(`/effects/${seg(id)}`, body)).effect;
  }

  async remove(id: string): Promise<void> {
    await this.http.delete(`/effects/${seg(id)}`);
  }

  async libraryThoughts(): Promise<ThoughtChoice> {
    return (await this.http.get<{ effect: ThoughtChoice }>("/settings/thoughts")).effect;
  }

  async setLibraryThoughts(choice: ThoughtChoice): Promise<ThoughtChoice> {
    return (
      await this.http.put<{ effect: ThoughtChoice }>("/settings/thoughts", { effect: choice })
    ).effect;
  }

  async preview(url: string, chains: Step[][]): Promise<Blob> {
    return (await this.http.postForFile("/effects/preview", { url, chains })).blob;
  }

  async parse(code: string): Promise<Step[]> {
    return (await this.http.post<{ chain: Step[] }>("/effects/parse", { code })).chain;
  }

  stale(bookId: string, speaker?: string): Promise<StaleSound> {
    const q = speaker == null ? "" : `?speaker=${encodeURIComponent(speaker)}`;
    return this.http.get<StaleSound>(`/books/${seg(bookId)}/effects/stale${q}`);
  }

  async reapply(bookId: string, scope: ExistingScope = {}): Promise<Job> {
    return (await this.http.post<{ job: Job }>(`/books/${seg(bookId)}/effects/reapply`, scope)).job;
  }

  async keep(bookId: string, scope: ExistingScope): Promise<number> {
    return (await this.http.post<{ kept: number }>(`/books/${seg(bookId)}/effects/keep`, scope))
      .kept;
  }
}

let service: EffectsService | null = null;

export function effectsService(): EffectsService {
  return (service ??= new HttpEffectsService());
}

/** For tests; `null` goes back to the HTTP one. */
export function setEffectsService(next: EffectsService | null): void {
  service = next;
}
