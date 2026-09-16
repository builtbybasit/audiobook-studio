// A shelf with more books than a glance can hold. The four seeded books never made the Library
// cope with twenty, so this is the set the "A full shelf" demo row adds: each borrows an import
// sample's chapters and is left at one point in the pipeline, so the search, filters and sort on
// the shelf have something to work against.
//
// The states are the ones the shelf tells apart: nothing run, part scripted, part narrated,
// failed scripting, stale audio, everything narrated but no audiobook, an audiobook that matches
// the book, and one the book has moved on from.
export type ShelfState =
  | "fresh"
  | "scripting"
  | "narrating"
  | "failed"
  | "stale"
  | "ready"
  | "built"
  | "behind";

export interface ShelfBook {
  id: string;
  title: string;
  author: string;
  cover: [string, string];
  /** which import sample supplies the chapters */
  sample: string;
  state: ShelfState;
  /** ISO date, so the shelf can sort by it */
  addedAt: string;
}

export const SHELF_BOOKS: ShelfBook[] = [
  {
    id: "shelf-ember",
    title: "Ember Road",
    author: "Tomasz Quill",
    cover: ["#7f1d1d", "#fb7185"],
    sample: "clean",
    state: "built",
    addedAt: "2026-05-02",
  },
  {
    id: "shelf-orchard",
    title: "The Orchard at the End of Time",
    author: "Halcyon Reed",
    cover: ["#365314", "#a3e635"],
    sample: "misleading",
    state: "behind",
    addedAt: "2026-05-19",
  },
  {
    id: "shelf-saltglass",
    title: "Saltglass",
    author: "Ines Varga",
    cover: ["#0c4a6e", "#7dd3fc"],
    sample: "clean",
    state: "ready",
    addedAt: "2026-06-01",
  },
  {
    id: "shelf-tenth",
    title: "The Tenth Immortal Is a Fraud",
    author: "Unknown Daoist",
    cover: ["#581c87", "#c084fc"],
    sample: "volumes",
    state: "narrating",
    addedAt: "2026-06-11",
  },
  {
    id: "shelf-clockwork",
    title: "A Clockwork Inheritance",
    author: "Perpetua Lark",
    cover: ["#78350f", "#fbbf24"],
    sample: "mixed",
    state: "stale",
    addedAt: "2026-06-24",
  },
  {
    id: "shelf-wolves",
    title: "Wolves of the Lower Court",
    author: "M. R. Halloway",
    cover: ["#1e3a8a", "#93c5fd"],
    sample: "clean",
    state: "failed",
    addedAt: "2026-07-03",
  },
  {
    id: "shelf-grey",
    title: "Grey Harbour, Red Sky",
    author: "Ines Varga",
    cover: ["#3f3f46", "#f87171"],
    sample: "misleading",
    state: "scripting",
    addedAt: "2026-07-09",
  },
  {
    id: "shelf-kettle",
    title: "The Kettle Witch",
    author: "Halcyon Reed",
    cover: ["#134e4a", "#5eead4"],
    sample: "clean",
    state: "fresh",
    addedAt: "2026-07-15",
  },
  {
    id: "shelf-lattice",
    title: "Lattice",
    author: "Perpetua Lark",
    cover: ["#312e81", "#a5b4fc"],
    sample: "mixed",
    state: "built",
    addedAt: "2026-07-22",
  },
  {
    id: "shelf-hollow",
    title: "Hollow Crown, Hollow Tooth",
    author: "Tomasz Quill",
    cover: ["#713f12", "#fde047"],
    sample: "clean",
    state: "narrating",
    addedAt: "2026-07-30",
  },
  {
    id: "shelf-siege",
    title: "Siege Diary of a Minor Clerk",
    author: "Cloudwalker of the Eastern Sea",
    cover: ["#065f46", "#6ee7b7"],
    sample: "volumes",
    state: "behind",
    addedAt: "2026-08-04",
  },
  {
    id: "shelf-ninefold",
    title: "Ninefold Ascension",
    author: "Unknown Daoist",
    cover: ["#4a044e", "#f0abfc"],
    sample: "serial",
    state: "scripting",
    addedAt: "2026-08-08",
  },
  {
    id: "shelf-lighthouse",
    title: "What the Lighthouse Kept",
    author: "Ines Varga",
    cover: ["#164e63", "#22d3ee"],
    sample: "clean",
    state: "ready",
    addedAt: "2026-08-12",
  },
  {
    id: "shelf-quiet",
    title: "The Quiet Auditor",
    author: "Perpetua Lark",
    cover: ["#1c1917", "#a8a29e"],
    sample: "misleading",
    state: "failed",
    addedAt: "2026-08-15",
  },
  {
    id: "shelf-cinder",
    title: "Cinderfall",
    author: "M. R. Halloway",
    cover: ["#9a3412", "#fdba74"],
    sample: "clean",
    state: "fresh",
    addedAt: "2026-08-30",
  },
  {
    id: "shelf-paper",
    title: "Paper Gods of the Delta",
    author: "Halcyon Reed",
    cover: ["#0f766e", "#99f6e4"],
    sample: "mixed",
    state: "stale",
    addedAt: "2026-09-03",
  },
  {
    id: "shelf-vane",
    title: "The Weathervane Conspiracy",
    author: "Tomasz Quill",
    cover: ["#1e40af", "#60a5fa"],
    sample: "clean",
    state: "built",
    addedAt: "2026-09-10",
  },
  {
    id: "shelf-last",
    title: "Last Orders at the World’s End",
    author: "Cloudwalker of the Eastern Sea",
    cover: ["#3b0764", "#d8b4fe"],
    sample: "volumes",
    state: "fresh",
    addedAt: "2026-09-14",
  },
];
