// Seeded situations for trying a build end to end. Like the Search demo, seeding mutates the open
// book in memory and the caller keeps the snapshot that puts it back — so running one scenario and
// then another starts each from the book as it really is, never from the last scenario's leftovers.
import type { Chapter, ExportScenario, Segment } from "@/types";

/** Fresh rows every call. */
export function exportScenarios(): ExportScenario[] {
  return [
    {
      id: "ready",
      label: "A book ready to export",
      hint: "Ashes of the Starforge — every chapter narrated, one volume.",
      bookId: "starforge",
    },
    {
      id: "mixed",
      label: "Ready, missing and stale together",
      hint: "The Cliché Cultivation World — three volumes, gaps and stale clips in the middle.",
      bookId: "cliche",
    },
    {
      id: "long",
      label: "A long book: 214 chapters, 6 volumes",
      hint: "Thousand Gates of the Ninth Heaven — the list, the plan and the file names at scale.",
      bookId: "gates",
    },
    {
      id: "update",
      label: "An export that needs updating",
      hint: "Thousand Gates v2 — chapters narrated and re-narrated since the last build.",
      bookId: "gates",
    },
    {
      id: "builds",
      label: "Running, failed and finished builds",
      hint: "Starts a build, and seeds one that failed and one that finished.",
      bookId: "starforge",
    },
  ];
}

/** What each scenario needs doing to the book, beyond what the seeded world already has. */
export interface ExportDemoPrep {
  /** bring every chapter up to date and start with no exports at all */
  freshen: boolean;
  /** drop this book's finished exports, so the list starts empty */
  clearExports: boolean;
  /** seed a running build, a failed one and a finished one */
  buildHistory: boolean;
  /** the line the toast reports */
  note: string;
}

export function exportDemoPrep(id: string): ExportDemoPrep {
  switch (id) {
    case "ready":
      return {
        freshen: true,
        clearExports: true,
        buildHistory: false,
        note: "Every chapter is narrated and current, and nothing has been exported yet.",
      };
    case "mixed":
      return {
        freshen: false,
        clearExports: false,
        buildHistory: false,
        note: "Chapters 1–3 are narrated, ch 2 is stale, ch 4 failed, and 13–24 have no audio.",
      };
    case "long":
      return {
        freshen: false,
        clearExports: true,
        buildHistory: false,
        note: "214 chapters across 6 volumes, with a scattering of gaps and stale clips.",
      };
    case "update":
      return {
        freshen: false,
        clearExports: false,
        buildHistory: false,
        note: "The v2 export is missing 9 chapters narrated since, and 4 of its own have changed.",
      };
    case "builds":
      return {
        freshen: false,
        clearExports: false,
        buildHistory: true,
        note: "One build is running, one failed and is waiting for a retry, one finished.",
      };
    default:
      return { freshen: false, clearExports: false, buildHistory: false, note: "" };
  }
}

/** Bring every chapter of the book up to date: stale clips become current, retakes are dropped. */
export function freshenChapters(
  chapters: Chapter[],
  segmentsOf: (chId: number) => Segment[],
): void {
  for (const c of chapters) {
    if (c.narration === "stale") c.narration = "done";
    for (const s of segmentsOf(c.id)) {
      if (s.audio.status === "stale") s.audio.status = "done";
      delete s.candidate;
    }
  }
}
