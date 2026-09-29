// Trying a scripting prompt on one chunk before it is saved or run: which layers the trial sends,
// what the request says, and how its answer reads. The component that asks is
// `@/components/PromptTrial.vue`; the server's side is `POST /api/books/:id/script-trial`.
//
// A trial takes drafts layer by layer, as the request does: a layer the page has a draft of is sent
// as that draft, and the others are the saved ones. So the prompt estimated and previewed here is
// the one the server will resolve, from the same `resolvePrompt`.
import type {
  BookPrompt,
  ProfilePrompt,
  PromptTemplate,
  PromptTrialRequest,
  PromptTrialResult,
} from "@/types";

/** Drafts in place of what is saved, as the trial's props carry them: absent is the saved one. */
export interface TrialDrafts {
  /** `null` is the built-in prompt */
  library?: PromptTemplate | null;
  /** `null` is none */
  profilePrompt?: ProfilePrompt | null;
  /** `null` is none */
  book?: BookPrompt | null;
}

/** The layers a trial resolves: each draft where there is one, the saved layer where there is not. */
export function trialLayers(
  drafts: TrialDrafts,
  saved: {
    library: PromptTemplate | null | undefined;
    profilePrompt: ProfilePrompt | null | undefined;
    book: BookPrompt | null | undefined;
  },
): { library: PromptTemplate | null; profile: ProfilePrompt | null; book: BookPrompt | null } {
  const pick = <T>(key: keyof TrialDrafts, fallback: T | null | undefined): T | null =>
    drafts[key] !== undefined ? (drafts[key] as T | null) : (fallback ?? null);
  return {
    library: pick<PromptTemplate>("library", saved.library),
    profile: pick<ProfilePrompt>("profilePrompt", saved.profilePrompt),
    book: pick<BookPrompt>("book", saved.book),
  };
}

/** The request for one chunk: only the layers there are drafts of, each copied as it stands now. */
export function trialRequest(
  profile: string,
  chapterId: number,
  part: number,
  drafts: TrialDrafts,
): PromptTrialRequest {
  const request: PromptTrialRequest = { profile, chapterId, part };
  for (const key of ["library", "profilePrompt", "book"] as const)
    if (drafts[key] !== undefined) Object.assign(request, { [key]: copy(drafts[key]) });
  return request;
}

const copy = <T>(v: T): T => (v == null ? v : { ...v });

/** The word check as one sentence: whether every word came back, or what was not. */
export function fidelitySummary(f: PromptTrialResult["fidelity"]): { ok: boolean; text: string } {
  if (f.ok && !f.missing && !f.added) return { ok: true, text: "Every word came back" };
  const parts = [
    f.missing ? `left out ${words(f.missing)}` : "",
    f.added ? `added ${words(f.added)}` : "",
  ].filter(Boolean);
  const said = parts.length ? parts.join(", ") : "did not match the prose";
  const examples = f.examples.slice(0, 3).map((e) => `“${e}”`);
  return {
    ok: false,
    text: `${said[0].toUpperCase()}${said.slice(1)}${examples.length ? ` — e.g. ${examples.join(", ")}` : ""}`,
  };
}

const words = (n: number): string => `${n.toLocaleString("en")} word${n === 1 ? "" : "s"}`;

/** A trial's tokens, as "1,204 in · 388 out, 120 of them thinking"; empty when none were reported. */
export function trialTokens(usage: PromptTrialResult["usage"]): string {
  if (!usage) return "";
  const n = (v: number) => v.toLocaleString("en");
  const thinking = usage.reasoningTokens ? `, ${n(usage.reasoningTokens)} of them thinking` : "";
  return `${n(usage.inputTokens)} in · ${n(usage.outputTokens)} out${thinking}`;
}

/** How long a trial took, as "3.2 s" or "1 min 4 s". */
export function trialTime(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
