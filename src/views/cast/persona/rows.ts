// Where a persona's row goes in the Cast table: right under its character's.
import { personaOwner } from "@/lib/cast";
import type { Character } from "@/types";

type Speaker = Pick<Character, "name" | "personaOf" | "masked">;

/**
 * Each linked persona moved under its character; `nested` marks the moved ones. A persona whose
 * character is filtered out stays put, as does a `masked` one (nesting would spoil the wearer).
 * `cast` is the whole book's, so links resolve whatever the filter.
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
