// Where a persona's row goes in the Cast table: right under its character's, whatever the order
// and filter put the rest in. Nothing here reads a store.
import { personaOwner } from "@/lib/cast";
import type { Character } from "@/types";

type Speaker = Pick<Character, "name" | "personaOf" | "masked">;

/**
 * The rows as sorted and filtered, with each linked persona moved to sit under its character, in
 * the order the personas came; `nested` marks the ones that moved. A persona whose character is
 * not among the rows (a search found only the persona) keeps its own place, unnested, and so does
 * one the scripting model linked (`masked`): a row under Sunny's would say who wears the mask.
 * `cast` is the whole book's, so a link is the one `personaOwner` reads, filtered or not.
 */
export function nestPersonas<R extends { c: Speaker }>(
  rows: readonly R[],
  cast: Pick<ReadonlyMap<string, Speaker>, "get">,
): (R & { nested: boolean })[] {
  const shown = new Map(rows.map((r) => [r.c.name, r]));
  const under = new Map<string, R[]>();
  for (const r of rows) {
    const owner = r.c.masked ? undefined : personaOwner(r.c, cast);
    // one level only: a character who is a persona themselves takes nobody under them
    if (!owner || !shown.has(owner.name) || personaOwner(owner, cast)) continue;
    const list = under.get(owner.name);
    if (list) list.push(r);
    else under.set(owner.name, [r]);
  }
  const moved = new Set([...under.values()].flat());
  const out: (R & { nested: boolean })[] = [];
  for (const r of rows) {
    if (moved.has(r)) continue;
    out.push({ ...r, nested: false });
    for (const p of under.get(r.c.name) ?? []) out.push({ ...p, nested: true });
  }
  return out;
}
