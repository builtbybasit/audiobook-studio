<script setup lang="ts">
// The shelf as a table: one row per book, the pipeline as columns, so twenty books can be
// compared at a glance and the one that needs a hand is found by scanning down a column. Progress
// is per stage, the way the overview shows it, so the two pages agree. A column header that can
// order the shelf is a button; the order itself belongs to the page, which keeps it in the URL.
import type { Book } from "@/types";
import type { PickedFile } from "@/components/addEpub";
import type { ShelfSort } from "@/views/library/shelf";
import ShelfRow from "@/views/library/ShelfRow.vue";
import { ArrowDown as SortIcon } from "@lucide/vue";

defineProps<{ books: Book[]; sort: ShelfSort }>();
const emit = defineEmits<{
  open: [book: Book];
  addVolume: [book: Book, picked: PickedFile];
  sort: [sort: ShelfSort];
}>();

// fixed widths, so a long title truncates instead of pushing the row wider than the page
const COLUMNS: { label: string; sort?: ShelfSort; cls?: string; w: string }[] = [
  { label: "Book", sort: "title", w: "30%" },
  { label: "Chapters", w: "15%" },
  { label: "Scripted", sort: "scripted", w: "6.5rem" },
  { label: "Narrated", sort: "narrated", w: "6.5rem" },
  { label: "Audiobook", w: "16%" },
  { label: "Next", cls: "text-right", w: "auto" },
  { label: "", w: "2.5rem" },
];
</script>

<template>
  <div class="card overflow-x-auto">
    <table class="w-full min-w-[720px] table-fixed border-collapse text-xs">
      <colgroup>
        <col v-for="c in COLUMNS" :key="c.label" :style="{ width: c.w }" />
      </colgroup>
      <thead>
        <tr class="label border-b border-zinc-200 text-left dark:border-zinc-800">
          <th
            v-for="c in COLUMNS"
            :key="c.label"
            class="px-3 py-2 font-semibold"
            :class="c.cls"
            :aria-sort="c.sort ? (sort === c.sort ? 'ascending' : 'none') : undefined"
          >
            <button
              v-if="c.sort"
              class="inline-flex items-center gap-1 uppercase hover:text-zinc-800 dark:hover:text-zinc-100"
              :class="sort === c.sort && 'text-violet-700 dark:text-violet-300'"
              :title="`Order by ${c.label.toLowerCase()}`"
              @click="emit('sort', c.sort)"
            >
              {{ c.label }} <SortIcon v-if="sort === c.sort" class="icon-sm" />
            </button>
            <template v-else>{{ c.label }}</template>
          </th>
        </tr>
      </thead>
      <tbody>
        <ShelfRow
          v-for="b in books"
          :key="b.id"
          :book="b"
          @open="emit('open', b)"
          @add-volume="(picked) => emit('addVolume', b, picked)"
        />
      </tbody>
    </table>
  </div>
</template>
