<script setup lang="ts">
// Adding an EPUB: a new novel, or the next volume of one already here. Confirming reads the file
// into a book (or volume) that waits in the contents review; nothing is on the shelf until that
// review is done. The prototype parses no file, so the dialog also asks what the file turns out
// to contain — the one place that is said.
import { useLibraryStore } from "@/stores/library";

import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { IMPORT_SAMPLES, importSample } from "@/mock";
import type { PendingAdd } from "@/components/addEpub";
import { UiSelect } from "@/ui";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";

const props = defineProps<{ pending: PendingAdd | null }>();
const emit = defineEmits<{ close: [] }>();
const libraryStore = useLibraryStore();
const router = useRouter();

const draft = ref<PendingAdd | null>(null);
watch(
  () => props.pending,
  (p) => {
    draft.value = p ? { ...p } : null;
  },
  { immediate: true },
);
const books = computed(() => libraryStore.shelved);
const sampleOptions = IMPORT_SAMPLES.map((s) => ({
  value: s.id,
  label: s.label,
  hint: `${s.volumes.reduce((a, v) => a + v.chapters.length, 0)} ch`,
}));
const sampleHint = computed(() => importSample(draft.value?.sample ?? "")?.hint ?? "");

/** Read the file and go straight to its contents review. */
function confirm() {
  const p = draft.value;
  if (!p) return;
  const bookId =
    p.mode === "new"
      ? libraryStore.importBook(p.sample, { file: p.file, title: p.title })
      : p.bookId;
  if (p.mode === "volume") {
    if (libraryStore.importVolume(p.bookId, p.sample, p.file, p.volName) == null) return;
  }
  emit("close");
  void router.push(`/book/${bookId}/contents`);
}
</script>

<template>
  <DialogRoot
    :open="!!draft"
    @update:open="
      (v) => {
        if (!v) emit('close');
      }
    "
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/40" />
      <DialogContent
        class="card fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 p-5 text-sm shadow-2xl focus:outline-none"
      >
        <DialogTitle class="label mb-1">Add EPUB</DialogTitle>
        <DialogDescription class="mb-4 truncate font-mono text-xs text-zinc-500">{{
          draft?.file
        }}</DialogDescription>
        <template v-if="draft">
          <div class="mb-3 grid grid-cols-2 gap-2">
            <button
              class="rounded-lg border p-3 text-left"
              :class="
                draft.mode === 'new'
                  ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10'
                  : 'border-zinc-200 dark:border-zinc-800'
              "
              :aria-pressed="draft.mode === 'new'"
              @click="draft.mode = 'new'"
            >
              <div class="font-medium">New novel</div>
              <div class="text-xs text-zinc-500">Standalone book, its own cast.</div>
            </button>
            <button
              class="rounded-lg border p-3 text-left disabled:opacity-40"
              :class="
                draft.mode === 'volume'
                  ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10'
                  : 'border-zinc-200 dark:border-zinc-800'
              "
              :aria-pressed="draft.mode === 'volume'"
              :disabled="!books.length"
              @click="
                draft.mode = 'volume';
                draft.bookId ||= books[0]?.id ?? '';
              "
            >
              <div class="font-medium">Next volume of…</div>
              <div class="text-xs text-zinc-500">
                Continues an existing novel: shared cast, continuous chapter numbers.
              </div>
            </button>
          </div>
          <template v-if="draft.mode === 'new'">
            <label class="block text-xs"
              >Title<input v-model="draft.title" class="input mt-1 w-full"
            /></label>
          </template>
          <template v-else>
            <label class="block text-xs"
              >Novel<UiSelect
                v-model="draft.bookId"
                :options="
                  books.map((b) => ({
                    value: b.id,
                    label: b.title,
                    hint: b.volumes.length + ' vol.',
                  }))
                "
                class="mt-1"
                block
            /></label>
            <label class="mt-2 block text-xs"
              >Volume name<input v-model="draft.volName" class="input mt-1 w-full"
            /></label>
          </template>

          <div
            class="mt-4 rounded-lg border border-dashed border-zinc-300 p-3 dark:border-zinc-700"
          >
            <label class="block text-xs"
              ><span class="font-medium">Sample contents</span>
              <span class="text-zinc-500"> · nothing is parsed in this prototype</span>
              <UiSelect v-model="draft.sample" :options="sampleOptions" class="mt-1" block
            /></label>
            <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{{ sampleHint }}</p>
          </div>

          <div class="mt-4 flex items-center justify-end gap-2">
            <span class="mr-auto text-[11px] text-zinc-500">Next: review the contents</span>
            <button class="btn-ghost" @click="emit('close')">Cancel</button
            ><button class="btn-primary" @click="confirm">Read the file</button>
          </div>
        </template>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
