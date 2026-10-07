// PROTOTYPE — throwaway. What every Listen variant is handed, and the stubs they share.
//
// The page keeps its data fetching and the player wiring; a variant only draws. Flags and the
// "stop at the end of the chapter" switch are stubs kept in memory here, never written to the
// server: the question is what the page should look like, not whether the flag API works.
import { onMounted, onUnmounted, reactive, ref } from "vue";
import type { PlayerState } from "@/composables/usePlayer";
import type { TimelineClip } from "@/lib/speech";
import type { WordMark } from "@/lib/listen";
import type { Book, Chapter, ChapterHeard, FlagKind, Segment } from "@/types";

export interface ListenCtx {
  bookId: string;
  book: Book | undefined;
  chapter: Chapter | undefined;
  /** the book's kept chapters, in order */
  chapters: Chapter[];
  opened: number;
  open: (id: number) => void;
  /** the spoken lines of the open chapter */
  rows: Segment[];
  marks: Map<number, WordMark[]>;
  heard: ChapterHeard;
  /** the line under the playhead, while this chapter is loaded */
  current: number | null;
  word: number;
  colorOf: (name: string) => string;
  loaded: boolean;
  status: string;
  narrated: number;
  refetch: () => void;
  timeline: TimelineClip[];
  total: number;
  isThis: boolean;
  p: PlayerState;
  /** toggle, or start from `at` seconds into the chapter */
  playChapter: (at?: number) => void;
  listenFrom: (s: Segment, offset: number) => void;
  seekTo: (sec: number) => void;
  skip: (d: number) => void;
  next: () => void;
  prev: () => void;
  cycleRate: () => void;
  /** reading along follows the playhead; off once the person scrolls away */
  follow: boolean;
  setFollow: (v: boolean) => void;
}

export interface ProtoFlag {
  kind: FlagKind;
  note: string;
}
/** stub: flags raised on this page, by segment id — in memory only */
export const protoFlags = reactive(new Map<number, ProtoFlag>());
/** stub: stop when the chapter ends instead of running on into the next */
export const protoStopAtEnd = ref(false);

export const fmt = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** the chapter's place among the kept chapters — never its id */
export const placeOf = (ctx: ListenCtx, id = ctx.opened): number =>
  ctx.chapters.findIndex((c) => c.id === id) + 1;

export const isNarratedChapter = (c: Chapter): boolean =>
  c.narration === "done" || c.narration === "stale";

/** the narrated chapter before/after the open one, or null */
export function neighbour(ctx: ListenCtx, d: 1 | -1): Chapter | null {
  const i = ctx.chapters.findIndex((c) => c.id === ctx.opened);
  for (let j = i + d; j >= 0 && j < ctx.chapters.length; j += d) {
    if (isNarratedChapter(ctx.chapters[j])) return ctx.chapters[j];
  }
  return null;
}

/** the line to act on: the one playing, else the first */
export const focusRow = (ctx: ListenCtx): Segment | undefined =>
  ctx.rows.find((s) => s.id === ctx.current) ?? ctx.rows[0];

/** speakers heard in this chapter, with how many lines each — names and colours only */
export function speakersOf(ctx: ListenCtx): { name: string; n: number; color: string }[] {
  const n = new Map<string, number>();
  for (const s of ctx.rows) n.set(s.speaker, (n.get(s.speaker) ?? 0) + 1);
  return [...n]
    .map(([name, count]) => ({ name, n: count, color: ctx.colorOf(name) }))
    .sort((a, b) => b.n - a.n);
}

/**
 * Keys every variant answers: j/k next and previous line, , and . ten seconds back and forward,
 * f flags the line playing. Space is the app's already. ← → are the variant switcher's.
 */
export function useProtoKeys(get: () => ListenCtx, flag: () => void): void {
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const ctx = get();
    const k = e.key.toLowerCase();
    if (k === "j") {
      if (ctx.isThis) ctx.next();
      else ctx.playChapter();
    } else if (k === "k") {
      if (ctx.isThis) ctx.prev();
    } else if (k === ",") {
      if (ctx.isThis) ctx.skip(-10);
    } else if (k === ".") {
      if (ctx.isThis) ctx.skip(10);
    } else if (k === "f") flag();
    else return;
    e.preventDefault();
  }
  onMounted(() => window.addEventListener("keydown", onKey));
  onUnmounted(() => window.removeEventListener("keydown", onKey));
}
