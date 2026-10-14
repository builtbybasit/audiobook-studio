// The Demo drawer's store: situations, the one this tab applied, and simulated speed. All of it is
// the server's (`server/routes/demo.ts`): applying or resetting reseeds the library and the page
// reloads, so nothing old needs reconciling. The server does not remember which situation it is in,
// so the applied one is kept in `sessionStorage` for after the reload.
import type { AppliedSituation, DemoSituation, DemoSituations } from "@/types";
import { defineStore } from "pinia";
import { ApiError } from "@/services/http";
import { demoService } from "@/services/demo";
import { useUiStore } from "@/stores/ui";

/** The situation this tab last put the demo into, as the drawer's "Now" shows it. */
export type AppliedRow = AppliedSituation["scenario"] & Pick<AppliedSituation, "note">;

/** `sessionStorage` keys: what was applied, and that the drawer was open when the page went. */
export const APPLIED_KEY = "audiobook-studio:demo-situation";
export const REOPEN_KEY = "audiobook-studio:demo-drawer";

// Read off `globalThis` per call and guarded (as `services/mode.ts`): a browser blocking storage
// throws on the property, and that must only forget the situation, not break the page.
const session = () => (globalThis as { sessionStorage?: Storage }).sessionStorage;

function recall<T>(key: string): T | null {
  try {
    const raw = session()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function keep(key: string, value: unknown): void {
  try {
    if (value == null || value === false) session()?.removeItem(key);
    else session()?.setItem(key, JSON.stringify(value));
  } catch {
    // the page loads again without it: the chip says "Demo mode" and no more
  }
}

/** How the page loads again on a path. A test hands over its own, so nothing reloads. */
let loadPage = (path: string): void => globalThis.location.assign(path);

export function setPageLoader(next: (path: string) => void): void {
  loadPage = next;
}

interface DemoState {
  groups: DemoSituations["groups"];
  situations: DemoSituation[];
  /** the list and the speed have been read from the demo library */
  loaded: boolean;
  applied: AppliedRow | null;
  /** how much faster than 1× the demo's simulated work runs (`SPEEDS`) */
  speed: number;
  /** a request is on its way; the drawer holds still until it answers */
  busy: boolean;
}

export const useDemoStore = defineStore("demo", {
  state: (): DemoState => ({
    groups: [],
    situations: [],
    loaded: false,
    applied: recall<AppliedRow>(APPLIED_KEY),
    speed: 1,
    busy: false,
  }),
  getters: {
    /** Each heading with its situations, in the server's order; empty ones left out. */
    grouped(s): (DemoSituations["groups"][number] & { rows: DemoSituation[] })[] {
      return s.groups
        .map((g) => ({ ...g, rows: s.situations.filter((r) => r.group === g.id) }))
        .filter((g) => g.rows.length);
    },
  },
  actions: {
    async load(): Promise<void> {
      if (this.loaded) return;
      const read = await this._ask("read the demo's situations", () =>
        Promise.all([demoService().situations(), demoService().speed()]),
      );
      if (!read) return;
      const [{ groups, situations }, speed] = read;
      Object.assign(this, { groups, situations, speed, loaded: true });
    },
    /**
     * Apply a situation and reload on it (`reopen` keeps the drawer open). The demo is reseeded
     * first, so a row always gives the same situation.
     */
    async applyScenario(id: string, { reopen = false } = {}): Promise<void> {
      const answer = await this._ask("put the demo into that situation", () =>
        demoService().apply(id),
      );
      if (!answer) return;
      this.applied = { ...answer.scenario, note: answer.note };
      keep(APPLIED_KEY, this.applied);
      keep(REOPEN_KEY, reopen);
      loadPage(answer.open);
    },
    /** Put the demo back as it was seeded, and load the page again on `path`. */
    async resetDemo(path: string, { reopen = false } = {}): Promise<void> {
      const done = await this._ask("reset the demo", async () => {
        await demoService().reset();
        return true;
      });
      if (!done) return;
      this.applied = null;
      keep(APPLIED_KEY, null);
      keep(REOPEN_KEY, reopen);
      loadPage(path);
    },
    /** A run already going picks the new speed up as it goes. */
    async setSpeed(speed: number): Promise<void> {
      const answered = await this._ask("change the demo's speed", () =>
        demoService().setSpeed(speed),
      );
      if (answered != null) this.speed = answered;
    },
    /** Whether the drawer was open when the page last went, forgotten once asked. */
    takeReopen(): boolean {
      const reopen = recall<boolean>(REOPEN_KEY) === true;
      keep(REOPEN_KEY, null);
      return reopen;
    },
    /** One request at a time, and a failure said rather than thrown; null when it failed. */
    async _ask<T>(what: string, request: () => Promise<T>): Promise<T | null> {
      this.busy = true;
      try {
        return await request();
      } catch (cause) {
        const api = cause instanceof ApiError ? cause : null;
        useUiStore().toast(api ? api.message : `Could not ${what}`, {
          kind: "error",
          description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
          timeout: 8000,
        });
        return null;
      } finally {
        this.busy = false;
      }
    },
  },
});
