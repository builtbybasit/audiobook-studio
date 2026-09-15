// Page state that has to outlive the route.
//
// Leaving the Endpoints page and coming back must not lose which tab you were on, what you had
// half-typed into a connection form, or how you had the activity list filtered. None of that is
// domain state, so it doesn't belong in the store — it lives here, at module scope, reactive and
// keyed by `<kind>:<id>`.
import { reactive } from "vue";
import { bindCredential } from "@/lib/credentials";
import { opsOf } from "@/lib/endpoints";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import type { ConnectionTest, EndpointKind, RangeKey, RequestStatus } from "@/types";

export type TabId = "overview" | "connection" | "requests" | "pricing" | "activity" | "expressions";

export const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "connection", label: "Connection" },
  { id: "requests", label: "Requests" },
  { id: "expressions", label: "Expressions" },
  { id: "pricing", label: "Pricing & budgets" },
  { id: "activity", label: "Activity" },
];

/** Connection changes are staged, never live-applied: switching provider under a running book is
 *  exactly the kind of silent change this page is supposed to prevent. */
export interface ConnectionDraft {
  name: string;
  model: string;
  baseUrl: string;
  needsKey: boolean;
  credentialId: string | null;
  quotaGroup: string;
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
  activity: {},
  tests: {},
});

export const tabOf = (key: string): TabId => ui.tab[key] ?? "overview";
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
  });
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
  };
  return (Object.keys(current) as (keyof ConnectionDraft)[]).filter((k) => d[k] !== current[k]);
}

export const draftDirty = (u: UnifiedEndpoint): boolean => draftChanges(u).length > 0;

export function applyDraft(u: UnifiedEndpoint): void {
  const d = draftFor(u);
  const target = (u.profile ?? u.endpoint) as unknown as Record<string, unknown>;
  target.name = d.name.trim();
  target.model = d.model.trim();
  target.baseUrl = d.baseUrl.trim();
  target.needsKey = d.needsKey;
  target.credentialId = d.credentialId;
  target.quotaGroup = d.quotaGroup.trim() || null;
  bindCredential(u.slot, d.credentialId);
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
  };
}

export function discardDraft(u: UnifiedEndpoint): void {
  delete ui.drafts[u.key];
}
