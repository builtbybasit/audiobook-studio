<script setup lang="ts">
// The sheet's second view: one effect taken apart. The header names it and says whether the
// sheet's subject uses it; under it the sheet's line, drawn and heard through the effect as this
// subject would hear it (`choice.effectsFor`) beside the line as the voice made it; then the steps
// on the left and the selected one at full size on the right (`StepInspector`).
//
// An effect belongs to the whole library, so an edit here reaches everyone who uses it. When
// that is anyone besides this subject the header says who ("Also on …") and offers a copy to
// edit instead. Delete asks first, naming everyone who loses it.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { DialogTitle, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import {
  ArrowLeft as BackIcon,
  Ellipsis as MoreIcon,
  Loader2 as SpinIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
} from "@lucide/vue";

import Waveform from "@/components/Waveform.vue";
import { useEffectsStore } from "@/stores/effects";
import type { EffectUses, Step } from "@/types";
import { UiDialog, UiHint } from "@/ui";
import { describe, isMix, labelOf } from "./catalog";
import { keyOf, listed, locate, placesOf, shift, type UsesSelf } from "./chain";
import type { Choice } from "./choice";
import type { TryLine } from "./lines";
import type { Previews } from "./preview";
import { useAudition } from "./audition";
import { sheetOnTop } from "./keys";
import AddStep from "./AddStep.vue";
import StepInspector from "./StepInspector.vue";

const props = defineProps<{
  bookId: string;
  effectId: string;
  line: TryLine | null;
  /** the editor is the view on screen: it may play */
  active: boolean;
  choice: Choice;
  /** whose choice this is, so "Also on" leaves it out */
  self: UsesSelf;
  previews: Previews;
}>();
const emit = defineEmits<{ back: []; edit: [id: string]; paste: [] }>();
const effectsStore = useEffectsStore();

const effect = computed(() => effectsStore.byId.get(props.effectId));
/** the sheet's subject hears this effect now */
const inUse = computed(() => props.choice.current.value === props.effectId);
/** the chain changed in place: write it behind */
function changed() {
  if (effect.value) effectsStore.update(props.effectId, { chain: effect.value.chain });
}
function rename(name: string) {
  effectsStore.update(props.effectId, { name });
}

// ---------- who else it reaches ----------
// Read once: the editor is made afresh for each effect, and the subject's own choice, the one thing
// this sheet changes, is left out of the line anyway.
const uses = ref<EffectUses | null>(null);
void effectsStore.usesOf(props.effectId).then((read) => (uses.value = read));
const others = computed(() => (uses.value ? placesOf(uses.value, props.bookId, props.self) : []));
async function makeCopy() {
  const copy = await effectsStore.duplicate(props.effectId);
  if (!copy) return;
  props.choice.choose(copy.id);
  emit("edit", copy.id);
}

// ---------- the ⋯ menu, and Delete ----------
const menu = ref(false);
const confirming = ref(false);
/** everyone who loses it, read afresh when Delete is asked for; null when the server couldn't say */
const losers = ref<string[] | null>(null);
async function askRemove() {
  menu.value = false;
  const read = await effectsStore.usesOf(props.effectId);
  losers.value = read ? placesOf(read, props.bookId) : null;
  confirming.value = true;
}
async function remove() {
  confirming.value = false;
  if (await effectsStore.remove(props.effectId)) emit("back");
}

// ---------- the steps ----------
const selected = ref<string | null>(effect.value?.chain[0] ? keyOf(effect.value.chain[0]) : null);
interface Row {
  key: string;
  depth: 0 | 1;
  tag: string;
  label: string;
  summary: string;
  item: Step | { on: boolean };
}
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  effect.value?.chain.forEach((s, i) => {
    out.push({
      key: keyOf(s),
      depth: 0,
      tag: String(i + 1),
      label: labelOf(s),
      summary: describe(s),
      item: s,
    });
    if (isMix(s))
      s.mix.forEach((l, li) =>
        out.push({
          key: keyOf(l),
          depth: 1,
          tag: String.fromCharCode(65 + li),
          label: l.name,
          summary: l.steps.length ? l.steps.map(labelOf).join(" › ") : "the voice as it is",
          item: l,
        }),
      );
  });
  return out;
});
/** the row lit: the selection, or the layer a selected step sits in */
const lit = computed(() => {
  const f = effect.value ? locate(effect.value.chain, selected.value) : null;
  return f?.kind === "step" && f.layer ? keyOf(f.layer) : selected.value;
});
function flip(r: Row) {
  r.item.on = !r.item.on;
  changed();
}
function moveSelection(by: number) {
  const i = rows.value.findIndex((r) => r.key === lit.value);
  const r = rows.value[Math.min(rows.value.length - 1, Math.max(0, i + by))];
  if (r) selected.value = r.key;
}
/** the top-level step the selection is on or inside */
const top = computed(() => {
  const chain = effect.value?.chain ?? [];
  const inside = (s: Step): boolean =>
    keyOf(s) === selected.value ||
    (isMix(s) && s.mix.some((l) => keyOf(l) === selected.value || l.steps.some(inside)));
  return selected.value ? chain.findIndex(inside) : -1;
});
const addWhere = computed(() => {
  const chain = effect.value?.chain ?? [];
  const i = top.value;
  return i < 0 || i === chain.length - 1 ? "at the end" : `after ${labelOf(chain[i]!)}`;
});
/** a new step goes right after the selected top-level step, or at the end */
function addTop(s: Step) {
  const chain = effect.value?.chain;
  if (!chain) return;
  chain.splice(top.value < 0 ? chain.length : top.value + 1, 0, s);
  selected.value = keyOf(s);
  changed();
}

// ---------- the audition ----------
const a = useAudition(
  () => props.line,
  () => (props.line ? props.choice.effectsFor(props.line, props.effectId) : []),
  props.previews,
);
watch(
  () => props.active,
  (on) => {
    if (!on) a.stop();
  },
);
/** what the line is heard through, when it is more than this effect: "Weaver mask › Inner voice" */
const heardAs = computed(() => {
  const all = props.line ? props.choice.effectsFor(props.line, props.effectId) : [];
  return all.length > 1 ? all.map((e) => e.name).join(" › ") : "";
});
const original = computed(() => props.line?.duration ?? 0);
const hearingEffect = computed(() => !a.holding.value);
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

// ---------- keys, while the editor is on screen: space, hold O, ↑↓, Alt ↑↓ ----------
function onKey(e: KeyboardEvent) {
  if (!props.active || e.metaKey || e.ctrlKey || !sheetOnTop()) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, select, [contenteditable]")) return;
  if (e.key === " " && !t?.closest("button, [role=switch], [role=slider]")) {
    e.preventDefault();
    a.toggle();
  } else if ((e.key === "o" || e.key === "O") && !e.repeat) a.hold(true);
  else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !t?.closest("[role=slider]")) {
    e.preventDefault();
    const by = e.key === "ArrowUp" ? -1 : 1;
    if (!e.altKey) return moveSelection(by);
    const f = effect.value && locate(effect.value.chain, selected.value);
    if (f && shift(f, by)) changed();
  }
}
function onKeyUp(e: KeyboardEvent) {
  if (e.key === "o" || e.key === "O") a.hold(false);
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("keyup", onKeyUp);
});
</script>

<template>
  <div v-if="effect" class="flex h-full min-h-0 flex-col">
    <!-- header: back, name, use, ⋯ -->
    <div class="space-y-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
      <div class="flex items-center gap-2">
        <button
          class="btn-ghost btn-xs shrink-0 border border-zinc-300 font-medium dark:border-zinc-700"
          @click="emit('back')"
        >
          <BackIcon class="icon-sm" /> All effects
        </button>
        <input
          :value="effect.name"
          class="input min-w-0 flex-1 py-0.5 text-sm font-medium"
          aria-label="Effect name"
          @input="rename(($event.target as HTMLInputElement).value)"
        />
        <span
          v-if="inUse"
          class="shrink-0 rounded bg-violet-500/15 px-1.5 py-px text-[10px] font-semibold text-violet-700 dark:text-violet-300"
          >Active</span
        >
        <button v-else class="btn-ghost btn-xs shrink-0" @click="choice.choose(effectId)">
          Use
        </button>
        <PopoverRoot v-model:open="menu">
          <PopoverTrigger
            class="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Effect actions"
          >
            <MoreIcon class="icon-lg" />
          </PopoverTrigger>
          <PopoverPortal v-if="menu">
            <PopoverContent align="end" :side-offset="4" class="ui-popup w-52 p-1 text-xs">
              <button
                class="ui-item w-full text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                @click="askRemove"
              >
                Delete effect from all books…
              </button>
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
      </div>
      <div v-if="others.length" class="flex items-center gap-2 text-xs text-zinc-500">
        <span class="min-w-0 flex-1 truncate" :title="others.join(', ')"
          >Also on {{ listed(others) }}</span
        >
        <UiHint
          label="a shared effect"
          text="An edit here changes it everywhere it is used. Make a copy to change it only here."
        />
        <button class="btn-ghost btn-xs shrink-0" @click="makeCopy">Make a copy</button>
      </div>
    </div>

    <!-- the line, drawn and heard -->
    <div
      class="space-y-2 border-b border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/70"
    >
      <template v-if="line">
        <div class="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
          <span
            class="text-[11px]"
            :class="
              hearingEffect ? 'text-zinc-400' : 'font-medium text-violet-600 dark:text-violet-400'
            "
            >Original</span
          >
          <Waveform
            :key="line.url"
            :url="line.url"
            :duration="original"
            :progress="original ? Math.min(1, a.time.value / original) : 0"
            :played="hearingEffect ? '#a1a1aa' : '#7c3aed'"
            wave="#d4d4d8"
            :height="28"
            @seek="(f) => a.seek(f * original)"
          />
          <span
            class="flex items-center gap-1 text-[11px]"
            :class="
              hearingEffect ? 'font-medium text-violet-600 dark:text-violet-400' : 'text-zinc-400'
            "
          >
            Effect <SpinIcon v-if="a.busy.value" class="h-3 w-3 animate-spin" />
          </span>
          <Waveform
            v-if="a.effectUrl.value && a.effectDuration.value"
            :key="a.effectUrl.value"
            :url="a.effectUrl.value"
            :duration="a.effectDuration.value"
            :progress="Math.min(1, a.time.value / a.effectDuration.value)"
            :played="hearingEffect ? '#7c3aed' : '#a1a1aa'"
            wave="#d4d4d8"
            :height="28"
            @seek="(f) => a.seek(f * a.effectDuration.value)"
          />
          <div v-else class="h-7 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800"></div>
        </div>
        <div class="flex items-center gap-3">
          <button
            class="grid h-8 w-8 place-items-center rounded-full bg-violet-600 text-white hover:bg-violet-500"
            :aria-label="a.playing.value ? 'Pause' : 'Play'"
            @click="a.toggle()"
          >
            <PauseIcon v-if="a.playing.value" class="icon icon-fill" />
            <PlayIcon v-else class="icon icon-fill" />
          </button>
          <span class="w-14 font-mono text-[11px] tabular-nums text-zinc-500">{{
            clock(a.time.value)
          }}</span>
          <button
            class="btn-ghost btn-xs select-none"
            :class="
              a.holding.value &&
              'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
            "
            @pointerdown="a.hold(true)"
            @pointerup="a.hold(false)"
            @pointerleave="a.hold(false)"
          >
            Hold to compare
          </button>
          <UiHint
            label="comparing"
            text="Hold the button, or the O key, to hear the line as the voice made it; let go to hear the effect again. Space plays, ↑↓ pick a step, Alt ↑↓ move it."
          />
          <span v-if="heardAs" class="min-w-0 flex-1 truncate text-right text-[11px] text-zinc-500"
            >Heard as {{ heardAs }}</span
          >
        </div>
      </template>
      <p v-else class="text-xs text-zinc-500">No narrated lines to try it on yet.</p>
    </div>

    <!-- the steps, and the one selected -->
    <div class="flex min-h-0 flex-1">
      <div
        class="flex min-h-0 w-[300px] shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800"
      >
        <ol class="min-h-0 flex-1 overflow-y-auto p-2" role="listbox" aria-label="Steps">
          <li
            v-for="r in rows"
            :key="r.key"
            role="option"
            :aria-selected="lit === r.key"
            class="flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2"
            :class="[
              r.depth ? 'pl-7' : 'pl-2',
              lit === r.key
                ? 'bg-violet-100 dark:bg-violet-500/20'
                : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/70',
            ]"
            @click="selected = r.key"
          >
            <span
              class="w-4 shrink-0 text-center font-mono text-[11px]"
              :class="
                r.depth ? 'font-semibold text-violet-600 dark:text-violet-400' : 'text-zinc-400'
              "
              >{{ r.tag }}</span
            >
            <button
              class="grid h-4 w-4 shrink-0 place-items-center"
              :aria-label="`${r.label} ${r.item.on ? 'on' : 'off'}`"
              :aria-pressed="r.item.on"
              @click.stop="flip(r)"
            >
              <span
                class="h-2.5 w-2.5 rounded-full"
                :class="r.item.on ? 'bg-emerald-500' : 'border border-zinc-400'"
              ></span>
            </button>
            <span
              class="shrink-0 truncate text-sm"
              :class="[!r.item.on && 'text-zinc-400', !r.depth && 'font-medium']"
              >{{ r.label }}</span
            >
            <span class="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-zinc-500">{{
              r.summary
            }}</span>
          </li>
          <li v-if="!rows.length" class="px-2 py-4 text-center text-sm text-zinc-400">
            No steps yet
          </li>
        </ol>
        <div
          class="flex items-center gap-3 border-t border-zinc-200 px-2 py-2 dark:border-zinc-800"
        >
          <AddStep :where="addWhere" @add="addTop" />
          <button class="text-xs text-zinc-500 hover:text-violet-600" @click="emit('paste')">
            Paste Python…
          </button>
        </div>
      </div>
      <div class="min-w-0 flex-1">
        <StepInspector
          :chain="effect.chain"
          :selected="selected"
          @select="(key) => (selected = key)"
          @change="changed"
        />
      </div>
    </div>
  </div>

  <UiDialog v-model:open="confirming" class="card w-[min(420px,94vw)] space-y-3 p-4">
    <DialogTitle class="font-semibold">Delete “{{ effect?.name }}” from every book?</DialogTitle>
    <p class="text-sm text-zinc-600 dark:text-zinc-300">
      <template v-if="losers === null">Where it is used couldn’t be checked.</template>
      <template v-else-if="losers.length">Used by {{ listed(losers, 6) }}.</template>
      <template v-else>Nothing uses it.</template>
      <UiHint
        v-if="losers?.length"
        label="what deleting takes"
        text="Speakers who used it go back to no effect, and their thoughts to the book’s. A book’s thoughts go back to all books’, and all books’ thoughts to none."
      />
    </p>
    <div class="flex justify-end gap-2">
      <button class="btn-ghost btn-xs" @click="confirming = false">Cancel</button>
      <button
        class="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-500"
        @click="remove"
      >
        Delete from every book
      </button>
    </div>
  </UiDialog>
</template>
