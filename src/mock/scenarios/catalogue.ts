// What the Demo tools offer. One row per situation worth testing, named for the situation rather
// than for the data behind it, with a line saying what will be on screen.
//
// This file is the menu; `situations.ts` is what each row does to the world. They are kept apart so
// the wording can be read in one place, and so a row can be added without reading the mutations.
import { exportScenarios } from "./export";
import { IMPORT_SAMPLES } from "../fixtures/imports";
import type { DemoGroup, DemoScenario } from "@/types";

/** The order the panel lists them in, and what each heading is called. */
export const DEMO_GROUPS: { id: DemoGroup; label: string }[] = [
  { id: "import", label: "Importing an EPUB" },
  { id: "shelf", label: "The shelf" },
  { id: "start", label: "Starting a book" },
  { id: "trouble", label: "Runs that go wrong" },
  { id: "blocked", label: "Blocked before a run" },
  { id: "review", label: "Review and retakes" },
  { id: "export", label: "Export" },
];

/** Fresh rows every call — the panel renders these, it never holds on to them. */
export function demoScenarios(): DemoScenario[] {
  return [
    // the import rows open the contents review on a book the scenario itself creates; the id is
    // fixed so the row knows where it opens before the book exists
    ...IMPORT_SAMPLES.map((s): DemoScenario => ({
      id: `import-${s.id}`,
      group: "import",
      name: s.label,
      blurb: s.hint,
      bookId: `import-${s.id}`,
      path: `/book/import-${s.id}/contents`,
    })),
    {
      id: "full-shelf",
      group: "shelf",
      name: "A full shelf",
      blurb:
        "Eighteen more books, in every state the shelf tells apart — nothing run, part way, failed, stale, built, behind — with three chapters scripting as you arrive. For the search, the filters and the sort.",
      bookId: "cliche",
      path: "/library",
      runs: [{ kind: "scripting", chapterIds: [13, 14, 15] }],
    },
    {
      id: "fresh-book",
      group: "start",
      name: "A new book, nothing scripted",
      blurb:
        "Letters from the Drowned City as it looks just after import: chapters to pick over, no script, no cast but the Narrator.",
      bookId: "drowned",
      path: "/book/drowned/scripting",
    },
    {
      id: "resume-book",
      group: "start",
      name: "A book part-way through",
      blurb:
        "The Cliché Cultivation World: 12 chapters scripted, 3 narrated, one failed and one unverified — and three chapters scripting as you arrive.",
      bookId: "cliche",
      path: "/book/cliche",
      runs: [{ kind: "scripting", chapterIds: [13, 14, 15] }],
    },
    {
      id: "scripting-failed",
      group: "trouble",
      name: "Scripting that failed and was rate-limited",
      blurb:
        "Two chapters kept nothing, the scripting endpoint is in a 429 cooldown, and the queue has the rows to retry.",
      bookId: "drowned",
      path: "/queue",
    },
    {
      id: "narration-failed",
      group: "trouble",
      name: "Narration that failed and was rate-limited",
      blurb:
        "One chapter with failed clips, another only part rendered, and the speech endpoint backing off after a 429.",
      bookId: "cliche",
      path: "/book/cliche/narration?ch=4",
    },
    {
      id: "no-voices",
      group: "blocked",
      name: "Speakers with no voice",
      blurb:
        "The Narrator and two speakers unassigned, one pointing at a voice that no longer exists and one at a paused endpoint.",
      bookId: "cliche",
      path: "/book/cliche/cast",
    },
    {
      id: "budget-spent",
      group: "blocked",
      name: "The budget is spent",
      blurb:
        "The book's cap and its scripting budget are used up, so every estimate reports a blocker instead of starting.",
      bookId: "cliche",
      path: "/book/cliche/narration",
    },
    {
      id: "stale-audio",
      group: "review",
      name: "Edited script, stale audio, retakes to compare",
      blurb:
        "Lines edited after narration, clips that no longer match them, flagged audio and second takes waiting beside the first.",
      bookId: "starforge",
      path: "/book/starforge/narration?ch=1",
    },
    {
      id: "expressions",
      group: "review",
      name: "Expressions placed in a line",
      blurb:
        "Ashes of the Starforge, chapter 1: a sigh and a softer delivery placed on the Captain’s line, and a laugh on the next line whose position needs a look after an edit. The reader opens on the line.",
      bookId: "starforge",
      path: "/book/starforge/scripting?ch=1",
    },
    {
      id: "mis-attributed",
      group: "review",
      name: "One speaker mis-attributed all through",
      blurb:
        "An alias the model invented, scattered through the book, with the Search page open on the matches to fix in bulk.",
      bookId: "cliche",
      path: "/book/cliche/search",
    },
    // the Export rows keep their own wording, so the page's own Demo chip and this panel agree
    ...exportScenarios().map((s): DemoScenario => ({
      id: s.id,
      group: "export",
      name: s.label,
      blurb: s.hint,
      bookId: s.bookId,
      path: `/book/${s.bookId}/export`,
    })),
  ];
}

export const demoScenario = (id: string): DemoScenario | undefined =>
  demoScenarios().find((s) => s.id === id);
