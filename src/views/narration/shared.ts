import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { computed } from "vue";

import { usePlayer } from "@/composables/usePlayer";
import type { AudioStatus, ReqError, Segment, SegmentAudio } from "@/types";

export const STATUS_BG: Record<AudioStatus, string> = {
  none: "bg-zinc-300 dark:bg-zinc-700",
  queued: "bg-zinc-400 dark:bg-zinc-600",
  generating: "bg-violet-500 animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  stale: "bg-amber-500",
};
export const fmt = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** the player's name for the retake waiting beside the clip in the book — `2` plays it */
export const candId = (s: Segment): string => `cand${s.id}`;

/** the clip under the playhead is this one — true whether it is playing alone or inside the chapter */
export const onClip = (id: string): boolean => {
  const { p } = usePlayer();
  return p.clipId === id && p.playing;
};

/**
 * What a failed request's status says: the provider's HTTP status when it answered with one. A
 * failure with none never had an answer — refused before it went out, or no response came back.
 */
export const errorStatus = (e: ReqError): string => (e.code ? `HTTP ${e.code}` : "no HTTP status");

export interface ChapterProps {
  bookId: string;
  chapterId: number;
}

/** The line itself, in the reader — where a wrong speaker, direction or word is fixed before a
 *  retake would read the same request again. The same deep link Search uses. */
export const lineLink = (props: ChapterProps, s: Segment) => ({
  path: `/book/${props.bookId}/scripting`,
  query: { ch: String(props.chapterId), seg: String(s.id) },
});

export function useJob(props: ChapterProps) {
  const castStore = useCastStore();
  const endpointsStore = useEndpointsStore();
  const libraryStore = useLibraryStore();
  const narrationStore = useNarrationStore();
  const scriptsStore = useScriptsStore();
  const chapter = computed(() => libraryStore.chapter(props.bookId, props.chapterId));
  /** the book, for what it reads aloud (`isSpoken`) */
  const book = computed(() => libraryStore.bookById(props.bookId));
  const segments = computed(() => scriptsStore.segmentsOf(props.bookId, props.chapterId));
  const cast = computed(() => castStore.charactersOf(props.bookId));
  const colorOf = (name: string): string =>
    cast.value.find((c) => c.name === name)?.color ?? "#71717a";
  const voiceOf = (name: string): string => {
    const v = castStore.effectiveVoice(props.bookId, name);
    return v.label ? (v.own ? v.label : `${v.label} (Narrator’s)`) : "?";
  };
  const epName = (id: string | null): string =>
    endpointsStore.endpoints.find((e) => e.id === id)?.name ?? "—";
  /** what differs between the clip and the script now (the reason a row is stale, made explicit) */
  const drift = (s: Segment, a?: SegmentAudio): string[] =>
    narrationStore.clipDrift(props.bookId, s, a);
  return { chapter, book, segments, cast, colorOf, voiceOf, epName, drift };
}
