// A Demo tools situation, applied on the server.
//
// A situation (`applySituation` in `server/demo/seed/scenarios/situations.ts`) is applied through a
// `ScenarioContext`. Here that is a context over plain data: the seeded world, and beside it what a
// situation reaches for that the world does not hold — the queue's history, the histories of
// chapters' scripts, scripting a book had already paid for, and what the endpoints have been
// through. Every method does what the browser's demo store did when the browser applied them, with
// the browser's own helpers where the store had one, so a situation leaves the demo as it always
// did (`tests/server/demoSituations.test.ts` applies every one; `demoWorld.test.ts` holds the
// seeded world to `makeWorld()`, and `demoLive.test.ts` what is set going).
//
// The world as it is seeded, with no situation, is not still: a few runs are set going on it
// (`startupRuns`), so the Queue, the job indicator and the endpoints' activity are alive the first
// time anyone looks. A situation sets going only what it describes.
//
// Nothing is written here. What comes back is handed to the seed (`seed.ts`), which writes the rows
// in one transaction, and to `startLive`, which makes real what is not a row: runs in flight,
// builds, and the endpoints' recent trouble.
import { chapterStates } from "@/lib/exports";
import { seededHistory } from "@/lib/scriptHistory";
import { key } from "@/lib/scriptReview";
import { unusedTelemetry } from "@/lib/scripting";
import { chapterSeconds, pacingOrDefault } from "@/lib/speech";
import { makeJobHistory } from "~/demo/seed/fixtures/jobs";
import { startupRuns } from "~/demo/seed/scenarios/startup";
import {
  applySituation,
  historyJob,
  openingScriptSpend,
  type ScenarioContext,
} from "~/demo/seed/scenarios/situations";
import { makeWorld } from "~/demo/seed/world";
import { finishedExport } from "~/demo/seed/world/exports";
import { importInto, shelveInto } from "~/demo/seed/world/imports";
import type { DemoResult, DemoScenario, Endpoint } from "@/types";
import type { DemoLive, SpeechTelemetry } from "~/demo/live";
import { openingOf, type DemoWorld } from "~/demo/world";

/** The first id of the queue's history, as the browser's demo numbers its own. */
const FIRST_JOB = 100;

/** A world, seeded and with a situation applied, ready to be written and set going. */
export interface Situated {
  demo: DemoWorld;
  live: DemoLive;
  /** what the situation did, or null for the world as it is seeded */
  result: DemoResult | null;
}

const telemetryOf = ({
  history,
  failures,
  rateLimits,
  backoffUntil,
  lastError,
}: Endpoint): SpeechTelemetry => ({
  history,
  failures,
  rateLimits,
  backoffUntil,
  ...(lastError ? { lastError } : {}),
});

/**
 * The seeded world at `now`, with `scenario` applied to it when there is one. Every date the world
 * and the situation take from the clock is `now`, so a cooldown or a closing rate window is as
 * fresh as the request that asked for it. Without a situation the world's startup runs are set
 * going, unless it is to be `still`.
 */
export function situate(now: number, scenario?: DemoScenario, still = false): Situated {
  const world = makeWorld(now);
  let nextJob = FIRST_JOB;
  const demo: DemoWorld = {
    world,
    jobs: makeJobHistory(() => nextJob++, now),
    histories: {},
    requests: [],
    opening: openingOf(world.segments),
  };
  const live: DemoLive = {
    bookId: scenario?.bookId ?? "",
    runs: scenario ? (scenario.runs ?? []) : still ? [] : startupRuns(),
    builds: [],
    speech: {},
    scripting: {},
  };
  const result = scenario
    ? applySituation(
        contextOver(demo, live, now, () => nextJob++),
        scenario.id,
        scenario.bookId,
      )
    : null;
  // what every speech endpoint has been through, whether or not the situation touched it: the
  // seeded world's endpoints have a history of their own
  live.speech = Object.fromEntries(world.endpoints.map((e) => [e.id, telemetryOf(e)]));
  return { demo, live, result };
}

/** `ScenarioContext` as the browser's demo store implemented it, over `demo` and `live`. */
function contextOver(
  demo: DemoWorld,
  live: DemoLive,
  now: number,
  nextJob: () => number,
): ScenarioContext {
  const { world } = demo;
  const book = (bookId: string) => world.books.find((b) => b.id === bookId);
  const chapters = (bookId: string) => world.chapters[bookId] ?? [];
  const segmentsOf = (bookId: string, chId: number) => world.segments[key(bookId, chId)] ?? [];
  const pacingOf = (bookId: string) => pacingOrDefault(book(bookId)?.pacing);
  const nextExport = () => Math.max(0, ...world.exports.map((e) => e.id)) + 1;

  return {
    now: () => now,
    world,
    book,
    chapters,
    cast: (bookId) => world.characters[bookId] ?? [],
    segmentsOf,
    clearScript: (bookId, chId) => {
      delete world.segments[key(bookId, chId)];
      delete demo.histories[key(bookId, chId)];
    },
    seedHistory: (bookId, chId, history) => {
      demo.histories[key(bookId, chId)] = seededHistory(history);
    },
    profiles: () => world.profiles,
    telemetry: (profileId) => (live.scripting[profileId] ??= unusedTelemetry()),
    addHistory: (row) => {
      demo.jobs.push(historyJob(row, nextJob(), now));
    },
    clearJobs: (bookId) => {
      demo.jobs = demo.jobs.filter((j) => j.bookId !== bookId);
    },
    clearExports: (bookId) => {
      world.exports = world.exports.filter((e) => e.bookId !== bookId);
    },
    // the builds are started by `startLive`, against the book as it is written
    seedBuilds: (bookId) => {
      live.builds.push(bookId);
    },
    spent: (bookId) =>
      demo.requests.filter((r) => r.bookId === bookId).reduce((n, r) => n + (r.cost ?? 0), 0) +
      (demo.opening.get(bookId) ?? 0),
    addScriptUsage: (bookId, profileId, cost) => {
      demo.requests.push(
        openingScriptSpend(`opening-${demo.requests.length}`, bookId, profileId, cost, now),
      );
    },
    retime: (bookId, chId) => {
      const c = chapters(bookId).find((x) => x.id === chId);
      if (c) c.duration = chapterSeconds(segmentsOf(bookId, chId), pacingOf(bookId), book(bookId));
    },
    importSample: (sampleId, bookId) => importInto(world, sampleId, { id: bookId }),
    shelveBook: (spec) => shelveInto(world, spec),
    addFinishedExport: (bookId, ids) => {
      const b = book(bookId);
      if (!b) return;
      const state = chapterStates(
        chapters(bookId),
        ids,
        (id) => segmentsOf(bookId, id),
        pacingOf(bookId),
        b,
      );
      world.exports.push(finishedExport(nextExport(), b, chapters(bookId), ids, state));
    },
  };
}
