import { computed } from "vue";
import { useApp } from "../../stores/app";

export const STATUS_BG = {
  none: "bg-zinc-300 dark:bg-zinc-700",
  queued: "bg-zinc-400 dark:bg-zinc-600",
  generating: "bg-violet-500 animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  stale: "bg-amber-500",
};
export const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function useJob(props) {
  const app = useApp();
  const chapter = computed(() => app.chapter(props.bookId, props.chapterId));
  const segments = computed(() => app.segmentsOf(props.bookId, props.chapterId));
  const cast = computed(() => app.charactersOf(props.bookId));
  const colorOf = (name) => cast.value.find((c) => c.name === name)?.color ?? "#71717a";
  const voiceOf = (name) => {
    const v = app.effectiveVoice(props.bookId, name);
    return v.label ? (v.own ? v.label : `${v.label} (Narrator’s)`) : "?";
  };
  const epName = (id) => app.endpoints.find((e) => e.id === id)?.name ?? "—";
  const stats = computed(() => {
    const s = {
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
  return { app, chapter, segments, cast, colorOf, voiceOf, epName, stats };
}
