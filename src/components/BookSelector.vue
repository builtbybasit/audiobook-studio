<script setup lang="ts">
// The open book in the header: cover + title + ▾. Click lists the other books, each with its one
// next thing to do, and picking one lands on the page you are already on — Narration stays
// Narration — so switching books never costs your place. From six books up a search box comes
// first (title or author, the shelf's own matching); under that a box above three rows is clutter.
//
// `dim` is for the app pages (Library, Queue, Endpoints): the book is still one click away, but
// the header does not pretend you are on it.
import { useLibraryStore } from "@/stores/library";

import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { ChevronDown as SwitchIcon, ArrowRight as GoIcon, Search as SearchIcon } from "@lucide/vue";
import { useShell } from "@/composables/useShell";
import { bookFacts } from "@/views/library/bookFacts";
import { matchesQuery } from "@/views/library/shelf";
import { coverStyle, TONE_TEXT } from "@/views/library/shared";

defineProps<{ dim?: boolean }>();
const libraryStore = useLibraryStore();
const { book, switchTo, pageName, others } = useShell();
const router = useRouter();
const open = ref(false);
const q = ref("");
const input = ref<HTMLInputElement | null>(null);
const searchable = computed(() => libraryStore.shelved.length > 5);
const choices = computed(() =>
  others.value
    .filter((b) => matchesQuery(b, q.value))
    .map((b) => ({ b, next: bookFacts(b.id).next })),
);
watch(open, (o) => {
  q.value = "";
  if (o) void nextTick(() => input.value?.focus());
});
function pick(id: string) {
  open.value = false;
  void router.push(switchTo(id));
}
/** Enter takes the first match */
function onEnter() {
  const first = choices.value[0];
  if (first) pick(first.b.id);
}
</script>

<template>
  <PopoverRoot v-if="book" v-model:open="open">
    <PopoverTrigger as-child>
      <button
        class="flex min-w-0 items-center gap-2 rounded-md py-0.5 pl-0.5 pr-1.5 text-left hover:bg-zinc-100 data-[state=open]:bg-zinc-100 dark:hover:bg-zinc-800 dark:data-[state=open]:bg-zinc-800"
        :class="dim && 'opacity-70 hover:opacity-100'"
        title="Switch book"
      >
        <span class="h-7 w-5 shrink-0 rounded-sm shadow-sm" :style="coverStyle(book.cover)"></span>
        <span
          class="min-w-0 truncate font-serif text-sm text-zinc-900 lg:max-w-64 dark:text-zinc-100"
          >{{ book.title }}</span
        >
        <SwitchIcon class="icon shrink-0 text-zinc-400" />
      </button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        side="bottom"
        align="start"
        :side-offset="6"
        class="z-[60] flex w-80 flex-col rounded-lg border border-zinc-200 bg-white p-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div v-if="searchable" class="relative mb-1">
          <SearchIcon class="icon absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            ref="input"
            v-model="q"
            class="input w-full pl-7"
            placeholder="Find a book or author…"
            aria-label="Find a book"
            @keydown.enter.prevent="onEnter"
          />
        </div>
        <div class="label px-2 py-1.5">Switch book · stays on {{ pageName }}</div>
        <div class="max-h-80 overflow-y-auto">
          <button
            v-for="{ b, next } in choices"
            :key="b.id"
            class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
            @click="pick(b.id)"
          >
            <span class="h-9 w-7 shrink-0 rounded-sm" :style="coverStyle(b.cover)"></span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] font-medium">{{ b.title }}</span>
              <span class="block truncate text-[11px]" :class="TONE_TEXT[next.tone]">{{
                next.label
              }}</span>
            </span>
          </button>
          <div v-if="!choices.length" class="px-2 py-3 text-center text-xs text-zinc-500">
            <template v-if="q">No book matches “{{ q }}”.</template>
            <template v-else>No other books.</template>
          </div>
        </div>
        <RouterLink
          to="/library"
          class="mt-1 flex items-center gap-1.5 border-t border-zinc-200 px-2 pb-1 pt-2 text-xs text-zinc-500 hover:text-violet-500 dark:border-zinc-800"
          @click="open = false"
          >All {{ libraryStore.shelved.length }} books <GoIcon class="icon-sm"
        /></RouterLink>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
