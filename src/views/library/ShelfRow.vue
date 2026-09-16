<script setup lang="ts">
// One row of the shelf table.
import { computed } from "vue";
import type { Book } from "@/types";
import { useBookFacts } from "@/views/library/bookFacts";
import { hours, plural, TONE } from "@/views/library/shared";
import BookMenu from "@/views/library/BookMenu.vue";
import { ArrowRight as GoIcon } from "@lucide/vue";

const props = defineProps<{ book: Book }>();
const emit = defineEmits<{ open: []; addVolume: [file: string] }>();
const f = useBookFacts(() => props.book.id);
const p = computed(() => f.value.progress);
const pct = (n: number) => `${p.value.total ? (n / p.value.total) * 100 : 0}%`;
</script>

<template>
  <tr
    class="border-b border-zinc-100 align-top last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/40"
  >
    <td class="px-3 py-2.5">
      <button class="flex w-full items-center gap-3 text-left" @click="emit('open')">
        <span
          class="h-10 w-8 shrink-0 rounded-sm shadow-sm"
          :style="{ background: `linear-gradient(160deg, ${book.cover[0]}, ${book.cover[1]})` }"
        ></span>
        <span class="min-w-0">
          <span class="block truncate font-serif text-sm font-semibold leading-tight">{{
            book.title
          }}</span>
          <span class="block truncate text-[11px] text-zinc-500">{{ book.author }}</span>
          <span
            v-if="f.activity"
            class="mt-0.5 flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300"
            ><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"></span
            >{{ f.activity }}</span
          >
        </span>
      </button>
    </td>
    <td class="px-3 py-2.5 text-zinc-600 dark:text-zinc-300">
      <span class="whitespace-nowrap"
        ><b class="text-zinc-800 dark:text-zinc-100">{{ f.contents.included }}</b> of
        {{ f.contents.total }}</span
      >
      <span class="text-zinc-400"
        ><template v-if="book.volumes.length > 1"> · {{ book.volumes.length }} vols</template
        ><template v-if="f.contents.skipped"> · {{ f.contents.skipped }} skipped</template></span
      >
    </td>
    <td class="px-3 py-2.5">
      <div class="font-mono text-[11px]">{{ p.scripted }}/{{ p.total }}</div>
      <div class="mt-1 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div class="h-full bg-amber-500" :style="{ width: pct(p.scripted) }"></div>
      </div>
      <div v-if="f.failedScripting" class="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
        {{ f.failedScripting }} failed
      </div>
    </td>
    <td class="px-3 py-2.5">
      <div class="font-mono text-[11px]">{{ p.narrated }}/{{ p.total }}</div>
      <div class="mt-1 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div class="h-full bg-sky-500" :style="{ width: pct(p.narrated) }"></div>
      </div>
      <div v-if="p.stale" class="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
        {{ p.stale }} stale
      </div>
      <div v-else-if="f.failedNarration" class="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
        {{ f.failedNarration }} failed
      </div>
    </td>
    <td class="px-3 py-2.5 text-zinc-600 dark:text-zinc-300">
      <template v-if="f.latest">
        <RouterLink :to="`/book/${book.id}/export?tab=library`" class="hover:underline">
          <span class="text-zinc-800 dark:text-zinc-100"
            >v{{ f.latest.version }} · {{ hours(f.latest.duration) }}</span
          >
          <div
            class="mt-0.5 text-[11px]"
            :class="
              f.behind
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-emerald-700 dark:text-emerald-400'
            "
          >
            {{ f.behind ? f.behindWhy || "needs an update" : "up to date" }}
          </div>
        </RouterLink>
      </template>
      <span v-else-if="f.building">building…</span>
      <span v-else class="text-zinc-400">none yet</span>
      <div v-if="f.failedJobs" class="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
        <RouterLink to="/queue" class="hover:underline"
          >{{ plural(f.failedJobs, "job") }} failed</RouterLink
        >
      </div>
    </td>
    <td class="px-3 py-2 text-right">
      <RouterLink
        :to="`/book/${book.id}/${f.next.to}`"
        class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-left font-medium"
        :class="TONE[f.next.tone]"
        >{{ f.next.label }} <GoIcon class="icon-sm opacity-70"
      /></RouterLink>
    </td>
    <td class="px-1 py-2 text-right">
      <BookMenu
        :book="book"
        align="end"
        trigger-class="grid h-7 w-7 place-items-center rounded-full text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        @add-volume="(file) => emit('addVolume', file)"
      />
    </td>
  </tr>
</template>
