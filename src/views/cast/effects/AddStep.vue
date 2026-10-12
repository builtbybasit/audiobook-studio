<script setup lang="ts">
// "+ Add step": the catalog in a popover, grouped by what a plugin does. Type to narrow, ↑↓ to
// move, Enter to add; the foot says where the step goes (`where`, from whoever mounts it — after
// the selected step, or at the end of a layer). A Mix is offered only where one can go (`mix`).
import { computed, nextTick, ref, watch } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { Plus as AddIcon, Search as SearchIcon } from "@lucide/vue";

import type { Step } from "@/types";
import { GROUPS, PLUGINS, newMix, newStep } from "./catalog";

const props = withDefaults(defineProps<{ mix?: boolean; where?: string }>(), {
  mix: true,
  where: "",
});
const emit = defineEmits<{ add: [Step] }>();
const open = ref(false);
const query = ref("");
const hi = ref(0);
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);

interface Item {
  key: string;
  label: string;
  blurb: string;
  group: string;
  make: () => Step;
}
const ALL = computed<Item[]>(() => [
  ...GROUPS.flatMap((group) =>
    Object.entries(PLUGINS)
      .filter(([, d]) => d.group === group)
      .map(([key, d]) => ({
        key,
        label: d.label,
        blurb: d.blurb,
        group,
        make: () => newStep(key),
      })),
  ),
  ...(props.mix
    ? [
        {
          key: "Mix",
          label: "Mix",
          blurb: "Layers side by side, added together",
          group: "Layers",
          make: newMix,
        },
      ]
    : []),
]);
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q
    ? ALL.value.filter((i) => `${i.label} ${i.blurb} ${i.group} ${i.key}`.toLowerCase().includes(q))
    : ALL.value;
});
const groups = computed(() =>
  [...new Set(shown.value.map((i) => i.group))].map((group) => ({
    group,
    items: shown.value.filter((i) => i.group === group),
  })),
);
watch(query, () => (hi.value = 0));
watch(open, async (o) => {
  if (!o) return;
  query.value = "";
  hi.value = 0;
  await nextTick();
  input.value?.focus();
});

function add(i: Item) {
  emit("add", i.make());
  open.value = false;
}
function onKey(e: KeyboardEvent) {
  const n = shown.value.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!n) return;
    hi.value = (hi.value + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    list.value
      ?.querySelector(`[data-add-item="${shown.value[hi.value]!.key}"]`)
      ?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const i = shown.value[hi.value];
    if (i) add(i);
  }
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      class="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-violet-600 hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-500/10"
    >
      <AddIcon class="icon-sm" /> Add step
    </PopoverTrigger>
    <PopoverPortal v-if="open">
      <PopoverContent
        align="start"
        side="top"
        :side-offset="6"
        class="ui-popup flex w-[min(420px,90vw)] flex-col text-xs"
        @open-auto-focus.prevent
      >
        <label
          class="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800"
        >
          <SearchIcon class="icon-sm shrink-0 text-zinc-400" />
          <input
            ref="input"
            v-model="query"
            class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
            placeholder="Find a step — reverb, pitch, echo…"
            aria-label="Find a step"
            @keydown="onKey"
          />
        </label>
        <!-- the scroll is inside: .ui-popup's overflow-hidden is unlayered and beats any utility -->
        <div
          ref="list"
          class="max-h-[min(55vh,calc(var(--reka-popper-available-height)-90px))] overflow-y-auto overscroll-contain p-1.5"
        >
          <section v-for="{ group, items } in groups" :key="group" class="mb-1">
            <div class="label px-1.5 pb-1 pt-1.5">{{ group }}</div>
            <div class="grid grid-cols-2 gap-1">
              <button
                v-for="i in items"
                :key="i.key"
                :data-add-item="i.key"
                class="rounded-md border px-2.5 py-1.5 text-left"
                :class="
                  shown[hi] === i
                    ? 'border-violet-400 bg-violet-50 dark:border-violet-500/60 dark:bg-violet-500/15'
                    : 'border-transparent hover:border-zinc-200 hover:bg-zinc-50 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/60'
                "
                @mouseenter="hi = shown.indexOf(i)"
                @click="add(i)"
              >
                <div class="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
                  {{ i.label }}
                </div>
                <div class="leading-snug text-zinc-500">{{ i.blurb }}</div>
              </button>
            </div>
          </section>
          <p v-if="!shown.length" class="px-2 py-6 text-center text-zinc-400">
            No step matches “{{ query }}”
          </p>
        </div>
        <div
          class="flex items-center gap-2 border-t border-zinc-200 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-800"
        >
          <span v-if="where" class="min-w-0 flex-1 truncate">Adds {{ where }}</span>
          <span class="ml-auto shrink-0 font-mono text-[10px] text-zinc-400">↑↓ · enter</span>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
