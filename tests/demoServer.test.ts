// The harness a demo tab's store tests run on: the page's services answered by a seeded demo library.
import { describe, expect, test } from "bun:test";

import { useLibraryStore } from "@/stores/library";
import { demoServer } from "./support/demoServer";
import { testPinia } from "./support/pinia";

describe("a demo tab", () => {
  test("reads the seeded shelf from the demo library", async () => {
    await demoServer();
    testPinia();
    const library = useLibraryStore();
    await library.load(true);
    expect(library.books.map((b) => b.id)).toEqual(
      expect.arrayContaining(["cliche", "starforge", "drowned", "gates"]),
    );
  });
});
