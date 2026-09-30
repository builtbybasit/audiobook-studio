<script setup lang="ts">
import { useUiStore } from "@/stores/ui";

// ⌘K / Ctrl+K command palette: reka Dialog + Listbox with a filter. The rows themselves — what
// you can jump to and what you can run — are worked out in `commands.ts`, which knows the stores
// and no DOM; this file knows the dialog and no domain.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  DialogDescription,
  DialogTitle,
  ListboxContent,
  ListboxFilter,
  ListboxGroup,
  ListboxGroupLabel,
  ListboxItem,
  ListboxRoot,
  useFilter,
} from "reka-ui";
import { Search as SearchIcon } from "@lucide/vue";
import { filterCommands, groupCommands, paletteCommands } from "@/components/commands";
import { modKey as mod } from "@/lib/format";
import { UiDialog } from "@/ui";

const uiStore = useUiStore();
const router = useRouter();
const open = ref(false);
const q = ref("");
const content = ref<{ $el?: HTMLElement } | null>(null);
const { contains } = useFilter({ sensitivity: "base" });

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    open.value = !open.value;
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
watch(open, (o) => {
  if (o) q.value = "";
});

const commands = computed(() => paletteCommands(router, mod));
const filtered = computed(() =>
  filterCommands(commands.value, q.value, contains, router, uiStore.currentBookId),
);
const groups = computed(() => groupCommands(filtered.value));

function run(id: string) {
  const c = filtered.value.find((c) => c.id === id) ?? commands.value.find((c) => c.id === id);
  if (!c) return;
  open.value = false;
  nextTick(() => c.run());
}
function onFilterKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !content.value?.$el?.querySelector("[data-highlighted]")) {
    e.preventDefault();
    if (filtered.value[0]) run(filtered.value[0].id);
  }
}
defineExpose({ open });
</script>

<template>
  <UiDialog
    v-model:open="open"
    placement="top"
    class="w-[min(640px,92vw)] overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
    @open-auto-focus.prevent
  >
    <DialogTitle class="sr-only">Command palette</DialogTitle>
    <DialogDescription class="sr-only"
      >Jump anywhere or run an action. Type to filter, arrows to move, Enter to
      run.</DialogDescription
    >
    <ListboxRoot
      :model-value="undefined"
      highlight-on-hover
      @update:model-value="(v) => run(String(v))"
    >
      <div class="flex items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <SearchIcon class="icon text-zinc-400" />
        <ListboxFilter
          v-model="q"
          auto-focus
          class="h-12 min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
          placeholder="Jump to a page, chapter, speaker… or run an action"
          @keydown="onFilterKey"
        />
        <kbd
          class="rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 dark:border-zinc-700"
          >esc</kbd
        >
      </div>
      <ListboxContent ref="content" class="max-h-[60vh] overflow-auto p-1.5">
        <ListboxGroup v-for="[g, items] in groups" :key="g" class="mb-1">
          <ListboxGroupLabel
            class="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400"
            >{{ g }}</ListboxGroupLabel
          >
          <ListboxItem
            v-for="c in items"
            :key="c.id"
            :value="c.id"
            class="ui-item py-1.5"
            @select="run(c.id)"
          >
            <span
              v-if="c.color"
              class="mr-2 inline-block h-2 w-2 shrink-0 rounded-full"
              :style="{ background: c.color }"
            ></span>
            <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
            <span v-if="c.hint" class="ml-3 shrink-0 text-[11px] text-zinc-400">{{ c.hint }}</span>
          </ListboxItem>
        </ListboxGroup>
        <div v-if="!filtered.length" class="p-6 text-center text-sm text-zinc-500">
          Nothing matches “{{ q }}”.
        </div>
      </ListboxContent>
      <div
        class="flex items-center gap-3 border-t border-zinc-200 px-3 py-1.5 text-[10px] text-zinc-400 dark:border-zinc-800"
      >
        <span><kbd class="font-mono">↑↓</kbd> move</span
        ><span><kbd class="font-mono">↵</kbd> run</span
        ><span><kbd class="font-mono">esc</kbd> close</span>
        <span class="ml-auto">{{ filtered.length }} of {{ commands.length }}</span>
      </div>
    </ListboxRoot>
  </UiDialog>
</template>
