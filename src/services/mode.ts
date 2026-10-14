// Demo or backend, chosen once when the page loads; neither ever silently becomes the other (a
// down backend is an error, not a slide into seeded books). The Demo chip sets a `sessionStorage`
// flag and reloads, so the choice lasts the tab and every service and store reads it at build time.
export type AppMode = "demo" | "backend";

export const MODE_KEY = "audiobook-studio:mode";

interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Read off `globalThis` per call: the server's typecheck has no DOM, tests swap the storage, and
// reading the property throws where the browser blocks storage.
const session = () => (globalThis as { sessionStorage?: ModeStorage }).sessionStorage;
const reload = () => (globalThis as { location?: { reload(): void } }).location?.reload();

/** Backend unless this tab asked for the demo, including when storage is missing or throws. */
export function readMode(): AppMode {
  try {
    return session()?.getItem(MODE_KEY) === "demo" ? "demo" : "backend";
  } catch {
    return "backend";
  }
}

export const mode: AppMode = readMode();
export const isDemo = mode === "demo";

/** `/demo/api`: same server and routes, separate database, so a demo tab can't reach yours. */
export const API_BASE = isDemo ? "/demo/api" : "/api";

/**
 * False, without reloading, when storage is missing or refused the write: the reload would land in
 * the same mode.
 */
function switchTo(next: AppMode): boolean {
  try {
    const storage = session();
    if (!storage) return false;
    if (next === "demo") storage.setItem(MODE_KEY, "demo");
    else storage.removeItem(MODE_KEY);
  } catch {
    return false;
  }
  reload();
  return true;
}

/** The library on the server is left as it is. */
export const enterDemo = (): boolean => switchTo("demo");

/** Whatever was done in the demo goes with the page. */
export const leaveDemo = (): boolean => switchTo("backend");
