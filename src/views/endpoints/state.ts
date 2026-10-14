// Endpoints page state that outlives the route (tab, half-typed forms, activity filters).
// Not domain state, so not in the store: module-scope, keyed by `<kind>:<id>`.
import { reactive } from "vue";
import { opsOf } from "@/lib/endpoints";
import { encodingChanged, repairEncoding } from "@/lib/audioFormat";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import { libraryPrompt } from "@/lib/prompt";
import type {
  ConnectionTest,
  Endpoint,
  EndpointKind,
  Profile,
  ProfilePrompt,
  PromptTemplate,
  RangeKey,
  RequestStatus,
  SpeechServer,
  Transcriber,
} from "@/types";

export type TabId =
  | "overview"
  | "connection"
  | "voices"
  | "requests"
  | "pricing"
  | "activity"
  | "expressions"
  | "prompt";

export const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "connection", label: "Connection" },
  { id: "voices", label: "Voices" },
  { id: "requests", label: "Requests" },
  { id: "prompt", label: "Prompt" },
  { id: "expressions", label: "Expressions" },
  { id: "pricing", label: "Pricing & budgets" },
  { id: "activity", label: "Activity" },
];

/** One list for both the tab triggers and the remembered-tab check, so they can't drift. */
const KIND_TABS: Record<EndpointKind, TabId[]> = {
  scripting: ["overview", "connection", "requests", "prompt", "pricing", "activity"],
  tts: ["overview", "connection", "voices", "requests", "expressions", "pricing", "activity"],
  transcription: ["overview", "connection", "requests", "pricing", "activity"],
};

export const tabsFor = (kind: EndpointKind): { id: TabId; label: string }[] =>
  TABS.filter((t) => KIND_TABS[kind].includes(t.id));

/** Staged, never live-applied: a provider switch must not silently hit a running book. */
export interface ConnectionDraft {
  name: string;
  model: string;
  baseUrl: string;
  needsKey: boolean;
  credentialId: string | null;
  quotaGroup: string;
  /** speech only: the server named for a base URL that cannot say (`Endpoint.server`) */
  server: SpeechServer | null;
  /** a preset's non-connection fields (prices, limits), applied on Save, dropped on Discard */
  preset: StagedPreset | null;
}

/** A preset's other fields, waiting for Save. `fields` is a copy, never the preset's own objects. */
export interface StagedPreset {
  label: string;
  fields: Record<string, unknown>;
}

export interface ActivityFilter {
  status: RequestStatus | "all";
  bookId: string | null;
  search: string;
  /** set by clicking a spike in a chart */
  window: { from: number; to: number } | null;
}

export const newFilter = (): ActivityFilter => ({
  status: "all",
  bookId: null,
  search: "",
  window: null,
});

interface PageState {
  selected: string | null;
  kind: "all" | EndpointKind;
  search: string;
  range: RangeKey;
  metric: "throughput" | "latency" | "spend" | "errors";
  tab: Record<string, TabId>;
  drafts: Record<string, ConnectionDraft>;
  /** prompt drafts by key; absent = the saved one */
  prompts: Record<string, ProfilePrompt>;
  /** null = the saved one */
  libraryPrompt: PromptTemplate | null;
  /** the detail pane shows the library's default prompt rather than the selected endpoint */
  showLibraryPrompt: boolean;
  activity: Record<string, ActivityFilter>;
  tests: Record<string, ConnectionTest>;
}

export const ui = reactive<PageState>({
  selected: null,
  kind: "all",
  search: "",
  range: "24h",
  metric: "throughput",
  tab: {},
  drafts: {},
  prompts: {},
  libraryPrompt: null,
  showLibraryPrompt: false,
  activity: {},
  tests: {},
});

/** The remembered tab, or overview when this kind lacks it. */
export const tabOf = (key: string, kind: EndpointKind = "tts"): TabId => {
  const want = ui.tab[key] ?? "overview";
  return tabsFor(kind).some((t) => t.id === want) ? want : "overview";
};
export const filterOf = (key: string): ActivityFilter => (ui.activity[key] ??= newFilter());

// ---------- connection drafts ----------
// Nothing writes through until `applyDraft`, so a typed base URL can't re-point a running book.

export function draftFor(u: UnifiedEndpoint): ConnectionDraft {
  return (ui.drafts[u.key] ??= {
    name: u.name,
    model: u.model,
    baseUrl: u.baseUrl,
    needsKey: u.needsKey,
    credentialId: opsOf(u).credentialId,
    quotaGroup: opsOf(u).quotaGroup ?? "",
    server: u.endpoint?.server ?? null,
    preset: null,
  });
}

/** Stage a preset on the draft; nothing reaches the endpoint before Save. `fields` must be a copy. */
export function stagePreset(
  u: UnifiedEndpoint,
  label: string,
  fields: Partial<Profile> | Partial<Endpoint> | Partial<Transcriber>,
): void {
  const d = draftFor(u);
  const { name, model, baseUrl, needsKey, ...rest } = fields;
  // a speech preset names its server or none: Kokoro's preset is not left speaking Breeze
  if (u.endpoint) {
    d.server = (rest as Partial<Endpoint>).server ?? null;
    delete (rest as Partial<Endpoint>).server;
  }
  if (name !== undefined) d.name = name;
  if (model !== undefined) d.model = model;
  if (baseUrl !== undefined) d.baseUrl = baseUrl;
  if (needsKey !== undefined) d.needsKey = needsKey;
  d.preset = Object.keys(rest).length ? { label, fields: rest } : null;
}

/** Fields that identify *which provider* this configuration talks to. */
export const PROVIDER_FIELDS: (keyof ConnectionDraft)[] = [
  "baseUrl",
  "model",
  "credentialId",
  "server",
];

export function draftChanges(u: UnifiedEndpoint): (keyof ConnectionDraft)[] {
  const d = draftFor(u);
  const ops = opsOf(u);
  const current: ConnectionDraft = {
    name: u.name,
    model: u.model,
    baseUrl: u.baseUrl,
    needsKey: u.needsKey,
    credentialId: ops.credentialId,
    quotaGroup: ops.quotaGroup ?? "",
    server: u.endpoint?.server ?? null,
    preset: null,
  };
  return (Object.keys(current) as (keyof ConnectionDraft)[]).filter((k) => d[k] !== current[k]);
}

export const draftDirty = (u: UnifiedEndpoint): boolean => draftChanges(u).length > 0;

/**
 * Write the draft (and any staged preset) onto the configuration. A new base URL may not support
 * the current format/rate, so those reset to the provider default in the same write; returns notes.
 */
export function applyDraft(u: UnifiedEndpoint): string[] {
  const d = draftFor(u);
  const target = u.entry as unknown as Record<string, unknown>;
  if (d.preset) Object.assign(target, d.preset.fields);
  // a preset names a server, and one hotword strength is not another server's: Whisper may refuse it
  if (d.preset && u.transcriber && !("hotwordLambda" in d.preset.fields))
    delete u.transcriber.hotwordLambda;
  target.name = d.name.trim();
  target.model = d.model.trim();
  target.baseUrl = d.baseUrl.trim();
  target.needsKey = d.needsKey;
  target.credentialId = d.credentialId;
  target.quotaGroup = d.quotaGroup.trim() || null;
  let notes: string[] = [];
  if (u.endpoint) {
    // before the encoding is held to the formats: Breeze offers no Opus
    if (d.server) u.endpoint.server = d.server;
    else delete u.endpoint.server;
    const r = repairEncoding(u.endpoint);
    if (encodingChanged(u.endpoint, r)) {
      u.endpoint.encoding = r.encoding;
      u.endpoint.sampleRate = r.sampleRate;
    }
    notes = r.notes;
  }
  // Re-seed rather than delete: `draftFor` would rebuild from this render's stale `u` snapshot
  // and show the old values as unsaved changes.
  ui.drafts[u.key] = {
    name: d.name.trim(),
    model: d.model.trim(),
    baseUrl: d.baseUrl.trim(),
    needsKey: d.needsKey,
    credentialId: d.credentialId,
    quotaGroup: d.quotaGroup.trim(),
    server: d.server,
    preset: null,
  };
  return notes;
}

export function discardDraft(u: UnifiedEndpoint): void {
  delete ui.drafts[u.key];
}

// ---------- prompt drafts ----------
// Staged and saved by button: a half-typed prompt is often invalid. A draft exists only once
// something is typed, so a server-side change shows through an untouched editor.

const sameTemplate = (a: PromptTemplate, b: PromptTemplate): boolean =>
  a.system === b.system && a.user === b.user;

/** The saved prompt, with unset fields filled in. */
export const savedProfilePrompt = (p: Profile): ProfilePrompt => ({
  mode: p.prompt?.mode ?? "default",
  system: p.prompt?.system ?? "",
  user: p.prompt?.user ?? "",
  notes: p.prompt?.notes ?? "",
});

/** The draft, or what is saved. */
export const profilePromptOf = (u: UnifiedEndpoint): ProfilePrompt | null =>
  u.profile ? (ui.prompts[u.key] ?? savedProfilePrompt(u.profile)) : null;

export function editProfilePrompt(u: UnifiedEndpoint, change: Partial<ProfilePrompt>): void {
  const cur = profilePromptOf(u);
  if (cur) ui.prompts[u.key] = { ...cur, ...change };
}

export function profilePromptDirty(u: UnifiedEndpoint): boolean {
  const d = ui.prompts[u.key];
  if (!d || !u.profile) return false;
  const saved = savedProfilePrompt(u.profile);
  return d.mode !== saved.mode || d.notes !== saved.notes || !sameTemplate(d, saved);
}

export function discardProfilePrompt(u: UnifiedEndpoint): void {
  delete ui.prompts[u.key];
}

/** The draft, or what is saved (the built-in one for none). */
export const libraryPromptOf = (saved: PromptTemplate | null): PromptTemplate =>
  ui.libraryPrompt ?? libraryPrompt(saved);

export function editLibraryPrompt(saved: PromptTemplate | null, change: Partial<PromptTemplate>) {
  ui.libraryPrompt = { ...libraryPromptOf(saved), ...change };
}

export const libraryPromptDirty = (saved: PromptTemplate | null): boolean =>
  !!ui.libraryPrompt && !sameTemplate(ui.libraryPrompt, libraryPrompt(saved));

/** Fills `{{excerpt}}` in prompt previews. Mara is the sample cast's one name. */
export const PROMPT_SAMPLE =
  "The lamps were already lit when Mara reached the bridge. “You’re late,” said the keeper, not looking up. She shook the rain from her hood. Late again, she thought. “The ferry was slow,” she said.";
