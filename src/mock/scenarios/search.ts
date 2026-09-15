// A seeded situation for the Search page's bulk corrections: one character's alias scattered
// through the book as if the model had mis-attributed it, a few flagged lines, and clips in all
// three states.
//
// `applySearchDemo` mutates the book it is handed and reports what it did; the caller took a
// snapshot first and puts the book back with it, so seeding one scenario can never be observed by
// the next. Nothing persists.
import { newSpeaker } from "../world/cast";
import type { Chapter, Character, SearchScenario, Segment } from "@/types";

/** The character an alias is scattered from, and the alias itself. */
export interface SearchDemoTarget {
  main: string;
  alias: string;
}

/** Null when the book has nothing scripted to scatter an alias through. */
export function searchDemoTarget(cast: Character[]): SearchDemoTarget | null {
  const main =
    cast.find((c) => c.major && c.name !== "Narrator" && c.aliases.length) ??
    cast.find((c) => c.major && c.name !== "Narrator");
  if (!main) return null;
  return { main: main.name, alias: main.aliases[0] ?? main.name.split(" ").at(-1)! };
}

/** Fresh rows every call — the page renders these, it never holds on to them. */
export function searchScenarios(d: SearchDemoTarget): SearchScenario[] {
  return [
    {
      id: "alias",
      label: `Mis-attributed “${d.alias}”`,
      hint: "Matches in every chapter — more than one page of them — mixed speakers and directions, clips rendered, stale and not yet rendered, and a few already flagged.",
      query: d.alias,
      speaker: "",
      type: "all",
    },
    {
      id: "settled",
      label: `Lines already read by ${d.main}`,
      hint: `Filtered to ${d.main}, so “Change speaker to ${d.main}” has nothing left to change.`,
      query: d.alias,
      speaker: d.main,
      type: "all",
    },
    {
      id: "empty",
      label: "No results",
      hint: "A term this book never uses.",
      query: "orbital docking clamp",
      speaker: "",
      type: "all",
    },
  ];
}

/** What the seeding did, for the toast that reports it. */
export interface SearchDemoResult {
  moved: number;
  flagged: number;
  staled: number;
  cleared: number;
}

export function applySearchDemo(
  target: SearchDemoTarget,
  cast: Character[],
  scripted: Chapter[],
  segmentsOf: (chId: number) => Segment[],
): SearchDemoResult {
  const { main, alias } = target;
  // the alias is a speaker of its own, with no voice — exactly what a re-script leaves behind
  if (!cast.some((c) => c.name === alias)) cast.push(newSpeaker(alias, cast.length));
  let moved = 0;
  let flagged = 0;
  let staled = 0;
  let cleared = 0;
  for (const [i, c] of scripted.entries()) {
    const segs = segmentsOf(c.id);
    // every other chapter contributes mis-attributed lines, so matches span the whole book
    if (i % 2 === 1) {
      const his = segs.filter((x) => x.speaker === main);
      for (const [j, s] of his.entries())
        if (moved < 16 && j % 2 === 0) {
          s.speaker = alias;
          moved++;
        }
    }
    for (const s of segs) {
      const hit = s.speaker.includes(alias) || s.text.includes(alias);
      if (!hit) continue;
      // already-flagged lines to explain "existing flags are kept"
      if (s.audio.status === "done" && flagged < 3 && !s.flag) {
        s.flag = {
          kind: flagged === 0 ? "delivery" : "pronunciation",
          note: flagged === 0 ? "flat — the line should land" : `“${alias}” is read as two words`,
          at: Date.now() - (40 + flagged * 7) * 60000,
        };
        flagged++;
        continue;
      }
      // and clips in every state: rendered, already stale, never rendered
      if (s.audio.status === "done" && staled < 4 && s.id % 5 === 2) {
        s.audio.status = "stale";
        if (c.narration === "done") c.narration = "stale";
        staled++;
        continue;
      }
      if (s.direction && cleared < 6 && s.id % 4 === 1) {
        s.direction = "";
        cleared++;
      }
    }
  }
  return { moved, flagged, staled, cleared };
}
