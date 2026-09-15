// One pristine fixture graph per Pinia instance. Stores receive independent owned slices,
// so initialization order and resets cannot seed conflicting worlds or share mutable state.
import { clone } from "@/lib/utils";
import { makeWorld } from "@/mock";
import type { World } from "@/types";
import type { Pinia } from "pinia";
import { getActivePinia } from "pinia";
const seeds = new WeakMap<Pinia, World>();
export function seedState<K extends keyof World>(...keys: K[]): Pick<World, K> {
  const pinia = getActivePinia();
  if (!pinia) throw new Error("Initialize Pinia before creating application stores.");
  let world = seeds.get(pinia);
  if (!world) {
    world = makeWorld();
    seeds.set(pinia, world);
  }
  const result = {} as Pick<World, K>;
  for (const key of keys) result[key] = clone(world[key]);
  return result;
}
