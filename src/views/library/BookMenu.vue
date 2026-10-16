<script setup lang="ts">
// The per-book menu, the same on a cover and on a table row.
// Export asks about voice samples on the item itself, unticked every time: samples go out only
// when asked for. Remove has no Undo, so it takes a second click and says what it takes.
import { useLibraryStore } from "@/stores/library";

import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { Book } from "@/types";
import { plural } from "@/lib/contents";
import { pickedFrom, type PickedFile } from "@/components/addEpub";
import { libraryService, scriptExportUrl } from "@/services/library";
import { sizeLabel } from "@/lib/audioFormat";
import { UiCheckbox } from "@/ui";
import type { ScriptExportSamples } from "@/types";
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
const confirming = ref(false);

// ---------- export, and the voice samples it can carry ----------
const samples = ref<ScriptExportSamples | null>(null);
/** Export is asking whether to include the samples: the item opened into its second step. */
const exporting = ref(false);
const withSamples = ref(false);
/** The item waits for this, so a click can't skip the samples question; a failure means none. */
const checking = ref(false);
watch(menu, async (open) => {
  exporting.value = false;
  withSamples.value = false;
  samples.value = null;
  if (!open) return;
  checking.value = true;
  try {
    samples.value = await libraryService().scriptExportSamples(props.book.id);
  } catch {
    // answered below as no samples
  } finally {
    checking.value = false;
  }
});
const sampleVoices = computed(() => samples.value?.voices ?? []);
const samplesNote = computed(() => {
  const v = sampleVoices.value;
  const bytes = v.reduce((n, x) => n + x.bytes, 0);
  return (
    `Recordings of ${plural(v.length, "voice")} (${v.map((x) => x.speaker).join(", ")}) · ` +
    `${sizeLabel(bytes)}.`
  );
});
/** What the item is about to take, in the menu's own words. */
const removeWarning = computed(
  () =>
    `Removes “${props.book.title}”, its ${plural(contents.value.total, "chapter")}, script, cast and audiobooks. This cannot be undone.`,
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
  if (!confirming.value) {
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
    <!-- mounted only while open: a closed PopoverContent in a card that unmounts freezes the
         renderer -->
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
        <label
          v-if="!libraryStore.importingVolume(book.id)"
          class="ui-item w-full cursor-pointer hover:bg-violet-50 dark:hover:bg-violet-500/15"
        >
          <AddIcon class="mr-1 icon-sm" /> Add a volume…
          <input type="file" accept=".epub" class="hidden" @change="addVolume" />
        </label>
        <template v-if="sampleVoices.length">
          <button
            class="ui-item w-full hover:bg-violet-50 dark:hover:bg-violet-500/15"
            :aria-expanded="exporting"
            title="The whole book's script, cast and dictionary as a .script.zip"
            @click="exporting = !exporting"
          >
            <ExportIcon class="mr-1 icon-sm" /> Export script…
          </button>
          <div
            v-if="exporting"
            class="mx-1 mb-1 space-y-1.5 rounded bg-zinc-50 p-2 dark:bg-zinc-800/60"
          >
            <label class="flex items-center gap-2 font-medium">
              <UiCheckbox v-model="withSamples" size="xs" /> Include voice samples
            </label>
            <p class="text-[10px] leading-snug text-zinc-500">{{ samplesNote }}</p>
            <a
              class="btn-primary btn-xs w-full justify-center"
              :href="scriptExportUrl(book.id, withSamples)"
              download
              @click="menu = false"
            >
              Download{{ withSamples ? " with samples" : "" }}
            </a>
          </div>
        </template>
        <button
          v-else-if="checking"
          class="ui-item w-full opacity-50"
          disabled
          title="Checking whether any voice keeps its recordings"
        >
          <ExportIcon class="mr-1 icon-sm" /> Export script
          <span class="ml-auto text-[10px] text-zinc-500">checking…</span>
        </button>
        <a
          v-else
          class="ui-item w-full hover:bg-violet-50 dark:hover:bg-violet-500/15"
          :href="scriptExportUrl(book.id)"
          download
          title="The whole book's script, cast and dictionary as a .script.zip"
          @click="menu = false"
        >
          <ExportIcon class="mr-1 icon-sm" /> Export script
        </a>
        <button
          class="ui-item w-full hover:bg-violet-50 dark:hover:bg-violet-500/15"
          title="Read a script file into this book"
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
              >{{ plural(contents.total, "chapter") }}, script, cast and audiobooks · asks
              first</span
            ></span
          >
        </button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
