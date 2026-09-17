// What the prototype sets running on first load, so the Queue, the job indicator and the endpoint
// activity are not empty the first time you look at them. The store owns the one-shot guard and the
// timer; this is only the list of what gets kicked off.
export interface StartupRun {
  kind: "scripting" | "narration";
  bookId: string;
  chapterIds: number[];
}

/** Long enough that the first paint is the seeded world, not a queue already in motion. */
export const STARTUP_DELAY_MS = 1200;

/**
 * The credentials the demo runs on. They are not keys: nothing is sent anywhere, and they exist so
 * the seeded endpoints are usable without asking anyone to paste a real one. Kept here rather than
 * in `main.ts` because a demo reset has to put them back — a scenario is free to take one away.
 */
export const SEEDED_KEYS: [string, string][] = [
  ["openai", "sk-prototype-demo-key-4f2a"],
  ["fish", "fa-prototype-demo-7b31"],
  ["gemini", "AIza-prototype-demo-2e9f"],
  ["profile:openai", "sk-prototype-demo-key-4f2a"],
  ["profile:deepseek", "ds-prototype-91cd"],
  // The named credentials the seeded endpoints point at, under the `cred:<id>` slots the registry
  // uses. Opening the Endpoints page binds every endpoint that names a credential, which *mirrors*
  // that credential's secret into the endpoint's own slot — so a credential with no secret does not
  // leave the endpoint's key alone, it wipes it. Seeding both halves is what keeps a seeded
  // endpoint usable after the page that manages it has been looked at.
  ["cred:openai-personal", "sk-prototype-demo-key-4f2a"],
  ["cred:proxy-work", "gw-prototype-demo-5c08"],
  ["cred:fish-personal", "fa-prototype-demo-7b31"],
  ["cred:deepseek", "ds-prototype-91cd"],
];

export const startupRuns = (): StartupRun[] => [
  { kind: "scripting", bookId: "drowned", chapterIds: [3, 4, 5] },
  { kind: "narration", bookId: "cliche", chapterIds: [5, 6] },
];
