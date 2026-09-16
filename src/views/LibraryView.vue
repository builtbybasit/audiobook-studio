<script setup lang="ts">
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";

import { ref } from "vue";
import { useRouter } from "vue-router";

import type { Book, BookProgress } from "@/types";
import MiniBar from "@/components/MiniBar.vue";
import EmptyState from "@/components/EmptyState.vue";
import { Library as LibraryIcon } from "@lucide/vue";
import { Plus as AddIcon } from "@lucide/vue";
import { UiSelect } from "@/ui";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
const libraryStore = useLibraryStore();
const uiStore = useUiStore();
const router = useRouter();
const dragging = ref(false);
/** The add-a-file dialog: what was dropped, and whether it becomes a new novel or a new volume. */
interface PendingAdd {
  file: string;
  mode: "new" | "volume";
  bookId: string;
  title: string;
  volName: string;
}
const pending = ref<PendingAdd | null>(null);

function open(b: Book) {
  uiStore.currentBookId = b.id;
  router.push(`/book/${b.id}`);
}
function addFake(e: Event | DragEvent | null, bookId: string | null = null) {
  const file =
    (e?.target as HTMLInputElement | null)?.files?.[0]?.name ??
    (e as DragEvent | null)?.dataTransfer?.files?.[0]?.name ??
    "Untitled Upload.epub";
  const guess = file.replace(/\.epub$/i, "");
  pending.value = {
    file,
    mode: bookId ? "volume" : "new",
    bookId: bookId ?? libraryStore.books[0]?.id ?? "",
    title: guess,
    volName: guess,
  };
}
function confirmAdd() {
  const p = pending.value;
  if (!p) return;
  if (p.mode === "new") libraryStore.addNovel(p.file, p.title);
  else libraryStore.addVolume(p.bookId, p.file, p.volName);
  pending.value = null;
}
function stageOf(p: BookProgress) {
  if (p.scripted < p.total)
    return {
      label: `${p.total - p.scripted} to script`,
      cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    };
  if (p.narrated < p.total)
    return {
      label: `${p.total - p.narrated} to narrate`,
      cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    };
  if (p.stale)
    return {
      label: `${p.stale} stale`,
      cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    };
  if (p.exported)
    return {
      label: `Complete · export v${p.exported}`,
      cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    };
  if (p.narrated)
    return {
      label: "Ready to export",
      cls: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    };
  return { label: "New", cls: "bg-zinc-500/15 text-zinc-500" };
}
</script>

<template>
  <div class="mx-auto max-w-6xl p-6">
    <div class="mb-5 flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-semibold">Library</h1>
        <p class="text-sm text-zinc-500">
          {{ libraryStore.books.length }} books · open one to continue
        </p>
      </div>
      <label class="btn-primary cursor-pointer"
        ><AddIcon class="icon" /> Add EPUB<input
          type="file"
          accept=".epub"
          class="hidden"
          @change="addFake($event)"
      /></label>
    </div>

    <div
      class="mb-6 grid place-items-center rounded-xl border-2 border-dashed px-6 py-8 text-sm text-zinc-500 transition-colors"
      :class="
        dragging
          ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10'
          : 'border-zinc-300 dark:border-zinc-700'
      "
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="
        dragging = false;
        addFake($event);
      "
    >
      Drop .epub files here — a new novel, or another volume of one you already have
    </div>

    <EmptyState
      v-if="!libraryStore.books.length"
      :icon="LibraryIcon"
      title="No books yet"
      body="Add an EPUB to start. Each file becomes a novel, or a volume of one you already have."
    />
    <div class="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
      <div
        v-for="b in libraryStore.books"
        :key="b.id"
        class="card overflow-hidden text-left transition-shadow hover:shadow-lg hover:shadow-violet-500/10"
      >
        <button
          class="group block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
          :aria-label="`Open ${b.title}`"
          @click="open(b)"
        >
          <div
            class="relative aspect-[3/4] p-4"
            :style="{ background: `linear-gradient(160deg, ${b.cover[0]}, ${b.cover[1]})` }"
          >
            <div class="font-serif text-lg font-semibold leading-tight text-white drop-shadow">
              {{ b.title }}
            </div>
            <div class="mt-1 text-xs text-white/80">{{ b.author }}</div>
            <span
              class="absolute bottom-3 left-3 rounded-full px-2 py-0.5 text-[11px] font-semibold backdrop-blur"
              :class="stageOf(libraryStore.progress(b.id)).cls"
              >{{ stageOf(libraryStore.progress(b.id)).label }}</span
            >
            <span
              v-if="libraryStore.progress(b.id).running"
              class="absolute bottom-3 right-3 h-2 w-2 animate-pulse rounded-full bg-emerald-400"
            ></span>
          </div>
          <div class="space-y-1.5 p-3 text-xs">
            <div class="flex justify-between">
              <span class="text-zinc-500">Chapters</span
              ><span
                >{{ libraryStore.progress(b.id).total
                }}<span v-if="b.volumes.length > 1" class="text-zinc-400">
                  · {{ b.volumes.length }} vols</span
                ></span
              >
            </div>
            <MiniBar
              label="Scripted"
              :n="libraryStore.progress(b.id).scripted"
              :of="libraryStore.progress(b.id).total"
              color="bg-amber-500"
            />
            <MiniBar
              label="Narrated"
              :n="libraryStore.progress(b.id).narrated"
              :of="libraryStore.progress(b.id).total"
              color="bg-sky-500"
            />
            <div class="flex justify-between">
              <span class="text-zinc-500">Exports</span
              ><span>{{ libraryStore.progress(b.id).exported }}</span>
            </div>
          </div>
        </button>
        <div class="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <label
            class="block cursor-pointer text-center text-[11px] text-zinc-400 hover:text-violet-500"
            ><AddIcon class="icon-sm" /> Add volume to {{ b.title
            }}<input type="file" accept=".epub" class="hidden" @change="addFake($event, b.id)"
          /></label>
        </div>
      </div>
    </div>

    <!-- add dialog -->
    <DialogRoot
      :open="!!pending"
      @update:open="
        (v) => {
          if (!v) pending = null;
        }
      "
    >
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-40 bg-black/40" />
        <DialogContent
          class="card fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 p-5 text-sm shadow-2xl focus:outline-none"
        >
          <DialogTitle class="label mb-1">Add EPUB</DialogTitle>
          <DialogDescription class="mb-4 truncate font-mono text-xs text-zinc-500">{{
            pending?.file
          }}</DialogDescription>
          <template v-if="pending">
            <div class="mb-3 grid grid-cols-2 gap-2">
              <button
                class="rounded-lg border p-3 text-left"
                :class="
                  pending.mode === 'new'
                    ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10'
                    : 'border-zinc-200 dark:border-zinc-800'
                "
                @click="pending.mode = 'new'"
              >
                <div class="font-medium">New novel</div>
                <div class="text-xs text-zinc-500">Standalone book, its own cast.</div>
              </button>
              <button
                class="rounded-lg border p-3 text-left"
                :class="
                  pending.mode === 'volume'
                    ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10'
                    : 'border-zinc-200 dark:border-zinc-800'
                "
                @click="pending.mode = 'volume'"
              >
                <div class="font-medium">Next volume of…</div>
                <div class="text-xs text-zinc-500">
                  Continues an existing novel: shared cast, continuous chapter numbers.
                </div>
              </button>
            </div>
            <template v-if="pending.mode === 'new'">
              <label class="block text-xs"
                >Title<input v-model="pending.title" class="input mt-1 w-full"
              /></label>
            </template>
            <template v-else>
              <label class="block text-xs"
                >Novel<UiSelect
                  v-model="pending.bookId"
                  :options="
                    libraryStore.books.map((b) => ({
                      value: b.id,
                      label: b.title,
                      hint: b.volumes.length + ' vol.',
                    }))
                  "
                  class="mt-1"
                  block
              /></label>
              <label class="mt-2 block text-xs"
                >Volume name<input v-model="pending.volName" class="input mt-1 w-full"
              /></label>
            </template>
            <div class="mt-4 flex justify-end gap-2">
              <button class="btn-ghost" @click="pending = null">Cancel</button
              ><button class="btn-primary" @click="confirmAdd">Add</button>
            </div>
          </template>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
