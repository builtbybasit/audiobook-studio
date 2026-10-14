// A chapter cut into its scripting profile's requests; runs and prompt trials must cut alike.
import type { Profile } from "@/types";
import { scriptParts } from "@/lib/scripting";

/** As the Endpoints page previews it (`scriptParts`). No profile or limit 0: the whole chapter. */
export function chunksOf(text: string, profile: Profile | undefined): string[] {
  const parts = profile ? scriptParts(text, profile) : [];
  return parts.length ? parts : [text];
}

/** Characters of preceding text sent as context. */
const BEFORE_MAX = 800;

/**
 * The end of chunk `i - 1` for `{{excerpt.before}}`: its last paragraphs within `BEFORE_MAX`.
 * Prose, not script, since chunks run side by side. "" for the first chunk (it gets the recap).
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
