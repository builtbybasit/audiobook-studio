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
