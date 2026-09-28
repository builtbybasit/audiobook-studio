<script setup lang="ts">
// The per-book menu, the same on a cover and on a table row: where to go in the book, one more
// volume, and Remove from library.
//
// The script travels as a file from here too: **Export script** downloads it, **Import script…**
// opens the page that reads one in. Both are the server's, so the demo says so on the item.
//
// Removing acts at once and offers the usual Undo toast — the app's one rule for danger, see
// `src/stores/README.md`. It used to ask first as well, which said nothing Undo did not already
// cover; what that step explained now hangs off the item itself, where it can be read before the
// click rather than after it. With a server answering there is no Undo — nothing puts a book back
// in the database — so the same rule sends the item down its other branch: it asks, with a second
// click on the item itself, and says it cannot be undone.
import { useLibraryStore } from "@/stores/library";

import { computed, nextTick, ref } from "vue";
import { useRouter } from "vue-router";
import { plural } from "@/views/library/shared";
import type { Book } from "@/types";
import { pickedFrom, type PickedFile } from "@/components/addEpub";
import { scriptExportUrl } from "@/services/library";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import {
  Download as ExportIcon,
  Ellipsis as MenuIcon,
  FileUp as ImportIcon,
  Plus as AddIcon,
  Trash2 as RemoveIcon,
} from "@lucide/vue";

const props = defineProps<{ book: Book; triggerClass?: string; align?: "start" | "end" }>();
const emit = defineEmits<{ addVolume: [picked: PickedFile] }>();
const libraryStore = useLibraryStore();
const router = useRouter();
const contents = computed(() => libraryStore.contentsOf(props.book.id));

const menu = ref(false);
/** Backend mode: a removal cannot be undone, so the item asks with a second click. */
const asksFirst = computed(() => !!libraryStore._service());
/** The script file is written and read by the server; the demo has none to ask. */
const NEEDS_SERVER = "Needs the server — start the app with pnpm dev";
const scriptFiles = computed(() => !!libraryStore._service());
const confirming = ref(false);
/** What the item is about to take, in the menu's own words. */
const removeWarning = computed(
  () =>
    `Removes “${props.book.title}”, its ${plural(contents.value.total, "chapter")}, script, cast and audiobooks. ` +
    (asksFirst.value ? "This cannot be undone." : "Undo is offered afterwards."),
);
function go(to: string) {
  menu.value = false;
  void router.push(`/book/${props.book.id}${to ? `/${to}` : ""}`);
}
function addVolume(e: Event) {
  const input = e.target as HTMLInputElement;
  const picked = pickedFrom(input.files);
  input.value = "";
  menu.value = false;
  if (picked) emit("addVolume", picked);
}
async function remove() {
  if (asksFirst.value && !confirming.value) {
    confirming.value = true;
    return;
  }
  menu.value = false;
  confirming.value = false;
  // let the menu unmount before the card does (see the template)
  await nextTick();
  await libraryStore.removeBook(props.book.id);
}
</script>

<template>
  <PopoverRoot v-model:open="menu" @update:open="(open) => open || (confirming = false)">
    <PopoverTrigger :class="triggerClass" :aria-label="`More actions for ${book.title}`">
      <MenuIcon class="icon" />
    </PopoverTrigger>
    <!-- mounted only while open: a closed PopoverContent left in a card that is then taken off the
         shelf (a search narrowing it away, a remove) freezes the renderer on unmount -->
    <PopoverPortal v-if="menu">
      <PopoverContent :align="align ?? 'start'" :side-offset="4" class="ui-popup w-56 p-1 text-xs">
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
        <label class="ui-item w-full cursor-pointer hover:bg-violet-50 dark:hover:bg-violet-500/15">
          <AddIcon class="mr-1 icon-sm" /> Add a volume…
          <input type="file" accept=".epub" class="hidden" @change="addVolume" />
        </label>
        <a
          v-if="scriptFiles"
          class="ui-item w-full hover:bg-violet-50 dark:hover:bg-violet-500/15"
          :href="scriptExportUrl(book.id)"
          download
          title="The whole book's script, cast and dictionary as a .script.zip"
          @click="menu = false"
        >
          <ExportIcon class="mr-1 icon-sm" /> Export script
        </a>
        <button v-else class="ui-item w-full opacity-50" disabled :title="NEEDS_SERVER">
          <ExportIcon class="mr-1 icon-sm" /> Export script
        </button>
        <button
          class="ui-item w-full hover:bg-violet-50 disabled:opacity-50 dark:hover:bg-violet-500/15"
          :disabled="!scriptFiles"
          :title="scriptFiles ? 'Read a script file into this book' : NEEDS_SERVER"
          @click="go('script-import')"
        >
          <ImportIcon class="mr-1 icon-sm" /> Import script…
        </button>
        <div class="my-1 border-t border-zinc-100 dark:border-zinc-800"></div>
        <button
          class="ui-item w-full items-start text-red-600 hover:bg-red-500/10 dark:text-red-400"
          :title="removeWarning"
          @click="remove"
        >
          <RemoveIcon class="mr-1 mt-0.5 icon-sm" />
          <span v-if="confirming" class="text-left leading-snug"
            >Remove for good?
            <span class="block text-[10px] font-normal text-zinc-500"
              >This cannot be undone · click again to remove</span
            ></span
          >
          <span v-else class="text-left leading-snug"
            >Remove from library
            <span class="block text-[10px] font-normal text-zinc-500"
              >{{ plural(contents.total, "chapter") }}, script, cast and audiobooks ·
              {{ asksFirst ? "asks first" : "Undo offered" }}</span
            ></span
          >
        </button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
