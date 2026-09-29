// Page state that has to outlive the route.
//
// Leaving the Endpoints page and coming back must not lose which tab you were on, what you had
// half-typed into a connection form, or how you had the activity list filtered. None of that is
// domain state, so it doesn't belong in the store — it lives here, at module scope, reactive and
// keyed by `<kind>:<id>`.
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

/** Tabs that only make sense for a speech endpoint: a chat model has neither a voice catalogue nor
 *  expression tags. Kept here so the trigger list and the "is this tab still valid" check that
 *  guards a remembered tab can't drift apart. */
const TTS_ONLY: TabId[] = ["voices", "expressions"];
/** …and the one that only makes sense for a chat model: a speech endpoint is sent no prompt. */
const SCRIPTING_ONLY: TabId[] = ["prompt"];

export const tabsFor = (kind: EndpointKind): { id: TabId; label: string }[] =>
  TABS.filter((t) => !(kind === "tts" ? SCRIPTING_ONLY : TTS_ONLY).includes(t.id));

/** Connection changes are staged, never live-applied: switching provider under a running book is
 *  exactly the kind of silent change this page is supposed to prevent. */
export interface ConnectionDraft {
  name: string;
  model: string;
  baseUrl: string;
  needsKey: boolean;
  credentialId: string | null;
  quotaGroup: string;
  /** what a preset filled in beyond the connection — billing or token prices, limits, concurrency —
   *  held here with the rest, so Save applies it and Discard drops it */
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
  /** a scripting endpoint's prompt being edited, by key; absent is the saved one, untouched */
  prompts: Record<string, ProfilePrompt>;
  /** the library's default prompt being edited; null is the saved one, untouched */
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

/** The remembered tab, or the first one this kind has. Selecting a scripting endpoint while
 *  Voices was open must land somewhere real rather than on an empty panel. */
export const tabOf = (key: string, kind: EndpointKind = "tts"): TabId => {
  const want = ui.tab[key] ?? "overview";
  return tabsFor(kind).some((t) => t.id === want) ? want : "overview";
};
export const filterOf = (key: string): ActivityFilter => (ui.activity[key] ??= newFilter());

// ---------- connection drafts ----------
// A connection edit is staged and applied on purpose. Typing a new base URL must not quietly
// re-point a book that is mid-run at a different provider, so nothing here writes through until
// `applyDraft` is called — and the draft survives leaving the page.

export function draftFor(u: UnifiedEndpoint): ConnectionDraft {
  return (ui.drafts[u.key] ??= {
    name: u.name,
    model: u.model,
    baseUrl: u.baseUrl,
    needsKey: u.needsKey,
    credentialId: opsOf(u).credentialId,
    quotaGroup: opsOf(u).quotaGroup ?? "",
    preset: null,
  });
}

/**
 * Stage a preset on this endpoint's draft. The connection half goes into the fields the form edits;
 * the rest waits beside them until Save, which is what the page promises — nothing a preset fills
 * in reaches the endpoint, or the server behind it, before then. `fields` must be a copy.
 */
export function stagePreset(
  u: UnifiedEndpoint,
  label: string,
  fields: Partial<Profile> | Partial<Endpoint>,
): void {
  const d = draftFor(u);
  const { name, model, baseUrl, needsKey, ...rest } = fields;
  if (name !== undefined) d.name = name;
  if (model !== undefined) d.model = model;
  if (baseUrl !== undefined) d.baseUrl = baseUrl;
  if (needsKey !== undefined) d.needsKey = needsKey;
  d.preset = Object.keys(rest).length ? { label, fields: rest } : null;
}

/** Fields that identify *which provider* this configuration talks to. */
export const PROVIDER_FIELDS: (keyof ConnectionDraft)[] = ["baseUrl", "model", "credentialId"];

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
    preset: null,
  };
  return (Object.keys(current) as (keyof ConnectionDraft)[]).filter((k) => d[k] !== current[k]);
}

export const draftDirty = (u: UnifiedEndpoint): boolean => draftChanges(u).length > 0;

/**
 * Write the draft onto the configuration. Returns what had to be put back so the audio choice still
 * fits: a new base URL can speak another API (Fish Audio's formats and rates are not OpenAI's), and
 * a format or rate the new one lacks goes back to the provider's default here, in the same write,
 * rather than being left for the server to refuse the next line with. A staged preset's prices and
 * limits are written in the same go.
 */
export function applyDraft(u: UnifiedEndpoint): string[] {
  const d = draftFor(u);
  const target = (u.profile ?? u.endpoint) as unknown as Record<string, unknown>;
  if (d.preset) Object.assign(target, d.preset.fields);
  target.name = d.name.trim();
  target.model = d.model.trim();
  target.baseUrl = d.baseUrl.trim();
  target.needsKey = d.needsKey;
  target.credentialId = d.credentialId;
  target.quotaGroup = d.quotaGroup.trim() || null;
  let notes: string[] = [];
  if (u.endpoint) {
    const r = repairEncoding(u.endpoint);
    if (encodingChanged(u.endpoint, r)) {
      u.endpoint.encoding = r.encoding;
      u.endpoint.sampleRate = r.sampleRate;
    }
    notes = r.notes;
  }
  // Re-seed the draft from what was just written instead of deleting it. `draftFor` would rebuild
  // it from the `u` snapshot this render still holds — the pre-save values — so the form would show
  // the old text back and claim unsaved changes that had in fact just been saved.
  ui.drafts[u.key] = {
    name: d.name.trim(),
    model: d.model.trim(),
    baseUrl: d.baseUrl.trim(),
    needsKey: d.needsKey,
    credentialId: d.credentialId,
    quotaGroup: d.quotaGroup.trim(),
    preset: null,
  };
  return notes;
}

export function discardDraft(u: UnifiedEndpoint): void {
  delete ui.drafts[u.key];
}

// ---------- prompt drafts ----------
// A prompt is staged too, and saved with a button: a half-typed one is usually not a prompt at all
// (the excerpt tag deleted on the way to moving it), and the write-behind would send it to a server
// that refuses it, then read back the saved one over what was being typed. A draft exists only once
// something is typed, so a prompt the server changes underneath an untouched editor shows through.

const sameTemplate = (a: PromptTemplate, b: PromptTemplate): boolean =>
  a.system === b.system && a.user === b.user;

/** An endpoint's say over the prompt as saved, with the text a Default one has not got filled in. */
export const savedProfilePrompt = (p: Profile): ProfilePrompt => ({
  mode: p.prompt?.mode ?? "default",
  system: p.prompt?.system ?? "",
  user: p.prompt?.user ?? "",
});

/** What the Prompt tab shows: the draft, or what is saved. */
export const profilePromptOf = (u: UnifiedEndpoint): ProfilePrompt | null =>
  u.profile ? (ui.prompts[u.key] ?? savedProfilePrompt(u.profile)) : null;

/** Change part of an endpoint's prompt, starting a draft from the saved one. */
export function editProfilePrompt(u: UnifiedEndpoint, change: Partial<ProfilePrompt>): void {
  const cur = profilePromptOf(u);
  if (cur) ui.prompts[u.key] = { ...cur, ...change };
}

export function profilePromptDirty(u: UnifiedEndpoint): boolean {
  const d = ui.prompts[u.key];
  if (!d || !u.profile) return false;
  const saved = savedProfilePrompt(u.profile);
  return d.mode !== saved.mode || !sameTemplate(d, saved);
}

export function discardProfilePrompt(u: UnifiedEndpoint): void {
  delete ui.prompts[u.key];
}

/** What the Default prompt panel shows: the draft, or what is saved (the built-in one for none). */
export const libraryPromptOf = (saved: PromptTemplate | null): PromptTemplate =>
  ui.libraryPrompt ?? libraryPrompt(saved);

export function editLibraryPrompt(saved: PromptTemplate | null, change: Partial<PromptTemplate>) {
  ui.libraryPrompt = { ...libraryPromptOf(saved), ...change };
}

export const libraryPromptDirty = (saved: PromptTemplate | null): boolean =>
  !!ui.libraryPrompt && !sameTemplate(ui.libraryPrompt, libraryPrompt(saved));

/**
 * What the prompt previews fill `{{excerpt}}` with: a short paragraph with a speaker in it, so the
 * preview reads like a request rather than a chapter-long wall. Mara is the sample cast's one name.
 */
export const PROMPT_SAMPLE =
  "The lamps were already lit when Mara reached the bridge. “You’re late,” said the keeper, not looking up. She shook the rain from her hood. Late again, she thought. “The ferry was slow,” she said.";
