<script setup lang="ts">
// A book still in its contents review. It is not on the shelf, but it must not vanish either: the
// card says where it stands and offers the way back in, or the way out.
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";

import { computed } from "vue";
import { plural } from "@/views/library/shared";
import type { Book } from "@/types";
import { ArrowRight as ResumeIcon } from "@lucide/vue";

const props = defineProps<{ book: Book }>();
const libraryStore = useLibraryStore();
const uiStore = useUiStore();
const s = computed(() => libraryStore.contentsOf(props.book.id));
const pending = computed(() => s.value.suggested + s.value.review);
function discard() {
  libraryStore.discardImport(props.book.id);
  uiStore.toast("Import cancelled", {
    kind: "info",
    description: "Nothing was added to the library.",
    timeout: 4000,
  });
}
</script>

<template>
  <article
    class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border-2 border-dashed border-violet-300 bg-violet-500/5 px-4 py-3 text-xs dark:border-violet-500/40"
    :aria-label="`${book.title}, contents review in progress`"
  >
    <div class="min-w-0 flex-1">
      <div class="label text-violet-600 dark:text-violet-300">Reviewing contents</div>
      <div class="truncate font-serif text-base leading-tight">
        {{ book.title }} <span class="font-sans text-xs text-zinc-500">· {{ book.author }}</span>
      </div>
    </div>
    <div class="text-zinc-600 dark:text-zinc-300">
      <b>{{ s.included }}</b> of {{ plural(s.total, "chapter") }} would go in
      <template v-if="pending">
        · <span class="text-amber-600 dark:text-amber-400">{{ pending }} to decide</span></template
      >
      <template v-if="s.skipped"> · {{ s.skipped }} skipped</template>
    </div>
    <div class="flex items-center gap-2">
      <RouterLink :to="`/book/${book.id}/contents`" class="btn-primary btn-xs">
        Resume review <ResumeIcon class="icon-sm" />
      </RouterLink>
      <button class="btn-ghost btn-xs" @click="discard">Discard</button>
    </div>
  </article>
</template>
