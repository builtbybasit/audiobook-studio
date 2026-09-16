// Seeded situations a page can be dropped into, for trying a flow end to end. The scenarios
// themselves live in `src/mock/scenarios`; these are the shapes the pages render them from.

/** Which part of the workflow a scenario is for. The Demo tools panel groups its rows by this. */
export type DemoGroup = "import" | "shelf" | "start" | "trouble" | "blocked" | "review" | "export";

/** One seeded situation offered by the Demo tools: a plain-language name, a line saying what you
 *  will be looking at, and where it opens. Applying one always starts from the seeded world, so the
 *  same row gives the same situation however many scenarios ran before it. */
export interface DemoScenario {
  id: string;
  group: DemoGroup;
  /** what to call it, in the user's words */
  name: string;
  /** one line on what is on screen once it is applied */
  blurb: string;
  /** the book it puts you in */
  bookId: string;
  /** where it opens */
  path: string;
  /** simulated runs to start once it is seeded, so there is work in flight to watch */
  runs?: { kind: "scripting" | "narration"; chapterIds: number[] }[];
}

/** What a scenario did, for the toast that reports it and where it wants to open. */
export interface DemoResult {
  /** a factual line — counts, not adjectives */
  note: string;
  /** overrides the scenario's own path when the situation decides the query */
  open?: string;
}

/** A seeded situation the Export page can be dropped into, for trying a build end to end. */
export interface ExportScenario {
  id: string;
  label: string;
  hint: string;
  /** the book it puts you in */
  bookId: string;
}

/** A seeded situation the Search page can be dropped into, for trying the bulk flow. */
export interface SearchScenario {
  id: string;
  label: string;
  hint: string;
  query: string;
  /** speaker filter, "" for any */
  speaker: string;
  /** segment type filter, "all" for any */
  type: string;
}
