// Applies a Demo tools situation (`applySituation`) through a `ScenarioContext` over plain data.
// Writes nothing: `seed.ts` writes the rows and `startLive` starts what is not a row. With no
// situation, `startupRuns` set a few runs going so the demo looks alive.
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

const FIRST_JOB = 100;

export interface Situated {
  demo: DemoWorld;
  live: DemoLive;
  /** null without a situation */
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

/** The seeded world with `scenario` applied; dates are relative to `now`, so cooldowns are new. */
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
  // every endpoint, touched or not: seeded ones have a history of their own
  live.speech = Object.fromEntries(world.endpoints.map((e) => [e.id, telemetryOf(e)]));
  return { demo, live, result };
}

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
    // started by `startLive`, once the book is written
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
