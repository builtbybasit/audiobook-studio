// Resets the demo, optionally into a situation: wipe everything, seed again. The queue is stopped
// first (aborting and awaiting the running job), so nothing from the old world is written after the
// wipe or runs again; the seed's live part starts last, on the running queue.
import { is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { rm } from "node:fs/promises";

import type { DemoScenario } from "@/types";
import type { Db } from "~/db/client";
import * as schema from "~/db/schema";
import type { DemoLive } from "~/demo/live";
import { seedDemo, type Seeding } from "~/demo/seed";
import type { Runner } from "~/jobs/runner";
import type { SpeechGate } from "~/providers/gate";
import type { Reset } from "~/routes/demo";
import type { VoiceFiles } from "~/voices/files";

/** Read off the schema, so a table added later is emptied too. */
const TABLES = Object.values(schema as Record<string, unknown>).filter((t): t is SQLiteTable =>
  is(t, SQLiteTable),
);

/** Empties every table but the migrations' record, in one transaction. */
export function wipe(db: Db): void {
  db.transaction((tx) => {
    // schema order mixes parents and children, so foreign keys are checked only at commit
    tx.run(sql`PRAGMA defer_foreign_keys = ON`);
    for (const table of TABLES) tx.delete(table).run();
  });
}

export interface DemoParts {
  db: Db;
  runner: Runner;
  gate: SpeechGate;
  voiceFiles: VoiceFiles;
  base: string;
  /** removed whole */
  dirs: readonly string[];
  /** `startLive` */
  live: (live: DemoLive) => Promise<void>;
  /** `SeedOptions.still` */
  still?: boolean;
}

/** Resets run one at a time: a second waits for the first. */
export function demoReset({
  db,
  runner,
  gate,
  voiceFiles,
  base,
  dirs,
  live,
  still,
}: DemoParts): Reset {
  async function rebuild(scenario?: DemoScenario): Promise<Seeding> {
    await runner.stop();
    let seeding: Seeding;
    try {
      wipe(db);
      await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
      seeding = seedDemo(db, voiceFiles, { base, now: Date.now(), scenario, still });
      // the endpoints were replaced, so the gate rereads its limits
      gate.changed();
    } finally {
      runner.start();
    }
    await live(seeding.live);
    return seeding;
  }
  let last: Promise<unknown> = Promise.resolve();
  return (scenario) => {
    const turn = last.then(() => rebuild(scenario));
    last = turn.catch(() => undefined);
    return turn;
  };
}
