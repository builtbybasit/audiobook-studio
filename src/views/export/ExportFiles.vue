<script setup lang="ts">
import { useLibraryStore } from "@/stores/library";

// Every file in the plan, and inside each one the chapters in the order they will play, with the
// marker title the player will show. At 214 chapters this is the only honest way to answer "is the
// order right?" — so it is a real list rather than a sample of three.
import { computed, ref, watch } from "vue";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Play as PlayIcon,
  X as CloseIcon,
} from "@lucide/vue";

import { markerTitle } from "@/lib/exports";
import { clock, hms, mb, plural } from "@/views/export/shared";
import type { ExportPlan, ExportSettings } from "@/types";

const props = defineProps<{
  open: boolean;
  bookId: string;
  plan: ExportPlan;
  settings: ExportSettings;
}>();
const emit = defineEmits<{ "update:open": [boolean]; preview: [number[], string] }>();
const libraryStore = useLibraryStore();
const openFiles = ref(new Set<string>());
// a single-file plan has nothing to choose between: open it straight away
watch(
  () => props.open,
  (o) => {
    if (o && props.plan.files.length === 1) openFiles.value = new Set([props.plan.files[0].name]);
  },
);
function toggle(name: string) {
  const next = new Set(openFiles.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  openFiles.value = next;
}
const chapter = (id: number) => libraryStore.chapter(props.bookId, id);
const volumeName = (id: number) => {
  const c = chapter(id);
  return c
    ? (libraryStore.volumesOf(props.bookId).find((v) => v.id === c.volumeId)?.name ?? null)
    : null;
};
const shown = computed(() => props.plan.files);
</script>

<template>
  <DialogRoot :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/35" />
      <DialogContent
        class="fixed inset-x-2 bottom-2 top-2 z-50 mx-auto flex max-w-3xl flex-col rounded-xl border border-zinc-200 bg-white shadow-2xl focus:outline-none sm:inset-y-8 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <header class="shrink-0 border-b border-zinc-200 p-4 sm:p-5 dark:border-zinc-800">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <DialogTitle class="break-words text-lg font-semibold">{{ plan.label }}</DialogTitle>
              <DialogDescription class="mt-0.5 text-sm text-zinc-500"
                >{{ plural(plan.files.length, "file") }} · {{ plural(plan.chapters, "chapter") }} ·
                {{ hms(plan.duration) }} · ~{{ mb(plan.size) }}</DialogDescription
              >
            </div>
            <DialogClose class="btn-ghost btn-xs" aria-label="Close"
              ><CloseIcon class="icon"
            /></DialogClose>
          </div>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <ul class="space-y-2">
            <li
              v-for="(f, fi) in shown"
              :key="f.name"
              class="rounded-lg border border-zinc-200 dark:border-zinc-800"
            >
              <div class="flex items-center gap-2 p-2.5">
                <button
                  class="flex min-w-0 flex-1 items-center gap-2 text-left"
                  :aria-expanded="openFiles.has(f.name)"
                  @click="toggle(f.name)"
                >
                  <component
                    :is="openFiles.has(f.name) ? ChevronDownIcon : ChevronRightIcon"
                    class="icon-sm shrink-0 text-zinc-400"
                  />
                  <span class="w-6 shrink-0 font-mono text-[11px] text-zinc-400">{{ fi + 1 }}</span>
                  <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="f.name">{{
                    f.name
                  }}</span>
                </button>
                <span class="shrink-0 font-mono text-[11px] text-zinc-500"
                  >{{ f.chapterIds.length }} ch · {{ hms(f.duration) }} · ~{{ mb(f.size) }}</span
                >
                <button
                  class="icon-btn shrink-0"
                  :title="`preview ${f.name}`"
                  @click="emit('preview', f.chapterIds, f.name)"
                >
                  <PlayIcon class="icon-sm icon-fill" />
                </button>
              </div>
              <ol
                v-if="openFiles.has(f.name)"
                class="border-t border-zinc-100 px-2.5 py-1.5 dark:border-zinc-800"
              >
                <li
                  v-for="(id, i) in f.chapterIds"
                  :key="id"
                  class="flex items-center gap-2 py-0.5 text-xs"
                >
                  <span class="w-8 shrink-0 text-right font-mono text-[11px] text-zinc-400">{{
                    i + 1
                  }}</span>
                  <span class="min-w-0 flex-1 truncate">
                    <template v-if="f.markers">{{
                      markerTitle(chapter(id)!, i + 1, settings, volumeName(id))
                    }}</template>
                    <template v-else>{{ chapter(id)?.title }}</template>
                  </span>
                  <span class="shrink-0 font-mono text-[11px] text-zinc-400">{{
                    clock(chapter(id)?.duration ?? 0)
                  }}</span>
                </li>
                <li
                  v-if="!f.markers && settings.grouping !== 'chapter'"
                  class="mt-1 pl-10 text-[11px] text-amber-600 dark:text-amber-400"
                >
                  No chapter marks are written in this file, so a player shows it as one track.
                </li>
              </ol>
            </li>
          </ul>
        </div>

        <footer
          class="shrink-0 border-t border-zinc-200 p-3 text-[11px] leading-relaxed text-zinc-500 dark:border-zinc-800"
        >
          Chapters play in the book's own order. A chapter you skipped is not here, and neither is
          one you left out of the selection.
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
