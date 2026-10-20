<script setup lang="ts">
// The right half of the editor: the selected plugin, Mix or layer at full size.
// Changes are made in place, then `change` has the editor write them behind. A delete leaves
// nothing selected, so a second click on Delete can't take out the next step unseen.
import { computed, ref, watch } from "vue";
import {
  ArrowDown as DownIcon,
  ArrowUp as UpIcon,
  ChevronLeft as BackIcon,
  Copy as CopyIcon,
  Trash2 as DeleteIcon,
} from "@lucide/vue";

import { UiSlider, UiSwitch } from "@/ui";
import type { Layer, Step } from "@/types";
import { PLUGINS, describe, formatParam, isMix, labelOf, newStep } from "./catalog";
import { duplicateAt, keyOf, locate, removeAt, shift } from "./chain";
import AddStep from "./AddStep.vue";

const props = defineProps<{ chain: Step[]; selected: string | null }>();
const emit = defineEmits<{ select: [key: string | null]; change: [] }>();

const found = computed(() => locate(props.chain, props.selected));
/** the selected plugin step, when a plugin is what is selected */
const plugin = computed(() => {
  const f = found.value;
  return f?.kind === "step" && !isMix(f.step) ? f.step : null;
});
const def = computed(() => (plugin.value ? PLUGINS[plugin.value.plugin] : undefined));
/** the numbers shown: the catalog's for a plugin it knows, else whatever the step holds */
const params = computed(() => {
  const s = plugin.value;
  if (!s) return [];
  if (def.value) return Object.entries(def.value.params).map(([key, p]) => ({ key, p }));
  return Object.keys(s.params).map((key) => ({ key, p: null }));
});
const letter = (i: number) => String.fromCharCode(65 + i);
const kind = computed(() => found.value?.kind ?? "step");

function setParam(key: string, raw: number) {
  const s = plugin.value;
  if (!s || !Number.isFinite(raw)) return;
  const p = def.value?.params[key];
  s.params[key] = p ? Math.min(p.max, Math.max(p.min, raw)) : raw;
  emit("change");
}
/** The selected step or layer on or off. */
function setOn(on: boolean) {
  const f = found.value;
  if (!f) return;
  (f.kind === "step" ? f.step : f.layer).on = on;
  emit("change");
}
function renameLayer(name: string) {
  const f = found.value;
  if (f?.kind !== "layer") return;
  f.layer.name = name;
  emit("change");
}
function addToLayer(s: Step) {
  const f = found.value;
  if (f?.kind !== "layer") return;
  f.layer.steps.push(s);
  emit("change");
  emit("select", keyOf(s));
}
function addLayer() {
  const f = found.value;
  if (f?.kind !== "step" || !isMix(f.step)) return;
  const l: Layer = {
    name: `Layer ${letter(f.step.mix.length)}`,
    on: true,
    steps: [newStep("Gain")],
  };
  f.step.mix.push(l);
  emit("change");
  emit("select", keyOf(l));
}
function move(by: number) {
  if (found.value && shift(found.value, by)) emit("change");
}
function duplicate() {
  if (!found.value) return;
  const key = duplicateAt(found.value);
  emit("change");
  emit("select", key);
}

/** what was just deleted, to put back */
const removed = ref<{ put: () => void; key: string; name: string } | null>(null);
function remove() {
  const f = found.value;
  if (!f) return;
  const name = f.kind === "layer" ? f.layer.name : labelOf(f.step);
  const r = removeAt(f);
  removed.value = { put: () => r.list.splice(r.index, 0, r.item), key: keyOf(r.item), name };
  emit("change");
  emit("select", null);
}
function undoRemove() {
  const r = removed.value;
  if (!r) return;
  r.put();
  removed.value = null;
  emit("change");
  emit("select", r.key);
}
watch(
  () => props.selected,
  (key) => {
    if (key) removed.value = null;
  },
);
</script>

<template>
  <div v-if="!found" class="grid h-full place-items-center p-5 text-sm text-zinc-400">
    <div
      v-if="removed"
      class="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300"
    >
      <span
        >Removed <b>{{ removed.name }}</b></span
      >
      <button class="font-medium hover:underline" @click="undoRemove">Undo</button>
    </div>
    <span v-else>Pick a step on the left</span>
  </div>

  <div v-else class="flex h-full flex-col">
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
      <!-- back up to the layer a step sits in -->
      <button
        v-if="found.kind === 'step' && found.layer"
        class="-mb-2 flex items-center gap-0.5 text-xs text-zinc-500 hover:text-violet-600"
        @click="emit('select', keyOf(found.layer))"
      >
        <BackIcon class="icon-sm" /> {{ found.layer.name }}
      </button>

      <!-- a plugin -->
      <template v-if="plugin">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h3 class="text-lg font-semibold" :class="!plugin.on && 'text-zinc-400'">
              {{ labelOf(plugin) }}
            </h3>
            <p class="text-xs text-zinc-500">{{ def?.blurb ?? "Read from pasted code" }}</p>
          </div>
          <UiSwitch
            :model-value="plugin.on"
            :aria-label="`${labelOf(plugin)} on`"
            class="pt-1"
            @update:model-value="setOn"
          />
        </div>
        <div
          v-for="{ key, p } in params"
          :key="key"
          class="space-y-1.5"
          :class="!plugin.on && 'opacity-50'"
        >
          <div class="flex items-center gap-2">
            <span class="flex-1 text-sm">{{ p?.label ?? key }}</span>
            <input
              type="number"
              class="input w-24 px-2 py-1 text-right font-mono text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              :min="p?.min"
              :max="p?.max"
              :step="p?.step ?? 'any'"
              :value="plugin.params[key] ?? p?.default"
              :aria-label="`${labelOf(plugin)} ${p?.label ?? key}`"
              @change="setParam(key, Number(($event.target as HTMLInputElement).value))"
            />
            <span class="w-8 text-xs text-zinc-400">{{ p?.unit }}</span>
          </div>
          <template v-if="p">
            <UiSlider
              :model-value="plugin.params[key] ?? p.default"
              :min="p.min"
              :max="p.max"
              :step="p.step"
              :label="`${labelOf(plugin)} ${p.label}`"
              @update:model-value="(v) => setParam(key, v)"
            />
            <div class="flex justify-between font-mono text-[10px] text-zinc-400">
              <span>{{ formatParam(plugin.plugin, key, p.min) }}</span>
              <span>{{ formatParam(plugin.plugin, key, p.max) }}</span>
            </div>
          </template>
        </div>
        <p v-if="!params.length" class="text-xs text-zinc-400">Nothing to set</p>
      </template>

      <!-- a Mix -->
      <template v-else-if="found.kind === 'step' && isMix(found.step)">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h3 class="text-lg font-semibold">Mix</h3>
            <p class="text-xs text-zinc-500">Layers side by side, added together</p>
          </div>
          <UiSwitch
            :model-value="found.step.on"
            aria-label="Mix on"
            class="pt-1"
            @update:model-value="setOn"
          />
        </div>
        <ul class="space-y-1">
          <li v-for="(l, li) in found.step.mix" :key="keyOf(l)">
            <button
              class="flex w-full items-center gap-2 rounded-md border border-zinc-200 px-2 py-1.5 text-left hover:border-violet-400 dark:border-zinc-800"
              :class="!l.on && 'opacity-50'"
              @click="emit('select', keyOf(l))"
            >
              <span
                class="grid h-5 w-5 shrink-0 place-items-center rounded bg-violet-100 text-[10px] font-semibold text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
                >{{ letter(li) }}</span
              >
              <span class="flex-1 truncate text-sm">{{ l.name }}</span>
              <span class="text-[11px] text-zinc-400">{{ l.steps.length }} steps</span>
            </button>
          </li>
        </ul>
        <button
          class="text-xs text-violet-600 hover:underline dark:text-violet-400"
          @click="addLayer"
        >
          + Add layer
        </button>
      </template>

      <!-- a layer -->
      <template v-else-if="found.kind === 'layer'">
        <button
          class="-mb-2 flex items-center gap-0.5 text-xs text-zinc-500 hover:text-violet-600"
          @click="emit('select', keyOf(found.mix))"
        >
          <BackIcon class="icon-sm" /> Mix
        </button>
        <div class="flex items-center gap-3">
          <span
            class="grid h-7 w-7 shrink-0 place-items-center rounded bg-violet-100 text-xs font-semibold text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
            >{{ letter(found.index) }}</span
          >
          <input
            :value="found.layer.name"
            class="input min-w-0 flex-1 py-1 text-base font-semibold"
            aria-label="Layer name"
            @input="renameLayer(($event.target as HTMLInputElement).value)"
          />
          <UiSwitch
            :model-value="found.layer.on"
            :aria-label="`${found.layer.name} on`"
            @update:model-value="setOn"
          />
        </div>
        <ol class="space-y-1">
          <li v-for="(s, si) in found.layer.steps" :key="keyOf(s)">
            <button
              class="flex w-full items-baseline gap-3 rounded-md border border-zinc-200 px-2 py-1.5 text-left hover:border-violet-400 dark:border-zinc-800"
              :class="!s.on && 'opacity-50'"
              @click="emit('select', keyOf(s))"
            >
              <span class="w-4 font-mono text-[11px] text-zinc-400">{{ si + 1 }}</span>
              <span class="text-sm font-medium">{{ labelOf(s) }}</span>
              <span class="truncate font-mono text-[11px] text-zinc-500">{{ describe(s) }}</span>
            </button>
          </li>
        </ol>
        <p v-if="!found.layer.steps.length" class="text-xs text-zinc-400">
          No steps: this layer is the voice as it is
        </p>
        <AddStep :mix="false" :where="`at the end of ${found.layer.name}`" @add="addToLayer" />
      </template>
    </div>

    <!-- the foot: move, copy, take out -->
    <div class="flex items-center gap-2 border-t border-zinc-200 px-5 py-2.5 dark:border-zinc-800">
      <button
        class="icon-btn h-7 w-7"
        aria-label="Move up (Alt ↑)"
        data-tip="Move up (Alt ↑)"
        @click="move(-1)"
      >
        <UpIcon class="icon-sm" />
      </button>
      <button
        class="icon-btn h-7 w-7"
        aria-label="Move down (Alt ↓)"
        data-tip="Move down (Alt ↓)"
        @click="move(1)"
      >
        <DownIcon class="icon-sm" />
      </button>
      <button class="btn-ghost btn-xs ml-auto" @click="duplicate">
        <CopyIcon class="icon-sm" /> Duplicate {{ kind }}
      </button>
      <button
        class="btn-ghost btn-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
        @click="remove"
      >
        <DeleteIcon class="icon-sm" /> Delete {{ kind }}
      </button>
    </div>
  </div>
</template>
