<script setup lang="ts">
// A peek at one picker chapter: opening text, size, and the skip switch. One serves the whole list
// (a popover per row was most of a long book's components); the list moves it by changing `anchor`
// and `chapter`, and a click on any `[data-peek]` is that move, not a click outside.
import { computed } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot } from "reka-ui";
import { useChapterText } from "@/queries";
import type { Chapter } from "@/types";

const props = defineProps<{ bookId: string; chapter?: Chapter; anchor?: HTMLElement }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ skip: [Chapter, boolean] }>();

// read on peek: an unread chapter would otherwise show empty, which reads as an empty chapter
const { text, isPending } = useChapterText(
  () => props.bookId,
  () => (open.value ? props.chapter?.id : null),
  "plain",
);
const peek = computed(() =>
  text.value.length > 700 ? text.value.slice(0, 700) + "…" : text.value,
);
/** focus moved outside while open, so closing must not pull it back */
let left = false;
function onOutside(e: Event) {
  if ((e.target as HTMLElement | null)?.closest?.("[data-peek]")) e.preventDefault();
  else left = true;
}
function onClosed(e: Event) {
  e.preventDefault();
  if (!left) props.anchor?.focus();
  left = false;
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverPortal>
      <PopoverContent
        v-if="chapter"
        :reference="anchor"
        side="right"
        :side-offset="8"
        align="start"
        class="ui-popup w-[min(420px,90vw)] p-3 text-xs"
        @interact-outside="onOutside"
        @close-auto-focus="onClosed"
      >
        <div class="mb-1 flex items-baseline gap-2">
          <b class="text-sm">{{ chapter.title }}</b
          ><span class="text-zinc-400"
            >~{{ chapter.words.toLocaleString() }} words ·
            {{ Math.round((chapter.words * 5.6) / 1000) }}k chars</span
          >
        </div>
        <p
          class="max-h-48 overflow-auto whitespace-pre-line font-serif text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300"
        >
          {{ isPending ? "Reading…" : peek }}
        </p>
        <div
          class="mt-2 flex items-center gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800"
        >
          <span class="text-zinc-500"
            >{{
              chapter.excluded
                ? "Skipped: left out of every stage and the audiobook."
                : chapter.note
                  ? chapter.note.reason + "."
                  : "A notice, front matter, or a duplicate? Skip it."
            }}
            <RouterLink :to="`/book/${bookId}/contents?ch=${chapter.id}`" class="underline"
              >Review contents</RouterLink
            ></span
          >
          <button
            class="btn-ghost btn-xs ml-auto"
            @click="emit('skip', chapter, !chapter.excluded)"
          >
            {{ chapter.excluded ? "Include again" : "Skip this chapter" }}
          </button>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
