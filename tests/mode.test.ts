// Which world the page runs in: the server's unless this tab asked for the demo.
//
// The choice is a flag in the tab's `sessionStorage`, read once when the page loads; the Demo
// chip's Enter and Leave set or clear it and load the page again. Anything short of a flag that
// says "demo" is backend — no storage, a storage that throws, a flag with some other value — so a
// broken browser or a server that is down never lands a person in the seeded books.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { enterDemo, leaveDemo, mode, MODE_KEY, readMode } from "@/services/mode";
import { demoTab, MemoryStorage } from "./support/demoTab";

const reload = mock(() => {});
const saved = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;

function useStorage(storage: unknown) {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}
function blockStorage() {
  Object.defineProperty(globalThis, "sessionStorage", {
    get() {
      throw new Error("SecurityError: access to storage is denied");
    },
    configurable: true,
  });
}

beforeEach(() => {
  reload.mockClear();
  Object.defineProperty(globalThis, "location", {
    value: { reload },
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  Object.defineProperty(globalThis, "sessionStorage", saved);
  delete (globalThis as { location?: unknown }).location;
});

describe("reading the mode", () => {
  test("a tab that asked for the demo runs it", () => {
    useStorage(demoTab());
    expect(readMode()).toBe("demo");
  });

  test("a tab that asked for nothing talks to the server", () => {
    useStorage(new MemoryStorage());
    expect(readMode()).toBe("backend");
  });

  test("a flag with anything else in it is not the demo", () => {
    const storage = new MemoryStorage();
    storage.setItem(MODE_KEY, "Demo");
    useStorage(storage);
    expect(readMode()).toBe("backend");
  });

  test("no storage at all, or one that throws, is backend", () => {
    useStorage(undefined);
    expect(readMode()).toBe("backend");
    blockStorage();
    expect(readMode()).toBe("backend");
    useStorage({
      getItem() {
        throw new Error("quota");
      },
    });
    expect(readMode()).toBe("backend");
  });

  test("the suite itself runs as a demo tab", () => {
    expect(mode).toBe("demo");
  });
});

describe("entering and leaving", () => {
  test("entering sets the flag and loads the page again", () => {
    const storage = new MemoryStorage();
    useStorage(storage);
    expect(enterDemo()).toBe(true);
    expect(storage.getItem(MODE_KEY)).toBe("demo");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readMode()).toBe("demo");
  });

  test("leaving clears it and loads the page again", () => {
    const storage = demoTab();
    useStorage(storage);
    expect(leaveDemo()).toBe(true);
    expect(storage.getItem(MODE_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readMode()).toBe("backend");
  });

  test("a storage that will not keep the choice does not reload into the same mode", () => {
    useStorage({
      getItem: () => null,
      setItem() {
        throw new Error("quota");
      },
      removeItem() {},
    });
    expect(enterDemo()).toBe(false);
    blockStorage();
    expect(enterDemo()).toBe(false);
    expect(leaveDemo()).toBe(false);
    useStorage(undefined);
    expect(enterDemo()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
