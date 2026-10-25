<script setup lang="ts">
// The book's flagged lines, retaken in one run. A big run says its size and price first.
import { computed, ref } from "vue";
import { DialogDescription, DialogTitle } from "reka-ui";
import { Flag as FlagIcon } from "@lucide/vue";

import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { plural } from "@/lib/contents";
import { money } from "@/lib/pricing";
import { UiDialog } from "@/ui";
import type { FlaggedRetakes } from "@/types";

const props = defineProps<{ bookId: string }>();

const libraryStore = useLibraryStore();
const narrationStore = useNarrationStore();

/** each take is paid and waits for a verdict, so past this many the run is shown before it goes */
const ASK_OVER = 50;

// the server's counts, so no script needs reading
const flagged = computed(() =>
  libraryStore.chaptersOf(props.bookId).reduce((n, c) => n + (c.lines?.flagged ?? 0), 0),
);
const ask = ref<FlaggedRetakes | null>(null);
const asking = ref(false);

async function retake() {
  if (flagged.value <= ASK_OVER) return void narrationStore.retakeFlaggedBook(props.bookId);
  asking.value = true;
  const preview = await narrationStore.flaggedRetakes(props.bookId);
  asking.value = false;
  // every one already waiting for a verdict: the run itself says so
  if (preview && preview.lines <= ASK_OVER) go();
  else ask.value = preview;
}
function go() {
  ask.value = null;
  void narrationStore.retakeFlaggedBook(props.bookId);
}
</script>

<template>
  <div v-if="flagged" class="card flex shrink-0 items-center gap-2 p-2 text-xs">
    <FlagIcon class="icon-sm shrink-0 text-amber-500" />
    <span class="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300">{{
      plural(flagged, "flagged line")
    }}</span>
    <button
      class="btn-ghost btn-xs shrink-0 border-amber-400 text-amber-600"
      :disabled="asking"
      data-tip="Another take of every flagged line in the book, each kept beside its line to compare"
      @click="retake"
    >
      Retake flagged ({{ flagged }})
    </button>
  </div>
  <UiDialog
    :open="!!ask"
    class="card w-[min(420px,94vw)] space-y-3 p-4"
    @update:open="(open) => !open && (ask = null)"
  >
    <template v-if="ask">
      <DialogTitle class="font-semibold"
        >Retake {{ plural(ask.lines, "flagged line") }}?</DialogTitle
      >
      <DialogDescription class="text-sm text-zinc-600 dark:text-zinc-300">
        Across {{ plural(ask.chapters, "chapter")
        }}<template v-if="ask.cost != null">, about {{ money(ask.cost) }}</template
        >. Each take waits beside its line for you to compare.
      </DialogDescription>
      <p v-if="ask.busy" class="text-xs text-zinc-500">
        {{ plural(ask.busy, "chapter") }} being narrated will be left alone.
      </p>
      <div class="flex justify-end gap-2">
        <button class="btn-ghost btn-xs" @click="ask = null">Cancel</button>
        <button class="btn-primary btn-xs" :disabled="!ask.lines" @click="go">Retake</button>
      </div>
    </template>
  </UiDialog>
</template>
