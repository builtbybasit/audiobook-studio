<script setup lang="ts">
// The per-book menu, the same on a cover and on a table row: where to go in the book, one more
// volume, and Remove from library behind a second step. Removing offers the usual Undo toast.
import { useLibraryStore } from "@/stores/library";

import { computed, nextTick, ref } from "vue";
import { useRouter } from "vue-router";
import { plural } from "@/views/library/shared";
import type { Book } from "@/types";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { Ellipsis as MenuIcon, Plus as AddIcon, Trash2 as RemoveIcon } from "@lucide/vue";

const props = defineProps<{ book: Book; triggerClass?: string; align?: "start" | "end" }>();
const emit = defineEmits<{ addVolume: [file: string] }>();
const libraryStore = useLibraryStore();
const router = useRouter();
const contents = computed(() => libraryStore.contentsOf(props.book.id));

const menu = ref(false);
const removing = ref(false);
function go(to: string) {
  menu.value = false;
  void router.push(`/book/${props.book.id}${to ? `/${to}` : ""}`);
}
function addVolume(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0]?.name ?? "volume.epub";
  input.value = "";
  menu.value = false;
  emit("addVolume", file);
}
async function remove() {
  menu.value = false;
  removing.value = false;
  // let the menu unmount before the card does (see the template)
  await nextTick();
  libraryStore.removeBook(props.book.id);
}
</script>

<template>
  <PopoverRoot v-model:open="menu" @update:open="(v) => !v && (removing = false)">
    <PopoverTrigger :class="triggerClass" :aria-label="`More actions for ${book.title}`">
      <MenuIcon class="icon" />
    </PopoverTrigger>
    <!-- mounted only while open: a closed PopoverContent left in a card that is then taken off the
         shelf (a search narrowing it away, a remove) freezes the renderer on unmount -->
    <PopoverPortal v-if="menu">
      <PopoverContent :align="align ?? 'start'" :side-offset="4" class="ui-popup w-56 p-1 text-xs">
        <template v-if="!removing">
          <button
            class="ui-item w-full hover:bg-violet-50 dark:hover:bg-violet-500/15"
            @click="go('')"
          >
            Overview
          </button>
          <button
            class="ui-item w-full hover:bg-violet-50 dark:hover:bg-violet-500/15"
            @click="go('contents')"
          >
            Contents
            <span class="ml-auto font-mono text-[10px] text-zinc-400"
              >{{ contents.included }}/{{ contents.total }}</span
            >
          </button>
          <button
            class="ui-item w-full hover:bg-violet-50 dark:hover:bg-violet-500/15"
            @click="go('cast')"
          >
            Cast
          </button>
          <label
            class="ui-item w-full cursor-pointer hover:bg-violet-50 dark:hover:bg-violet-500/15"
          >
            <AddIcon class="mr-1 icon-sm" /> Add a volume…
            <input type="file" accept=".epub" class="hidden" @change="addVolume" />
          </label>
          <div class="my-1 border-t border-zinc-100 dark:border-zinc-800"></div>
          <button
            class="ui-item w-full text-red-600 hover:bg-red-500/10 dark:text-red-400"
            @click="removing = true"
          >
            <RemoveIcon class="mr-1 icon-sm" /> Remove from library…
          </button>
        </template>
        <div v-else class="p-2">
          <p class="leading-relaxed">
            Remove <b>{{ book.title }}</b> and its {{ plural(contents.total, "chapter") }}, scripts,
            cast and audiobooks? Undo is offered for a moment afterwards.
          </p>
          <div class="mt-2 flex justify-end gap-1">
            <button class="btn-ghost btn-xs" @click="removing = false">Keep</button>
            <button
              class="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-500"
              @click="remove"
            >
              Remove
            </button>
          </div>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
