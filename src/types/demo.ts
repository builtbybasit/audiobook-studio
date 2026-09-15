// Seeded situations a page can be dropped into, for trying a flow end to end. The scenarios
// themselves live in `src/mock/scenarios`; these are the shapes the pages render them from.

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
