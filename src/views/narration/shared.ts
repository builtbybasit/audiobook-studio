import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { computed } from "vue";

import type { AudioStatus } from "@/types";

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

export interface ChapterProps {
  bookId: string;
  chapterId: number;
}

export interface JobStats extends Record<AudioStatus, number> {
  total: number;
  duration: number;
}

export function useJob(props: ChapterProps) {
  const castStore = useCastStore();
  const endpointsStore = useEndpointsStore();
  const libraryStore = useLibraryStore();
  const scriptsStore = useScriptsStore();
  const chapter = computed(() => libraryStore.chapter(props.bookId, props.chapterId));
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
  const stats = computed<JobStats>(() => {
    const s: JobStats = {
      none: 0,
      stale: 0,
      done: 0,
      failed: 0,
      generating: 0,
      queued: 0,
      total: segments.value.length,
      duration: 0,
    };
    for (const x of segments.value) {
      s[x.audio.status] = (s[x.audio.status] ?? 0) + 1;
      s.duration += x.audio.duration;
    }
    return s;
  });
  return { chapter, segments, cast, colorOf, voiceOf, epName, stats };
}
