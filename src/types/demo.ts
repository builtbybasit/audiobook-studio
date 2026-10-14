// Shapes the Demo tools render seeded situations from; the scenarios live in
// `server/demo/seed/scenarios`.

/** The Demo tools panel groups its rows by this. */
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

/**
 * Applying one always starts from the seeded world, so the same row always gives the same result.
 */
export interface DemoScenario {
  id: string;
  group: DemoGroup;
  /** in the user's words */
  name: string;
  /** one line on what is on screen once applied */
  blurb: string;
  bookId: string;
  path: string;
  /** simulated runs started once seeded, so there is work in flight to watch */
  runs?: { kind: "scripting" | "narration"; chapterIds: number[] }[];
  /** what to try, in order; the drawer keeps these beside the page */
  steps?: string[];
}

export interface DemoResult {
  /** a factual line — counts, not adjectives */
  note: string;
  /** overrides the scenario's path when the situation decides the query */
  open?: string;
}

/** `GET /demo/api/demo/situations` */
export type DemoSituation = Pick<
  DemoScenario,
  "id" | "group" | "name" | "blurb" | "bookId" | "path"
> & {
  steps: string[];
};

/** The drawer lists situations under `groups`, in order. */
export interface DemoSituations {
  groups: { id: DemoGroup; label: string }[];
  situations: DemoSituation[];
}

/** `POST /demo/api/demo/situations/:id` */
export interface AppliedSituation {
  scenario: Omit<DemoSituation, "group" | "blurb">;
  /** a factual line — counts, not adjectives */
  note: string;
  /** the situation's own path, or a more exact one it decided */
  open: string;
}

export interface ExportScenario {
  id: string;
  label: string;
  hint: string;
  bookId: string;
}
