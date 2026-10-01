// A chapter cut into the requests its scripting profile allows. A run cuts it this way when it is
// priced and again when it is sent (`server/jobs/scripting.ts`), and a prompt trial cuts it the same
// way so that its part 3 is a run's part 3 (`trial.ts`).
import type { Profile } from "@/types";
import { scriptParts } from "@/lib/scripting";

/**
 * The chapter cut into the requests its profile allows, exactly as the Endpoints page previews
 * them: `scriptParts` is the demo's own call, with the source's whitespace kept so the pieces
 * rejoin to the chapter. No profile, or a limit of 0, is the chapter whole.
 */
export function chunksOf(text: string, profile: Profile | undefined): string[] {
  const parts = profile ? scriptParts(text, profile) : [];
  return parts.length ? parts : [text];
}

/** About how much of the text before a request is sent with it as context. */
const BEFORE_MAX = 800;

/**
 * The end of the chunk before chunk `i`, for `{{excerpt.before}}`: its last paragraphs, as many as
 * fit in `BEFORE_MAX` characters, and at least the tail of the last one. "" for the first chunk,
 * whose context is the previous chapter's recap. A chunk's requests run side by side, so this is
 * the prose, not the script that chunk will come back as.
 */
export function beforeOf(chunks: readonly string[], i: number): string {
  if (i <= 0 || i > chunks.length) return "";
  const paragraphs = chunks[i - 1]
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const kept: string[] = [];
  let size = 0;
  for (const p of paragraphs.reverse()) {
    if (kept.length && size + p.length > BEFORE_MAX) break;
    kept.unshift(p);
    size += p.length;
  }
  const [first = ""] = kept;
  if (first.length > BEFORE_MAX) {
    const tail = first.slice(-BEFORE_MAX);
    kept[0] = `…${tail.slice(tail.indexOf(" ") + 1)}`;
  }
  return kept.join("\n");
}
