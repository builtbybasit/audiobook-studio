<script lang="ts">
/** "A chapter’s script could not be read", or "3 chapters’ scripts …", for a read across chapters. */
export const scriptsUnread = (chapters: number): string =>
  `${chapters === 1 ? "A chapter’s script" : `${chapters} chapters’ scripts`} could not be read`;
</script>

<script setup lang="ts">
// A read the page needs that failed, said where its figures would have been and with the way to
// ask again — so a count across the book that is short, or a list that is empty because nothing
// arrived, never passes for one that is complete.
import { TriangleAlert as WarnIcon } from "@lucide/vue";

defineProps<{ message: string }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <p class="flex flex-wrap items-center gap-2 text-sm text-red-600" role="alert">
    <WarnIcon class="icon shrink-0" /> {{ message }}
    <button class="btn-ghost btn-xs" @click="$emit('retry')">Retry</button>
  </p>
</template>
