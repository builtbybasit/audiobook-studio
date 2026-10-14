// Runs the demo starts when seeded with no situation, so the Queue isn't empty on first look.
export interface StartupRun {
  kind: "scripting" | "narration";
  bookId: string;
  chapterIds: number[];
}

export const startupRuns = (): StartupRun[] => [
  { kind: "scripting", bookId: "drowned", chapterIds: [3, 4, 5] },
  { kind: "narration", bookId: "cliche", chapterIds: [5, 6] },
];
