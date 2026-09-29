// The demo library's own routes: its situations, its reset and its speed (`server/routes/demo.ts`).
//
// Only the demo library answers them — the real one has no route that empties it or speeds it up —
// so this service is asked only from a demo tab, by the Demo drawer. Everything else a demo tab
// does goes through the same services as the real library's, pointed at `/demo/api`.
import type { AppliedSituation, DemoSituations } from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { API_BASE } from "@/services/mode";

export interface DemoService {
  /** Every situation the demo offers, and the headings they are listed under. */
  situations(): Promise<DemoSituations>;
  /** Seed the demo again with one situation applied; what it did and where to look. */
  apply(id: string): Promise<AppliedSituation>;
  /** Seed the demo again as it began. */
  reset(): Promise<void>;
  /** How much faster than 1× the demo's simulated work runs. */
  speed(): Promise<number>;
  /** Set it; resolves with the speed the demo now runs at. */
  setSpeed(speed: number): Promise<number>;
}

export class HttpDemoService implements DemoService {
  private readonly http: HttpClient;
  constructor(base = API_BASE, fetch?: FetchLike) {
    this.http = new HttpClient(base, fetch);
  }

  situations(): Promise<DemoSituations> {
    return this.http.get<DemoSituations>("/demo/situations");
  }

  apply(id: string): Promise<AppliedSituation> {
    return this.http.post<AppliedSituation>(`/demo/situations/${seg(id)}`);
  }

  async reset(): Promise<void> {
    await this.http.post("/demo/reset");
  }

  async speed(): Promise<number> {
    return (await this.http.get<{ speed: number }>("/demo/speed")).speed;
  }

  async setSpeed(speed: number): Promise<number> {
    return (await this.http.put<{ speed: number }>("/demo/speed", { speed })).speed;
  }
}

let service: DemoService | null = null;

/** The demo service, built on first use against this tab's API. */
export function demoService(): DemoService {
  return (service ??= new HttpDemoService());
}

/** For tests: point the Demo drawer at a demo library of the test's own. */
export function setDemoService(next: DemoService | null): void {
  service = next;
}
