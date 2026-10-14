// The seam the library's voice effects go through, as `@/services/library` is for books.
import type { Effect, EffectUses, Job, StaleSound, Step, ThoughtChoice } from "@/types";
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
  /** How many of a book's clips have an old sound, and how many of those cannot be redone. */
  stale(bookId: string): Promise<StaleSound>;
  /** Refused (409) while one is queued or running. */
  reapply(bookId: string): Promise<Job>;
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

  stale(bookId: string): Promise<StaleSound> {
    return this.http.get<StaleSound>(`/books/${seg(bookId)}/effects/stale`);
  }

  async reapply(bookId: string): Promise<Job> {
    return (await this.http.post<{ job: Job }>(`/books/${seg(bookId)}/effects/reapply`)).job;
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
