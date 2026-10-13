// The seam the library's voice effects are read and written through.
//
// The same arrangement as `@/services/library`: one HTTP implementation, asking the library this
// tab is on (`API_BASE`) — yours, or the demo's — unless a test set another. The effects store
// asks `effectsService()`; no view knows which answered.
import type { Effect, EffectUses, Job, StaleSound, Step, ThoughtChoice } from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { API_BASE } from "@/services/mode";

export interface EffectsService {
  /** Every effect, in the order the library lists them. */
  list(): Promise<Effect[]>;
  /** A new effect, right after `after` or at the end of the list; the server gives it its id. */
  create(effect: Omit<Effect, "id">, after?: string): Promise<Effect>;
  /** Every book and speaker that chooses it, and whether the library's thought effect is it. */
  uses(id: string): Promise<EffectUses>;
  /** Its name, chain and `useWhen` replaced by these — one left out is cleared; the id stays. */
  update(effect: Effect): Promise<Effect>;
  /** Gone, and every choice of it with it: the server clears each book's and speaker's. */
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
  /** Queue the book's Re-apply; refused (409) while one is queued or running. */
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

/** Point the app at a different implementation; `null` goes back to the HTTP one. For tests. */
export function setEffectsService(next: EffectsService | null): void {
  service = next;
}
