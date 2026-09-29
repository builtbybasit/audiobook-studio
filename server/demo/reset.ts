// Putting the demo back the way it started: everything it holds gone, and the seed laid down again.
//
// Only the demo library is given this (`server/libraries.ts`), and it is given the demo's own
// database, queue and folders — there is nothing here that could name the real library's.
//
// The queue is stopped first and started again last. A stop aborts the job that is running and
// waits for its handler to come back, so nothing from the old world is still being written when
// the rows go; the job it hands back to the queue is one of those rows, so nothing from the old
// world runs again in the new one either.
import { is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { rm } from "node:fs/promises";

import type { Db } from "~/db/client";
import * as schema from "~/db/schema";
import { seedDemo, type Seeded } from "~/demo/seed";
import type { Runner } from "~/jobs/runner";
import type { SpeechGate } from "~/providers/gate";
import type { Reset } from "~/routes/demo";
import type { VoiceFiles } from "~/voices/files";

/** Every table the schema declares, read off it so a table added later is emptied too. */
const TABLES = Object.values(schema as Record<string, unknown>).filter((t): t is SQLiteTable =>
  is(t, SQLiteTable),
);

/** Every row of every table, gone in one transaction. The migrations' own record is not one. */
export function wipe(db: Db): void {
  db.transaction((tx) => {
    // The tables go in the order the schema lists them, parents and children mixed; deferred, the
    // foreign keys are only asked at the commit, when there is nothing left for one to point at.
    tx.run(sql`PRAGMA defer_foreign_keys = ON`);
    for (const table of TABLES) tx.delete(table).run();
  });
}

export interface DemoParts {
  db: Db;
  runner: Runner;
  gate: SpeechGate;
  voiceFiles: VoiceFiles;
  /** the demo's API base, which the seed writes its clips' urls under */
  base: string;
  /** the demo's folders — its clips, its audiobooks, its voices' recordings — removed whole */
  dirs: readonly string[];
}

/** The demo's reset, one at a time: a second asked for while one runs waits for it, then runs. */
export function demoReset({ db, runner, gate, voiceFiles, base, dirs }: DemoParts): Reset {
  async function rebuild(): Promise<Seeded> {
    await runner.stop();
    try {
      wipe(db);
      await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
      const seeded = seedDemo(db, voiceFiles, { base });
      // the endpoints were replaced, as a save replaces them; the gate reads its limits again
      gate.changed();
      return seeded;
    } finally {
      runner.start();
    }
  }
  let last: Promise<unknown> = Promise.resolve();
  return () => {
    const turn = last.then(rebuild);
    last = turn.catch(() => undefined);
    return turn;
  };
}
