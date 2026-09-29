// Every test runs as a tab that has entered the demo. Preloaded by `bunfig.toml`.
//
// The app talks to the server unless the tab's `sessionStorage` says otherwise
// (`src/services/mode.ts`), and Bun has no `sessionStorage` at all — so without this every store
// would be built against the HTTP services and ask a server that is not there. The suite is
// written against the seeded world; a test of the backend half hands its store a service of its
// own (`setLibraryService` and its kind), which works whichever mode was read at startup.
//
// It has to run before anything imports the mode, which is what a preload is for — and so it
// spells the key out rather than importing it, which would read the mode before the flag is set.
// Defined rather than assigned so the mode's own test can put a storage that throws in its place.
const MODE_KEY = "audiobook-studio:mode";

export class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  clear(): void {
    this.items.clear();
  }
}

export function demoTab(): MemoryStorage {
  const storage = new MemoryStorage();
  storage.setItem(MODE_KEY, "demo");
  return storage;
}

Object.defineProperty(globalThis, "sessionStorage", {
  value: demoTab(),
  configurable: true,
  writable: true,
});
