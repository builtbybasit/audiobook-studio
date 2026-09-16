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
export { BOOK_SEEDS, MINOR_LINES, bookSeed } from "@/mock/fixtures/books";
export type { BookSeed, CastSeed } from "@/mock/fixtures/books";
export { DIRECTIONS, PALETTE } from "@/mock/fixtures/style";
export {
  AZURE_VOICES,
  DISCOVERABLE_VOICES,
  FISH_MODELS,
  KOKORO_VOICES,
  OPENAI_VOICES,
  voiceRef,
} from "@/mock/fixtures/voices";
export { EXPRESSION_TAGS, makeEndpoints } from "@/mock/fixtures/endpoints";
export { makeProfiles, makeScriptSettings } from "@/mock/fixtures/profiles";
export { makeLexicon } from "@/mock/fixtures/lexicon";
export { makeJobHistory } from "@/mock/fixtures/jobs";
export { REQUEST_ERRORS } from "@/mock/fixtures/errors";
export { NOTICES, noteOf, noticeBody, noticeTitle } from "@/mock/fixtures/notices";
export {
  IMPORT_SAMPLES,
  importSample,
  sampleForFile,
  type ImportSample,
} from "@/mock/fixtures/imports";
export { SHELF_BOOKS, type ShelfBook, type ShelfState } from "@/mock/fixtures/shelf";

// the world
export { makeWorld } from "@/mock/world";
export { makeVolumes, makeChapters, volumesOfSeed } from "@/mock/world/chapters";
export { importedBook, importedVolume, type ImportedBook } from "@/mock/world/imports";
export { chapterParts, partsText, type ContentPart } from "@/mock/world/text";
export { generateSegments } from "@/mock/world/script";
export { makeCharacters, newSpeaker } from "@/mock/world/cast";
export { routeOf, seedClip, timeOf, type ClipWorld } from "@/mock/world/audio";

// helpers the simulators share
export { rnd, rng, pick } from "@/mock/random";
export type { Rng } from "@/mock/random";

// demo scenarios — seeded situations a page can be dropped into
export {
  applySearchDemo,
  searchDemoTarget,
  searchScenarios,
  type SearchDemoResult,
  type SearchDemoTarget,
} from "@/mock/scenarios/search";
export {
  SEEDED_KEYS,
  STARTUP_DELAY_MS,
  startupRuns,
  type StartupRun,
} from "@/mock/scenarios/startup";
export {
  exportDemoPrep,
  exportScenarios,
  freshenChapters,
  type ExportDemoPrep,
} from "@/mock/scenarios/export";
export { DEMO_GROUPS, demoScenario, demoScenarios } from "@/mock/scenarios/catalogue";
export { applySituation, type HistoryRow, type ScenarioContext } from "@/mock/scenarios/situations";

// simulators — the timer-driven fakes that stand in for the endpoints
export { discoverVoices, voicesUrl } from "@/mock/simulators/voices";
export { runBuild, failBuild, type BuildSimContext } from "@/mock/simulators/build";
export { dispatchNarration, type NarrationSimContext } from "@/mock/simulators/narration";
export {
  collapseChunk,
  reseg,
  simulateScriptRun,
  type ScriptRun,
  type ScriptSimContext,
} from "@/mock/simulators/scripting";
export type { SimulatorContext } from "@/mock/simulators/context";
export { SPEEDS, clock, simMs } from "@/mock/simulators/clock";
