// Demo or backend, chosen once when the page loads.
//
// The rule this file exists to enforce is in `docs/demo.md`: the two modes are selected at the
// service boundary, and neither ever silently becomes the other. A backend that is down is an
// error the person sees — not a quiet slide into seeded books that look real, priced at rates
// nobody is being charged.
//
// The app talks to the server unless this tab has asked for the demo. The Demo chip asks by
// setting a flag in `sessionStorage` and reloading, so the choice lasts as long as the tab and a
// new tab opens on the real library. Nothing else sets the flag: a server that does not answer
// leaves the page in backend mode, saying so. Reloading rather than switching in place is what
// keeps the choice once-per-page — every service and store below reads it when it is built.
export type AppMode = "demo" | "backend";

/** The one `sessionStorage` key the choice is kept under. */
export const MODE_KEY = "audiobook-studio:mode";

/** The part of Web Storage this reads and writes. */
interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Read off `globalThis` at each call rather than named directly: the server's typecheck includes
// this file without the DOM, a test swaps the storage in and out, and merely reading the property
// throws in a browser that blocks storage for the site.
const session = () => (globalThis as { sessionStorage?: ModeStorage }).sessionStorage;
const reload = () => (globalThis as { location?: { reload(): void } }).location?.reload();

/**
 * The mode a page loading now runs in: the demo when this tab asked for it, backend otherwise —
 * including when there is no storage to ask, or it throws.
 */
export function readMode(): AppMode {
  try {
    return session()?.getItem(MODE_KEY) === "demo" ? "demo" : "backend";
  } catch {
    return "backend";
  }
}

export const mode: AppMode = readMode();
export const isDemo = mode === "demo";

/**
 * Where this tab's API answers: your library at `/api`, the demo library at `/demo/api`. Both are
 * the same server and the same routes; the demo's are a second library with a database of its own,
 * so nothing a demo tab does can reach yours.
 */
export const API_BASE = isDemo ? "/demo/api" : "/api";

/**
 * Change the tab's mode and load the page again in it.
 *
 * Returns false, and does not reload, when there is no storage or it refused the write: the page
 * would load straight back into the mode it is in, so the caller has to say it could not switch.
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

/** Open the seeded demo in this tab. The library on the server is left as it is. */
export const enterDemo = (): boolean => switchTo("demo");

/** Back to the server's library. Whatever was done in the demo goes with the page. */
export const leaveDemo = (): boolean => switchTo("backend");
