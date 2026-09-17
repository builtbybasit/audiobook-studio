// One pristine fixture graph per Pinia instance. Stores receive independent owned slices,
// so initialization order and resets cannot seed conflicting worlds or share mutable state.
import { clone } from "@/lib/utils";
import { makeWorld } from "@/mock";
import type { World } from "@/types";
import type { Pinia } from "pinia";
import { getActivePinia } from "pinia";
const seeds = new WeakMap<Pinia, World>();
function pristine(): World {
  const pinia = getActivePinia();
  if (!pinia) throw new Error("Initialize Pinia before creating application stores.");
  let world = seeds.get(pinia);
  if (!world) {
    world = makeWorld();
    seeds.set(pinia, world);
  }
  return world;
}

export function seedState<K extends keyof World>(...keys: K[]): Pick<World, K> {
  const world = pristine();
  const result = {} as Pick<World, K>;
  for (const key of keys) result[key] = clone(world[key]);
  return result;
}

/**
 * Read a figure off the pristine world without taking a copy of it.
 *
 * For a store that needs to know something *about* the seeded world rather than to own a slice of
 * it — what its narration had already cost, say. `read` must only aggregate: what it is handed is
 * the shared pristine graph, and writing to it would leak into the next `$reset()`.
 */
export function seedRead<T>(read: (world: World) => T): T {
  return read(pristine());
}
