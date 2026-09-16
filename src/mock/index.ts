// PROTOTYPE — the mock world. Nothing here is fetched or persisted.
//
// `fixtures/` is hand-authored source data, `world/` expands it into the entities the app works on,
// `scenarios/` are the seeded situations the demo buttons drop you into, and `simulators/` are the
// timer-driven fakes that stand in for the endpoints a real build would call. Fixture generation
// and simulated execution are deliberately kept apart: a fixture never starts a timer, and a
// simulator never invents data a fixture could have provided.
//
// This barrel is what the rest of the app imports — `@/mock` — so the layout above can change
// without touching the store or the views.

// fixtures
export { BOOK_SEEDS, MINOR_LINES, bookSeed } from "./fixtures/books";
export type { BookSeed, CastSeed } from "./fixtures/books";
export { DIRECTIONS, PALETTE } from "./fixtures/style";
export {
  AZURE_VOICES,
  DISCOVERABLE_VOICES,
  FISH_MODELS,
  KOKORO_VOICES,
  OPENAI_VOICES,
  voiceRef,
} from "./fixtures/voices";
export { makeEndpoints } from "./fixtures/endpoints";
export { makeProfiles, makeScriptSettings } from "./fixtures/profiles";
export { makeLexicon } from "./fixtures/lexicon";
export { makeJobHistory } from "./fixtures/jobs";
export { REQUEST_ERRORS } from "./fixtures/errors";

// the world
export { makeWorld } from "./world";
export { makeVolumes, makeChapters, volumesOfSeed, importedChapterCount } from "./world/chapters";
export { generateSegments } from "./world/script";
export { makeCharacters, newSpeaker } from "./world/cast";
export { routeOf, seedClip, timeOf, type ClipWorld } from "./world/audio";

// helpers the simulators share
export { rnd, rng, pick } from "./random";
export type { Rng } from "./random";

// demo scenarios — seeded situations a page can be dropped into
export {
  applySearchDemo,
  searchDemoTarget,
  searchScenarios,
  type SearchDemoResult,
  type SearchDemoTarget,
} from "./scenarios/search";
export { SEEDED_KEYS, STARTUP_DELAY_MS, startupRuns, type StartupRun } from "./scenarios/startup";
export {
  exportDemoPrep,
  exportScenarios,
  freshenChapters,
  type ExportDemoPrep,
} from "./scenarios/export";
export { DEMO_GROUPS, demoScenario, demoScenarios } from "./scenarios/catalogue";
export { applySituation, type HistoryRow, type ScenarioContext } from "./scenarios/situations";

// simulators — the timer-driven fakes that stand in for the endpoints
export { discoverVoices, voicesUrl } from "./simulators/voices";
export { runBuild, failBuild, type BuildSimContext } from "./simulators/build";
export { dispatchNarration, type NarrationSimContext } from "./simulators/narration";
export {
  collapseChunk,
  reseg,
  simulateScriptRun,
  type ScriptRun,
  type ScriptSimContext,
} from "./simulators/scripting";
export type { SimulatorContext } from "./simulators/context";
