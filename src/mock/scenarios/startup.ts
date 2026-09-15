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

export const startupRuns = (): StartupRun[] => [
  { kind: "scripting", bookId: "drowned", chapterIds: [3, 4, 5] },
  { kind: "narration", bookId: "cliche", chapterIds: [5, 6] },
];
