// Every test runs as a tab that entered the demo (Bun has no `sessionStorage`, so the stores would
// otherwise build against a server that isn't there). Backend tests set their own services. A
// preload, so it runs before anything reads the mode; it spells the key out for the same reason,
// and defines rather than assigns so the mode's test can swap in a storage that throws.
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
