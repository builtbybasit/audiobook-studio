<script setup lang="ts">
// The shelf as a grid of covers; everything a book has to say sits under its cover. Best when
// the shelf is short and books are told apart by sight.
import type { Book } from "@/types";
import type { PickedFile } from "@/components/addEpub";
import BookCard from "@/views/library/BookCard.vue";

defineProps<{ books: Book[] }>();
const emit = defineEmits<{ open: [book: Book]; addVolume: [book: Book, picked: PickedFile] }>();

// arrows move between covers, like the lists elsewhere
function onGridKey(e: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const grid = e.currentTarget as HTMLElement;
  const opens = [...grid.querySelectorAll<HTMLElement>("[data-card-open]")];
  const i = opens.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const cols = Math.max(
    1,
    Math.round(grid.clientWidth / (opens[0]?.closest("article")?.clientWidth ?? 1) || 1),
  );
  const delta =
    e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -cols : cols;
  opens[Math.max(0, Math.min(opens.length - 1, i + delta))]?.focus();
}
</script>

<template>
  <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4" @keydown="onGridKey">
    <BookCard
      v-for="b in books"
      :key="b.id"
      :book="b"
      @open="emit('open', b)"
      @add-volume="(picked) => emit('addVolume', b, picked)"
    />
  </div>
</template>
