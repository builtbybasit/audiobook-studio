// Seeds the demo library: the world (`demo/world.ts`) with any situation applied first, plus the
// Simulated endpoint and profile from their presets. Endpoints pass the save route's schemas.
// One transaction: ~13k rows, and a half-written seed would leave a broken demo.
import * as v from "valibot";

import { presetById, scriptingPresetById, type Preset } from "@/lib/presets";
import { makeScriptSettings, newProfile } from "@/lib/scripting";
import type { DemoResult, DemoScenario } from "@/types";
import type { Db } from "~/db/client";
import { seedEffects } from "~/db/effects";
import { books, endpoints } from "~/db/schema";
import { writeScriptSettings } from "~/db/settings";
import type { DemoLive } from "~/demo/live";
import { situate } from "~/demo/situations";
import { writeWorld, worldEndpoints } from "~/demo/world";
import { saveEndpoints } from "~/endpoints/ops";
import { EndpointSchema, ProfileSchema } from "~/lib/schemas";
import type { VoiceFiles } from "~/voices/files";

/** Ids seeded, for the reset's answer and the boot log. */
export interface Seeded {
  endpoints: string[];
  profiles: string[];
  books: string[];
}

export const SIMULATED_ID = "simulated";

/** A copy, so the seed never shares the catalogue's objects. */
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

/** No endpoint of either kind, and no book. */
export function isFresh(db: Db): boolean {
  return !db.select().from(endpoints).get() && !db.select().from(books).get();
}

export interface SeedOptions {
  base: string;
  /** every date in the world is relative to this */
  now: number;
  scenario?: DemoScenario;
  /** no startup runs, for a test that reasons about the queue */
  still?: boolean;
}

export interface Seeding {
  seeded: Seeded;
  /** for `startLive` once the queue runs */
  live: DemoLive;
  /** null without a situation */
  result: DemoResult | null;
}

export function seedDemo(
  db: Db,
  voiceFiles: VoiceFiles,
  { base, now, scenario, still }: SeedOptions,
): Seeding {
  const { demo, live, result } = situate(now, scenario, still);
  const own = worldEndpoints(demo.world);
  const config = {
    // the world's own first, in order
    endpoints: [...own.endpoints.map((e) => v.parse(EndpointSchema, e)), speechEndpoint()],
    profiles: [...own.profiles.map((p) => v.parse(ProfileSchema, p)), scriptingProfile()],
    credentials: own.credentials,
  };

  db.transaction((tx) => {
    saveEndpoints(tx, config, voiceFiles);
    writeScriptSettings(tx, { ...makeScriptSettings(), profile: config.profiles[0].id });
    // a reset empties every table, including the effects a migration seeded
    seedEffects(tx);
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
