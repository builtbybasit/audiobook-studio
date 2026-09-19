// The contents review, as pure functions over a book's chapters: what state a chapter is in, the
// counts kept on screen, and the groups a batch decision covers. The store and the page both read
// these, so the header, the filters and the import button cannot disagree about a number.
import type { Chapter, ContentState, ContentsSummary, NoticeGroup, NoticeKind } from "@/types";

/** What each kind of note is called when several are decided together. */
export const NOTICE_LABEL: Record<NoticeKind, string> = {
  hiatus: "Hiatus announcements",
  health: "Personal updates",
  return: "Return announcements",
  schedule: "Release schedules",
  progress: "Progress updates",
  promo: "Promotional links",
  donation: "Donation messages",
  duplicate: "Duplicate notices",
  unreadable: "Could not be read",
  sponsor: "Sponsor thanks",
  vote: "Vote reminders",
  afterword: "Afterwords",
  translator: "Translator’s notes",
  mixed: "Story with a note inside",
  title: "Notice-like titles",
};

/** A note the user has not acted on: neither skipped nor kept. */
export const isUndecided = (c: Chapter): boolean => !!c.note && !c.excluded && !c.kept;

export function stateOf(c: Chapter): ContentState {
  if (c.excluded) return "skipped";
  if (!c.note) return "included";
  if (c.kept) return "kept";
  return c.note.verdict === "skip" ? "suggested" : "review";
}

export function summarize(chapters: Chapter[]): ContentsSummary {
  const out: ContentsSummary = {
    total: chapters.length,
    included: 0,
    skipped: 0,
    suggested: 0,
    review: 0,
    kept: 0,
    noted: 0,
  };
  for (const c of chapters) {
    if (c.note) out.noted++;
    const s = stateOf(c);
    if (s === "skipped") out.skipped++;
    else out.included++;
    if (s === "suggested") out.suggested++;
    else if (s === "review") out.review++;
    else if (s === "kept") out.kept++;
  }
  return out;
}

/** Notes grouped by kind, largest first, suggested skips before the ones that need a look. */
export function noticeGroups(chapters: Chapter[]): NoticeGroup[] {
  const by = new Map<NoticeKind, NoticeGroup>();
  for (const c of chapters) {
    if (!c.note) continue;
    let g = by.get(c.note.kind);
    if (!g) {
      g = {
        kind: c.note.kind,
        verdict: c.note.verdict,
        label: NOTICE_LABEL[c.note.kind],
        ids: [],
        pending: [],
        skipped: 0,
        kept: 0,
      };
      by.set(c.note.kind, g);
    }
    g.ids.push(c.id);
    if (c.excluded) g.skipped++;
    else if (c.kept) g.kept++;
    else g.pending.push(c.id);
  }
  return [...by.values()].sort(
    (a, b) =>
      Number(a.verdict === "review") - Number(b.verdict === "review") ||
      b.ids.length - a.ids.length,
  );
}

/** The first line of a chapter, for the row under its title. */
export function excerptOf(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut) + "…";
}

/** “Add to library · 208 chapters”, “Add volume · 34 chapters” — the label says what goes in. */
export function importLabel(kind: "book" | "volume", included: number): string {
  const n = `${included} chapter${included === 1 ? "" : "s"}`;
  return kind === "book" ? `Add to library · ${n}` : `Add volume · ${n}`;
}

export const plural = (n: number, one: string, many = one + "s"): string =>
  `${n} ${n === 1 ? one : many}`;
