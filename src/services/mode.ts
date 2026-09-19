// Demo or backend, chosen once at startup.
//
// The rule this file exists to enforce is in `docs/demo.md`: the two modes are selected at the
// service boundary, and neither ever silently becomes the other. A backend that is down is an
// error the person sees — not a quiet slide into seeded books that look real, priced at rates
// nobody is being charged.
//
// Demo is the default, and stays the default. It is the mode with no backend, no credentials and
// no paid requests, which is what makes it the safe thing to land on.
export type AppMode = "demo" | "backend";

const raw = (import.meta.env.VITE_MODE ?? "demo").trim();

if (raw !== "demo" && raw !== "backend")
  throw new Error(
    `VITE_MODE must be "demo" or "backend", not ${JSON.stringify(raw)}. ` +
      `Leave it unset for the seeded demo.`,
  );

export const mode: AppMode = raw;
export const isDemo = mode === "demo";
export const isBackend = mode === "backend";
