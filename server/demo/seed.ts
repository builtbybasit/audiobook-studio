// What the demo library starts with, and goes back to on a reset or a situation.
//
// The world the browser's demo shows (`makeWorld()`, written by `demo/world.ts`): its books, casts,
// scripts and clips, exports and the queue's history from earlier today, and its endpoints — every
// one simulated, so nothing in the demo reaches the network or is billed. A Demo tools situation is
// applied to that world before any of it is written (`demo/situations.ts`), so a situation is a
// seed like any other rather than a set of changes made to a demo already running. Beside them, the
// Simulated speech endpoint and the Simulated scripting profile, so the preset a person would pick
// to try a run for nothing is there too. The preset's are the presets' own `apply` — what the
// Endpoints page fills in when the preset is picked — and every endpoint is checked by the schemas
// the save route checks with and saved the way it saves them, so the demo's endpoints are ones a
// person could have made.
//
// All of it is one transaction: a seed is some thirteen thousand rows, which a file database would
// otherwise commit one at a time, and a seed that stopped halfway would leave a demo that is
// neither fresh nor whole.
import * as v from "valibot";

import { presetById, scriptingPresetById, type Preset } from "@/lib/presets";
import { newProfile } from "@/lib/scripting";
import type { DemoResult, DemoScenario } from "@/types";
import type { Db } from "~/db/client";
import { books, endpoints } from "~/db/schema";
import type { DemoLive } from "~/demo/live";
import { situate } from "~/demo/situations";
import { writeWorld, worldEndpoints } from "~/demo/world";
import { saveEndpoints } from "~/endpoints/ops";
import { EndpointSchema, ProfileSchema } from "~/lib/schemas";
import type { VoiceFiles } from "~/voices/files";

/** What a seed put in, by id, for the reset's answer and the boot log. */
export interface Seeded {
  endpoints: string[];
  profiles: string[];
  books: string[];
}

/** The id the Simulated endpoint and the Simulated profile are both kept under. */
export const SIMULATED_ID = "simulated";

/** A preset's fields, as a copy the seed can hand on without sharing the catalogue's objects. */
function applied<T>(preset: Preset<T> | undefined): Partial<T> {
  if (!preset) throw new Error("The Simulated preset the demo is seeded from is missing");
  return structuredClone(preset.apply);
}

const speechEndpoint = () =>
  v.parse(EndpointSchema, {
    id: SIMULATED_ID,
    enabled: true,
    ...applied(presetById("simulated")),
  });

const scriptingProfile = () =>
  v.parse(
    ProfileSchema,
    newProfile({ ...applied(scriptingPresetById("simulated")), id: SIMULATED_ID }),
  );

/** A library nobody has used yet: no endpoint of either kind, and no book. */
export function isFresh(db: Db): boolean {
  return !db.select().from(endpoints).get() && !db.select().from(books).get();
}

export interface SeedOptions {
  /** the demo's API base, which its clips' urls are under */
  base: string;
  /** the moment the world is seeded at: every date in it, and every date a situation sets */
  now: number;
  /** the Demo tools row to apply to the world before it is written */
  scenario?: DemoScenario;
}

export interface Seeding {
  seeded: Seeded;
  /** what is left for `startLive` once the queue is running: runs, builds, endpoints' trouble */
  live: DemoLive;
  /** what the situation did, or null for the world as it is seeded */
  result: DemoResult | null;
}

/** Put the demo's world and endpoints into a library with none, with the situation applied. */
export function seedDemo(
  db: Db,
  voiceFiles: VoiceFiles,
  { base, now, scenario }: SeedOptions,
): Seeding {
  const { demo, live, result } = situate(now, scenario);
  const own = worldEndpoints(demo.world);
  const config = {
    // the world's own first, in its order, as the browser's demo lists them
    endpoints: [...own.endpoints.map((e) => v.parse(EndpointSchema, e)), speechEndpoint()],
    profiles: [...own.profiles.map((p) => v.parse(ProfileSchema, p)), scriptingProfile()],
    credentials: own.credentials,
  };

  db.transaction((tx) => {
    saveEndpoints(tx, config, voiceFiles);
    writeWorld(tx, demo, { base, now });
  });

  return {
    seeded: {
      endpoints: config.endpoints.map((e) => e.id),
      profiles: config.profiles.map((p) => p.id),
      books: demo.world.books.map((b) => b.id),
    },
    live,
    result,
  };
}
