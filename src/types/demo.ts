// Seeded situations a page can be dropped into, for trying a flow end to end. The scenarios
// themselves live in `src/mock/scenarios`; these are the shapes the pages render them from.

/** Which part of the workflow a scenario is for. The Demo tools panel groups its rows by this. */
export type DemoGroup =
  | "import"
  | "shelf"
  | "start"
  | "trouble"
  | "blocked"
  | "review"
  | "bulk"
  | "pricing"
  | "export";

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
  /** what to try once it is applied, in order — the drawer keeps these beside the page */
  steps?: string[];
}

/** What a scenario did, for the toast that reports it and where it wants to open. */
export interface DemoResult {
  /** a factual line — counts, not adjectives */
  note: string;
  /** overrides the scenario's own path when the situation decides the query */
  open?: string;
}

/** A situation as the demo library lists it for the drawer (`GET /demo/api/demo/situations`). */
export type DemoSituation = Pick<
  DemoScenario,
  "id" | "group" | "name" | "blurb" | "bookId" | "path"
> & {
  steps: string[];
};

/** Every situation the demo offers, and the headings the drawer lists them under, in order. */
export interface DemoSituations {
  groups: { id: DemoGroup; label: string }[];
  situations: DemoSituation[];
}

/** What putting the demo into a situation did (`POST /demo/api/demo/situations/:id`). */
export interface AppliedSituation {
  scenario: Omit<DemoSituation, "group" | "blurb">;
  /** a factual line — counts, not adjectives */
  note: string;
  /** where to look at it: the situation's own path, or a more exact one it decided */
  open: string;
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
