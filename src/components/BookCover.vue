<script setup lang="ts">
// A book's cover in a caller-sized box: a gray placeholder unless `showCovers`, then the EPUB's
// image over a generated gradient, so the box is never blank while loading or on a failed fetch.
// Decorative: the title is always written beside.
import { ref } from "vue";
import type { Book } from "@/types";
import { coverStyle, showCovers } from "@/views/library/shared";

withDefaults(defineProps<{ book: Pick<Book, "cover" | "coverImage">; as?: "div" | "span" }>(), {
  as: "div",
});
/** set when the image fails, so a dead url shows the gradient rather than a broken icon */
const failed = ref<string | null>(null);
</script>

<template>
  <component
    :is="as"
    class="relative overflow-hidden"
    :class="!showCovers && 'bg-zinc-200 dark:bg-zinc-700'"
    :style="showCovers ? coverStyle(book.cover) : undefined"
  >
    <img
      v-if="showCovers && book.coverImage && failed !== book.coverImage"
      :src="book.coverImage"
      alt=""
      loading="lazy"
      class="absolute inset-0 h-full w-full object-cover"
      @error="failed = book.coverImage ?? null"
    />
    <slot />
  </component>
</template>
