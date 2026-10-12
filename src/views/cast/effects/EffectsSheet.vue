<script setup lang="ts">
// The voice effects sheet, opened from the cast page for the book's thought effect or for one
// speaker (`subject`). Two views slide side by side inside it: the list of effects to try on and
// choose (`TryList`), and one effect taken apart (`EffectEditor`), for which the sheet widens.
//
// The header is both views': who the sheet is for, and the line they try effects on — one of the
// subject's own narrated lines, stepped through by its place among them and blurred until asked
// for, since the line is there to be heard and the story not read ahead. A speaker's sheet switches
// between their lines and their thoughts itself; the book's is about thoughts only.
import { computed, nextTick, ref, watch } from "vue";
import { DialogTitle } from "reka-ui";
import { ChevronLeft as PrevIcon, ChevronRight as NextIcon, X as CloseIcon } from "@lucide/vue";

import { useEffects } from "@/queries";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import { UiHint, UiSheet, UiToggleGroup } from "@/ui";
import { useChoice, type ChoiceView } from "./choice";
import { useTryLines } from "./lines";
import { usePreviews } from "./preview";
import type { EffectSlot } from "@/types";
import type { EffectSubject } from "./subject";
import EffectEditor from "./EffectEditor.vue";
import PasteDialog from "./PasteDialog.vue";
import ReapplyBar from "./ReapplyBar.vue";
import TryList from "./TryList.vue";

const props = defineProps<{ bookId: string; subject: EffectSubject | null }>();
const open = defineModel<boolean>("open", { default: false });
// the library's effects, read in once and kept; the page may read them too, which costs nothing more
useEffects();
const effectsStore = useEffectsStore();
const castStore = useCastStore();

const slot = ref<EffectSlot>("effect");
const SLOTS = [
  { value: "effect", label: "All lines" },
  { value: "thoughts", label: "Thoughts" },
];
const name = computed(() => (props.subject?.kind === "speaker" ? props.subject.name : ""));
const view = computed<ChoiceView>(() => (props.subject?.kind === "speaker" ? slot.value : "book"));
const color = computed(
  () => castStore.charactersOf(props.bookId).find((c) => c.name === name.value)?.color ?? "#a1a1aa",
);
const choice = useChoice(
  () => props.bookId,
  () => view.value,
  () => name.value,
);
const previews = usePreviews();

// ---------- the line both views play ----------
const lines = useTryLines(
  () => props.bookId,
  () =>
    !open.value || !props.subject
      ? null
      : view.value === "book"
        ? { speaker: null, thoughts: true }
        : { speaker: name.value, thoughts: view.value === "thoughts" },
);
const idx = ref(0);
/** the line's words are blurred until clicked: it is there to be heard, not read ahead */
const shown = ref(false);
const line = computed(() => lines.value[idx.value] ?? null);
function go(i: number) {
  if (!lines.value[i]) return;
  idx.value = i;
  shown.value = false;
}

// ---------- which view ----------
const mode = ref<"try" | "edit">("try");
const editId = ref<string | null>(null);
const editing = computed(() => (editId.value ? effectsStore.byId.get(editId.value) : undefined));
const tryPane = ref<HTMLElement | null>(null);
const editPane = ref<HTMLElement | null>(null);
/** the pane sliding out takes the focus with it, so the one sliding in is given it */
async function show(m: "try" | "edit") {
  mode.value = m;
  await nextTick();
  (m === "try" ? tryPane : editPane).value?.focus({ preventScroll: true });
}
function edit(id: string) {
  editId.value = id;
  void show("edit");
}
// an effect removed while it is open (here or in another tab) leaves nothing to edit
watch(editing, (e) => {
  if (!e && mode.value === "edit") void show("try");
});

const pasting = ref(false);
const pasteInto = computed(() =>
  mode.value === "edit" && editing.value
    ? { id: editing.value.id, name: editing.value.name }
    : null,
);

/** Opened, or opened for someone else: start on the list, at their first line — or in the editor,
 *  when the book's sheet was opened to tune an effect. */
watch(
  () => [open.value, props.subject] as const,
  ([o, s]) => {
    mode.value = "try";
    editId.value = null;
    idx.value = 0;
    shown.value = false;
    choice.changed.value = null;
    if (s?.kind === "speaker") slot.value = s.slot;
    if (!o) previews.clear();
    else if (s?.kind === "book" && s.effect) edit(s.effect);
  },
  { immediate: true },
);
function setSlot(s: EffectSlot) {
  if (s === slot.value) return;
  slot.value = s;
  idx.value = 0;
  shown.value = false;
  choice.changed.value = null;
  void show("try");
}
</script>

<template>
  <UiSheet
    v-model:open="open"
    class="transition-[max-width] duration-300 ease-out"
    :class="mode === 'edit' ? 'max-w-[min(820px,94vw)]' : 'max-w-[560px]'"
  >
    <template v-if="subject">
      <!-- who, and the line both views play -->
      <div class="space-y-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div class="flex items-center gap-2">
          <template v-if="subject.kind === 'book'">
            <DialogTitle class="font-semibold">Thoughts · whole book</DialogTitle>
            <UiHint
              label="the book’s thought effect"
              text="Every thought line gets it after its speaker’s own effect, unless the speaker has a thought effect of their own. ↑↓ move · Space play · Enter choose."
            />
          </template>
          <template v-else>
            <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: color }"></span>
            <DialogTitle class="font-semibold">{{ name }}</DialogTitle>
            <span class="text-xs text-zinc-400">effect</span>
            <UiHint
              label="trying effects on"
              text="Each row plays this line through that effect. On Thoughts, the speaker’s own effect plays first. ↑↓ move · Space play · Enter choose."
            />
          </template>
          <button
            class="ml-auto rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Close"
            @click="open = false"
          >
            <CloseIcon class="icon-lg" />
          </button>
        </div>
        <div v-if="lines.length" class="flex items-center gap-2">
          <button
            class="rounded p-1 text-zinc-500 hover:text-violet-600 disabled:opacity-30"
            :disabled="idx === 0"
            aria-label="Previous line"
            @click="go(idx - 1)"
          >
            <PrevIcon class="icon" />
          </button>
          <span class="shrink-0 font-mono text-[11px] text-zinc-500"
            >Line {{ idx + 1 }} of {{ lines.length }}</span
          >
          <button
            class="rounded p-1 text-zinc-500 hover:text-violet-600 disabled:opacity-30"
            :disabled="idx >= lines.length - 1"
            aria-label="Next line"
            @click="go(idx + 1)"
          >
            <NextIcon class="icon" />
          </button>
          <button
            class="min-w-0 flex-1 truncate text-left text-xs"
            :class="!shown && 'select-none blur-[4px]'"
            :title="shown ? undefined : 'Show the line'"
            @click="shown = !shown"
          >
            {{ line?.text }}
          </button>
        </div>
        <p
          v-if="line?.baked"
          class="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400"
        >
          This line still has its old effect baked in
          <UiHint
            label="a line with its old effect"
            text="It was made before effects were kept apart from the voice, so each effect here plays on top of the old one. Re-narrate it to hear it clean."
          />
        </p>
        <p v-if="!lines.length" class="text-xs text-zinc-500">
          No narrated {{ view === "effect" ? "lines" : "thought lines" }} to try effects on yet.
        </p>
        <div v-if="subject.kind === 'speaker'">
          <UiToggleGroup
            :model-value="slot"
            :options="SLOTS"
            aria-label="Which of their lines"
            @update:model-value="(v) => setSlot(v as EffectSlot)"
          />
        </div>
        <ReapplyBar :book-id="bookId" />
      </div>

      <!-- the two views side by side; the track slides between them -->
      <div class="relative min-h-0 flex-1 overflow-clip">
        <div
          class="flex h-full w-[200%] transition-transform duration-300 ease-out"
          :class="mode === 'edit' && '-translate-x-1/2'"
        >
          <section
            ref="tryPane"
            tabindex="-1"
            class="flex h-full w-1/2 flex-col outline-none"
            :inert="mode !== 'try'"
            aria-label="Try effects on"
          >
            <TryList
              :key="`${view}:${name}`"
              :book-id="bookId"
              :view="view"
              :name="name"
              :line="line"
              :active="open && mode === 'try'"
              :choice="choice"
              :previews="previews"
              @edit="edit"
              @paste="pasting = true"
            />
          </section>
          <section
            ref="editPane"
            tabindex="-1"
            class="flex h-full w-1/2 flex-col outline-none"
            :inert="mode !== 'edit'"
            aria-label="Edit the effect"
          >
            <EffectEditor
              v-if="editing"
              :key="editing.id"
              :book-id="bookId"
              :effect-id="editing.id"
              :line="line"
              :active="open && mode === 'edit'"
              :choice="choice"
              :self="{ bookId, view, name }"
              :previews="previews"
              @back="show('try')"
              @edit="edit"
              @paste="pasting = true"
            />
          </section>
        </div>
      </div>
    </template>
  </UiSheet>

  <PasteDialog v-model:open="pasting" :into="pasteInto" @made="edit" />
</template>
