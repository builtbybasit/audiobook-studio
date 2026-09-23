<script setup lang="ts">
// A book's cover, in whatever box the caller sizes: the EPUB's own image when it carried one, and
// the generated gradient when it did not. The gradient stays underneath the image, so the box is
// never blank while the image loads or if it cannot be fetched; anything the caller puts inside
// (a title, a vignette) sits over both. Decorative: the title is always written next to it.
import { ref } from "vue";
import type { Book } from "@/types";
import { coverStyle } from "@/views/library/shared";

withDefaults(defineProps<{ book: Pick<Book, "cover" | "coverImage">; as?: "div" | "span" }>(), {
  as: "div",
});
/** the image that would not load, so a dead url shows the gradient rather than a broken icon */
const failed = ref<string | null>(null);
</script>

<template>
  <component :is="as" class="relative overflow-hidden" :style="coverStyle(book.cover)">
    <img
      v-if="book.coverImage && failed !== book.coverImage"
      :src="book.coverImage"
      alt=""
      loading="lazy"
      class="absolute inset-0 h-full w-full object-cover"
      @error="failed = book.coverImage ?? null"
    />
    <slot />
  </component>
</template>
