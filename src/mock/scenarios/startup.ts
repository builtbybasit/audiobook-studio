// What the demo sets running whenever it is seeded as it began — when it is first opened, and on a
// reset — so the Queue, the job indicator and the endpoint activity are not empty the first time
// you look at them. The server sets them going (`server/demo/situations.ts`); this is only the list.
export interface StartupRun {
  kind: "scripting" | "narration";
  bookId: string;
  chapterIds: number[];
}

export const startupRuns = (): StartupRun[] => [
  { kind: "scripting", bookId: "drowned", chapterIds: [3, 4, 5] },
  { kind: "narration", bookId: "cliche", chapterIds: [5, 6] },
];
