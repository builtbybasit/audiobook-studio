<script setup lang="ts">
// The row under the header, on the open book's own pages: every page and stage of the book as
// tabs — the stages with their counts, what is wrong in colour — and the one next thing to do as
// a pill at the far end, the same words as the shelf card and the overview banner. Desktop only:
// on a phone the drawer lists the pages instead (AppRail).
import { computed } from "vue";
import { ArrowRight as GoIcon } from "@lucide/vue";
import { useShell } from "@/composables/useShell";
import { TONE } from "@/views/library/shared";

const { book, facts, waiting, castCount, activeKey, onBookPage } = useShell();
const base = computed(() => (book.value ? `/book/${book.value.id}` : ""));
const p = computed(() => facts.value?.progress);
const TAB =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";
const TAB_ON =
  "bg-violet-50 font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300";
const on = (k: string) => activeKey.value === k && TAB_ON;
</script>

<template>
  <div
    v-if="book && facts && p && onBookPage"
    class="hidden h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-200 bg-white px-3 lg:flex dark:border-zinc-800 dark:bg-zinc-900"
  >
    <RouterLink :to="base" :class="[TAB, on('overview')]">Overview</RouterLink>
    <RouterLink :to="`${base}/contents`" :class="[TAB, on('contents')]">Contents</RouterLink>
    <RouterLink :to="`${base}/cast`" :class="[TAB, on('cast')]"
      >Cast <span class="text-zinc-400">{{ castCount }}</span></RouterLink
    >
    <RouterLink
      :to="`${base}/review`"
      :class="[TAB, on('review'), waiting && 'text-amber-700 dark:text-amber-300']"
      >Review
      <span
        v-if="waiting"
        class="rounded-full bg-amber-400/25 px-1.5 text-[10px] font-semibold tabular-nums"
        >{{ waiting }}</span
      ></RouterLink
    >
    <RouterLink :to="`${base}/search`" :class="[TAB, on('search')]">Search</RouterLink>

    <span class="mx-1 h-5 w-px shrink-0 bg-zinc-200 dark:bg-zinc-700"></span>

    <RouterLink :to="`${base}/scripting`" :class="[TAB, on('scripting')]"
      >Scripting
      <span class="tabular-nums text-zinc-400"
        ><span v-if="facts.failedScripting" class="text-red-600 dark:text-red-400"
          >{{ facts.failedScripting }} failed · </span
        >{{ p.scripted }}/{{ p.total }}</span
      ></RouterLink
    >
    <RouterLink :to="`${base}/narration`" :class="[TAB, on('narration')]"
      >Narration
      <span class="tabular-nums text-zinc-400"
        ><span v-if="p.stale" class="text-amber-600 dark:text-amber-400"
          >{{ p.stale }} stale · </span
        >{{ p.narrated }}/{{ p.total }}</span
      ></RouterLink
    >
    <RouterLink :to="`${base}/export`" :class="[TAB, on('export')]"
      >Export
      <span class="text-zinc-400"
        ><template v-if="facts.latest"
          >v{{ facts.latest.version
          }}<span v-if="facts.behind" class="text-amber-600 dark:text-amber-400">
            · behind</span
          ></template
        ><template v-else-if="facts.building">building…</template
        ><template v-else>—</template></span
      ></RouterLink
    >

    <RouterLink
      :to="`${base}/${facts.next.to}`"
      class="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors"
      :class="TONE[facts.next.tone]"
      ><span class="max-w-64 truncate">{{ facts.next.label }}</span
      ><GoIcon class="icon-sm opacity-70"
    /></RouterLink>
  </div>
</template>
