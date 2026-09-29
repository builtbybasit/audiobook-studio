// The Demo drawer's store over the demo library: the situations it lists, putting the demo into one
// and back, and the speed (`src/stores/demo.ts`, `server/routes/demo.ts`).
//
// The store asks a seeded demo library in-process (`support/demoServer.ts`) and loads the page
// again through a loader of the test's own, so what it would have loaded is recorded rather than
// followed. The tab's `sessionStorage` is the suite's in-memory one; a store built again from a
// fresh Pinia is the page after that load.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEMO_GROUPS, demoScenarios } from "@/mock/scenarios/catalogue";
import { HttpDemoService, setDemoService } from "@/services/demo";
import { APPLIED_KEY, REOPEN_KEY, setPageLoader, useDemoStore } from "@/stores/demo";
import { useUiStore } from "@/stores/ui";
import type { Book } from "@/types";
import { DEMO_BASE } from "~/libraries";
import { demoServer, type DemoServer } from "./support/demoServer";
import { testPinia } from "./support/pinia";

let server: DemoServer;
/** every path the store asked the page to load */
let loaded: string[];
/** every toast the store raised */
let toasts: string[];

/** The store as a page that has just loaded builds it. */
function freshStore() {
  testPinia();
  useUiStore().toast = (msg) => {
    toasts.push(msg);
    return "test";
  };
  return useDemoStore();
}

beforeEach(async () => {
  // the ui store reads the colour scheme as it is built
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  server = await demoServer();
  setDemoService(new HttpDemoService(DEMO_BASE, server.fetch));
  loaded = [];
  toasts = [];
  setPageLoader((path) => void loaded.push(path));
});

afterEach(() => {
  sessionStorage.removeItem(APPLIED_KEY);
  sessionStorage.removeItem(REOPEN_KEY);
  setDemoService(null);
});

const shelf = async () =>
  ((await (await server.fetch(`${DEMO_BASE}/books`)).json()) as { books: Book[] }).books.map(
    (b) => b.id,
  );

describe("the demo store", () => {
  test("lists every situation under its heading, and the speed, from the demo library", async () => {
    const demo = freshStore();
    await demo.load();
    expect(demo.loaded).toBe(true);
    expect(demo.groups).toEqual(DEMO_GROUPS);
    expect(demo.situations.map((s) => s.id)).toEqual(demoScenarios().map((s) => s.id));
    expect(demo.grouped.flatMap((g) => g.rows).length).toBe(demo.situations.length);
    expect(demo.speed).toBe(1);
  });

  test("applies a situation on the server, loads the page on it, and still says so afterwards", async () => {
    const row = demoScenarios().find((s) => s.id === "import-clean")!;
    const demo = freshStore();
    await demo.applyScenario(row.id, { reopen: true });

    expect(loaded).toEqual(["/book/import-clean/contents"]);
    expect(await shelf()).toContain("import-clean");
    expect(demo.applied).toMatchObject({ id: row.id, name: row.name, path: row.path });
    expect(demo.applied!.note).not.toBe("");

    // the page after the load: the same situation, and the drawer open again once
    const after = freshStore();
    expect(after.applied).toEqual(demo.applied);
    expect(after.takeReopen()).toBe(true);
    expect(after.takeReopen()).toBe(false);
  });

  test("resets the demo, forgets the situation, and loads the page where it was", async () => {
    const demo = freshStore();
    await demo.applyScenario("import-clean");
    expect(demo.takeReopen()).toBe(false);
    await demo.resetDemo("/queue");

    expect(loaded.at(-1)).toBe("/queue");
    expect(await shelf()).not.toContain("import-clean");
    expect(demo.applied).toBeNull();
    expect(sessionStorage.getItem(APPLIED_KEY)).toBeNull();
    expect(freshStore().applied).toBeNull();
  });

  test("sets the demo library's speed, and reads it back on the next page", async () => {
    const demo = freshStore();
    await demo.setSpeed(16);
    expect(demo.speed).toBe(16);

    const after = freshStore();
    await after.load();
    expect(after.speed).toBe(16);
  });

  test("says so when the demo library refuses, and changes nothing", async () => {
    const demo = freshStore();
    await demo.setSpeed(3);
    expect(demo.speed).toBe(1);
    await demo.applyScenario("nothing-like-it");
    expect(loaded).toEqual([]);
    expect(demo.applied).toBeNull();
    expect(toasts.length).toBe(2);
    expect(demo.busy).toBe(false);
  });
});
